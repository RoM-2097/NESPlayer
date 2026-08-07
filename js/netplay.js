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
  // INPUT_DELAY is ADAPTIVE: before the match the host pings the guest to
  // measure the round-trip time and picks a delay that covers the cloud
  // latency, so both sides sustain a full 60 FPS instead of dropping frames
  // while the peer's input is still in flight (the old fixed 2-frame delay
  // starved to ~25 FPS on hosts like Render's free tier where RTT > 33 ms).
var INPUT_DELAY = 3;
  var MIN_INPUT_DELAY = 3;
  var MAX_INPUT_DELAY = 12;   // cap ≈ 200 ms so it never feels too laggy
  // Extra headroom (ms) added above the WORST-CASE one-way latency when
  // choosing the adaptive delay, plus one extra frame in computeAdaptiveDelay.
  // This guarantees the peer's input for a render frame is always buffered, so
  // GG.step() never returns false and the game stays at a full 60 FPS even on
  // a jittery cloud connection.
  var SAFETY_MARGIN_MS = 33;  // 2 frames
  // Round-trip measurement for the adaptive delay.
  var rttSamples = [];
  var pingSends = {};
  var pingSeq = 0;
  var syncPingDone = false;
  var probeDeadline = 0;

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

  // ---- Adaptive input-delay calibration ----
  // Before the match starts (while in 'syncing'), the host pings the guest
  // several times. Each round-trip sample is (round-trip / 2) one-way, and the
  // chosen INPUT_DELAY = ceil(one-way / 16.67ms) + 1 guarantees the peer's
  // input for a render frame is already buffered, so GG.step() never returns
  // false due to in-flight latency and the game runs at a full 60 FPS.
  function sendPing() {
    var seq = ++pingSeq;
    pingSends[seq] = Date.now();
    send({ type: 'p2p', data: { type: 'ping', seq: seq } });
  }

function computeAdaptiveDelay() {
    if (!rttSamples.length) return MIN_INPUT_DELAY;
    // Use the WORST-CASE (max) one-way latency plus a 2-frame safety margin so
    // the peer's input for a render frame is ALWAYS already buffered. The old
    // p95 + no-margin estimate under-sized the window on jittery connections,
    // which made GG.step() return false and DROP frames (netplay dropped to
    // ~25 FPS). Dropped frames are catastrophic here: they both tank the frame
    // rate AND desync the two cores (one side skips a frame the other renders).
    var max = 0;
    for (var i = 0; i < rttSamples.length; i++) {
      if (rttSamples[i] > max) max = rttSamples[i];
    }
    var frames = Math.ceil((max + SAFETY_MARGIN_MS) / 16.67) + 1;
    var d = Math.max(MIN_INPUT_DELAY, Math.min(MAX_INPUT_DELAY, frames));
    return d;
  }

function finishLatencyProbe() {
    if (syncPingDone) return;
    syncPingDone = true;
    INPUT_DELAY = computeAdaptiveDelay();
    if (INPUT_DELAY > MIN_INPUT_DELAY) {
      toast('Netplay latency calibrated: ' + INPUT_DELAY + ' frames of input delay', 'success');
    }
    // Tell the guest the agreed delay so BOTH sides lockstep with the same
    // INPUT_DELAY (critical for becomeReady's seed window 0..INPUT_DELAY).
    send({ type: 'p2p', data: { type: 'probe-done', delay: INPUT_DELAY } });
    becomeReady();
    setState('playing');
    if (role === 'host' && cfg.host && cfg.host.onStart) cfg.host.onStart();
    if (role === 'guest' && cfg.guest && cfg.guest.onStart) cfg.guest.onStart();
  }

  // Kick off the RTT probe. The host starts it; the guest participates by
  // answering each ping (and running its own measurement).
  function startLatencyProbe(fromHost) {
    rttSamples = [];
    pingSends = {};
    pingSeq = 0;
    syncPingDone = false;
probeDeadline = Date.now() + 1500;
    if (fromHost) {
      // Host: send a burst of pings; each guest reply measures one RTT.
      for (var i = 0; i < 5; i++) sendPing();
      scheduleProbeTimeout();
    }
  }

// ---- WebSocket lifecycle ----
  var connectTimer = null;

// Normalize a server URL into a valid absolute WebSocket URL. Accepts
  // "ws://…"/"wss://…" as-is, converts "http(s)://" to ws(s), and prepends
  // "ws://" to a bare host:port (e.g. "localhost:3000"). Without this, a
  // malformed URL makes `new WebSocket()` throw "an invalid or illegal string
  // was specified".
  //
  // SECURITY (HTTPS deployment): when the page itself is served over HTTPS the
  // browser treats a plain `ws://` WebSocket as insecure mixed content and
  // BLOCKS the connection outright. So on an HTTPS page we always upgrade a
  // `ws://` (or bare host) URL to `wss://`. This is exactly the situation on
  // Render/Railway/Fly (and localhost over a TLS proxy), so netplay must use
  // the secure scheme or it will silently fail to connect.
  function pageIsHttps() {
    return typeof location !== 'undefined' && location && location.protocol === 'https:';
  }

  function normalizeWsUrl(url) {
    if (!url) return '';
    var u = String(url).trim();
    if (!u) return '';
    var httpsPage = pageIsHttps();
    if (u.indexOf('wss://') === 0) return u;                       // already secure
    if (u.indexOf('ws://') === 0) {
      // Upgrade to wss:// on an HTTPS page (mixed-content rule), else keep ws://.
      return httpsPage ? 'wss://' + u.slice(5) : u;
    }
    if (u.indexOf('http://') === 0) return 'ws://' + u.slice(7);
    if (u.indexOf('https://') === 0) return 'wss://' + u.slice(8);
    // Bare host:port — default to the same scheme the page uses.
    return httpsPage ? 'wss://' + u : 'ws://' + u;
  }

  function connect(url, onOpen) {
    url = normalizeWsUrl(url);
    if (!url) {
      setState('error');
      toast('Enter a valid server URL (e.g. ws://localhost:3000)', 'error');
      return;
    }
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
      // Host sends the ready-ack, then starts the RTT latency probe. The
      // chosen INPUT_DELAY is sent in probe-done so both sides agree on the
      // same delay window (critical for lockstep: becomeReady seeds frames
      // 0..INPUT_DELAY, so host and guest MUST use the identical value).
      send({ type: 'p2p', data: { type: 'ready' } });
      startLatencyProbe(true);
      return;
    }
    if (data.type === 'ready' && role === 'guest') {
      // Guest has the ROM and got the host's ready-ack; it now participates
      // in the probe (answers each ping). It does NOT start playing until it
      // receives probe-done with the agreed delay.
      startLatencyProbe(false);
      return;
    }
    if (data.type === 'ping') {
      // Guest answers the host's ping so the host can measure the round-trip.
      send({ type: 'p2p', data: { type: 'pong', seq: data.seq } });
      return;
    }
    if (data.type === 'pong' && role === 'host') {
      // Host: one round-trip sample. (round-trip / 2) is the one-way latency.
      var t0 = pingSends[data.seq];
      if (t0) {
        var oneWay = (Date.now() - t0) / 2;
        rttSamples.push(oneWay);
        delete pingSends[data.seq];
      }
      // Once all pings are answered (or the deadline passes), finalize.
      var allDone = Object.keys(pingSends).length === 0;
      if (allDone || Date.now() > probeDeadline) finishLatencyProbe();
      return;
    }
    if (data.type === 'probe-done') {
      // Guest adopts the host's measured delay so both sides lockstep with
      // the SAME INPUT_DELAY, then starts playing.
      if (typeof data.delay === 'number') INPUT_DELAY = data.delay;
      finishLatencyProbe();
      return;
    }
    if (data.type === 'input') {
      onPeerInput(data);
      return;
    }
if (data.type === 'chat') {
      if (GG.onChat) GG.onChat(data.from === 'me' ? 'me' : 'peer', data.text || '');
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
    // NOTE: do NOT clear peerInputs here. The peer's seed frames (0..INPUT_DELAY)
    // may already have arrived while we were still in 'syncing' — clearing them
    // would make us wait forever for input we already received. resetState()
    // cleared peerInputs at session start, so any frames present now are the
    // peer's legitimate initial inputs and must be preserved.
latestPeer = null;
    renderPeer = null;
    lastStep = Date.now();
    // Seed our own buffered inputs for the delay window (all-zero start) AND
    // TRANSMIT them immediately. GG.step() starts rendering at
    // renderFrame = nextFrame - INPUT_DELAY = 0, so the peer MUST have our
    // input for frames 0..INPUT_DELAY buffered — otherwise those frames would
    // never be sent (sendFrameInput only fires once nextFrame advances past
    // them) and both sides would stall at frame 0 forever.
    for (var i = 0; i <= nextFrame; i++) {
      localInputs[i] = { p1: 0, p2: 0 };
      sendFrameInput(i);
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

  // Send a chat message to the peer. Returns false if not connected.
  GG.sendChat = function (text) {
    if (!active || !ws || ws.readyState !== 1) return false;
    if (typeof text !== 'string' || !text.trim()) return false;
    send({ type: 'p2p', data: { type: 'chat', text: text.slice(0, 500) } });
    return true;
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
    // Reset adaptive-delay calibration state.
    rttSamples = [];
    pingSends = {};
    pingSeq = 0;
    syncPingDone = false;
    probeDeadline = 0;
  }

  // ---- Adaptive-delay probe timeout ----
  // If the guest never answers a ping (or a pong is lost), the host would
  // otherwise wait forever in 'syncing'. This fallback finalizes the probe
  // with whatever samples we have so the match always starts.
  function scheduleProbeTimeout() {
    setTimeout(function () {
      if (!syncPingDone && role === 'host') finishLatencyProbe();
    }, 2000);
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

    // 1) Capture our input for the current LIVE frame and publish it. Always
    //    send even when we're waiting, so the peer has our input buffered.
    localInputs[nextFrame] = {
      p1: maskToByte(localInput.p1),
      p2: maskToByte(localInput.p2)
    };
    sendFrameInput(nextFrame);

// 2) Pick the peer's input for the frame we are about to render. The
    //    adaptive INPUT_DELAY (worst-case one-way + 2-frame safety margin)
    //    makes this frame essentially always already buffered, so we can run
    //    at a full 60 FPS. If it is somehow still missing (a latency spike
    //    beyond the calibrated window), we HOLD the most recent peer input for
    //    this frame rather than returning false. Returning false would make
    //    app.js SKIP nes.frame() entirely — dropping the frame, which both
    //    tanks the FPS (the ~25 FPS the user saw) AND desyncs the two cores
    //    (one side renders a frame the other skips). Holding the last input
    //    keeps both sides rendering the exact same frame count, so lockstep is
    //    preserved and the game stays at 60 FPS. A true peer stall is caught
    //    by the STALL_TIMEOUT bail above.
    var renderFrame = nextFrame - INPUT_DELAY;
    var peer = peerInputs[renderFrame];
    if (!peer && latestPeer) {
      // Jitter fallback: reuse the most recent input we did receive. Since
      // both sides run the same delay model, they will both hold on the same
      // frame, so the cores stay in lockstep.
      peer = latestPeer;
    }
    if (!peer) {
      // No input at all yet (shouldn't happen after becomeReady seeds the
      // window) — use neutral (no buttons) so the frame still advances.
      peer = { p1: 0, p2: 0 };
    }
    renderPeer = peer;

    // 3) Advance live frame counter.
    nextFrame++;

// 4) Advance render frame counter (now points at the frame we applied).
    //    Keep renderPeer cached until applyRemote() runs (before nes.frame()).
    frame = renderFrame;

    lastStep = Date.now();
    return true;
  };

// Apply the inputs for the current RENDER frame to BOTH controllers:
  // our own DELAYED input (localInputs[frame]) to the local controller and
  // the peer's DELAYED input (renderPeer) to the opponent's controller.
  //
  // This is the fix for the "desync after a while" bug. Delay-based netcode
  // renders INPUT_DELAY frames behind the live exchange, so for frame N the
  // peer applies OUR input sampled for frame N. If we instead apply our
  // CURRENT (live frame N+INPUT_DELAY) input to our own controller, the two
  // cores execute different inputs for frame N and diverge permanently on the
  // first button press. Applying both inputs from the SAME delayed frame keeps
  // both sides byte-identical (controller 1 = host's frame-N input, controller
  // 2 = guest's frame-N input) — exactly what the determinism test validates.
  GG.applyFrame = function (nesObj) {
    if (!active || !romReady) return;
    var mine = localInputs[frame];
    var peer = renderPeer;
    // Our own input for this frame lives in the p1 slot (host) or p2 slot
    // (guest); the opponent's lives in the opposite slot of the peer frame.
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

  // Backwards-compatible alias for existing callers/tests.
  GG.applyRemote = GG.applyFrame;

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

