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
  //
  // A FIXED 2-frame delay only works on a low-latency link (LAN). Over the
  // public internet the round-trip (often via a TURN relay) routinely exceeds
  // 33ms, so the peer's input for the render frame has NOT arrived yet and
  // step() holds the emulator — dropping below 60 FPS and glitching audio.
  // The delay is therefore ADAPTIVE: we measure how often we had to wait for
  // peer input and grow/shrink the render lag to cover the live RTT+jitter.
  var INPUT_DELAY_MIN = 2;      // minimum render lag (fast LAN)
  var INPUT_DELAY_MAX = 16;     // maximum render lag (~266ms) before we give up
  var INPUT_DELAY = 4;          // starting delay (covers a typical internet RTT)
  var measuredDelay = INPUT_DELAY; // current adaptive render lag in frames
  var delayMisses = 0;          // frames where we HAD to wait for peer input
  var delaySamples = 0;         // frames sampled since the last adjustment

  // ---- Pre-match RTT calibration (restores 60 FPS) ----
  // The in-play adaptive tuner only grows the render delay AFTER misses
  // accumulate, and at ~50 FPS the miss rate (~17%) sits just below the growth
  // threshold, so it never adapts and the game stays stuck at 50 FPS. To fix
  // this we calibrate the input delay UP FRONT: after the ROM handshake the
  // host pings the guest over the reliable channel, measures one-way latency,
  // and both sides agree on an INPUT_DELAY that covers the live RTT so
  // GG.step() never drops a frame in flight. The in-play adapter then only
  // corrects drift. See TODO.md.
  var rttSamples = [];          // one-way latency samples (ms) from the probe
  var pingSends = {};           // seq -> send timestamp (host, awaiting pong)
  var pingSeq = 0;              // host ping sequence counter
  var calibrating = false;      // true while the pre-match probe is running
  var probeDeadline = 0;        // ms timestamp; past this we finalize anyway
  var probeDone = false;        // guard so finishLatencyProbe runs once

var localInput = { p1: new Array(8).fill(0), p2: new Array(8).fill(0) };
  var localInputs = {};     // live frame -> {p1:byte, p2:byte}
  var peerInputs = {};      // live frame -> {p1:byte, p2:byte}
  var latestPeer = null;    // most recent peer input (prediction fallback)
  var renderPeer = null;    // peer input to apply on the current render frame

  // ROM transfer is chunked so a ROM payload never exceeds the WebRTC
  // RTCDataChannel SCTP max-message-size (~256KB). Sending the whole ROM as a
  // single JSON message silently drops it on the wire, leaving the guest stuck
  // on "sync ROM" forever. Breaking it into small reliable chunks guarantees
  // the guest receives every byte.
  var ROM_CHUNK = 32768;    // 32KB per chunk — well under the ~256KB limit
  var romReceive = null;    // { name, total, parts, received } while receiving

var STALL_TIMEOUT = 3000;
  var lastStep = 0;

  // ICE candidates received before the remote description is set must be
  // buffered and flushed afterwards, otherwise addIceCandidate() throws
  // InvalidStateError and the connection can never establish. This matters
  // on real networks where candidates can arrive before the SDP offer/answer.
var pendingIce = [];
  var iceFailTimer = null;
  // ICE candidate diagnostics for the debug panel. Tracking the candidate
  // types (host / srflx / relay) and how many were exchanged on each side
  // reveals whether a NAT/firewall is blocking P2P (no relay candidate) or
  // whether the TURN relay itself is unreachable (no relay candidates at all).
  var localCandidates = [];   // { type, proto } as gathered by onicecandidate
  var remoteCandidates = [];  // { type, proto } as received via signaling

  // ---- Debug window instrumentation ----
  // A timestamped, auto-trimmed event ring buffer describing every step of the
  // netplay handshake (socket, ICE, data channels, ROM transfer, ready). The
  // app surfaces this in a debug panel inside the netplay modal so a stubborn
  // "sync ROM" freeze can be traced to the exact stage that never completes.
  var DEBUG_LOG_MAX = 400;
  var debugLog = [];
  var debugSeq = 0;

  function dbg(msg) {
    var entry = {
      seq: debugSeq++,
      t: Date.now(),
      ms: (Date.now() - (debugLastT || Date.now())),
      msg: String(msg)
    };
    debugLastT = entry.t;
    debugLog.push(entry);
    if (debugLog.length > DEBUG_LOG_MAX) debugLog.splice(0, debugLog.length - DEBUG_LOG_MAX);
    if (GG.onDebug) {
      try { GG.onDebug(entry); } catch (e) { /* ignore */ }
    }
  }
  var debugLastT = 0;

  // Snapshot of everything the debug panel needs to show the live state.
  function debugInfo() {
    function chState(ch) {
      if (!ch) return 'none';
      return ch.readyState;
    }
    return {
      role: role,
      state: state,
      active: active,
      romReady: romReady,
      player: player,
      room: room,
      frame: frame,
      nextFrame: nextFrame,
      inputDelay: INPUT_DELAY,
      peerInputs: Object.keys(peerInputs).length,
      localInputs: Object.keys(localInputs).length,
      latestPeer: latestPeer ? { p1: latestPeer.p1, p2: latestPeer.p2 } : null,
      renderPeer: renderPeer ? { p1: renderPeer.p1, p2: renderPeer.p2 } : null,
      lastStepAge: lastStep ? (Date.now() - lastStep) : null,
      socketConnected: !!(socket && socket.connected),
      pcState: pc ? pc.connectionState : 'none',
      iceState: pc ? pc.iceConnectionState : 'none',
      dcReliable: chState(dcReliable),
      dcInput: chState(dcInput),
pendingIce: pendingIce.length,
      romBytes: (role === 'host' && cfg.host && cfg.host.romBytes) ? cfg.host.romBytes.length : null,
      hasNes: !!(role === 'host' && cfg.host && cfg.host.nes) || !!(role === 'guest' && cfg.guest && cfg.guest.nes),
      localHost: countType(localCandidates, 'host'),
      localSrflx: countType(localCandidates, 'srflx'),
      localRelay: countType(localCandidates, 'relay'),
      remoteHost: countType(remoteCandidates, 'host'),
      remoteSrflx: countType(remoteCandidates, 'srflx'),
      remoteRelay: countType(remoteCandidates, 'relay')
    };
  }

  // Count candidates of a given type in a candidate array (for the debug panel).
  function countType(arr, type) {
    var n = 0;
    for (var i = 0; i < arr.length; i++) if (arr[i].type === type) n++;
    return n;
  }

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
      dbg('socket connected to ' + url);
      if (onReady) onReady();
    });
    socket.on('connect_error', function () {
      dbg('socket connect_error');
      if (state === 'connecting' || state === 'error') {
        setState('error');
        toast('Signaling server unreachable', 'error');
      }
    });
    socket.on('signal', function (msg) {
      dbg('socket signal recv: ' + (msg && msg.data && msg.data.sdp ? 'sdp' : (msg && msg.data && msg.data.candidate ? 'ice' : '?')));
      handleSignal(msg);
    });
    socket.on('peer-joined', function () {
      dbg('socket peer-joined (role=' + role + ')');
      // Host: guest is here → start the WebRTC offer.
      if (role === 'host') startHostPeer();
    });
    socket.on('peer-left', function () {
      dbg('socket peer-left');
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

function flushPendingIce() {
    var queued = pendingIce;
    pendingIce = [];
    for (var i = 0; i < queued.length; i++) {
      addIceCandidate(queued[i]);
    }
  }

function addIceCandidate(candidate) {
    if (!pc) return;
    // If the remote description hasn't been set yet, addIceCandidate() throws
    // InvalidStateError. Buffer it and flush after the description is applied.
    if (!pc.remoteDescription) {
      pendingIce.push(candidate);
      dbg('ice buffered (no remote desc yet; pending=' + pendingIce.length + ')');
      return;
    }
try {
      var ct = candidateType(candidate);
      remoteCandidates.push(ct);
      dbg('remote ice candidate: ' + ct.type + '/' + ct.proto + ' addr=' + ct.address + ':' + ct.port);
      pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(function (e) {
        console.warn('[nesplayer] ICE candidate rejected:', e);
        dbg('ice candidate rejected: ' + (e && e.message));
      });
    } catch (e) {
      console.warn('[nesplayer] ICE candidate error:', e);
      dbg('ice candidate error: ' + (e && e.message));
    }
  }

  function handleSdp(from, data) {
    if (!pc) return;
    var desc = new RTCSessionDescription(data.sdp);
    dbg('sdp recv: ' + desc.type + ' (len=' + String(data.sdp && data.sdp.sdp ? data.sdp.sdp.length : 0) + ')');
    pc.setRemoteDescription(desc).then(function () {
      if (desc.type === 'offer') {
        return pc.createAnswer().then(function (ans) {
          return pc.setLocalDescription(ans);
        }).then(function () {
          dbg('sdp answer sent');
          if (socket && socket.connected) socket.emit('signal', { sdp: pc.localDescription });
        });
      }
    }).then(function () {
      // Remote description is now set (offer or answer) — apply any ICE
      // candidates that arrived before it.
      flushPendingIce();
    }).catch(function (e) {
      console.error('[nesplayer] SDP error:', e);
      dbg('sdp error: ' + (e && e.message));
      setState('error');
      toast('WebRTC negotiation failed', 'error');
    });
  }

function handleIce(from, candidate) {
    if (!pc) return;
    addIceCandidate(candidate);
  }

// Classify a candidate by its type ('host' | 'srflx' | 'prflx' | 'relay'),
  // transport protocol, address and port for the debug panel.
  //
  // NOTE: When an RTCIceCandidate is sent THROUGH signaling (socket.io), it is
  // JSON-serialized, which only keeps its OWN enumerable properties
  // (candidate, sdpMid, sdpMLineIndex). The type/protocol/address/port are
  // GETTERS on the prototype, so they are lost in transit — the peer sees
  // "unknown/? addr=?:undefined". Those values are still present inside the SDP
  // candidate string (e.g. "candidate:842163049 1 udp 2122260223 1.2.3.4 51234
  // typ host"), so we PARSE the string to recover the real diagnostics.
  function candidateType(cand) {
    var type = cand && cand.type;
    var proto = cand && cand.protocol;
    var address = cand && (cand.address || cand.ip);
    var port = cand && cand.port;
    var s = cand && cand.candidate;
    if (s) {
      var parts = String(s).split(' ');
      // SDP candidate layout (space-separated):
      //   candidate:foundation component protocol priority address port typ type [...]
      //   parts[0]=candidate:... parts[1]=foundation parts[2]=component
      //   parts[3]=protocol parts[4]=priority parts[5]=address parts[6]=port
      //   parts[7]="typ" parts[8]=type
      if (parts.length >= 9) {
        proto = parts[3] || proto;
        address = parts[5] || address;
        port = parts[6] || port;
        type = parts[8] || type;
      }
    }
    return {
      type: type || 'unknown',
      proto: proto || '?',
      address: address || '?',
      port: (port !== undefined && port !== null && port !== '') ? port : '?'
    };
  }

  // ---- WebRTC peer connection ----

function initPeer(offerer) {
    var cfgRTC = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        // TURN relay so the peer can connect even when both sides are behind
        // symmetric NATs / strict firewalls where STUN alone cannot establish
        // a direct P2P path. Free/open relay is fine for validating the fix;
        // for production use a self-hosted coturn or a paid TURN provider.
        { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
        { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
        { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
      ]
    };
pc = new RTCPeerConnection(cfgRTC);
    dbg('RTCPeerConnection created (offerer=' + offerer + ')');

pc.onicecandidate = function (e) {
      if (e.candidate) {
var ct = candidateType(e.candidate);
        localCandidates.push(ct);
        dbg('local ice candidate: ' + ct.type + '/' + ct.proto + ' addr=' + ct.address + ':' + ct.port);
        if (socket && socket.connected) {
          socket.emit('signal', { candidate: e.candidate });
        }
      }
    };
pc.oniceconnectionstatechange = function () {
      if (!pc) return;
      var st = pc.iceConnectionState;
      dbg('ice state: ' + st);
      if (st === 'connected' || st === 'completed') {
        // ICE succeeded — clear any pending failure timer.
        iceFailTimer = null;
        return;
      }
      if (st === 'disconnected' || st === 'checking') {
        // 'disconnected' is TRANSIENT and recoverable — it commonly flickers
        // during real-network negotiation (especially over a TURN relay with
        // higher latency) before reaching 'connected'. Do NOT tear down here;
        // that would kill the connection right as it establishes.
        return;
      }
      if (st === 'failed') {
        // Definitive failure. Give the connection one ICE-restart attempt and
        // a short grace window before declaring the session lost.
        if (!iceFailTimer) {
          iceFailTimer = setTimeout(function () {
            iceFailTimer = null;
            endSession('Peer connection lost', true);
          }, 8000);
          try {
            // Ask the browser to restart ICE with fresh candidates rather than
            // giving up immediately — helps when a candidate pair was rejected.
            if (pc && typeof pc.restartIce === 'function') pc.restartIce();
          } catch (e) { /* ignore */ }
        }
        return;
      }
      // 'closed' / other terminal states: tear down.
      if (st === 'closed') {
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
      dbg('data channels created (reliable + input)');
      wireChannels();
    } else {
      // Guest waits for the host's channels.
      pc.ondatachannel = function (e) {
        dbg('ondatachannel: ' + e.channel.label);
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
      dbg('reliable channel open');
      // Both channels must be open before starting gameplay exchange.
      maybePeerReady();
    };
    dcReliable.onclose = function () {
      dbg('reliable channel closed');
    };
    dcReliable.onerror = function (e) {
      dbg('reliable channel error');
    };
    dcReliable.onmessage = function (e) {
      handleReliableMessage(e.data);
    };
  }

// Re-send every buffered local input frame still in the live window. On a
  // real network the reliable channel (ROM) can open BEFORE the unordered input
  // channel, so becomeReady()'s seed inputs (frames 0..INPUT_DELAY) may have
  // been sent while dcInput was still closed and silently dropped. Re-sending
  // them here, the moment the input channel opens, guarantees the peer has the
  // full initial window — otherwise the host stalls waiting for the guest's
  // frame 0 and times out with "Netplay stalled".
  function resendPendingInputs() {
    if (!dcInput || dcInput.readyState !== 'open') return;
    for (var n in localInputs) {
      sendFrameInput(Number(n));
    }
  }

function wireInput() {
    if (!dcInput) return;
    dcInput.onopen = function () {
      dbg('input channel open');
      maybePeerReady();
      // Recover any seed inputs dropped before this channel opened.
      if (romReady) resendPendingInputs();
    };
    dcInput.onclose = function () {
      dbg('input channel closed');
    };
    dcInput.onerror = function (e) {
      dbg('input channel error');
    };
    dcInput.onmessage = function (e) {
      handleInputBinary(e.data);
    };
  }

function handleReliableMessage(raw) {
    var msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    // ---- ROM transfer (chunked) ----
    // The host splits the ROM into small reliable chunks. We accumulate them
    // and only boot the guest once EVERY chunk has arrived (see the notes in
    // maybePeerReady about the RTCDataChannel max-message-size that silently
    // dropped a single oversized ROM message).
    if (msg.type === 'rom-chunk') {
      if (role === 'guest' && cfg.guest && cfg.guest.loadRom) {
        // Start a fresh assembly buffer for this transfer.
        if (!romReceive || romReceive.total !== msg.total ||
            romReceive.parts !== msg.parts || romReceive.name !== msg.name) {
          romReceive = {
            name: msg.name,
            total: msg.total,
            parts: msg.parts,
            received: 0,
            chunks: {}
          };
        }
        if (romReceive.chunks[msg.index] === undefined) {
          romReceive.chunks[msg.index] = msg.data;
          romReceive.received++;
        }
        dbg('rom chunk ' + (romReceive.received) + '/' + romReceive.parts);
        // All chunks present → join them in order and boot the guest.
        if (romReceive.received === romReceive.parts) {
          var partsArr = [];
          for (var i = 0; i < romReceive.parts; i++) {
            if (romReceive.chunks[i] === undefined) {
              romReceive = null;
              setState('error');
              toast('ROM transfer incomplete', 'error');
              return;
            }
            partsArr.push(romReceive.chunks[i]);
          }
          var fullRom = partsArr.join('');
          romReceive = null;
try {
            cfg.guest.loadRom(fullRom, msg.name);
            sendReliable({ type: 'ready' });
            dbg('ready sent after loading ROM (' + fullRom.length + ' bytes)');
            setState('syncing');
            // The guest now WAITS for the host's 'probe-done' (which carries
            // the agreed INPUT_DELAY) before calling becomeReady(). The host
            // runs the pre-match RTT latency probe after it receives our
            // 'ready', then ships 'probe-done' so BOTH sides start playing
            // with the identical delay window. (Older code self-bootstrapped
            // into playing here, but that started lockstep before the host and
            // left the guest stuck at ~50 FPS because its INPUT_DELAY never
            // matched the host's.)
          } catch (e) {
            dbg('ROM load failed: ' + (e && e.message));
            setState('error');
            toast('ROM load failed: ' + e.message, 'error');
          }
        }
      }
      return;
    }

if (msg.type === 'ready') {
      dbg('ready received');
      if (role === 'host') {
        // Host has both sides' ROM. Acknowledge the guest's ready, then run the
        // pre-match RTT latency probe so the two sides agree on an INPUT_DELAY
        // before starting gameplay (this is what keeps FPS at 60 on a real
        // network — see finishLatencyProbe). The guest starts playing when it
        // receives 'probe-done'.
        sendReliable({ type: 'ready' });
        startLatencyProbe(true);
      } else {
        // Guest: don't becomeReady here — wait for the host's 'probe-done'
        // (which carries the agreed INPUT_DELAY) so both sides start with the
        // SAME delay window. The old code self-bootstrapped into playing here,
        // which started lockstep before the host, but the pre-match probe now
        // gates both sides on the same calibration.
      }
      return;
    } else if (msg.type === 'ping') {
      // Guest answers the host's ping so the host can measure the round-trip.
      sendReliable({ type: 'pong', seq: msg.seq });
      dbg('pong sent for ping seq=' + msg.seq);
      return;
    } else if (msg.type === 'pong') {
      // Host: one round-trip sample (the guest echoed our ping).
      if (role === 'host') handlePong(msg.seq);
      return;
    } else if (msg.type === 'probe-done') {
      // Guest adopts the host's measured delay so BOTH sides lockstep with the
      // identical INPUT_DELAY, then starts playing.
      var agreedDelay = (typeof msg.delay === 'number') ? msg.delay : INPUT_DELAY;
      finishLatencyProbe(agreedDelay);
      return;
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
    // Prune the buffer to the live window. measuredDelay is adaptive, so the
    // lookahead bound tracks the current render lag (not a hard-coded delay).
    var min = frame - 4, max = nextFrame + Math.max(measuredDelay, INPUT_DELAY) + 8;
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
var rom = cfg.host.romBytes;
        var romName = cfg.host.romName || 'game.nes';
        dbg('both channels open → sending ROM (' + rom.length + ' bytes, name=' + romName + ')');
        // Chunk the ROM into small reliable messages. A single oversized JSON
        // message can exceed the RTCDataChannel SCTP max-message-size (~256KB)
        // and be silently dropped, so the guest never completes the sync.
        var total = rom.length;
        var parts = Math.max(1, Math.ceil(total / ROM_CHUNK));
        for (var ci = 0; ci < parts; ci++) {
          var start = ci * ROM_CHUNK;
          var end = Math.min(start + ROM_CHUNK, total);
          sendReliable({
            type: 'rom-chunk',
            name: romName,
            total: total,
            index: ci,
            parts: parts,
            data: rom.slice(start, end)
          });
        }
        dbg('ROM sent in ' + parts + ' chunk(s) (' + total + ' bytes)');
      } else if (role === 'host') {
        dbg('both channels open but host has NO romBytes — cannot send ROM');
      } else if (role === 'guest') {
        dbg('both channels open (guest) — waiting for host rom');
      }
    }
  }

  function startHostPeer() {
    dbg('startHostPeer: creating offer');
    initPeer(true);
    pc.createOffer().then(function (offer) {
      return pc.setLocalDescription(offer);
    }).then(function () {
      dbg('offer sent');
      if (socket && socket.connected) socket.emit('signal', { sdp: pc.localDescription });
    }).catch(function (e) {
      console.error('[nesplayer] offer error:', e);
      dbg('offer error: ' + (e && e.message));
      setState('error');
    });
  }

  function becomeReady() {
    dbg('becomeReady() — transitioning to playing');
    romReady = true;
    frame = 0;
    // Start from the measured (adaptive) render delay; the lockstep loop will
    // keep tuning it from here based on live peer-input arrival.
    measuredDelay = INPUT_DELAY;
    delayMisses = 0;
    delaySamples = 0;
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

  // ---- Pre-match RTT latency probe (restores 60 FPS) ----
  // The in-play adaptive tuner (maybeTuneDelay) only grows the render delay
  // AFTER misses accumulate, and at ~50 FPS the miss rate (~17%) sits just
  // below the old 20% growth threshold, so it never adapts and the game stays
  // permanently stuck at 50 FPS. To fix this we calibrate the input delay UP
  // FRONT: after the ROM handshake the host pings the guest over the reliable
  // channel, measures one-way latency, and both sides agree on an INPUT_DELAY
  // that covers the live RTT so GG.step() never drops a frame in flight. The
  // in-play adapter then only corrects drift. See TODO.md.

  function sendPing() {
    var seq = ++pingSeq;
    pingSends[seq] = Date.now();
    sendReliable({ type: 'ping', seq: seq });
  }

  // One-way latency samples (ms) collected by the probe. Uses the 95th
  // percentile so occasional spikes don't force an over-large delay, plus one
  // frame of safety margin. Capped to [INPUT_DELAY_MIN, INPUT_DELAY_MAX].
  function computeAdaptiveDelay() {
    if (!rttSamples.length) return INPUT_DELAY_MIN;
    var sorted = rttSamples.slice().sort(function (a, b) { return a - b; });
    var p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
    var frames = Math.ceil(p95 / 16.67) + 1;
    return Math.max(INPUT_DELAY_MIN, Math.min(INPUT_DELAY_MAX, frames));
  }

  // Host sample: a guest 'pong' has arrived for a ping we sent.
  function handlePong(seq) {
    var t0 = pingSends[seq];
    if (t0) {
      var oneWay = (Date.now() - t0) / 2;
      rttSamples.push(oneWay);
      delete pingSends[seq];
    }
    // All pings answered (or the deadline passed) → finalize with our samples.
    var allDone = Object.keys(pingSends).length === 0;
    if (role === 'host' && (allDone || Date.now() > probeDeadline)) {
      finishLatencyProbe(null);
    }
  }

  // Kick off the pre-match probe. Only the host initiates (sends pings); the
  // guest participates by answering each ping. fromHost=false is kept for
  // symmetry / future use.
  function startLatencyProbe(fromHost) {
    calibrating = true;
    probeDone = false;
    rttSamples = [];
    pingSends = {};
    pingSeq = 0;
    probeDeadline = Date.now() + 1500;
    dbg('latency probe started (fromHost=' + !!fromHost + ')');
    if (fromHost) {
      for (var i = 0; i < 5; i++) sendPing();
      // Fallback so a lost pong never hangs the match: finalize with whatever
      // samples we have after a grace period.
      setTimeout(function () {
        if (role === 'host' && !probeDone) finishLatencyProbe(null);
      }, 2000);
    }
  }

  // Finalize the probe and start playing. delay is the peer-agreed INPUT_DELAY
  // (the guest receives it via 'probe-done'); when null the host computes it
  // from its own RTT samples and ships it to the guest so both match.
  function finishLatencyProbe(delay) {
    if (probeDone) return;
    probeDone = true;
    calibrating = false;
    if (typeof delay === 'number') {
      INPUT_DELAY = delay;
    } else {
      INPUT_DELAY = computeAdaptiveDelay();
      // Host computed the delay — tell the guest so both sides lockstep with
      // the IDENTICAL INPUT_DELAY (critical: becomeReady seeds 0..INPUT_DELAY).
      if (role === 'host' && dcReliable && dcReliable.readyState === 'open') {
        sendReliable({ type: 'probe-done', delay: INPUT_DELAY });
      }
    }
    dbg('latency probe done: INPUT_DELAY=' + INPUT_DELAY + ' frames');
    becomeReady();
    setState('playing');
    if (role === 'host' && cfg.host && cfg.host.onStart) cfg.host.onStart();
    if (role === 'guest' && cfg.guest && cfg.guest.onStart) cfg.guest.onStart();
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
          dbg('create-room failed: ' + (res && res.error));
          setState('error');
          toast(res && res.error ? res.error : 'Could not create room', 'error');
          return;
        }
        player = res.player;
        room = res.room;
        role = 'host';
        active = true;
        setState('waiting');
        dbg('room created: ' + room + ' (player ' + player + ')');
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
          dbg('join-room failed: ' + (res && res.error));
          setState('error');
          toast(res && res.error ? res.error : 'Could not join room', 'error');
          return;
        }
        player = res.player;
        room = res.room;
        role = 'guest';
        active = true;
        setState('waiting');
        dbg('joined room: ' + room + ' (player ' + player + ')');
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
pendingIce = [];
    iceFailTimer = null;
    romReceive = null;
    localCandidates = [];
    remoteCandidates = [];
    localInput = { p1: new Array(8).fill(0), p2: new Array(8).fill(0) };
    calibrating = false;
    probeDone = false;
    rttSamples = [];
    pingSends = {};
  }

function endSession(msg, notifyPeer) {
    dbg('endSession: ' + (msg || 'Netplay ended') + ' (notifyPeer=' + !!notifyPeer + ')');
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
    dbg('bailLockstep — resuming single-player (was holding for sync/input)');
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
      dbg('STALL_TIMEOUT hit — bailing to single-player');
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
    //    measuredDelay frames ahead. WAIT for it so both cores ADVANCE IN
    //    LOCKSTEP.
    //
    //    ADAPTIVE BUFFER: on a low-latency LAN the peer input is nearly always
    //    present (the fixed old delay of 2 frames suffices). Over the public
    //    internet—especially through a TURN relay—the one-way latency routinely
    //    exceeds 33ms, so a fixed 2-frame window means the render frame's peer
    //    input has NOT arrived yet and step() holds, dropping below 60 FPS and
    //    glitching audio. We therefore measure how often we miss and grow the
    //    render lag to cover the live RTT+jitter. When we go a long stretch
    //    without a miss, we steal a frame back to keep latency lower on links
    //    that improve. This keeps FPS locked at 60 while minimising lag.
    var renderFrame = nextFrame - measuredDelay;
    var peerIn = peerInputs[renderFrame];
    if (!peerIn) {
      delayMisses++;
      delaySamples++;
      // Peer's input for this frame hasn't arrived yet — HOLD (do not advance)
      // so we stay frame-locked. lastStep is intentionally NOT updated here,
      // so the stall timeout above still fires if the peer truly vanishes and
      // we degrade gracefully to single-player.
      maybeTuneDelay(false);
      return false;
    }
    // Input arrived in flight — register a clean sample and shrink the buffer
    // opportunistically when we've been comfy for a while.
    delaySamples++;
    maybeTuneDelay(true);
    renderPeer = peerIn;

    // 3) Advance counters.
    nextFrame++;
    frame = renderFrame;
    lastStep = Date.now();
    return true;
  };

// Periodically re-evaluate the render lag based on the peer-input miss rate.
  // If we've been missing inputs frequently (>10% over the window), the buffer
  // is too small for the live RTT/jitter — grow it. Growth is monotonic-safe:
  // we advance nextFrame by the same amount so renderFrame (=nextFrame -
  // measuredDelay) never moves backward and the emulator never re-computes an
  // already-rendered frame (which would desync the two cores). We deliberately
  // do NOT shrink the buffer: shrinking would make renderFrame leap forward and
  // skip a frame number, which also desyncs lockstep. Starting from a modest
  // INPUT_DELAY and only growing trades a little extra lag for guaranteed
  // determinism on any link.
  //
  // NOTE: the threshold was lowered from 20%->10% and the window from 60->30
  // frames. At ~50 FPS the miss rate (~17%) sat just below the old 20% gate,
  // so the tuner NEVER grew the delay and the game stayed permanently stuck at
  // 50 FPS. The pre-match RTT probe now nails the correct starting delay, but
  // this lower hysteresis lets the in-play adapter still correct drift quickly.
  var DELAY_WINDOW = 30;      // re-tune after this many sampled frames
  function maybeTuneDelay(clean) {
    if (delaySamples < DELAY_WINDOW) return;
    var missRate = delayMisses / delaySamples;
    if (missRate > 0.10 && measuredDelay < INPUT_DELAY_MAX) {
      measuredDelay++;
      // Advance the LIVE pointer so the RENDER pointer stays monotonic — the
      // peer input for the new, deeper render frame is already in flight.
      nextFrame++;
      localInputs[nextFrame] = {
        p1: maskToByte(localInput.p1),
        p2: maskToByte(localInput.p2)
      };
      sendFrameInput(nextFrame);
      dbg('adaptive delay: ' + measuredDelay + ' frames (miss=' + (missRate * 100).toFixed(0) + '%)');
    }
    delayMisses = 0;
    delaySamples = 0;
  }

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

  // Debug window accessors. The app polls getDebugInfo() while the debug panel
  // is open and appends getDebugLog() entries to the on-screen log.
  GG.getDebugInfo = function () { return debugInfo(); };
  GG.getDebugLog = function () {
    return debugLog.slice();
  };

  GG.disconnect = function () {
    dbg('disconnect() called');
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
