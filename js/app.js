/* ============================================================
   NOVA · NESPLAYER — Application Logic
   ============================================================ */
(function () {
  'use strict';

  /* ---------- Constants ---------- */
  var NES_CTRL = jsnes.Controller;

  var SAVE_PREFIX = 'nesplayer.state.';
  var RECENT_KEY = 'nesplayer.recent';
  var RECENT_MAX = 8;
  var VOLUME_KEY = 'nesplayer.volume';
  var BIND_KEY = 'nesplayer.bindings';

  // Rewind: snapshot cadence + ring-buffer sizing. Snapshots are stripped of
  // the per-frame PPU framebuffers and the ROM payload (re-injected on
  // restore), so each is ~0.6 MB. 48 snaps at 6 snaps/s ≈ 8 s of history.
  var REWIND_SAMPLE_EVERY = 10;   // capture one snapshot every 10 frames (~6/s)
  var REWIND_MAX_SNAPSHOTS = 48;  // ring depth ≈ 8 s of rewind history
  var REWIND_STEP_EVERY = 2;      // rewind speed: 1 snapshot per 2 emulated frames

  // The eight NES buttons we expose for remapping, in display order.
  var NES_BUTTONS = [
    { id: NES_CTRL.BUTTON_UP,     name: 'D-Pad Up' },
    { id: NES_CTRL.BUTTON_DOWN,   name: 'D-Pad Down' },
    { id: NES_CTRL.BUTTON_LEFT,   name: 'D-Pad Left' },
    { id: NES_CTRL.BUTTON_RIGHT,  name: 'D-Pad Right' },
    { id: NES_CTRL.BUTTON_A,      name: 'A (Jump)' },
    { id: NES_CTRL.BUTTON_B,      name: 'B (Duck / Fire)' },
    { id: NES_CTRL.BUTTON_SELECT, name: 'Select' },
    { id: NES_CTRL.BUTTON_START,  name: 'Start' }
  ];

  // Default bindings: two keyboard keys + one gamepad button per NES face.
  // Gamepad indices follow the standard HTML5 Gamepad button order
  // (0=A, 1=B, 8=Back/Select, 9=Start, 12-15=D-Pad).
  var DEFAULT_BINDINGS = {};
  DEFAULT_BINDINGS[NES_CTRL.BUTTON_UP]     = { key1: 'ArrowUp',    key2: 'KeyW', pad: 12 };
  DEFAULT_BINDINGS[NES_CTRL.BUTTON_DOWN]   = { key1: 'ArrowDown',  key2: 'KeyS', pad: 13 };
  DEFAULT_BINDINGS[NES_CTRL.BUTTON_LEFT]   = { key1: 'ArrowLeft',  key2: 'KeyA', pad: 14 };
  DEFAULT_BINDINGS[NES_CTRL.BUTTON_RIGHT]  = { key1: 'ArrowRight', key2: 'KeyD', pad: 15 };
  DEFAULT_BINDINGS[NES_CTRL.BUTTON_A]      = { key1: 'KeyX',       key2: '',    pad: 0 };
  DEFAULT_BINDINGS[NES_CTRL.BUTTON_B]      = { key1: 'KeyZ',       key2: '',    pad: 1 };
  DEFAULT_BINDINGS[NES_CTRL.BUTTON_SELECT] = { key1: 'ShiftLeft',  key2: 'ShiftRight', pad: 8 };
  DEFAULT_BINDINGS[NES_CTRL.BUTTON_START]  = { key1: 'Enter',      key2: 'NumpadEnter', pad: 9 };

  // Live bindings, reverse lookup maps, and binding-modal state.
  var bindings = {};
  var keyToNes = {};   // KeyboardEvent.code -> NES button id
  var padToNes = {};   // gamepad button index -> NES button id
  var modalOpen = false;
var debuggerOpen = false;  // debugger modal active state
  var debugWasPaused = false; // pause state before the debugger auto-paused
var cheatModalOpen = false;  // cheat modal active state
  var cheats = [];             // array of { addr, value, compare (or null), label }
  var cheatHookActive = false; // is the PRG-read cheat hook installed on nes.mmap.load?
  var originalMmapLoad = null; // original nes.mmap.load (restored when the hook is removed)
  var netplayModalOpen = false; // netplay modal active state
  var capturing = null;   // { nes, field, type } while waiting for a key/pad press
  var padCaptureActive = false;

  /* ---------- Elements ---------- */
  function $(id) { return document.getElementById(id); }
  var els = {
    landing: $('landing'),
    player: $('player'),
    dropzone: $('dropzone'),
    btnBrowse: $('btnBrowse'),
    btnBack: $('btnBack'),
    romInput: $('romInput'),
    screen: $('screen'),
    screenWrap: $('screenWrap'),
    screenOverlay: $('screenOverlay'),
    overlayIcon: $('overlayIcon'),
    overlayText: $('overlayText'),
    ledPower: $('ledPower'),
    ledPaused: $('ledPaused'),
    fpsDisplay: $('fpsDisplay'),
    padStatus: $('padStatus'),
    gameTitle: $('gameTitle'),
    gameMeta: $('gameMeta'),
    mFile: $('mFile'),
    mSize: $('mSize'),
    mMapper: $('mMapper'),
    mPrg: $('mPrg'),
    mChr: $('mChr'),
    mMirror: $('mMirror'),
    mBattery: $('mBattery'),
    btnPause: $('btnPause'),
    btnReset: $('btnReset'),
    btnRewind: $('btnRewind'),
    btnSound: $('btnSound'),
    soundIcon: $('soundIcon'),
    btnFilters: $('btnFilters'),
    filtersMenu: $('filtersMenu'),
    fScanlines: $('fScanlines'),
    fStatic: $('fStatic'),
    btnSave1: $('btnSave1'),
    btnLoad1: $('btnLoad1'),
    btnFullscreen: $('btnFullscreen'),
    btnExitFs: $('btnExitFs'),
    btnRatio43: $('btnRatio43'),
    btnRatio169: $('btnRatio169'),
btnDebug: $('btnDebug'),
    debugModal: $('debugModal'),
    btnCheats: $('btnCheats'),
    cheatModal: $('cheatModal'),
    cheatClose: $('cheatClose'),
    cheatInput: $('cheatInput'),
    cheatAdd: $('cheatAdd'),
    cheatHint: $('cheatHint'),
    cheatList: $('cheatList'),
    cheatClearAll: $('cheatClearAll'),
btnControls: $('btnControls'),
    btnNetplay: $('btnNetplay'),
    btnNetplayLanding: $('btnNetplayLanding'),
    netplayModal: $('netplayModal'),
    netplayClose: $('netplayClose'),
    netplayUrl: $('netplayUrl'),
    netplayCreate: $('netplayCreate'),
    netplayJoin: $('netplayJoin'),
    netplayRoomCode: $('netplayRoomCode'),
    netplayStatus: $('netplayStatus'),
    netplayRoomBox: $('netplayRoomBox'),
    netplayRoomCodeDisplay: $('netplayRoomCodeDisplay'),
    netplayDisconnect: $('netplayDisconnect'),
    netplayChat: $('netplayChat'),
    netplayChatInput: $('netplayChatInput'),
    netplayChatSend: $('netplayChatSend'),
    btnBind: $('btnBind'),
    btnRecord: $('btnRecord'),
    recordIcon: $('recordIcon'),
    recBadge: $('recBadge'),
    bindModal: $('bindModal'),
    btnCloseModal: $('btnCloseModal'),
    btnResetBindings: $('btnResetBindings'),
    bindHint: $('bindHint'),
    bindRows: $('bindRows'),
    volumeSlider: $('volumeSlider'),
    recentList: $('recentList'),
    btnClearRecent: $('btnClearRecent'),
    toasts: $('toasts'),
    // Live input HUD
    hudUp: $('hudUp'),
    hudDown: $('hudDown'),
    hudLeft: $('hudLeft'),
    hudRight: $('hudRight'),
    hudA: $('hudA'),
    hudB: $('hudB'),
    hudSelect: $('hudSelect'),
    hudStart: $('hudStart')
  };

  // NES button id -> HUD element (mirrors NES_BUTTONS).
  var HUD_MAP = {};
  HUD_MAP[NES_CTRL.BUTTON_UP]     = els.hudUp;
  HUD_MAP[NES_CTRL.BUTTON_DOWN]   = els.hudDown;
  HUD_MAP[NES_CTRL.BUTTON_LEFT]   = els.hudLeft;
  HUD_MAP[NES_CTRL.BUTTON_RIGHT]  = els.hudRight;
  HUD_MAP[NES_CTRL.BUTTON_A]      = els.hudA;
  HUD_MAP[NES_CTRL.BUTTON_B]      = els.hudB;
  HUD_MAP[NES_CTRL.BUTTON_SELECT] = els.hudSelect;
  HUD_MAP[NES_CTRL.BUTTON_START]  = els.hudStart;

  /* ---------- State ---------- */
  var nes = null;
  var screenCtx = els.screen.getContext('2d');
  var imageData = screenCtx.createImageData(256, 240);

  var romName = '';
  var romSize = 0;

  var running = false;
  var paused = false;
  var soundEnabled = true;
  var testPattern = false;   // when true, show RGB self-test bars instead of the game
  var fullscreen = false;    // screen-wrap overlay fullscreen state
  var ratio = '169';         // '43' = 4:3 (letterboxed), '169' = 16:9 (stretch fill)

  // Video filters: scanlines + static are CSS overlays, the color mode is a
  // pixel-level remap applied in blitScreen() (so it also reaches recordings).
  var scanlinesEnabled = false;
  var staticEnabled = false;
  var colorMode = 'normal';  // 'normal' | 'gb' | 'ega' | 'cga' | 'bw'
  var filterLUT = null;      // 32k-entry color lookup table (null when normal)
  var filtersOpen = false;   // filters dropdown visibility

  // Audio
  var audioCtx = null;
  var audioGain = null;
  var audioVolume = 0.8;
  var audioRing = new Float32Array(65536);
  var audioWrite = 0;
  var audioRead = 0;

// Input
  var keysHeld = {};       // KeyboardEvent.code -> true while a physical key is held
  var padHeld = {};        // NES button id -> true while a gamepad *button* is held
  var axisHeld = {};       // NES button id -> true while a gamepad *axis* (stick/hat) is held
  var inputPrev = {};      // NES button id -> last applied button state
  var padIndex = null;     // gamepad index
  var focused = true;      // browser window focus; gamepad input is only grabbed while focused

  // FPS (counts emulated frames so the HUD reflects true game speed, not the
  // monitor's raw rAF tick rate).
  var lastFpsTime = 0;
  var emuFrameCount = 0;

  // Recording
  var recorder = null;
  var recorderChunks = [];
  var recording = false;
  var streamDest = null;
  // Offscreen 4× capture canvas — the MediaRecorder stream source. Recording
  // from a 1024×960 nearest-neighbour canvas (instead of the raw 256×240
  // screen) keeps pixels crisp and allows a true 60 FPS video track.
  var CAPTURE_SCALE = 4;
  var captureCanvas = null;
  var captureCtx = null;
  // Recording telemetry: how many emulated frames were actually stamped onto
  // the capture canvas, when the recording started, and whether the finalizer
  // already ran (guards against double onstop).
  var capturedFrames = 0;
  var recordStartTime = 0;
  var recorderFinalized = false;

  // Rewind state. snaps is a ring buffer of serialized snapshots (oldest at
  // index 0). While rewind.active the game loop steps backwards through it.
  var rewind = {
    snaps: [],
    framesSinceSnap: 0,
    active: false,
    pos: -1,
    stepCount: 0,
    atStart: false   // set once when the buffer start is reached (toast guard)
  };
  // Sources currently holding the rewind trigger ('kb' | 'pad' | 'btn').
  var rewindHeld = {};

  /* ---------- Audio ---------- */
  function initAudio() {
    if (audioCtx) {
      if (audioCtx.state === 'suspended') audioCtx.resume();
      return;
    }
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) { console.warn('Web Audio not supported'); soundEnabled = false; return; }
      audioCtx = new AC({ latencyHint: 'interactive' });
      audioGain = audioCtx.createGain();
      audioGain.gain.value = audioVolume;
      var node = audioCtx.createScriptProcessor(2048, 0, 2);
      node.onaudioprocess = function (e) {
        var l = e.outputBuffer.getChannelData(0);
        var r = e.outputBuffer.getChannelData(1);
        var v = audioVolume;
        for (var i = 0; i < l.length; i++) {
          if (audioRead !== audioWrite) {
            l[i] = audioRing[audioRead] * v;
            audioRead = (audioRead + 1) % audioRing.length;
            r[i] = audioRing[audioRead] * v;
            audioRead = (audioRead + 1) % audioRing.length;
          } else {
            l[i] = 0; r[i] = 0;
          }
        }
      };
      node.connect(audioGain);
      audioGain.connect(audioCtx.destination);
    } catch (err) {
      console.warn('Audio init failed:', err);
      soundEnabled = false;
    }
  }

  function onAudioSample(l, r) {
    if (!audioCtx) return;
    // Drop audio while rewinding — the APU state being rendered is a restored
    // snapshot and its audio must not leak into the live output.
    if (rewind.active) return;
    audioRing[audioWrite] = l;
    audioWrite = (audioWrite + 1) % audioRing.length;
    audioRing[audioWrite] = r;
    audioWrite = (audioWrite + 1) % audioRing.length;
  }

  function applyVolume(v) {
    audioVolume = v;
    if (audioGain) audioGain.gain.value = v;
    try { localStorage.setItem(VOLUME_KEY, String(v)); } catch (e) {}
  }

  function setSoundEnabled(on) {
    soundEnabled = on;
    els.soundIcon.textContent = on ? '🔊' : '🔇';
    els.btnSound.classList.toggle('is-active', !on);
  }

  /* ---------- Rewind ---------- */
  // Serialize the current emulator state into the rewind ring. The three PPU
  // framebuffers (buffer/bgbuffer/pixrendered) are rebuilt each frame by the
  // core, and the ROM payload is re-injected on restore, so both are stripped
  // here to keep snapshots small.
  function captureRewindSnapshot() {
    if (!nes) return;
    var snap = nes.toJSON();
    delete snap.ppu.buffer;
    delete snap.ppu.bgbuffer;
    delete snap.ppu.pixrendered;
    delete snap.romData;
    rewind.snaps.push(JSON.stringify(snap));
    if (rewind.snaps.length > REWIND_MAX_SNAPSHOTS) rewind.snaps.shift();
  }

  // Restore a snapshot by index, re-injecting the ROM payload and re-creating
  // the PPU framebuffers the snapshot was stripped of, then render one frame
  // so the screen immediately shows the restored state.
  function restoreRewindSnapshot(i) {
    if (!nes || !rewind.snaps[i]) return;
    var snap;
    try { snap = JSON.parse(rewind.snaps[i]); }
    catch (err) { console.warn('[nesplayer] bad rewind snapshot', err); return; }
    snap.romData = nes.romData;
    nes.fromJSON(snap);
    ensurePPUBuffers();
    nes.frame();
  }

  function ensurePPUBuffers() {
    if (!nes.ppu.buffer) nes.ppu.buffer = new Array(61440);
    if (!nes.ppu.bgbuffer) nes.ppu.bgbuffer = new Array(61440);
    if (!nes.ppu.pixrendered) nes.ppu.pixrendered = new Array(61440);
  }

  // Track the sources holding the rewind trigger. Multiple sources (keyboard,
  // gamepad, toolbar button) can overlap, so rewind stays active until ALL of
  // them are released.
  function holdRewind(src) {
    if (!nes) return;   // rewind needs a loaded ROM
    rewindHeld[src] = true;
    syncRewindActive();
  }

  function releaseRewind(src) {
    delete rewindHeld[src];
    syncRewindActive();
  }

  function syncRewindActive() {
    var any = false;
    for (var k in rewindHeld) { if (rewindHeld[k]) { any = true; break; } }
    if (any && !rewind.active) {
      rewind.active = true;
      rewind.pos = rewind.snaps.length - 1;
      rewind.stepCount = 0;
      rewind.atStart = false;
      // Held gameplay buttons must not reach the emulator during rewind.
      releaseAllInput();
      els.btnRewind.classList.add('is-rewinding');
      toast('⟲ Rewinding…', 'success');
    } else if (!any && rewind.active) {
      rewind.active = false;
      // Drop snapshots captured while rewinding so play resumes from exactly
      // the frame we rewound to (the tail becomes the new "now").
      if (rewind.pos >= 0 && rewind.pos < rewind.snaps.length - 1) {
        rewind.snaps.length = rewind.pos + 1;
      }
      els.btnRewind.classList.remove('is-rewinding');
    }
  }

  // Step one snapshot further back every REWIND_STEP_EVERY emulated frames.
  function stepRewind() {
    rewind.stepCount++;
    if (rewind.stepCount < REWIND_STEP_EVERY) return;
    rewind.stepCount = 0;
    if (rewind.pos <= 0) {
      // Toast only once per hold instead of every other frame.
      if (!rewind.atStart) {
        rewind.atStart = true;
        toast('Start of rewind buffer', 'error');
      }
      return;
    }
    rewind.pos--;
    restoreRewindSnapshot(rewind.pos);
  }

  function maybeCaptureRewind() {
    rewind.framesSinceSnap++;
    if (rewind.framesSinceSnap < REWIND_SAMPLE_EVERY) return;
    rewind.framesSinceSnap = 0;
    captureRewindSnapshot();
  }

  // Clear the rewind history (used on ROM load and reset).
  function resetRewind() {
    rewind.snaps.length = 0;
    rewind.framesSinceSnap = 0;
    rewind.active = false;
    rewind.pos = -1;
    rewind.stepCount = 0;
    rewind.atStart = false;
    rewindHeld = {};
    if (els.btnRewind) els.btnRewind.classList.remove('is-rewinding');
  }

/* ---------- NES core ---------- */
  // The vendored jsnes.min.js core calls `this.nes.stop()` when the CPU hits an
  // ILLEGAL 6502 opcode, but this build never defines `stop()`. That makes
  // nes.frame() throw `TypeError: this.nes.stop is not a function`, which the
  // netplay lockstep try/catch turns into a "Netplay error" + a frozen host.
  // Polyfill `stop()` once, before any NES instance is created, so an illegal
  // opcode halts gracefully (sets running=false + crashMessage) instead of
  // throwing. This is belt-and-suspenders with the netplay.js polyfill.
  (function ensureNesStop() {
    try {
      if (jsnes.NES && jsnes.NES.prototype && typeof jsnes.NES.prototype.stop === 'undefined') {
        jsnes.NES.prototype.stop = function () {
          this.running = false;
          this.crashMessage = 'Game crashed: invalid opcode';
        };
      }
    } catch (e) { /* best-effort */ }
  })();

  function createNES() {
    var rate = audioCtx ? audioCtx.sampleRate : 44100;
    return new jsnes.NES({
      onFrame: function (buf) {
        // buf: array of 61440 ints — each a 0x00RRGGBB palette entry as
        // produced by the jsnes core (getRgb(R,G,B) = (R<<16)|(G<<8)|B).
        // NOTE: An R<->B channel swap is applied here (user-confirmed the
        // game displayed red/blue swapped). Write each RGBA byte explicitly
        // so results are correct regardless of CPU endianness:
        //   byte[0] = blue  (bits  7-0 of the 0xBBGGRR value)
        //   byte[1] = green (bits 15-8)
        //   byte[2] = red   (bits 23-16)
        // Rendered as: R port <- original B byte, B port <- original R byte.
        var data = imageData.data;
        var o = 0;
        for (var i = 0; i < 61440; i++) {
          var v = buf[i] >>> 0;
          data[o++] = v & 0xFF;          // R (from swapped/blue byte)
          data[o++] = (v >> 8) & 0xFF;   // G (unchanged)
          data[o++] = (v >> 16) & 0xFF;  // B (from swapped/red byte)
          data[o++] = 0xFF;              // A
        }
        // Commit immediately to eliminate any race with the render loop, and
        // push the frame to the 4× capture canvas while recording.
        blitScreen();
        blitCapture();
      },
      onAudioSample: onAudioSample,
      onStatusUpdate: function (msg) { console.log('[jsnes]', msg); },
      preferredFrameRate: 60,
      emulateSound: true,
      sampleRate: rate
    });
  }

  /* ---------- ROM loading ---------- */
  function buildBinaryString(bytes) {
    var s = '';
    var chunk = 0x8000;
    for (var i = 0; i < bytes.length; i += chunk) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunk, bytes.length)));
    }
    return s;
  }

  function prettyName(name) {
    return name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function loadROM(arrayBuffer, fileName) {
    var bytes = new Uint8Array(arrayBuffer);
    if (bytes.length < 16) throw new Error('File is too small to be a NES ROM.');
    if (bytes[0] !== 0x4E || bytes[1] !== 0x45 || bytes[2] !== 0x53 || bytes[3] !== 0x1A) {
      throw new Error('Not a valid NES ROM (missing NES\\x1a header).');
    }

    var prgBanks = bytes[4];
    var chrHalf = bytes[5];
    var chrBanks = chrHalf * 2;
    var flag6 = bytes[6];
    var flag7 = bytes[7];
    var mapper = ((flag7 & 0xF0) | (flag6 >> 4)) & 0xFF;
    var fourScreen = (flag6 & 0x08) !== 0;
    var battery = (flag6 & 0x02) !== 0;
    var mirroringRaw = flag6 & 0x01;
    if (bytes.length >= 16 && (flag7 & 0x0C) === 0x08) {
      // NES 2.0
      mapper |= (bytes[8] & 0x0F) << 4;
    }

    // A fresh ROM replaces nes (and nes.mmap). Drop any cheat read-hook that
    // was installed on the OLD instance so the flag refs don't go stale.
    uninstallCheatHook();

    initAudio();
    var dataStr = buildBinaryString(bytes);
    nes = createNES();
    try {
      nes.loadROM(dataStr);
    } catch (err) {
      nes = null;
      throw new Error('Unsupported ROM: ' + err.message);
    }

    romName = prettyName(fileName) || 'Untitled';
    romSize = bytes.length;

    els.gameTitle.textContent = romName;
    els.gameMeta.textContent = formatSize(romSize);
    els.mFile.textContent = fileName;
    els.mSize.textContent = formatSize(romSize);
    els.mMapper.textContent = (nes.rom ? nes.rom.getMapperName() : 'Unknown') + ' [' + mapper + ']';
    els.mPrg.textContent = prgBanks + ' × 16KB';
    els.mChr.textContent = chrBanks + ' × 4KB';
    els.mMirror.textContent = fourScreen ? 'Four-screen' : (mirroringRaw ? 'Vertical' : 'Horizontal');
    els.mBattery.textContent = battery ? 'Yes (SRAM)' : 'No';

    // A freshly loaded ROM invalidates an open debugger session (it holds a
    // stale emulator reference); close it so it re-attaches on the next open.
    if (debuggerOpen) closeDebugger(false);

    running = true;
    paused = false;
    resetRewind();
    captureRewindSnapshot();
    updatePauseUI();
    showView('player');
    addRecent(fileName, romName, romSize);
    toast('▶ ' + romName, 'success');
  }

  /* ---------- Game loop ---------- */
  // The emulator is stepped in fixed 1000/60 ms increments via an accumulator,
  // so gameplay stays at true 60 FPS on any display refresh rate (60/120/144 Hz)
  // and recordings capture exactly 60 unique frames per second.
  var STEP_MS = 1000 / 60;
  var stepAccumulator = 0;
  var lastStepTime = 0;

// The emulator is stepped on a setTimeout scheduler instead of
  // requestAnimationFrame so it keeps running at full speed even when the tab
  // or window loses focus (browsers throttle/pause rAF in background tabs).
  // Elapsed time is measured with performance.now(), which is monotonic and
  // independent of the frame callback's own timestamp.
  function frame(timestamp) {
    var now = (typeof timestamp === 'number') ? timestamp : performance.now();
    if (!lastStepTime) lastStepTime = now;
    var elapsed = now - lastStepTime;
    lastStepTime = now;
    // Clamp huge gaps (e.g. after a long tab switch) to avoid spiralling
    // catch-up, which could otherwise spin the emulator for many frames.
    if (elapsed > 250) elapsed = 250;
    stepAccumulator += elapsed;

    // Never let a single bad frame kill the loop. If stepEmulator() throws
    // (e.g. a netplay lockstep edge case), we still re-schedule so the game
    // can never freeze on a silent exception.
    try {
      while (stepAccumulator >= STEP_MS) {
        stepEmulator();
        stepAccumulator -= STEP_MS;
      }
    } catch (err) {
      console.error('[nesplayer] stepEmulator error:', err);
      // If a session is active, tear netplay down so the game degrades to
      // normal single-player playback instead of stalling on a dead peer.
      var GGg = window.NESNetplay;
      if (GGg && GGg.isActive && GGg.isActive()) {
        try { GGg.disconnect(); } catch (e) { /* ignore */ }
        toast('Netplay error — resuming single-player', 'error');
      }
      stepAccumulator = 0;
    }
    trackFPS();
    setTimeout(function () { frame(performance.now()); }, STEP_MS);
  }

function stepEmulator() {
    // When the RGB self-test is shown, don't step the emulator, so the bars
    // stay perfectly stable instead of being overwritten by the game frame.
    if (!(running && !paused && nes && !testPattern)) return;

    // Hold-to-rewind: step back through the snapshot buffer instead of
    // advancing gameplay. Input is released so held buttons don't leak in.
    if (rewind.active) {
      stepRewind();
      return;
    }

var GG = window.NESNetplay;
    // Lockstep only gates the emulator once BOTH sides are connected and have
    // the ROM (isReady). While a netplay session is active but NOT yet ready
    // (waiting/joining/syncing), the emulator MUST NOT advance: any single-
    // player frames rendered in that window would parse RNG / timers and leave
    // the two cores at different states, permanently desyncing the match the
    // instant lockstep begins. So we HOLD the emulator (release held inputs and
    // skip nes.frame()) so both sides always start the match from an identical
    // frame 0. This is the difference between a stable netplay session and the
    // near-immediate desync that occurred before.
    var netplayActive = !!(GG && GG.isReady && GG.isReady());
    if (GG && GG.isActive && GG.isActive() && !netplayActive) {
      // Held buttons must not leak into lockstep once it starts.
      releaseAllInput();
      return; // hold: do not render single-player frames while syncing
    }

if (!modalOpen && !cheatModalOpen && !debuggerOpen && !netplayModalOpen) {
      // Rebuild the reverse maps from the LIVE bindings every frame, then
      // derive the desired button states from the held physical inputs.
      // This guarantees a binding captured in the Bind modal works
      // immediately in-game, with no stale lookups or stuck buttons.
      rebuildBindMaps();
      pollGamepad();
      applyInput(nes);
    } else {
      // While a modal (bind, cheats, debugger, netplay) is open, hold inputs
      // so accidental presses don't reach the game.
      releaseAllInput();
    }

// In netplay (deterministic lockstep), feed our local input to the module
    // and only advance a frame once the peer's input for this frame has
    // arrived. GG.step() returns true only when we may advance. This section
    // is isolated so a netplay edge-case can never take down the emulator or
    // the render loop — on error we tear the session down and keep playing.
if (netplayActive) {
      try {
        netplayFeed();
        if (!GG.step()) return;   // wait for the opponent's input this frame
        // applyFrame() applies BOTH inputs for the render frame: our own
        // DELAYED input to the local controller (overriding the immediate
        // applyInput() write above) and the peer's input to the other pad.
        // This keeps both cores byte-identical — the previous applyRemote()
        // only wrote the peer's input, so the local controller held the
        // CURRENT (live-frame) input while the peer applied our DELAYED input,
        // permanently desyncing the two cores on the first button press.
        GG.applyFrame(nes);
      } catch (err) {
        console.error('[nesplayer] netplay lockstep error:', err);
        try { GG.disconnect(); } catch (e) { /* ignore */ }
        toast('Netplay error — resuming single-player', 'error');
      }
    }

    // Re-apply active cheats right before the frame so the game sees the
    // modified bytes (and can't overwrite them between frames).
    applyCheats();
    nes.frame();
    emuFrameCount++;
    maybeCaptureRewind();
  }

  /* ---------- RGB self-test pattern ---------- */
  // Press T to show pure R/G/B/C/M/Y/W bars. If the bars look correct, the
  // canvas pipeline is fine and the "no red" issue is in the ROM/game itself.
  function renderTestPattern() {
    var data = imageData.data;
    var W = 256, H = 240;
    var bars = [
      [255, 0, 0],   // R
      [0, 255, 0],   // G
      [0, 0, 255],   // B
      [255, 255, 0], // Y
      [255, 0, 255], // M
      [0, 255, 255], // C
      [255, 255, 255]// W
    ];
    var o = 0;
    for (var y = 0; y < H; y++) {
      for (var x = 0; x < W; x++) {
        var c = bars[Math.floor((x / W) * bars.length)];
        data[o++] = c[0];
        data[o++] = c[1];
        data[o++] = c[2];
        data[o++] = 255;
      }
    }
  }

  // Write the current framebuffer (`imageData`) to the on-screen canvas.
  // When a color mode other than 'normal' is active, the raw game/test-pattern
  // pixels are remapped through the filter LUT on the fly, so the effect is
  // visible live AND baked into the 4× recording canvas (blitCapture copies
  // this canvas).
  function blitScreen() {
    if (filterLUT) {
      var lut = filterLUT;
      var d = imageData.data;
      for (var i = 0; i < d.length; i += 4) {
        var idx = (d[i] << 7) | (d[i + 1] << 2) | (d[i + 2] >> 6);
        d[i] = lut[idx];
        d[i + 1] = lut[idx + 1];
        d[i + 2] = lut[idx + 2];
      }
    }
    screenCtx.putImageData(imageData, 0, 0);
  }

  /* ---------- Color filters ---------- */
  // Build a 32k-entry LUT (5 bits R, 6 bits G, 5 bits B) that maps every
  // possible input pixel to its filtered colour. Building once per mode change
  // keeps the per-frame blit path a pure array lookup with zero math.
  function buildFilterLUT(mode) {
    // Original Gameboy palette (4 luminance shades, darkest -> lightest).
    var GB_SHADES = [[15, 56, 15], [48, 98, 48], [139, 172, 15], [155, 188, 15]];
    // Standard EGA 16-color palette.
    var EGA = [
      [0, 0, 0], [0, 0, 170], [0, 170, 0], [0, 170, 170],
      [170, 0, 0], [170, 0, 170], [170, 85, 0], [170, 170, 170],
      [85, 85, 85], [85, 85, 255], [85, 255, 85], [85, 255, 255],
      [255, 85, 85], [255, 85, 255], [255, 255, 85], [255, 255, 255]
    ];
    // CGA palette 0 (RGBI, low intensity): black / cyan / magenta / gray.
    var CGA = [[0, 0, 0], [0, 170, 170], [170, 0, 170], [170, 170, 170]];

    var lut = new Uint8Array(32768 * 3);
    var i = 0;
    for (var r5 = 0; r5 < 32; r5++) {
      for (var g6 = 0; g6 < 64; g6++) {
        for (var b5 = 0; b5 < 32; b5++) {
          var r = (r5 << 3) | (r5 >> 2);
          var g = (g6 << 2) | (g6 >> 4);
          var b = (b5 << 3) | (b5 >> 2);

          if (mode === 'bw') {
            // Rec.601 luma -> gray (0.299R + 0.587G + 0.114B).
            var y = (r * 77 + g * 150 + b * 29) >> 8;
            lut[i++] = y; lut[i++] = y; lut[i++] = y;
            continue;
          }

          if (mode === 'gb') {
            // Map luminance to the 4 Gameboy shades for an authentic look.
            var luma = (r * 77 + g * 150 + b * 29) >> 8;
            var shade = luma < 64 ? 0 : luma < 128 ? 1 : luma < 192 ? 2 : 3;
            lut[i++] = GB_SHADES[shade][0];
            lut[i++] = GB_SHADES[shade][1];
            lut[i++] = GB_SHADES[shade][2];
            continue;
          }

          // EGA / CGA: quantize to the nearest palette colour.
          var pal = (mode === 'ega') ? EGA : CGA;
          var best = 0, bestD = Infinity;
          for (var p = 0; p < pal.length; p++) {
            var dr = r - pal[p][0], dg = g - pal[p][1], db = b - pal[p][2];
            var d = dr * dr + dg * dg + db * db;
            if (d < bestD) { bestD = d; best = p; }
          }
          lut[i++] = pal[best][0];
          lut[i++] = pal[best][1];
          lut[i++] = pal[best][2];
        }
      }
    }
    return lut;
  }

  // Rebuild the LUT for the active mode (or clear it for 'normal') and refresh
  // the on-screen frame so the new palette applies instantly.
  function applyColorMode(mode) {
    colorMode = mode;
    if (mode === 'normal') {
      filterLUT = null;
    } else if (mode === 'gb') {
      filterLUT = buildFilterLUT('gb');
    } else if (mode === 'ega') {
      filterLUT = buildFilterLUT('ega');
    } else if (mode === 'cga') {
      filterLUT = buildFilterLUT('cga');
    } else if (mode === 'bw') {
      filterLUT = buildFilterLUT('bw');
    }
    updateFilterUI();
    if (nes) {
      // Re-run the last emulated frame through the new LUT immediately.
      blitScreen();
      blitCapture();
    }
  }

  // Update the active state on the Filters menu buttons and toggles.
  function updateFilterUI() {
    els.fScanlines.classList.toggle('is-on', scanlinesEnabled);
    els.fScanlines.setAttribute('aria-checked', String(scanlinesEnabled));
    els.fStatic.classList.toggle('is-on', staticEnabled);
    els.fStatic.setAttribute('aria-checked', String(staticEnabled));
    var modes = els.filtersMenu.querySelectorAll('.filters-mode');
    for (var i = 0; i < modes.length; i++) {
      modes[i].classList.toggle('is-active', modes[i].getAttribute('data-mode') === colorMode);
    }
  }

  function toggleScanlines() {
    scanlinesEnabled = !scanlinesEnabled;
    els.screenWrap.classList.toggle('crt', scanlinesEnabled);
    updateFilterUI();
    toast(scanlinesEnabled ? 'Scanlines on' : 'Scanlines off', 'success');
  }

  function toggleStatic() {
    staticEnabled = !staticEnabled;
    els.screenWrap.classList.toggle('static', staticEnabled);
    updateFilterUI();
    toast(staticEnabled ? 'Static on' : 'Static off', 'success');
  }

  function setColorMode(mode) {
    var names = { normal: 'Original', gb: 'Gameboy', ega: 'EGA', cga: 'CGA', bw: 'Black & white' };
    applyColorMode(mode);
    toast('Color mode: ' + (names[mode] || mode), 'success');
  }

  function toggleFiltersMenu(force) {
    filtersOpen = (force !== undefined) ? force : !filtersOpen;
    els.filtersMenu.hidden = !filtersOpen;
    els.btnFilters.setAttribute('aria-expanded', String(filtersOpen));
    els.btnFilters.classList.toggle('is-active', filtersOpen);
  }

  // Close the dropdown when clicking outside it.
  function closeFiltersOnOutside(e) {
    if (filtersOpen && !e.target.closest('.filters')) toggleFiltersMenu(false);
  }

  // While recording, stamp the screen canvas onto the 4× capture canvas using
  // nearest-neighbour scaling (imageSmoothingEnabled = false) so pixels stay
  // crisp. Called once per EMULATED frame, so the recording has exactly 60
  // unique frames per second with no duplicates.
  function blitCapture() {
    if (!recording) return;
    ensureCaptureCanvas();
    captureCtx.imageSmoothingEnabled = false;
    captureCtx.drawImage(els.screen, 0, 0, 256, 240, 0, 0, 256 * CAPTURE_SCALE, 240 * CAPTURE_SCALE);
    capturedFrames++;
  }

  // Lazily create the offscreen capture canvas used as the recording source.
  function ensureCaptureCanvas() {
    if (!captureCanvas) {
      captureCanvas = document.createElement('canvas');
      captureCanvas.width = 256 * CAPTURE_SCALE;
      captureCanvas.height = 240 * CAPTURE_SCALE;
      captureCtx = captureCanvas.getContext('2d');
      captureCtx.imageSmoothingEnabled = false;
    }
  }

  // The RGB self-test is redrawn on the same fixed 60 FPS cadence as the game
  // (own accumulator), so a recording of the bars has uniform frame pacing on
  // any display refresh rate — same guarantee as gameplay.
  var testAccumulator = 0;
  var lastTestTime = 0;

  // Like the main loop, this runs on setTimeout (not rAF) so the RGB self-test
  // keeps animating at full speed even when the tab loses focus.
  function renderLoop(timestamp) {
    var now = (typeof timestamp === 'number') ? timestamp : performance.now();
    if (testPattern) {
      if (!lastTestTime) lastTestTime = now;
      var elapsed = now - lastTestTime;
      lastTestTime = now;
      if (elapsed > 250) elapsed = 250;
      testAccumulator += elapsed;
      while (testAccumulator >= STEP_MS) {
        testAccumulator -= STEP_MS;
        renderTestPattern();
        blitScreen();
        blitCapture();
      }
    } else {
      lastTestTime = 0;
      testAccumulator = 0;
    }
    setTimeout(function () { renderLoop(performance.now()); }, STEP_MS);
  }

  function trackFPS() {
    var now = performance.now();
    if (now - lastFpsTime >= 1000) {
      // Report emulated frames per second (true game speed). When paused the
      // last value is kept so the HUD doesn't read "0 FPS".
      if (running && !paused) {
        var fps = Math.round((emuFrameCount * 1000) / (now - lastFpsTime));
        els.fpsDisplay.textContent = fps + ' FPS';
      }
      emuFrameCount = 0;
      lastFpsTime = now;
    }
  }

/* ---------- Keyboard ---------- */
  // True when the user is typing into a text field (e.g. the chat box). Global
  // game input and shortcuts must be suppressed while typing so keystrokes
  // reach the field instead of the emulator.
  function typingInField() {
    var el = document.activeElement;
    if (!el) return false;
    var tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable === true;
  }

  function handleKeyDown(e) {
    if (e.repeat) return;

    // While typing in a text field (chat, cheat input, etc.), let the key
    // reach the field and do NOT feed it to the game or trigger shortcuts.
    if (typingInField()) {
      // Enter in the chat box still sends the message (handled by its own
      // keydown listener); everything else goes to the field untouched.
      return;
    }

var anyModal = modalOpen || cheatModalOpen || debuggerOpen || netplayModalOpen;

    // While capturing a binding, the next key press gets assigned.
    if (modalOpen && capturing) {
      e.preventDefault();
      handleCaptureKey(e.code);
      return;
    }

    // Record the physical key as held; applyInput() maps it each frame via the
    // live bindings (rebuilt every frame from the bindings table). If the key
    // is bound to a NES button it becomes game input; otherwise it may still
    // trigger a global shortcut below. While a menu is open this is skipped so
    // bound keys (e.g. Z/X) still reach modal inputs like the cheat-code field.
    var btn = keyToNes[e.code];
    if (btn !== undefined && !anyModal) {
      e.preventDefault();
      keysHeld[e.code] = true;
      return;
    }

    // Hold Backspace to rewind through the snapshot buffer.
    if (e.code === 'Backspace' && !anyModal) { holdRewind('kb'); return; }

    // Escape always closes whatever modal is on top.
    if (e.code === 'Escape') {
if (modalOpen) closeBindModal();
      else if (cheatModalOpen) closeCheatModal();
      else if (debuggerOpen) closeDebugger();
      else if (netplayModalOpen) closeNetplayModal();
      else if (fullscreen) exitFullscreen();
      return;
    }

    // While a menu is open, all other global shortcuts are disabled so typing
    // in inputs can't trigger game actions (e.g. G opening the debugger while
    // the cheat panel is open).
    if (anyModal) return;

    switch (e.code) {
      case 'KeyP': togglePause(); break;
      case 'KeyF': toggleFullscreen(); break;
      case 'KeyV': toggleRecording(); break;
      case 'KeyB': openBindModal(); break;
      case 'KeyG': toggleDebugger(); break;
      case 'KeyC': toggleCheatModal(); break;
      case 'KeyR': if (nes) resetGame(); break;
      case 'KeyM': toggleSound(); break;
      case 'KeyT': toggleTestPattern(); break;
    }
  }

  function handleKeyUp(e) {
    delete keysHeld[e.code];
    if (e.code === 'Backspace') releaseRewind('kb');
    e.preventDefault();
  }

/* ---------- Gamepad ---------- */
  // Gamepad spoofing/reading is only allowed while the browser window is
  // focused. When the window loses focus we release all held gamepad buttons
  // (so nothing stays stuck) and stop grabbing input until it regains focus.
  function releaseGamepadInput() {
    // Clear any held pad buttons/axes and the pad rewind trigger so the game
    // never keeps a button "pressed" across a focus loss.
    padHeld = {};
    axisHeld = {};
    releaseRewind('pad');
    // Push buttonUp transitions to the core so the emulator sees them released.
    if (nes) {
      var ctrl = localController();
      for (var j = 0; j < NES_BUTTONS.length; j++) {
        var nid = NES_BUTTONS[j].id;
        if (inputPrev[nid]) {
          nes.buttonUp(ctrl, nid);
          inputPrev[nid] = false;
          setHud(nid, false);
        }
      }
    }
  }

  function pollGamepad() {
    // Only grab gamepad input while the browser window is focused.
    if (!focused) return;
    if (!navigator.getGamepads) return;
    var pads = navigator.getGamepads();
    if (!pads) return;

    var pad = (padIndex !== null && pads[padIndex]) ? pads[padIndex] : null;
    if (!pad) {
      for (var i = 0; i < pads.length; i++) {
        if (pads[i] && pads[i].connected) { pad = pads[i]; padIndex = i; break; }
      }
    }
    if (!pad) {
      if (padIndex !== null) {
        padIndex = null;
        els.padStatus.textContent = '🎮 none';
        els.padStatus.classList.remove('is-connected');
      }
      return;
    }

    els.padStatus.textContent = '🎮 ' + (pad.id ? pad.id.replace(/\s*\(.*\)$/, '') : 'Gamepad');
    els.padStatus.classList.add('is-connected');

    // Buttons 0..15 in standard order
    var buttons = pad.buttons || [];

    // If the bindings modal is open, assign the next gamepad button press.
    if (modalOpen && capturing) {
      for (var ci = 0; ci < Math.min(16, buttons.length); ci++) {
        if (buttons[ci] && buttons[ci].pressed) { handleCapturePad(ci); break; }
      }
    }

    for (var b = 0; b < Math.min(16, buttons.length); b++) {
      var nbtn = padToNes[b];
      if (nbtn === undefined) continue;
      var pressed = !!(buttons[b] && buttons[b].pressed);
      if (pressed) padHeld[nbtn] = true;
      else delete padHeld[nbtn];
    }

    // Right trigger (standard button index 7) = hold-to-rewind.
    if (buttons[7] && buttons[7].pressed) holdRewind('pad');
    else releaseRewind('pad');

    // Analog sticks + D-Pad hat axes act as D-Pad. Axis presses are tracked in
    // a SEPARATE map (axisHeld) so a stick at rest (value 0) can never delete a
    // simultaneous D-Pad button press that lives in padHeld (buttons 12-15).
    var axes = pad.axes || [];
    if (axes.length >= 2) {
      setAxis(NES_CTRL.BUTTON_LEFT, NES_CTRL.BUTTON_RIGHT, axes[0]);
      setAxis(NES_CTRL.BUTTON_UP, NES_CTRL.BUTTON_DOWN, axes[1]);
    }
    // Some pads expose the D-Pad on axes 6/7 instead of buttons 12-15
    if (axes.length >= 8) {
      setAxis(NES_CTRL.BUTTON_LEFT, NES_CTRL.BUTTON_RIGHT, axes[6]);
      setAxis(NES_CTRL.BUTTON_UP, NES_CTRL.BUTTON_DOWN, axes[7]);
    }
  }

  // Reflect a NES button state on the live input HUD.
  function setHud(nesBtn, on) {
    var el = HUD_MAP[nesBtn];
    if (el) el.classList.toggle('is-pressed', !!on);
  }

// The controller this local player controls. In netplay the host is Player 1
  // and the guest is Player 2; outside netplay there is only Player 1.
  function localController() {
    var GG = window.NESNetplay;
    if (GG && GG.isActive && GG.isActive()) {
      return GG.getRole() === 'guest' ? 2 : 1;
    }
    return 1;
  }

  // Compute the desired state for every NES button from the held physical
  // inputs (keyboard + gamepad) using the LIVE bindings, then push only the
  // buttonDown/buttonUp transitions to the core. Because the reverse maps are
  // rebuilt every frame, a binding captured in the Bind modal takes effect
  // immediately in-game — no stale lookups, no missed presses.
  function applyInput(nesObj) {
    var desired = {};
    for (var code in keysHeld) {
      if (!keysHeld[code]) continue;
      var btn = keyToNes[code];
      if (btn !== undefined) desired[btn] = true;
    }
    for (var nb in padHeld) {
      if (padHeld[nb]) desired[nb] = true;
    }
    for (var ab in axisHeld) {
      if (axisHeld[ab]) desired[ab] = true;
    }
    var ctrl = localController();
    for (var j = 0; j < NES_BUTTONS.length; j++) {
      var nid = NES_BUTTONS[j].id;
      var on = !!desired[nid];
      if (on !== inputPrev[nid]) {
        if (on) nesObj.buttonDown(ctrl, nid);
        else nesObj.buttonUp(ctrl, nid);
        inputPrev[nid] = on;
      }
      setHud(nid, on);
    }
  }

// Release every button that was previously applied to the core (used while
  // the bindings modal is open so captured presses never reach the game).
  function releaseAllInput() {
    if (!nes) return;
    var ctrl = localController();
    for (var j = 0; j < NES_BUTTONS.length; j++) {
      var nid = NES_BUTTONS[j].id;
      if (inputPrev[nid]) {
        nes.buttonUp(ctrl, nid);
        inputPrev[nid] = false;
        setHud(nid, false);
      }
    }
    keysHeld = {};
    padHeld = {};
    axisHeld = {};
  }

  function setAxis(negBtn, posBtn, value) {
    if (value < -0.4) axisHeld[negBtn] = true;
    else delete axisHeld[negBtn];
    if (value > 0.4) axisHeld[posBtn] = true;
    else delete axisHeld[posBtn];
  }

  /* ---------- UI actions ---------- */
  function showView(name) {
    if (name === 'player') {
      els.landing.hidden = true;
      els.player.hidden = false;
      els.ledPower.classList.add('is-on');
      initAudio();
    } else {
      els.player.hidden = true;
      els.landing.hidden = false;
      els.ledPower.classList.remove('is-on');
      els.ledPaused.classList.remove('is-on');
    }
  }

  function togglePause() {
    paused = !paused;
    updatePauseUI();
  }

  function updatePauseUI() {
    els.btnPause.classList.toggle('is-active', paused);
    els.ledPaused.classList.toggle('is-on', paused);
    if (paused) {
      els.screenOverlay.hidden = false;
      els.overlayIcon.textContent = '⏸';
      els.overlayText.textContent = 'PAUSED';
    } else {
      els.screenOverlay.hidden = true;
    }
  }

  function resetGame() {
    try {
      nes.reset();
      resetRewind();
      captureRewindSnapshot();
      toast('Console reset', 'success');
    } catch (err) {
      toast('Reset failed: ' + err.message, 'error');
    }
  }

  function toggleSound() { setSoundEnabled(!soundEnabled); }

  function toggleFullscreen() {
    if (fullscreen) {
      exitFullscreen();
    } else {
      enterFullscreen();
    }
  }

  function enterFullscreen() {
    fullscreen = true;
    els.screenWrap.classList.add('is-fullscreen');
    // Reflect the active ratio on the overlay buttons.
    els.btnRatio43.classList.toggle('is-active', ratio === '43');
    els.btnRatio169.classList.toggle('is-active', ratio === '169');
    toast('Fullscreen — F or Esc to exit', 'success');
  }

  function exitFullscreen() {
    fullscreen = false;
    els.screenWrap.classList.remove('is-fullscreen');
  }

  function setRatio(r) {
    ratio = r;
    els.screenWrap.classList.toggle('is-ratio-43', r === '43');
    els.screenWrap.classList.toggle('is-ratio-169', r === '169');
    els.btnRatio43.classList.toggle('is-active', r === '43');
    els.btnRatio169.classList.toggle('is-active', r === '169');
    toast('Aspect ratio: ' + (r === '43' ? '4:3 (classic)' : '16:9 (stretch)'), 'success');
  }

  function toggleTestPattern() {
    testPattern = !testPattern;
    toast(testPattern ? 'RGB self-test pattern (T to exit)' : 'Back to game', 'success');
  }

/* ---------- CPU Debugger ---------- */
  // The debugger lives in js/debugger.js (window.NESDebugger). app.js owns the
  // open/close lifecycle: opening auto-pauses the console, the debugger's Step
  // button runs single frames, and closing restores the previous pause state.
  function toggleDebugger() {
    if (debuggerOpen) closeDebugger(true);
    else openDebugger();
  }

  function openDebugger() {
    if (!nes || !window.NESDebugger) return;
    // Ensure the debugger's internal init() has run and its els are populated.
    // If NESDebugger.init() hasn't been called yet (e.g. DOMContentLoaded race),
    // call it directly now.
    if (!window.NESDebugger.els) {
      try { window.NESDebugger.init(); } catch (e) { console.warn('[nesplayer] debugger init failed', e); }
    }
    // Still no els? Fall back to direct DOM access so the modal always opens.
    var dbgModal = document.getElementById('debugModal');
    if (!dbgModal) { toast('Debugger markup not found', 'error'); return; }

    // Remember whether the game was paused so closing restores the same state.
    debugWasPaused = paused;
    debuggerOpen = true;
    // Auto-pause while inspecting (the debugger's Step button runs single frames).
    if (!paused) {
      paused = true;
      updatePauseUI();
    }
    // Held inputs must not leak into the paused/stepped console.
    releaseAllInput();

    try {
      NESDebugger.open(nes);
    } catch (e) {
      console.warn('[nesplayer] NESDebugger.open() threw; falling back to direct DOM', e);
      // Direct fallback: show the modal manually.
      dbgModal.hidden = false;
      document.body.classList.add('no-scroll');
    }
  }

  function closeDebugger(resume) {
    if (!window.NESDebugger) return;
    debuggerOpen = false;
    try {
      if (window.NESDebugger.active) NESDebugger.close();
    } catch (e) {
      console.warn('[nesplayer] NESDebugger.close() threw; cleaning up DOM', e);
      // Fallback: hide the modal manually.
      var dbgModal = document.getElementById('debugModal');
      if (dbgModal) dbgModal.hidden = true;
      document.body.classList.remove('no-scroll');
    }
    if (resume !== false) {
      // Restore the pause state that was active before the debugger opened.
      paused = debugWasPaused;
    } else {
      paused = true;
    }
    updatePauseUI();
  }

  /* ---------- Cheat codes ---------- */
  // Classic RAM poke cheats. Each cheat holds a 16-bit address, a byte value
  // (0-255), an optional compare byte (Game Genie style) and a label. While a
  // ROM is running the writes are re-applied every frame so the game can't
  // overwrite them.
  function toggleCheatModal() {
    if (cheatModalOpen) closeCheatModal();
    else openCheatModal();
  }

  function openCheatModal() {
    if (!nes) { toast('Load a ROM first', 'error'); return; }
    if (debuggerOpen) closeDebugger(false);
    cheatModalOpen = true;
    renderCheatList();
    els.cheatModal.hidden = false;
    document.body.classList.add('no-scroll');
    if (els.cheatInput) els.cheatInput.focus();
  }

function closeCheatModal() {
    cheatModalOpen = false;
    els.cheatModal.hidden = true;
    document.body.classList.remove('no-scroll');
  }

/* ---------- Netplay ---------- */
  // The netplay socket lives in js/netplay.js (window.NESNetplay). It is a
  // deterministic-lockstep module: the host loads the ROM and ships the bytes
  // to the guest, and both advance frames only once each has the other's input.
  // app.js exposes the modal, wires the host/guest callbacks, and feeds the
  // module the local controller state each frame.
  function toggleNetplayModal() {
    if (netplayModalOpen) closeNetplayModal();
    else openNetplayModal();
  }

// Derive the netplay WebSocket URL from the current page so it matches the
  // origin that is serving the app. On an HTTPS page (Render, Railway, etc.)
  // this yields `wss://<host>` — a plaintext `ws://` from a secure page is
  // blocked by the browser with "The operation is insecure". On a local
  // http://localhost page it yields `ws://localhost:PORT`.
  function defaultNetplayUrl() {
    if (typeof location !== 'undefined' && location && location.protocol) {
      var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      var host = location.host || 'localhost:3000';
      return proto + '//' + host;
    }
    return 'ws://localhost:3000';
  }

// Upgrade a saved `ws://` server URL to `wss://` when the page is served
  // over HTTPS (a plaintext ws:// from a secure page is blocked by the browser
  // with "The operation is insecure"). Hosts like Render/Railway always serve
  // HTTPS, so any URL a user saved while testing locally must be upgraded.
  function normalizeNetplayUrl(url) {
    if (!url) return '';
    var u = String(url).trim();
    if (typeof location !== 'undefined' && location && location.protocol === 'https:' &&
        /^ws:\/\//i.test(u)) {
      return 'wss://' + u.replace(/^ws:\/\//i, '');
    }
    return u;
  }

  function openNetplayModal() {
    netplayModalOpen = true;
    els.netplayModal.hidden = false;
    document.body.classList.add('no-scroll');
    // Restore a previously used server URL (upgrading ws:// -> wss:// on
    // HTTPS), or default to the page's own origin so wss:// is used
    // automatically on HTTPS hosts.
    try {
      var savedUrl = localStorage.getItem('nesplayer.netplay.url');
      if (savedUrl) els.netplayUrl.value = normalizeNetplayUrl(savedUrl);
    } catch (e) {}
    if (!els.netplayUrl.value) els.netplayUrl.value = defaultNetplayUrl();
  }

  function closeNetplayModal() {
    netplayModalOpen = false;
    els.netplayModal.hidden = true;
    document.body.classList.remove('no-scroll');
  }

  // Set the status line in the netplay modal.
  function netplayStatus(msg, cls) {
    if (!els.netplayStatus) return;
    els.netplayStatus.textContent = msg;
    els.netplayStatus.className = 'netplay-status' + (cls ? ' ' + cls : '');
  }

// This local player's number: host = Player 1, guest = Player 2. Outside
  // netplay there is only Player 1.
  function myPlayerNumber() {
    var GG = window.NESNetplay;
    if (GG && GG.isActive && GG.isActive()) {
      return GG.getRole() === 'guest' ? 2 : 1;
    }
    return 1;
  }

  // Append a message bubble to the netplay chat log. who is the sender label
  // (e.g. 'Player 1'); kind is 'me' (right-aligned) or 'peer' (left-aligned).
  function appendNetplayChat(who, text, kind) {
    if (!els.netplayChat) return;
    var empty = els.netplayChat.querySelector('.netplay-chat__empty');
    if (empty) empty.remove();
    var msg = document.createElement('div');
    msg.className = 'netplay-chat__msg netplay-chat__msg--' + (kind === 'me' ? 'me' : 'peer');
    var whoEl = document.createElement('span');
    whoEl.className = 'netplay-chat__who';
    whoEl.textContent = who;
    var textEl = document.createElement('span');
    textEl.textContent = text;
    msg.appendChild(whoEl);
    msg.appendChild(textEl);
    els.netplayChat.appendChild(msg);
    els.netplayChat.scrollTop = els.netplayChat.scrollHeight;
  }

// Send a chat message to the peer over the existing p2p socket. The sender
  // also sees their own message echoed locally (the relay only relays, it does
  // not echo back), labelled "Player <n>" by this client's player number.
  function sendNetplayChat() {
    var GG = window.NESNetplay;
    if (!GG || !GG.isActive() || !GG.sendChat) return;
    var text = (els.netplayChatInput.value || '').trim();
    if (!text) return;
    GG.sendChat(text);
    appendNetplayChat('Player ' + myPlayerNumber(), text, 'me');
    els.netplayChatInput.value = '';
  }

  // Wire the netplay module's callbacks into the app UI and emulator. Called
  // once at startup (netplay.js is guaranteed loaded before the DOMContentLoaded
  // init because index.html loads it first).
  function initNetplay() {
    var GG = window.NESNetplay;
    if (!GG) return;

    // netplay.js owns the modal open/close via these callbacks.
    GG.onOpen = openNetplayModal;
    GG.onClose = closeNetplayModal;
    GG.onToast = toast;
    GG.onStateChange = function (s) {
      var labels = {
        idle: 'Disconnected',
        connecting: 'Connecting…',
        hosting: 'Hosting…',
        waiting: 'Waiting for a player…',
        syncing: 'Syncing ROM…',
        playing: 'Playing',
        error: 'Connection error',
        ended: 'Session ended'
      };
      netplayStatus(labels[s] || s, s === 'error' ? 'is-error' : (s === 'playing' ? 'is-ok' : ''));
    };
    GG.onRoomCreated = function (code) {
      if (els.netplayRoomCodeDisplay) els.netplayRoomCodeDisplay.textContent = code;
      if (els.netplayRoomBox) els.netplayRoomBox.hidden = false;
      netplayStatus('Room ' + code + ' created — share this code', 'is-ok');
    };
GG.onJoined = function (code) {
      netplayStatus('Joined room ' + code, 'is-ok');
      els.netplayRoomBox.hidden = true;
    };
// Incoming chat from the peer. The relay only ever forwards peer messages
    // (it never echoes), so 'from' is normally 'peer'; label it with the OTHER
    // player's number. If 'me' ever arrives it is labelled with our own number.
    GG.onChat = function (from, text) {
      var peerNum = (myPlayerNumber() === 2) ? 1 : 2;
      var who = (from === 'peer') ? 'Player ' + peerNum : 'Player ' + myPlayerNumber();
      appendNetplayChat(who, text, from);
    };

// Host/guest config. The host provides the loaded ROM bytes so the guest
    // can bootstrap identically; onStart/onStop just surface status.
    GG.init({
      host: {
        get nes() { return nes; },
        // nes.romData is already the binary string produced by buildBinaryString
        // in loadROM(); pass it through unchanged (never re-run buildBinaryString).
        get romBytes() { return (nes && nes.romData) ? nes.romData : null; },
        get romName() { return romName; },
        onStart: function () { netplayStatus('Playing — 2 players connected', 'is-ok'); },
        onStop: function () { netplayStatus('Netplay ended', 'is-error'); }
      },
guest: {
        get nes() { return nes; },
        loadRom: function (bytes, name) {
          // Guest receives the raw ROM bytes as a string and boots identically.
          if (window.__nesplayer && window.__nesplayer.loadRomString) {
            window.__nesplayer.loadRomString(bytes, name);
          }
        },
        onStart: function () { netplayStatus('Playing — 2 players connected', 'is-ok'); },
        onStop: function () { netplayStatus('Netplay ended', 'is-error'); }
      }
    });
  }

// Feed the current local controller state into the netplay module each frame.
  // p1/p2 are 8-element mask arrays (A,B,SEL,START,UP,DOWN,LEFT,RIGHT).
  // The host's local input goes into p1 (Player 1), the guest's into p2
  // (Player 2) — the peer receives the opposite slot as its opponent.
  function netplayFeed() {
    var GG = window.NESNetplay;
    if (!GG || !GG.isActive()) return;
    var p1 = [], p2 = [];
    for (var j = 0; j < NES_BUTTONS.length; j++) {
      var nid = NES_BUTTONS[j].id;
      var on = !!inputPrev[nid] ? 1 : 0;
      if (GG.getRole() === 'guest') p2.push(on);
      else p1.push(on);
    }
    // Pad the opposite array to 8 entries so both are always full-length.
    while (p1.length < 8) p1.push(0);
    while (p2.length < 8) p2.push(0);
    GG.setLocalInput({ p1: p1, p2: p2 });
  }

  // Load a ROM from its raw binary string (used by the netplay guest to boot
  // the identical ROM the host sent). Mirrors loadROM() but accepts a string.
  function loadRomString(str, fileName) {
    var bytes = new Uint8Array(str.length);
    for (var i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i) & 0xFF;
    // Reuse the existing load path (it validates the header + builds the NES).
    loadROM(bytes.buffer, fileName || 'netplay.nes');
  }

  // Expose the pieces netplay.js needs back into app.js (ROM-byte loading for
  // the guest, plus a few helpers).
  window.__nesplayer = {
    get nes() { return nes; },
    get paused() { return paused; },
    set paused(v) { paused = v; updatePauseUI(); },
    get running() { return running; },
    set running(v) { running = v; },
    get romName() { return romName; },
    get romData() { return nes ? nes.romData : null; },
    loadROM: loadROM,
    loadRomString: loadRomString,
    toast: toast,
    netplayFeed: netplayFeed,
    buildBinaryString: buildBinaryString
  };

// ---------- Game Genie decoder ----------
  // NES Game Genie alphabet: A=0, P=1, Z=2, L=3, G=4, I=5, T=6, Y=7,
  //                          E=8, O=9, X=10, U=11, K=12, S=13, V=14, N=15
  var GG_ALPHABET = 'APZLGITYEOXUKSVN';

  // Decode a Game Genie code into { addr, value, compare }.
  // Each GG letter is a 4-bit nibble. The address returned is the 15-bit
  // PRG-ROM OFFSET (e.g. GZUXNG → $2C3F); the app ORs in $8000 when it stores
  // the cheat so the mapper read-hook matches the full $8000-$FFFF CPU window.
  // Bits are drawn from scattered single bits of the letters — NOT a simple
  // nibble-per-letter mapping, so no per-nibble swap is used here.
  //
  // The NES Game Genie's core layout is the 6-letter code: the first six
  // letters encode the 15-bit PRG offset and the 8-bit replacement value.
  // Codes are accepted as 6 OR 8 letters; an 8-letter code is decoded with its
  // first six letters (the trailing letters are the bank-switch/compare
  // extension, which is ignored for the RAM-poke / PRG-override cheats used
  // here — so a cheat is never blocked by a compare guard).
  //
  // Reference: GZUXNGEI decoded via its first 6 letters (GZUXNG) → offset $2C3F.
  // Returns null on invalid input.
  function decodeGameGenie(code) {
    var clean = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (clean.length !== 6 && clean.length !== 8) return null;
    // Use the first 6 letters — the core 6-letter layout.
    var letters = clean.slice(0, 6);
    var n = [];
    for (var i = 0; i < letters.length; i++) {
      var idx = GG_ALPHABET.indexOf(letters[i]);
      if (idx === -1) return null;
      n.push(idx);
    }

    // 6-letter Game Genie layout:
    //   address = 0x8000 + ((n3 & 7) << 12) | ((n5 & 7) << 8) | ((n4 & 8) << 8) |
    //                       ((n2 & 7) << 4) | ((n1 & 8) << 4) | (n4 & 7) | (n3 & 8)
    //   data    = ((n1 & 7) << 4) | ((n0 & 8) << 4) | (n0 & 7) | (n5 & 8)
    var offset = ((n[3] & 7) << 12) |
                 ((n[5] & 7) << 8)  |
                 ((n[4] & 8) << 8)  |
                 ((n[2] & 7) << 4)  |
                 ((n[1] & 8) << 4)  |
                 (n[4] & 7)         |
                 (n[3] & 8);
    var value = ((n[1] & 7) << 4) |
                ((n[0] & 8) << 4) |
                (n[0] & 7)        |
                (n[5] & 8);
    return {
      addr: offset & 0x7FFF,
      value: value & 0xFF,
      compare: null
    };
  }

  // Add a cheat from the text input. Accepted formats:
  //   ADDR:VALUE              -> write VALUE to ADDR every frame
  //   ADDR:VALUE:COMPARE      -> only write when the byte at ADDR equals COMPARE
  //   ADDR:VALUE:COMPARE:LABEL -> with a display label
  //   SXIOPO                  -> Game Genie 6-letter code (auto-decoded)
  //   ZNSLAAAE                -> Game Genie 8-letter code (auto-decoded)
  // ADDR may be $xxxx / 0xXXXX hex or decimal. VALUE/COMPARE are decimal
  // (0-255) or hex ($xx / 0xXX).
  function addCheatFromInput() {
    var raw = (els.cheatInput.value || '').trim();
    if (!raw) { toast('Enter a cheat first', 'error'); return; }

    // First, try to decode as a Game Genie code.
    var gg = decodeGameGenie(raw);
    if (gg) {
      // The decoder returns the 15-bit PRG offset (e.g. GZUXNG → $2C3F) which
      // is the Game Genie convention users see. Internally the cheat targets
      // the full $8000-$FFFF CPU window, so OR in the base before storing —
      // the mapper read-hook compares against full 16-bit addresses.
      var ggFullAddr = 0x8000 | (gg.addr & 0x7FFF);
      cheats.push({
        addr: ggFullAddr,
        value: gg.value,
        compare: gg.compare,
        label: raw.toUpperCase() + ' ($' + gg.addr.toString(16).toUpperCase() + '=' + gg.value.toString(16).toUpperCase() +
          (gg.compare !== null ? ' if $' + gg.compare.toString(16).toUpperCase() : '') + ')'
      });
      els.cheatInput.value = '';
      renderCheatList();
      applyCheats();
      toast('GG cheat added: ' + raw.toUpperCase(), 'success');
      return;
    }

    // Fall back to ADDR:VALUE format.
    var parts = raw.split(':').map(function (s) { return s.trim(); });
    if (parts.length < 2) { toast('Format: $ADDR:VALUE[:COMPARE][:LABEL] or a Game Genie code', 'error'); return; }

    var addr = parseCheatByte(parts[0], true);
    var value = parseCheatByte(parts[1], false);
    if (addr === null || value === null) { toast('Invalid address or value', 'error'); return; }

    var compare = null;
    if (parts.length >= 3 && parts[2] !== '') {
      compare = parseCheatByte(parts[2], false);
      if (compare === null) { toast('Invalid compare value', 'error'); return; }
    }
    var label = parts.length >= 4 && parts[3] ? parts[3] : ('$' + addr.toString(16).toUpperCase() + '=' + value);

    cheats.push({ addr: addr, value: value, compare: compare, label: label });
    els.cheatInput.value = '';
    renderCheatList();
    applyCheats();
    toast('Cheat added: ' + label, 'success');
  }

  // Parse a single byte from user input. When isAddr the value must fit in 16
  // bits (it may still be written as a plain byte but we allow the full RAM
  // window). Returns null when unparseable or out of range.
  function parseCheatByte(str, isAddr) {
    var s = str.replace(/^\$/, '0x');
    var n = parseInt(s, 16);
    if (isNaN(n)) n = parseInt(str, 10);
    if (isNaN(n) || n < 0) return null;
    if (isAddr && n > 0xFFFF) return null;
    if (!isAddr && n > 0xFF) return null;
    return n;
  }

  function removeCheat(index) {
    cheats.splice(index, 1);
    renderCheatList();
    toast('Cheat removed', 'success');
  }

  function clearAllCheats() {
    cheats.length = 0;
    // No more PRG cheats: drop the read-hook so the mapper runs untouched.
    uninstallCheatHook();
    renderCheatList();
    toast('All cheats cleared', 'success');
  }

// Install a read-hook on nes.mmap.load() so cheats at $8000+ PRG ROM
  // addresses are intercepted BEFORE the mapper returns the real ROM byte.
  // This works on ALL mappers because the hook sits at the load() call site
  // the CPU uses every cycle — no bank-switch write trickery needed.
  function installCheatHook() {
    if (!nes || !nes.mmap || cheatHookActive) return;
    originalMmapLoad = nes.mmap.load;
    nes.mmap.load = function (addr) {
      // Delegate to the real mapper first.
      var real = originalMmapLoad.call(nes.mmap, addr);
      // Match a PRG cheat by its FULL $8000-$FFFF CPU address. Also accept
      // the same 15-bit PRG offset seen through the $C000 window (16KB NROM
      // mirrors PRG there), so cheats work regardless of which window the
      // game happens to read from. The compare guard (if any) still applies.
      var low15 = addr & 0x7FFF;
      for (var i = 0; i < cheats.length; i++) {
        var c = cheats[i];
        if (c.compare !== null && real !== c.compare) continue;
        if (c.addr === addr) return c.value;
        if (c.addr >= 0x8000 && (c.addr & 0x7FFF) === low15) return c.value;
      }
      return real;
    };
    cheatHookActive = true;
  }

  // Remove the cheat hook and restore the original mapper load().
  function uninstallCheatHook() {
    if (!cheatHookActive || !nes || !nes.mmap || !originalMmapLoad) return;
    nes.mmap.load = originalMmapLoad;
    originalMmapLoad = null;
    cheatHookActive = false;
  }

  // Apply cheats to RAM (< $2000) and install/uninstall the PRG read-hook
  // based on whether any cheats target $8000+ addresses. Called every frame
  // from stepEmulator() so RAM cheats are re-poked continuously.
  function applyCheats() {
    if (!nes || !cheats.length) return;
    var cpu = nes.cpu;
    var mmap = nes.mmap;
    var needsHook = false;
    for (var i = 0; i < cheats.length; i++) {
      var c = cheats[i];
      if (c.addr < 8192) {
        // Internal RAM: poke directly every frame so the game can't
        // overwrite the cheat value.
        cpu.mem[c.addr & 0x7FF] = c.value;
      } else {
        needsHook = true;
      }
    }
    // Install or uninstall the PRG read-hook as needed.
    if (needsHook && !cheatHookActive) {
      installCheatHook();
    } else if (!needsHook && cheatHookActive) {
      uninstallCheatHook();
    }
  }

  function renderCheatList() {
    if (!els.cheatList) return;
    els.cheatList.innerHTML = '';
    if (!cheats.length) {
      els.cheatList.innerHTML = '<p class="cheat-empty">No cheats yet. Add one above, or use C to open this panel.</p>';
      return;
    }
    cheats.forEach(function (c, i) {
      var row = document.createElement('div');
      row.className = 'cheat-row';

      var name = document.createElement('span');
      name.className = 'cheat-row__name';
      name.textContent = c.label;

      var spec = document.createElement('span');
      spec.className = 'cheat-row__spec';
      var hex = c.addr.toString(16).toUpperCase();
      var val = c.value.toString(16).toUpperCase();
      spec.textContent = '$' + hex + ' = $' + val + (c.compare !== null ? ' (if $' + c.compare.toString(16).toUpperCase() + ')' : '');

      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'cheat-row__del';
      del.textContent = '✕';
      del.title = 'Remove this cheat';
      del.addEventListener('click', function () { removeCheat(i); });

      row.appendChild(name);
      row.appendChild(spec);
      row.appendChild(del);
      els.cheatList.appendChild(row);
    });
  }

  /* ---------- Custom bindings ---------- */
  // Load persisted bindings (falling back to defaults), then build the
  // reverse lookup maps used by the keyboard/gamepad handlers.
  function initBindings() {
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem(BIND_KEY)); } catch (e) { saved = null; }

    bindings = {};
    var valid = saved && typeof saved === 'object' && saved.version === 1;
    for (var i = 0; i < NES_BUTTONS.length; i++) {
      var nid = NES_BUTTONS[i].id;
      var d = DEFAULT_BINDINGS[nid];
      var b = valid && saved.buttons && saved.buttons[nid] ? saved.buttons[nid] : null;
      bindings[nid] = {
        key1: (b && typeof b.key1 === 'string') ? b.key1 : d.key1,
        key2: (b && typeof b.key2 === 'string') ? b.key2 : (d.key2 || ''),
        pad:  (b && typeof b.pad === 'number')  ? b.pad  : d.pad
      };
    }
    rebuildBindMaps();
  }

  function saveBindings() {
    var out = { version: 1, buttons: {} };
    for (var i = 0; i < NES_BUTTONS.length; i++) {
      out.buttons[NES_BUTTONS[i].id] = bindings[NES_BUTTONS[i].id];
    }
    try { localStorage.setItem(BIND_KEY, JSON.stringify(out)); } catch (e) {}
  }

  // Recompute the reverse lookup tables after any change.
  function rebuildBindMaps() {
    keyToNes = {};
    padToNes = {};
    for (var i = 0; i < NES_BUTTONS.length; i++) {
      var nid = NES_BUTTONS[i].id;
      var b = bindings[nid];
      if (b.key1) keyToNes[b.key1] = nid;
      if (b.key2) keyToNes[b.key2] = nid;
      if (b.pad !== null && b.pad !== undefined) padToNes[b.pad] = nid;
    }
  }

  // Turn a KeyboardEvent.code into a short, friendly label for the modal.
  function keyLabel(code) {
    if (!code) return '';
    var map = {
      ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
      Space: 'Space', Enter: 'Enter', NumpadEnter: 'Enter', ShiftLeft: 'L-Shift',
      ShiftRight: 'R-Shift', ControlLeft: 'L-Ctrl', ControlRight: 'R-Ctrl',
      AltLeft: 'L-Alt', AltRight: 'R-Alt', Backspace: 'Bksp', Tab: 'Tab',
      Escape: 'Esc', CapsLock: 'Caps', ContextMenu: 'Menu',
      Digit0: '0', Digit1: '1', Digit2: '2', Digit3: '3', Digit4: '4',
      Digit5: '5', Digit6: '6', Digit7: '7', Digit8: '8', Digit9: '9',
      Numpad0: 'N0', Numpad1: 'N1', Numpad2: 'N2', Numpad3: 'N3', Numpad4: 'N4',
      Numpad5: 'N5', Numpad6: 'N6', Numpad7: 'N7', Numpad8: 'N8', Numpad9: 'N9',
      Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
      Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backslash: '\\'
    };
    if (map[code]) return map[code];
    if (code.indexOf('Key') === 0) return code.slice(3).toUpperCase();
    if (code.indexOf('F') === 0 && code.length <= 3 && !isNaN(parseInt(code.slice(1), 10))) {
      return code;
    }
    return code;
  }

  var PAD_LABELS = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'Back', 'Start', 'L3', 'R3', 'DPad↑', 'DPad↓', 'DPad←', 'DPad→'];

  function padLabel(idx) {
    return (idx >= 0 && idx < PAD_LABELS.length) ? PAD_LABELS[idx] : 'Btn ' + idx;
  }

  // Build the rows inside the bindings modal.
  function renderBindRows() {
    els.bindRows.innerHTML = '';
    for (var i = 0; i < NES_BUTTONS.length; i++) {
      (function (nb) {
        var b = bindings[nb.id];
        var row = document.createElement('div');
        row.className = 'bind-row';

        var name = document.createElement('span');
        name.className = 'bind-row__name';
        name.textContent = nb.name;

        var controls = document.createElement('div');
        controls.className = 'bind-row__controls';

        function makeBtn(field) {
          var btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'bind-key' + (capturing && capturing.nes === nb.id && capturing.field === field ? ' is-capturing' : '');
          btn.dataset.nes = nb.id;
          btn.dataset.field = field;
          var val = field === 'pad' ? padLabel(b.pad) : keyLabel(b[field]);
          btn.textContent = val || '—';
          btn.title = 'Click, then press a key / gamepad button';
          return btn;
        }

        controls.appendChild(makeBtn('key1'));
        controls.appendChild(makeBtn('key2'));
        controls.appendChild(makeBtn('pad'));

        var clear = document.createElement('button');
        clear.type = 'button';
        clear.className = 'bind-clear';
        clear.textContent = '✕';
        clear.title = 'Clear this binding';
        clear.dataset.nes = nb.id;
        clear.dataset.field = 'clear';

        row.appendChild(name);
        row.appendChild(controls);
        row.appendChild(clear);
        els.bindRows.appendChild(row);
      })(NES_BUTTONS[i]);
    }
  }

  function openBindModal() {
    capturing = null;
    renderBindRows();
    modalOpen = true;
    els.bindModal.hidden = false;
    document.body.classList.add('no-scroll');
    updateBindHint();
  }

  function closeBindModal() {
    modalOpen = false;
    capturing = null;
    els.bindModal.hidden = true;
    document.body.classList.remove('no-scroll');
    // Cancel any half-pressed capture bindings so the game doesn't get stuck.
    keysHeld = {};
    padHeld = {};
    releaseAllInput();
  }

  function updateBindHint() {
    if (capturing) {
      els.bindHint.textContent = 'Listening — press any key or gamepad button (Esc to cancel)…';
      els.bindHint.classList.add('is-live');
    } else {
      els.bindHint.textContent = 'Click a slot, then press the key or gamepad button you want to assign.';
      els.bindHint.classList.remove('is-live');
    }
  }

  // Attach the capture logic to a specific slot.
  function startCapture(nesId, field) {
    capturing = { nes: nesId, field: field };
    renderBindRows();
    updateBindHint();
  }

  // Shared commit logic used by both keyboard and gamepad capture.
  function commitCapture(nesId, field, value) {
    if (capturing && capturing.nes === nesId && capturing.field === field) {
      bindings[nesId][field] = value;
      rebuildBindMaps();
      saveBindings();
      capturing = null;
      renderBindRows();
      updateBindHint();
      toast('Binding updated', 'success');
    }
  }

  function handleCaptureKey(code) {
    if (!capturing) return;
    // The same key can be bound to two buttons; storing in a single shared
    // map would hide one of them, so we simply allow it here.
    if (code === 'Escape') { capturing = null; renderBindRows(); updateBindHint(); return; }
    commitCapture(capturing.nes, capturing.field, code);
  }

  function handleCapturePad(idx) {
    if (!capturing) return;
    commitCapture(capturing.nes, 'pad', idx);
  }

  function resetBindings() {
    try { localStorage.removeItem(BIND_KEY); } catch (e) {}
    initBindings();
    capturing = null;
    renderBindRows();
    updateBindHint();
    toast('Bindings restored to defaults', 'success');
  }

  // Wire the modal's click events (delegated).
  function setupBindModal() {
    els.bindRows.addEventListener('click', function (e) {
      var target = e.target.closest('button');
      if (!target) return;
      var nesId = parseInt(target.dataset.nes, 10);
      var field = target.dataset.field;
      if (field === 'clear') {
        // Clearing uses the shared commit path with an empty value.
        bindings[nesId].key1 = '';
        bindings[nesId].key2 = '';
        bindings[nesId].pad = null;
        rebuildBindMaps();
        saveBindings();
        renderBindRows();
        toast('Binding cleared', 'success');
      } else if (field) {
        startCapture(nesId, field);
      }
    });
  }

  /* ---------- Recording ---------- */
  function toggleRecording() {
    if (recording) { stopRecording(); } else { startRecording(); }
  }

  function startRecording() {
    if (!nes) { toast('Load a ROM first', 'error'); return; }
    if (!window.MediaRecorder) { toast('Screen recording is not supported in this browser', 'error'); return; }

    try {
      initAudio();
      ensureCaptureCanvas();
      var videoStream = captureCanvas.captureStream(60);
      streamDest = audioCtx.createMediaStreamDestination();
      audioGain.connect(streamDest);

      var tracks = videoStream.getVideoTracks().concat(streamDest.stream.getAudioTracks());
      var stream = new MediaStream(tracks);

      var mime = '';
      ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].forEach(function (m) {
        if (!mime && window.MediaRecorder.isTypeSupported && window.MediaRecorder.isTypeSupported(m)) mime = m;
      });

      recorderChunks = [];
      recorder = new MediaRecorder(stream, { mimeType: mime || undefined, videoBitsPerSecond: 12_000_000 });
      recorder.ondataavailable = function (e) { if (e.data && e.data.size) recorderChunks.push(e.data); };
      recorder.onstop = finalizeRecording;
      recorder.start(500);

      // Reset the recording telemetry for this session.
      capturedFrames = 0;
      recordStartTime = performance.now();
      recorderFinalized = false;

      recording = true;
      updateRecordUI();
      toast('● Recording… (V to stop)', 'success');
    } catch (err) {
      console.warn('Recording start failed:', err);
      toast('Recording failed to start', 'error');
    }
  }

  function stopRecording() {
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    if (streamDest) { try { audioGain.disconnect(streamDest); } catch (e) {} streamDest = null; }
    recording = false;
    updateRecordUI();
  }

  function finalizeRecording() {
    // The recorder may emit 'stop' once; guard against a second onstop firing
    // (e.g. after an error) so the download + teardown run exactly once.
    if (recorderFinalized) return;
    recorderFinalized = true;

    var type = (recorder && recorder.mimeType) ? recorder.mimeType : 'video/webm';
    var blob = new Blob(recorderChunks, { type: type });

    // Report the true average capture rate so we can confirm the recording is
    // genuinely 60 FPS (captured frames ÷ wall-clock seconds).
    var durationMs = Math.max(1, performance.now() - recordStartTime);
    var avgFps = Math.round((capturedFrames * 1000) / durationMs);
    console.log('[nesplayer] recording finalized: ' + capturedFrames + ' frames in ' +
      (durationMs / 1000).toFixed(2) + 's => ~' + avgFps + ' FPS');

    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    var stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    a.href = url;
    a.download = (romName || 'nesplayer') + '-' + stamp + '.webm';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1000);
    toast('Recording saved — ' + formatSize(blob.size) + ' · ~' + avgFps + ' FPS', 'success');

    // Tear down: the recorder is stopped, so reset the refs, clear the chunk
    // buffer, and release the capture canvas so a fresh one is created next
    // time (the underlying stream is fully released with it).
    recorder = null;
    recorderChunks = [];
    captureCanvas = null;
    captureCtx = null;
  }

  function updateRecordUI() {
    els.recordIcon.textContent = recording ? '⏺' : '●';
    els.btnRecord.classList.toggle('is-active', recording);
    if (recording) {
      els.btnRecord.classList.add('is-recording');
      els.recBadge.hidden = false;
    } else {
      els.btnRecord.classList.remove('is-recording');
      els.recBadge.hidden = true;
    }
  }

  /* ---------- Save / Load states ---------- */
  function saveState(slot) {
    if (!nes) { toast('Load a ROM first', 'error'); return; }
    try {
      var key = SAVE_PREFIX + romName + '.' + slot;
      localStorage.setItem(key, JSON.stringify(nes.toJSON()));
      toast('Saved state → slot ' + slot, 'success');
    } catch (err) {
      toast('Save failed: ' + err.message, 'error');
    }
  }

  function loadState(slot) {
    if (!nes) { toast('Load a ROM first', 'error'); return; }
    try {
      var key = SAVE_PREFIX + romName + '.' + slot;
      var data = localStorage.getItem(key);
      if (!data) { toast('No save in slot ' + slot, 'error'); return; }
      nes.fromJSON(JSON.parse(data));
      toast('Loaded state ← slot ' + slot, 'success');
    } catch (err) {
      toast('Load failed: ' + err.message, 'error');
    }
  }

  /* ---------- Recent ROMs ---------- */
  function getRecent() {
    try { return JSON.parse(localStorage.getItem(RECENT_KEY)) || []; }
    catch (e) { return []; }
  }

  function addRecent(fileName, name, size) {
    var list = getRecent().filter(function (r) { return r.file !== fileName; });
    list.unshift({ file: fileName, name: name, size: size, added: Date.now() });
    if (list.length > RECENT_MAX) list.length = RECENT_MAX;
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch (e) {}
    renderRecent();
  }

  var sessionBlobs = {};

  function renderRecent() {
    var list = getRecent();
    if (!list.length) {
      els.recentList.innerHTML = '<p class="recent__empty">No games yet — load your first ROM above!</p>';
      return;
    }
    els.recentList.innerHTML = '';
    list.forEach(function (r) {
      var card = document.createElement('div');
      card.className = 'recent-card';

      var icon = document.createElement('div');
      icon.className = 'recent-card__icon';
      icon.textContent = '🕹️';

      var name = document.createElement('div');
      name.className = 'recent-card__name';
      name.textContent = r.name;

      var meta = document.createElement('div');
      meta.className = 'recent-card__meta';
      meta.textContent = formatSize(r.size) + ' · ' + timeAgo(r.added);

      var del = document.createElement('button');
      del.className = 'recent-card__del';
      del.title = 'Remove from list';
      del.textContent = '✕';
      del.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var list2 = getRecent().filter(function (x) { return x.file !== r.file; });
        try { localStorage.setItem(RECENT_KEY, JSON.stringify(list2)); } catch (e) {}
        renderRecent();
      });

      card.appendChild(icon);
      card.appendChild(name);
      card.appendChild(meta);
      card.appendChild(del);
      card.addEventListener('click', function () { playRecent(r); });
      els.recentList.appendChild(card);
    });
  }

  function playRecent(r) {
    if (sessionBlobs[r.file]) {
      try { loadROM(sessionBlobs[r.file], r.file); }
      catch (err) { toast(err.message, 'error'); }
    } else {
      toast('ROM bytes are only kept for the current session — pick the file again to replay.', 'error');
    }
  }

  /* ---------- Helpers ---------- */
  function formatSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  }

  function timeAgo(ts) {
    if (!ts) return 'recently';
    var s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }

  function toast(msg, type) {
    var t = document.createElement('div');
    t.className = 'toast' + (type ? ' toast--' + type : '');
    t.textContent = msg;
    els.toasts.appendChild(t);
    setTimeout(function () {
      t.classList.add('is-out');
      setTimeout(function () { t.remove(); }, 300);
    }, 3200);
  }

  /* ---------- File open ---------- */
  function openFilePicker() {
    els.romInput.value = '';
    els.romInput.click();
  }

  function handleFile(file) {
    if (!file) return;
    if (file.size < 16) { toast('File too small to be a ROM', 'error'); return; }
    var reader = new FileReader();
    reader.onload = function (e) {
      var buf = e.target.result;
      sessionBlobs[file.name] = buf;
      try { loadROM(buf, file.name); }
      catch (err) { toast(err.message, 'error'); }
    };
    reader.onerror = function () { toast('Failed to read file', 'error'); };
    reader.readAsArrayBuffer(file);
  }

  /* ---------- Drag & drop ---------- */
  function setupDnD() {
    var dz = els.dropzone;
    ['dragenter', 'dragover'].forEach(function (evt) {
      dz.addEventListener(evt, function (e) { e.preventDefault(); dz.classList.add('is-dragover'); });
    });
    ['dragleave', 'drop'].forEach(function (evt) {
      dz.addEventListener(evt, function (e) { e.preventDefault(); dz.classList.remove('is-dragover'); });
    });
    dz.addEventListener('drop', function (e) {
      var files = e.dataTransfer.files;
      if (files && files.length) handleFile(files[0]);
    });
    dz.addEventListener('click', function (e) {
      if (e.target.closest('#btnBrowse')) return;
      openFilePicker();
    });
    dz.addEventListener('keydown', function (e) {
      if (e.code === 'Enter' || e.code === 'Space') { e.preventDefault(); openFilePicker(); }
    });
  }

  /* ---------- Init ---------- */
  function init() {
    // Start the screen black before any ROM is loaded.
    var data = imageData.data;
    for (var i = 0; i < data.length; i += 4) {
      data[i] = 0; data[i + 1] = 0; data[i + 2] = 0; data[i + 3] = 255;
    }

    var savedVol = parseFloat(localStorage.getItem(VOLUME_KEY));
    if (!isNaN(savedVol)) {
      audioVolume = Math.max(0, Math.min(1, savedVol));
      els.volumeSlider.value = Math.round(audioVolume * 100);
    }

    els.btnBrowse.addEventListener('click', function (e) { e.stopPropagation(); openFilePicker(); });
    els.romInput.addEventListener('change', function (e) {
      if (e.target.files && e.target.files.length) handleFile(e.target.files[0]);
    });
    els.btnBack.addEventListener('click', function () { showView('landing'); });
    els.btnPause.addEventListener('click', togglePause);
    els.btnReset.addEventListener('click', function () { if (nes) resetGame(); });
    els.btnRewind.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      holdRewind('btn');
      try { els.btnRewind.setPointerCapture(e.pointerId); } catch (err) {}
    });
    els.btnRewind.addEventListener('pointerup', function () { releaseRewind('btn'); });
    els.btnRewind.addEventListener('pointercancel', function () { releaseRewind('btn'); });
    els.btnRewind.addEventListener('lostpointercapture', function () { releaseRewind('btn'); });
    els.btnRewind.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    els.btnSound.addEventListener('click', toggleSound);
    els.btnFilters.addEventListener('click', function (e) { e.stopPropagation(); toggleFiltersMenu(); });
    els.fScanlines.addEventListener('click', toggleScanlines);
    els.fStatic.addEventListener('click', toggleStatic);
    els.filtersMenu.addEventListener('click', function (e) {
      var modeBtn = e.target.closest('.filters-mode');
      if (modeBtn) setColorMode(modeBtn.getAttribute('data-mode'));
    });
    document.addEventListener('click', closeFiltersOnOutside);
    els.btnSave1.addEventListener('click', function () { saveState(1); });
    els.btnLoad1.addEventListener('click', function () { loadState(1); });
    els.btnFullscreen.addEventListener('click', toggleFullscreen);
    els.btnExitFs.addEventListener('click', exitFullscreen);
    els.btnRatio43.addEventListener('click', function () { setRatio('43'); });
    els.btnRatio169.addEventListener('click', function () { setRatio('169'); });
    els.btnControls.addEventListener('click', function () {
      var side = document.querySelector('.side');
      if (side) side.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      toast('Controls: see keyboard & gamepad maps', 'success');
    });
    els.btnDebug.addEventListener('click', function () {
      if (debuggerOpen) closeDebugger(true);
      else openDebugger();
    });
    // The debugger's Run/✕ buttons close it internally; keep app state in sync.
    document.addEventListener('nesplayer:debugger-close', function () {
      if (debuggerOpen) {
        debuggerOpen = false;
        paused = debugWasPaused;
        updatePauseUI();
      }
    });
    els.btnCheats.addEventListener('click', toggleCheatModal);
    els.cheatClose.addEventListener('click', closeCheatModal);
    els.cheatModal.addEventListener('click', function (e) {
      if (e.target === els.cheatModal) closeCheatModal();
    });
    els.cheatAdd.addEventListener('click', addCheatFromInput);
    els.cheatClearAll.addEventListener('click', clearAllCheats);
els.cheatInput.addEventListener('keydown', function (e) {
      if (e.code === 'Enter') { e.preventDefault(); addCheatFromInput(); }
    });
els.btnNetplay.addEventListener('click', toggleNetplayModal);
    if (els.btnNetplayLanding) els.btnNetplayLanding.addEventListener('click', toggleNetplayModal);
    els.netplayClose.addEventListener('click', closeNetplayModal);
    els.netplayModal.addEventListener('click', function (e) {
      if (e.target === els.netplayModal) closeNetplayModal();
    });
els.netplayCreate.addEventListener('click', function () {
      var url = els.netplayUrl.value.trim();
      if (!url) { toast('Enter a server URL first', 'error'); return; }
      try { localStorage.setItem('nesplayer.netplay.url', url); } catch (e) {}
      if (window.NESNetplay) window.NESNetplay.createRoom(url);
      else toast('Netplay module not loaded', 'error');
    });
    els.netplayJoin.addEventListener('click', function () {
      var url = els.netplayUrl.value.trim();
      var code = (els.netplayRoomCode.value || '').trim().toUpperCase();
      if (!url) { toast('Enter a server URL first', 'error'); return; }
      if (!code) { toast('Enter a room code to join', 'error'); return; }
      try { localStorage.setItem('nesplayer.netplay.url', url); } catch (e) {}
      if (window.NESNetplay) window.NESNetplay.joinRoom(code, url);
      else toast('Netplay module not loaded', 'error');
    });
    els.netplayDisconnect.addEventListener('click', function () {
      if (window.NESNetplay) window.NESNetplay.disconnect();
    });
    els.netplayChatSend.addEventListener('click', sendNetplayChat);
    els.netplayChatInput.addEventListener('keydown', function (e) {
      if (e.code === 'Enter') { e.preventDefault(); sendNetplayChat(); }
    });
    els.btnBind.addEventListener('click', function () { openBindModal(); });
    els.btnCloseModal.addEventListener('click', closeBindModal);
    els.bindModal.addEventListener('click', function (e) {
      if (e.target === els.bindModal) closeBindModal();
    });
    els.btnResetBindings.addEventListener('click', resetBindings);
    els.btnRecord.addEventListener('click', toggleRecording);
    els.volumeSlider.addEventListener('input', function () { applyVolume(parseFloat(this.value) / 100); });
    els.btnClearRecent.addEventListener('click', function () {
      try { localStorage.removeItem(RECENT_KEY); } catch (e) {}
      renderRecent();
      toast('Recent list cleared', 'success');
    });

    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('keyup', handleKeyUp);

    window.addEventListener('gamepadconnected', function (e) {
      padIndex = e.gamepad.index;
      els.padStatus.textContent = '🎮 ' + (e.gamepad.id || 'Gamepad');
      els.padStatus.classList.add('is-connected');
      toast('Gamepad connected', 'success');
    });
    window.addEventListener('gamepaddisconnected', function (e) {
      if (padIndex === e.gamepad.index) {
        padIndex = null;
        els.padStatus.textContent = '🎮 none';
        els.padStatus.classList.remove('is-connected');
      }
    });

    // The browser window losing focus means the gamepad may be left in a held
    // state with no way to release it here, so release all pad input immediately
    // and stop reading the gamepad until focus returns. This prevents the game
    // from receiving phantom input while the user is in another window.
    window.addEventListener('blur', function () {
      focused = false;
      releaseGamepadInput();
    });
    window.addEventListener('focus', function () {
      focused = true;
    });

setupDnD();
    renderRecent();
    setupBindModal();
    initBindings();
    initNetplay();

    // Video filters start OFF (raw pixel-perfect image, original palette).
    els.screenWrap.classList.remove('crt', 'static');
    els.fScanlines.classList.remove('is-on');
    els.fStatic.classList.remove('is-on');
    els.fScanlines.setAttribute('aria-checked', 'false');
    els.fStatic.setAttribute('aria-checked', 'false');
    updateFilterUI();
    toggleFiltersMenu(false);
    setSoundEnabled(true);
    updateRecordUI();

    requestAnimationFrame(frame);
    requestAnimationFrame(renderLoop);
  }

  init();
})();

