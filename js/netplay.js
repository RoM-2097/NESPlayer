/* ============================================================
   NESPLAYER — Netplay Module (WebRTC peer-to-peer, delay-based)
   ------------------------------------------------------------
   Both players run an identical jsnes instance. The host loads
   the ROM and transmits the raw bytes to the guest so both
   bootstrap identically. Then each frame they exchange controller
   input DIRECTLY peer-to-peer over a WebRTC RTCDataChannel (UDP).

   WHY WEBRTC (not WebSockets)?
   ----------------------------
   WebSockets run over TCP (reliable + ordered). A single dropped
   packet retransmits and blocks every frame behind it — head-of-
   line blocking that causes catastrophic desync in a real-time
   game. WebRTC RTCDataChannel runs over UDP. We open the input
   channel with ordered:false + maxRetransmits:0, so each input
   frame is fire-and-forget. If a frame is lost we simply HOLD the
   most recent peer input for one frame (delay-based prediction),
   so the game never stalls and never drops below 60 FPS.

   SIGNALING
   ---------
   A lightweight Socket.io server (server/signal.js) only exchanges
   SDP offers/answers + ICE candidates to establish the peer
   connection. Once connected, ALL game data flows directly
   between the two browsers — the signaling server never relays
   gameplay.

   DATA STRUCTURE (compact binary)
   -------------------------------
   Each input frame is packed into a 4-byte Uint8Array:
     [ frameHi, frameLo, p1Byte, p2Byte ]
   frame  = 16-bit little-endian frame number
   p1Byte = host's 8-button mask (1 bit per button)
   p2Byte = guest's 8-button mask (1 bit per button)
   A single byte per player keeps packets minimal.

   Public API (window.NESNetplay) — identical to the WebSocket
   version so js/app.js needs NO changes:
     init({host:{...}, guest:{...}})
     open() / close() / disconnect()
     createRoom(url) / joinRoom(code, url)
     setLocalInput(state)
     step()          // returns true once a frame may advance
     applyFrame(nes) // apply both players' delayed input
     isActive() / isReady() / getRole() / getState() / getFrame()
     sendChat(text)
   ============================================================ */
(function () {
  'use strict';

  var GG = window.NESNetplay || (window.NESNetplay = {});

  // 8 buttons mapped to jsnes Controller ids. The wire format is
  // [UP,DOWN,LEFT,RIGHT,A,B,SEL,START]; jsnes Controller ids here are
  // UP=4,DOWN=5,LEFT=6,RIGHT=7,A=0,B=1,SEL=2,START=3.
  var BUTTON_ORDER = [4, 5, 6, 7, 0, 1, 2, 3];

  var cfg = { host: null, guest: null };

  // Socket.io signaling (client is vendored at js/neslib/socket.io.min.js).
  var io = window.io;
  var socket = null;

  // WebRTC peer connection + data channels.
  var pc = null;
  var dcReliable = null;  // ordered/reliable: ROM bytes + chat
  var dcInput = null;     // unordered/unreliable: per-frame inputs

  var player = null;        // 1 | 2 | null
  var room = null;
  var role = null;          // 'host' | 'guest' | null
  var active = false;
  var state = 'idle';       // idle|connecting|waiting|syncing|playing|error|ended

  var romReady = false;     // both sides connected + have the ROM
  var frame = 0;            // RENDER frame we are about to draw
  var nextFrame = 0;        // LIVE frame we capture/send next

  // Delay window in frames. We render INPUT_DELAY frames behind the live
  // exchange so the peer's input for a frame has already arrived in flight.
  var INPUT_DELAY = 2;

  var localInput = { p1: new Array(8).fill(0), p2: new Array(8).fill(0) };
  var localInputs = {};     // live frame -> {p1:byte, p2:byte}
  var peerInputs = {};      // live frame -> {p1:byte, p2:byte}
  var latestPeer = null;    // most recent peer input (prediction fallback)
  var renderPeer = null;    // peer input to apply on the current render frame

  var STALL_TIMEOUT = 3000;
  var lastStep = 0;

  // ---- Connection-establishment helpers ----

  function setState(s) {
    state = s;
    if (GG.onStateChange) GG.onStateChange(s);
  }
  function toast(msg, type) {
    if (GG.onToast) GG.onToast(msg, type);
  }

  // Normalize a signaling server URL into a valid Socket.io origin.
  // Accepts "http://"/"https://" (or bare host:port) and strips any path.
  function normalizeSignalingUrl(url) {
    if (!url) return '';
    var u = String(url).trim();
    if (!u) return '';
    if (u.indexOf('http://') === 0 || u.indexOf('https://') === 0) {
      return u.split('/').slice(0, 3).join('/'); // keep scheme://host:port
    }
    // Bare host:port or ws://… → assume http(s) on the same host.
    if (u.indexOf('ws://') === 0) return 'http://' + u.slice(5).split('/')[0];
    if (u.indexOf('wss://') === 0) return 'https://' + u.slice(6).split('/')[0];
    return 'http://' + u.split('/')[0];
  }

  function defaultSignalingUrl() {
    if (typeof location !== 'undefined' && location && location.protocol) {
      return location.protocol + '//' + (location.host || 'localhost:3000');
    }
    return 'http://localhost:3000';
  }

  // ---- Binary input packing ----
  function maskToByte(arr) {
    var b = 0;
    for (var i = 0; i < 8; i++) if (arr[i]) b |= (1 << i);
    return b;
  }
  function byteToMask(b) {
    var arr = new Array(8).fill(0);
    for (var i = 0; i < 8; i++) if ((b >> i) & 1) arr[i] = 1;
    return arr;
  }

  // Pack a frame's inputs into a 4-byte packet: [frameHi, frameLo, p1, p2].
  function packInput(n, p1, p2) {
    var buf = new Uint8Array(4);
    buf[0] = (n >>> 8) & 0xFF;
    buf[1] = n & 0xFF;
    buf[2] = p1 & 0xFF;
    buf[3] = p2 & 0xFF;
    return buf;
  }
  function unpackInput(buf) {
    return {
      frame: (buf[0] << 8) | buf[1],
      p1: buf[2],
      p2: buf[3]
    };
  }

  // Send our input for live frame n over the unreliable channel.
  function sendFrameInput(n) {
    var inp = localInputs[n];
    if (!inp || !dcInput || dcInput.readyState !== 'open') return;
    try {
      dcInput.send(packInput(n, inp.p1, inp.p2));
    } catch (e) { /* ignore */ }
  }

  // Send a JSON message over the reliable channel.
  function sendReliable(obj) {
    if (!dcReliable || dcReliable.readyState !== 'open') return false;
    try { dcReliable.send(JSON.stringify(obj)); return true; } catch (e) { return false; }
  }

  // ---- Signaling via Socket.io ----

  function connectSignaling(url, onReady) {
    url = normalizeSignalingUrl(url);
    if (!url) {
      setState('error');
      toast('Enter a valid signaling server URL', 'error');
      return;
    }
    if (socket) { try { socket.disconnect(); } catch (e) {} socket = null; }
    setState('connecting');
    try {
      socket = io(url, { transports: ['websocket', 'polling'], reconnection: false });
    } catch (e) {
      setState('error');
      toast('Signaling error: ' + e.message, 'error');
      return;
    }
    socket.on('connect', function () {
      if (onReady) onReady();
    });
    socket.on('connect_error', function () {
      if (state === 'connecting' || state === 'error') {
        setState('error');
        toast('Signaling server unreachable', 'error');
      }
    });
    socket.on('signal', function (msg) {
      handleSignal(msg);
    });
    socket.on('peer-joined', function () {
      // Host: guest is here → start the WebRTC offer.
      if (role === 'host') startHostPeer();
    });
    socket.on('peer-left', function () {
      endSession('Player disconnected', true);
    });
  }

  function handleSignal(msg) {
    if (!msg || !msg.data) return;
    var data = msg.data;
    if (data.sdp) {
      handleSdp(msg.from, data);
    } else if (data.candidate) {
      handleIce(msg.from, data.candidate);
    }
  }

  function handleSdp(from, data) {
    if (!pc) return;
    var desc = new RTCSessionDescription(data.sdp);
    pc.setRemoteDescription(desc).then(function () {
      if (desc.type === 'offer') {
        return pc.createAnswer().then(function (ans) {
          return pc.setLocalDescription(ans);
        }).then(function () {
          if (socket && socket.connected) socket.emit('signal', { sdp: pc.localDescription });
        });
      }
    }).catch(function (e) {
      console.error('[nesplayer] SDP error:', e);
      setState('error');
      toast('WebRTC negotiation failed', 'error');
    });
  }

  function handleIce(from, candidate) {
    if (!pc) return;
    try {
      pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (e) {
      console.warn('[nesplayer] ICE candidate rejected:', e);
    }
  }

  // ---- WebRTC peer connection ----

  function initPeer(offerer) {
    var cfgRTC = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    };
    pc = new RTCPeerConnection(cfgRTC);

    pc.onicecandidate = function (e) {
      if (e.candidate && socket && socket.connected) {
        socket.emit('signal', { candidate: e.candidate });
      }
    };
    pc.oniceconnectionstatechange = function () {
      if (pc && (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected')) {
        endSession('Peer connection lost', true);
      }
    };

    if (offerer) {
      // Host creates the reliable + input channels.
      dcReliable = pc.createDataChannel('reliable', { ordered: true });
      dcInput = pc.createDataChannel('input', {
        ordered: false,
        maxRetransmits: 0
      });
      wireChannels();
    } else {
      // Guest waits for the host's channels.
      pc.ondatachannel = function (e) {
        if (e.channel.label === 'reliable') {
          dcReliable = e.channel;
          wireReliable();
        } else if (e.channel.label === 'input') {
          dcInput = e.channel;
          wireInput();
        }
      };
    }
  }

  function wireChannels() {
    wireReliable();
    wireInput();
  }

  function wireReliable() {
    if (!dcReliable) return;
    dcReliable.onopen = function () {
      // Both channels must be open before starting gameplay exchange.
      maybePeerReady();
    };
    dcReliable.onmessage = function (e) {
      handleReliableMessage(e.data);
    };
  }

  function wireInput() {
    if (!dcInput) return;
    dcInput.onopen = function () {
      maybePeerReady();
    };
    dcInput.onmessage = function (e) {
      handleInputBinary(e.data);
    };
  }

  function handleReliableMessage(raw) {
    var msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (msg.type === 'rom') {
      if (role === 'guest' && cfg.guest && cfg.guest.loadRom) {
        try {
          cfg.guest.loadRom(msg.bytes, msg.name);
          sendReliable({ type: 'ready' });
          setState('syncing');
          // The guest never receives its own 'ready' message (only the host
          // does), so it must bootstrap its own lockstep state here or it
          // will stay unready forever: GG.isReady() remains false, the
          // emulator holds/never renders, and the guest freezes on a black
          // screen while the host plays.
          becomeReady();
          setState('playing');
          if (cfg.guest && cfg.guest.onStart) cfg.guest.onStart();
        } catch (e) {
          setState('error');
          toast('ROM load failed: ' + e.message, 'error');
        }
      }
    } else if (msg.type === 'ready') {
      becomeReady();
      setState('playing');
      if (role === 'host' && cfg.host && cfg.host.onStart) cfg.host.onStart();
      if (role === 'guest' && cfg.guest && cfg.guest.onStart) cfg.guest.onStart();
    } else if (msg.type === 'chat') {
      if (GG.onChat) GG.onChat(msg.from === 'me' ? 'me' : 'peer', msg.text || '');
    }
  }

  function handleInputBinary(raw) {
    var data;
    if (raw instanceof ArrayBuffer) {
      data = unpackInput(new Uint8Array(raw));
    } else if (raw && raw.buffer) {
      data = unpackInput(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength));
    } else {
      return;
    }
    if (data.frame === undefined) return;
    peerInputs[data.frame] = { p1: data.p1 >>> 0, p2: data.p2 >>> 0 };
    latestPeer = peerInputs[data.frame];
    var min = frame - 4, max = nextFrame + INPUT_DELAY + 8;
    for (var k in peerInputs) {
      var n = Number(k);
      if (n < min || n > max) delete peerInputs[k];
    }
  }

  function maybePeerReady() {
    // Both channels open → both sides are connected P2P.
    if (dcReliable && dcInput &&
        dcReliable.readyState === 'open' && dcInput.readyState === 'open') {
      setState('syncing');
      // Host ships the ROM now so the guest can bootstrap identically.
      if (role === 'host' && cfg.host && cfg.host.romBytes) {
        try {
          var hostNes = cfg.host.nes;
          if (hostNes) {
            if (typeof hostNes.reloadROM === 'function') hostNes.reloadROM();
            else if (typeof hostNes.reset === 'function') hostNes.reset();
            hostNes.running = true;
          }
        } catch (e) { /* ignore */ }
        sendReliable({
          type: 'rom',
          name: cfg.host.romName || 'game.nes',
          bytes: cfg.host.romBytes
        });
      } else if (role === 'guest') {
        // Guest has no ROM yet; it waits for the host's 'rom' message.
      }
    }
  }

  function startHostPeer() {
    initPeer(true);
    pc.createOffer().then(function (offer) {
      return pc.setLocalDescription(offer);
    }).then(function () {
      if (socket && socket.connected) socket.emit('signal', { sdp: pc.localDescription });
    }).catch(function (e) {
      console.error('[nesplayer] offer error:', e);
      setState('error');
    });
  }

  function becomeReady() {
    romReady = true;
    frame = 0;
    nextFrame = INPUT_DELAY;
    localInputs = {};
    latestPeer = null;
    renderPeer = null;
    lastStep = Date.now();
    // Seed our own buffered inputs for the delay window AND transmit them so
    // the peer has frames 0..INPUT_DELAY buffered before rendering starts.
    for (var i = 0; i <= nextFrame; i++) {
      localInputs[i] = { p1: 0, p2: 0 };
      sendFrameInput(i);
    }
  }

  // ---- Public API (identical to the WebSocket version) ----

  GG.init = function (c) {
    cfg.host = c.host || null;
    cfg.guest = c.guest || null;
  };

  GG.open = function () { if (GG.onOpen) GG.onOpen(); };
  GG.close = function () { GG.disconnect(); if (GG.onClose) GG.onClose(); };

  GG.createRoom = function (url) {
    var sUrl = url || GG.defaultUrl || defaultSignalingUrl();
    if (!sUrl) { setState('error'); toast('No signaling server URL configured', 'error'); return; }
    connectSignaling(sUrl, function () {
      socket.emit('create-room', function (res) {
        if (!res || !res.ok) {
          setState('error');
          toast(res && res.error ? res.error : 'Could not create room', 'error');
          return;
        }
        player = res.player;
        room = res.room;
        role = 'host';
        active = true;
        setState('waiting');
        if (GG.onRoomCreated) GG.onRoomCreated(room);
      });
    });
  };

  GG.joinRoom = function (code, url) {
    var sUrl = url || GG.defaultUrl || defaultSignalingUrl();
    if (!sUrl) { setState('error'); toast('No signaling server URL configured', 'error'); return; }
    connectSignaling(sUrl, function () {
      socket.emit('join-room', { room: code }, function (res) {
        if (!res || !res.ok) {
          setState('error');
          toast(res && res.error ? res.error : 'Could not join room', 'error');
          return;
        }
        player = res.player;
        room = res.room;
        role = 'guest';
        active = true;
        setState('waiting');
        // Guest must create its RTCPeerConnection now so pc.ondatachannel is
        // registered before the host's SDP offer arrives. Without this, the
        // host's offer hits `if (!pc) return;` and is dropped, the peer never
        // establishes, the host freezes waiting for data channels, and the ROM
        // is never sent.
        initPeer(false);
        if (GG.onJoined) GG.onJoined(room);
        // Guest's pc is ready; it waits for the host's offer (host got 'peer-joined').
      });
    });
  };

  GG.setLocalInput = function (state) {
    localInput.p1 = state.p1 || new Array(8).fill(0);
    localInput.p2 = state.p2 || new Array(8).fill(0);
  };

  GG.sendChat = function (text) {
    if (!active || !dcReliable || dcReliable.readyState !== 'open') return false;
    if (typeof text !== 'string' || !text.trim()) return false;
    sendReliable({ type: 'chat', text: text.slice(0, 500) });
    return true;
  };

  function resumeLocalEmulator() {
    var localNes = null;
    if (role === 'host' && cfg.host && cfg.host.nes) localNes = cfg.host.nes;
    else if (role === 'guest' && cfg.guest && cfg.guest.nes) localNes = cfg.guest.nes;
    if (localNes) { try { localNes.running = true; } catch (e) { /* ignore */ } }
  }

  function resetState() {
    active = false;
    role = null;
    player = null;
    room = null;
    romReady = false;
    frame = 0;
    nextFrame = 0;
    localInputs = {};
    peerInputs = {};
    latestPeer = null;
    renderPeer = null;
    localInput = { p1: new Array(8).fill(0), p2: new Array(8).fill(0) };
  }

  function endSession(msg, notifyPeer) {
    if (notifyPeer) {
      try { sendReliable({ type: 'peer-left' }); } catch (e) { /* ignore */ }
    }
    setState('ended');
    toast(msg || 'Netplay ended', 'error');
    if (role === 'host' && cfg.host && cfg.host.onStop) cfg.host.onStop();
    if (role === 'guest' && cfg.guest && cfg.guest.onStop) cfg.guest.onStop();
    resumeLocalEmulator();
    resetState();
  }

  function bailLockstep() {
    romReady = false;
    resumeLocalEmulator();
    setState('idle');
  }

  // Called each emulated frame once netplay is ready. Returns true when a
  // frame may advance. Uses DELAY-BASED prediction: if the peer's input for
  // the render frame hasn't arrived, we HOLD the latest received input rather
  // than stalling — so a single lost UDP packet never freezes the game.
  GG.step = function () {
    if (!active || !romReady) return false;

    if (Date.now() - lastStep > STALL_TIMEOUT) {
      toast('Netplay stalled — resuming single-player', 'error');
      bailLockstep();
      return true;
    }

    // 1) Capture + publish our input for the current LIVE frame.
    localInputs[nextFrame] = {
      p1: maskToByte(localInput.p1),
      p2: maskToByte(localInput.p2)
    };
    sendFrameInput(nextFrame);

// 2) The render frame's peer input must already be in flight — we send it
    //    INPUT_DELAY frames ahead. WAIT for it so both cores ADVANCE IN
    //    LOCKSTEP. If we rendered whenever the local setTimeout loop fired,
    //    the two clients' independent loops would drift apart and the cores
    //    would desync within seconds. Holding here (returning false) paces
    //    both sides to the slower one while the 2-frame delay buffer absorbs
    //    network jitter.
    var renderFrame = nextFrame - INPUT_DELAY;
    var peerIn = peerInputs[renderFrame];
    if (!peerIn) {
      // Peer's input for this frame hasn't arrived yet — HOLD (do not advance)
      // so we stay frame-locked. lastStep is intentionally NOT updated here,
      // so the stall timeout above still fires if the peer truly vanishes and
      // we degrade gracefully to single-player.
      return false;
    }
    renderPeer = peerIn;

    // 3) Advance counters.
    nextFrame++;
    frame = renderFrame;
    lastStep = Date.now();
    return true;
  };

  // Apply both players' DELAYED input for the current render frame so both
  // cores execute byte-identical inputs (controller 1 = host's frame-N input,
  // controller 2 = guest's frame-N input).
  GG.applyFrame = function (nesObj) {
    if (!active || !romReady) return;
    var mine = localInputs[frame];
    var peer = renderPeer;
    var myByte = (mine && player === 1) ? mine.p1 : (mine ? mine.p2 : 0);
    var oppByte = (peer && player === 1) ? peer.p2 : (peer ? peer.p1 : 0);
    var myCtrl = player, oppCtrl = player === 1 ? 2 : 1;
    for (var i = 0; i < 8; i++) {
      var btn = BUTTON_ORDER[i];
      if (myByte & (1 << i)) nesObj.buttonDown(myCtrl, btn);
      else nesObj.buttonUp(myCtrl, btn);
      if (oppByte & (1 << i)) nesObj.buttonDown(oppCtrl, btn);
      else nesObj.buttonUp(oppCtrl, btn);
    }
  };

  GG.applyRemote = GG.applyFrame;

  GG.applyLocal = function (nesObj, p1mask, p2mask) {
    for (var i = 0; i < 8; i++) {
      var btn = BUTTON_ORDER[i];
      if (p1mask[i]) nesObj.buttonDown(1, btn); else nesObj.buttonUp(1, btn);
      if (p2mask[i]) nesObj.buttonDown(2, btn); else nesObj.buttonUp(2, btn);
    }
  };

  GG.isActive = function () { return active; };
  GG.isReady = function () { return active && romReady; };
  GG.getRole = function () { return role; };
  GG.getState = function () { return state; };
  GG.getFrame = function () { return frame; };

  GG.disconnect = function () {
    try { sendReliable({ type: 'leave' }); } catch (e) { /* ignore */ }
    if (dcReliable) { try { dcReliable.close(); } catch (e) {} }
    if (dcInput) { try { dcInput.close(); } catch (e) {} }
    dcReliable = null;
    dcInput = null;
    if (pc) { try { pc.close(); } catch (e) {} pc = null; }
    if (socket) { try { socket.disconnect(); } catch (e) {} socket = null; }
    resumeLocalEmulator();
    resetState();
    setState('idle');
  };

})();
