/* ============================================================
   NESPLAYER — Netplay Module (delay-based netcode)
   ------------------------------------------------------------
   Both players run an identical jsnes instance. The host loads
   the ROM and transmits the raw bytes to the guest so both
   bootstrap identically. Then each frame they exchange controller
   input over a WebSocket relay.

   Unlike strict lockstep, this uses DELAY-BASED netcode: we render
   INPUT_DELAY frames BEHIND the live input exchange. That way the
   peer's input for a frame is (almost) always already buffered by
   the time we need it, so the local frame rate is decoupled from
   the network round-trip. Both sides therefore run at a true 60 FPS
   as long as the round-trip is under INPUT_DELAY × frame time
   (~33 ms for a 2-frame delay). If a specific frame's peer input
   hasn't arrived yet (jitter), we briefly hold the most recent
   peer input, so the game never stalls and never drops below
   full speed.

   Public API (window.NESNetplay):
     init({ host: {nes, romBytes, onBootstrap, onStart, onStop},
            guest: {nes, loadRom, onNeedRom, onStart, onStop} })
     open()          // open the host/guest modal
     close()         // close the modal + disconnect
     createRoom()    // host: create a room, send ROM once guest joins
     joinRoom(code)  // guest: join a room
     setLocalInput(state)  // {p1:[8 bytes], p2:[8 bytes]} current frame
     step()          // returns true (a frame may be advanced) once ready
     applyRemote(nesObj)   // apply the peer's buffered/held input
     isActive()      // true while in a netplay session
     getRole()       // 'host' | 'guest' | null
     getState()      // connection status string
     disconnect()
   ============================================================ */
(function () {
  'use strict';

  var GG = window.NESNetplay || (window.NESNetplay = {});

  // 8 buttons mapped to jsnes Controller ids. app.js packs p1/p2 masks in its
  // NES_BUTTONS display order (UP,DOWN,LEFT,RIGHT,A,B,SEL,START); the wire
  // format is therefore [UP,DOWN,LEFT,RIGHT,A,B,SEL,START] with the jsnes
  // Controller ids here (UP=4,DOWN=5,LEFT=6,RIGHT=7,A=0,B=1,SEL=2,START=3).
  var BUTTON_ORDER = [4, 5, 6, 7, 0, 1, 2, 3]; // UP,DOWN,LEFT,RIGHT,A,B,SEL,START

  var cfg = {
    host: null,   // { nes, romBytes, onBootstrap, onStart, onStop }
    guest: null   // { nes, loadRom, onNeedRom, onStart, onStop }
  };

  var ws = null;
  var player = null;        // 1 | 2 | null
  var room = null;
  var role = null;          // 'host' | 'guest' | null
  var active = false;
  var state = 'idle';       // idle | connecting | waiting | syncing | playing | error | ended

  var romReady = false;     // both sides connected + have the ROM; lockstep may run
  var frame = 0;            // RENDER frame — the frame we are about to draw this tick
  var nextFrame = 0;        // LIVE frame — the next input we capture and send

  // Frames of input delay. The current render frame is always nextFrame -
  // INPUT_DELAY, so the peer's input for it has had time to arrive in flight.
  var INPUT_DELAY = 2;

  var localInput = { p1: new Array(8).fill(0), p2: new Array(8).fill(0) };
  var localInputs = {};     // live frame -> {p1:byte, p2:byte} (queued for peering)
  var peerInputs = {};      // live frame -> {p1:byte, p2:byte} (buffered peer input)
  var latestPeer = null;    // most recent peer input received (prediction fallback)
  var renderPeer = null;    // peer input bytes to apply on the current render frame

  // Stall guard (startup only). Once the handshake completes we begin sending
  // input on our first step(); if the peer never sends anything back we still
  // keep rendering at full speed by holding the previous peer input, so there
  // is no freeze. This timeout only guards a guest whose 'start' never fired.
  var STALL_TIMEOUT = 3000;
  var lastStep = 0;         // last time we ADVANCED a frame (ms)

  // ---- Emulator-core hardening ----
  // The vendored jsnes.min.js core calls `this.nes.stop()` when the CPU hits an
  // ILLEGAL 6502 opcode, but this build never defines a `stop()` method. That
  // makes frame() throw `TypeError: this.nes.stop is not a function`. Polyfill
  // stop() once so an illegal opcode sets the crash flag and halts gracefully.
  //
  // The minified frame() uses an outer infinite loop that never checks running,
  // so we also override frame() with a version that breaks out when stopped.
  (function polyfillJSNESStop() {
    try {
      var NESCLS = (window.jsnes && window.jsnes.NES) || null;
      if (NESCLS && NESCLS.prototype) {
        if (typeof NESCLS.prototype.stop === 'undefined') {
          NESCLS.prototype.stop = function () {
            this.running = false;
            this.crashMessage = 'Game crashed: invalid opcode';
          };
        }
        if (typeof NESCLS.prototype.__frameSafe === 'undefined') {
          NESCLS.prototype.__frameSafe = true;
          var ORIG_FRAME = NESCLS.prototype.frame;
          NESCLS.prototype.frame = function () {
            if (this.running === false) return; // already stopped
            if (this.running === undefined) this.running = true;
            var ppu = this.ppu;
            ppu.startFrame();
            var t = 0, s = this.opts.emulateSound, i = this.cpu, e = ppu, h = this.papu;
            outer: for (;;) {
              if (this.running === false) break outer; // illegal opcode -> stop()
              for (0 === i.cyclesToHalt ? (t = i.emulate(), s && h.clockFrameCounter(t), t *= 3) : i.cyclesToHalt > 8 ? (t = 24, s && h.clockFrameCounter(8), i.cyclesToHalt -= 8) : (t = 3 * i.cyclesToHalt, s && h.clockFrameCounter(i.cyclesToHalt), i.cyclesToHalt = 0); t > 0; t--) {
                if (e.curX === e.spr0HitX && 1 === e.f_spVisibility && e.scanline - 21 === e.spr0HitY && e.setStatusFlag(e.STATUS_SPRITE0HIT, !0), e.requestEndFrame && 0 === --e.nmiCounter) { e.requestEndFrame = !1; e.startVBlank(); break outer; }
                e.curX++; 341 === e.curX && (e.curX = 0, e.endScanline());
              }
            }
            this.fpsFrameCount++;
          };
          NESCLS.prototype.frameSafe = ORIG_FRAME;
        }
      }
    } catch (e) { /* ignore — patching is best-effort */ }
  })();

  // ---- helpers ----
  function setState(s) {
    state = s;
    if (GG.onStateChange) GG.onStateChange(s);
  }

  function toast(msg, type) {
    if (GG.onToast) GG.onToast(msg, type);
  }

  function send(obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  // Turn a controller mask array into a small number for compact transport.
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

  // Publish our input for the given live frame to the peer.
  function sendFrameInput(n) {
    var inp = localInputs[n];
    if (!inp) return;
    send({
      type: 'p2p',
      data: {
        type: 'input',
        frame: n,
        p1: inp.p1,
        p2: inp.p2
      }
    });
  }

  // ---- WebSocket lifecycle ----
  var connectTimer = null;

  function connect(url, onOpen) {
    if (ws) { try { ws.close(); } catch (e) {} }
    if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
    setState('connecting');
    try {
      ws = new WebSocket(url);
    } catch (e) {
      setState('error');
      toast('WebSocket error: ' + e.message, 'error');
      return;
    }
    ws.onopen = function () {
      if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
      if (onOpen) onOpen();
    };
    ws.onmessage = function (e) { handleWSEvent(e.data); };
    ws.onclose = function () {
      if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
      if (active) {
        setState('ended');
        toast('Connection closed', 'error');
        if (role === 'host' && cfg.host && cfg.host.onStop) cfg.host.onStop();
        if (role === 'guest' && cfg.guest && cfg.guest.onStop) cfg.guest.onStop();
      } else if (state === 'connecting') {
        setState('error');
        toast('Could not connect to the netplay server', 'error');
      }
      resetState();
    };
    ws.onerror = function () {
      if (state === 'connecting' || state === 'error') {
        setState('error');
        toast('Netplay server unreachable', 'error');
      }
    };
    connectTimer = setTimeout(function () {
      try { if (ws && ws.readyState < 2) ws.close(); } catch (e) {}
      if (state === 'connecting') {
        setState('error');
        toast('Connection timed out — is the server running?', 'error');
      }
    }, 5000);
  }

  function handleWSEvent(raw) {
    var msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (msg.type === 'created') {
      player = msg.player;
      room = msg.room;
      role = 'host';
      active = true;
      setState('waiting');
      if (GG.onRoomCreated) GG.onRoomCreated(room);
      return;
    }
    if (msg.type === 'joined') {
      player = msg.player;
      room = msg.room;
      role = 'guest';
      active = true;
      setState('waiting');
      if (GG.onJoined) GG.onJoined(room);
      return;
    }
    if (msg.type === 'error') {
      setState('error');
      toast(msg.message || 'Server error', 'error');
      return;
    }
    if (msg.type === 'peer') {
      handlePeer(msg.data);
    }
  }

  function handlePeer(data) {
    if (!data) return;
    if (data.type === 'guest-joined' && role === 'host') {
      // Host sends the ROM now so the guest can bootstrap identically, but
      // does NOT start playing yet — it waits for the guest's 'ready' ack so
      // both sockets are connected and both have the ROM.
      setState('syncing');
      // Re-boot the host's emulator to the SAME fresh state the guest will
      // boot into (reloadROM re-parses the ROM with default mapper banks,
      // which matches a fresh loadROM() exactly). Fall back to reset().
      try {
        var hostNes = cfg.host && cfg.host.nes;
        if (hostNes) {
          if (typeof hostNes.reloadROM === 'function') hostNes.reloadROM();
          else if (typeof hostNes.reset === 'function') hostNes.reset();
          hostNes.running = true;
        }
      } catch (e) { /* ignore reset errors */ }
      if (cfg.host && cfg.host.romBytes) {
        send({
          type: 'p2p',
          data: {
            type: 'rom',
            name: cfg.host.romName || 'game.nes',
            bytes: cfg.host.romBytes
          }
        });
      } else {
        send({ type: 'p2p', data: { type: 'ready' } });
      }
      return;
    }
    if (data.type === 'rom' && role === 'guest') {
      // Guest receives the ROM bytes and boots the same state, then ACKS the
      // host but stays in 'syncing' until the host's ack-back so both sides
      // begin the lockstep at the same frame.
      if (cfg.guest && cfg.guest.loadRom) {
        try {
          cfg.guest.loadRom(data.bytes, data.name);
          send({ type: 'p2p', data: { type: 'ready' } });
          setState('syncing');
        } catch (e) {
          setState('error');
          toast('ROM load failed: ' + e.message, 'error');
        }
      }
      return;
    }
    if (data.type === 'ready' && role === 'host') {
      send({ type: 'p2p', data: { type: 'ready' } });
      becomeReady();
      setState('playing');
      if (cfg.host && cfg.host.onStart) cfg.host.onStart();
      return;
    }
    if (data.type === 'ready' && role === 'guest') {
      becomeReady();
      setState('playing');
      if (cfg.guest && cfg.guest.onStart) cfg.guest.onStart();
      return;
    }
    if (data.type === 'input') {
      onPeerInput(data);
      return;
    }
    if (data.type === 'peer-left') {
      setState('ended');
      toast('Player disconnected', 'error');
      if (role === 'host' && cfg.host && cfg.host.onStop) cfg.host.onStop();
      if (role === 'guest' && cfg.guest && cfg.guest.onStop) cfg.guest.onStop();
      resumeLocalEmulator();
      resetState();
    }
  }

  // Buffer a peer input frame by its live frame number. Keep the most recently
  // received one as the prediction fallback.
  function onPeerInput(data) {
    if (data.frame === undefined) return;
    peerInputs[data.frame] = { p1: data.p1 >>> 0, p2: data.p2 >>> 0 };
    latestPeer = peerInputs[data.frame];
    // Prune old buffered frames (we render with a bounded delay, so frames far
    // behind or far ahead are no longer needed).
    var min = frame - 4, max = nextFrame + INPUT_DELAY + 8;
    for (var k in peerInputs) {
      var n = Number(k);
      if (n < min || n > max) delete peerInputs[k];
    }
  }

  // Transition into the "playing" state once both sides are connected and
  // have the ROM. Called by both host (on guest 'ready') and guest (on host
  // ack-back). Seeds the render/live counters so the delay model starts clean.
  function becomeReady() {
    romReady = true;
    frame = 0;
    nextFrame = INPUT_DELAY;
    localInputs = {};
    peerInputs = {};
    latestPeer = null;
    renderPeer = null;
    lastStep = Date.now();
    // Seed our own buffered inputs for the delay window (all-zero start), so
    // the first frames can render immediately without waiting on the network.
    for (var i = 0; i <= nextFrame; i++) {
      localInputs[i] = { p1: 0, p2: 0 };
    }
  }

  // ---- Public API ----
  GG.init = function (c) {
    cfg.host = c.host || null;
    cfg.guest = c.guest || null;
  };

  GG.open = function () {
    if (GG.onOpen) GG.onOpen();
  };

  GG.close = function () {
    GG.disconnect();
    if (GG.onClose) GG.onClose();
  };

  function defaultServerUrl() {
    if (typeof location !== 'undefined' && location && location.protocol) {
      var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      var host = location.host || 'localhost:3000';
      return proto + '//' + host;
    }
    return 'ws://localhost:3000';
  }

  GG.createRoom = function (url) {
    var wsUrl = url || GG.defaultUrl || defaultServerUrl();
    if (!wsUrl) { setState('error'); toast('No server URL configured', 'error'); return; }
    connect(wsUrl, function () { send({ type: 'create' }); });
  };

  GG.joinRoom = function (code, url) {
    var wsUrl = url || GG.defaultUrl || defaultServerUrl();
    if (!wsUrl) { setState('error'); toast('No server URL configured', 'error'); return; }
    connect(wsUrl, function () { send({ type: 'join', room: code }); });
  };

  // Called each frame by app.js with the desired local button states.
  GG.setLocalInput = function (state) {
    localInput.p1 = state.p1 || new Array(8).fill(0);
    localInput.p2 = state.p2 || new Array(8).fill(0);
  };

  function resumeLocalEmulator() {
    var localNes = null;
    if (role === 'host' && cfg.host && cfg.host.nes) localNes = cfg.host.nes;
    else if (role === 'guest' && cfg.guest && cfg.guest.nes) localNes = cfg.guest.nes;
    if (localNes) {
      try { localNes.running = true; } catch (e) { /* ignore */ }
    }
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

  // Bail out of the netplay session without closing the socket. The local
  // emulator resumes single-player (GG.step() returns false because romReady
  // is false), so it never freezes, while the WebSocket stays open so the peer
  // won't spuriously see "Player disconnected" from a teardown we caused.
  function bailLockstep() {
    romReady = false;
    resumeLocalEmulator();
    setState('idle');
  }

  // Called every emulated frame by app.js once netplay is ready. Returns true
  // (a frame may advance) unconditionally — delay-based netcode never gates
  // the local emulator on the network, so both sides get a full 60 FPS. It
  // captures this frame's input, publishes it, advances the live frame counter,
  // and selects the peer's buffered input for the render frame to apply.
  GG.step = function () {
    if (!active || !romReady) return false;

    // Stall guard: if the ready handshake happened but we somehow never
    // advance (should not happen in delay mode), bail to single-player.
    if (Date.now() - lastStep > STALL_TIMEOUT) {
      toast('Netplay stalled — resuming single-player', 'error');
      bailLockstep();
      return true;
    }

    // 1) Capture our input for the current LIVE frame and publish it.
    localInputs[nextFrame] = {
      p1: maskToByte(localInput.p1),
      p2: maskToByte(localInput.p2)
    };
    sendFrameInput(nextFrame);

// 2) Pick the peer's input for the frame we are ABOUT to render.
    var renderFrame = nextFrame - INPUT_DELAY;
    var peer = peerInputs[renderFrame];
    if (!peer) peer = latestPeer; // prediction fallback (holds last known input)
    renderPeer = peer || { p1: 0, p2: 0 };

    // 3) Advance live frame counter.
    nextFrame++;

    // 4) Advance render frame counter (now points at the frame we applied).
    //    Keep renderPeer cached until applyRemote() runs (before nes.frame()).
    frame = renderFrame;

    lastStep = Date.now();
    return true;
  };

  // Apply the peer's selected input to the emulator's OTHER controller. Called
  // by app.js after GG.step() and before nes.frame() for the render frame.
  GG.applyRemote = function (nesObj) {
    if (!active || !romReady || !renderPeer) return;
    var arr = player === 1 ? renderPeer.p2 : renderPeer.p1;
    for (var i = 0; i < 8; i++) {
      var btn = BUTTON_ORDER[i];
      var target = player === 1 ? 2 : 1;
      if (arr & (1 << i)) nesObj.buttonDown(target, btn);
      else nesObj.buttonUp(target, btn);
    }
  };

  GG.applyLocal = function (nesObj, p1mask, p2mask) {
    for (var i = 0; i < 8; i++) {
      var btn = BUTTON_ORDER[i];
      if (p1mask[i]) nesObj.buttonDown(1, btn); else nesObj.buttonUp(1, btn);
      if (p2mask[i]) nesObj.buttonDown(2, btn); else nesObj.buttonUp(2, btn);
    }
  };

  GG.isActive = function () { return active; };
  // True only once both sockets are connected AND both sides have the ROM.
  GG.isReady = function () { return active && romReady; };
  GG.getRole = function () { return role; };
  GG.getState = function () { return state; };
  GG.getFrame = function () { return frame; };

  GG.disconnect = function () {
    if (ws) { try { send({ type: 'leave' }); } catch (e) {} try { ws.close(); } catch (e) {} }
    resumeLocalEmulator();
    ws = null;
    resetState();
    setState('idle');
  };

})();

