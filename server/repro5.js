// Faithful APP-LEVEL reproduction: mirrors js/app.js stepEmulator integration
// (netplayFeed + GG.step + GG.applyRemote + nes.frame + rewind-toJSON) against
// the relay, using the REAL jsnes. The goal is to surface any exception thrown
// on the HOST that the protocol-only repros (repro.js/.2/.3/.4) miss.
'use strict';
const { WebSocket } = require('ws');
const URL = 'ws://localhost:3000';

const jsnesMod = require('../js/neslib/jsnes.min.js');
const jsnes = jsnesMod.jsnes || jsnesMod;

// Apply the same stop() polyfill that netplay.js + app.js now install. The
// vendored jsnes calls this.nes.stop() on an illegal 6502 opcode but never
// defines it, so without this polyfill nes.frame() throws and the app's
// netplay lockstep try/catch would tear the session down ("Netplay error").
if (jsnes.NES && jsnes.NES.prototype && typeof jsnes.NES.prototype.stop === 'undefined') {
  jsnes.NES.prototype.stop = function () {
    this.running = false;
    this.crashMessage = 'Game crashed: invalid opcode';
  };
}

// A real-ish NES ROM (16-byte header + 16KB PRG + 8KB CHR). PRG filled with
// NOPs (0xEA) so frame() is safe; emulate a mapper flag so jsnes builds a real
// mapper object (NROM mapper 0).
function makeValidRom() {
  const prg = 1, chr = 1;
  const size = 16 + prg * 16384 + chr * 4096;
  const bytes = new Uint8Array(size);
  bytes[0] = 0x4E; bytes[1] = 0x45; bytes[2] = 0x53; bytes[3] = 0x1A;
  bytes[4] = prg; bytes[5] = chr >>> 1; bytes[6] = 0; bytes[7] = 0;
  // Fill PRG with NOPs (0xEA) so frame() is safe, and set a VALID reset
  // vector ($FFFC-$FFFD) pointing to a self-loop at $C000 so the CPU does NOT
  // execute zero-page RAM / hit illegal opcodes (which would call stop()).
  for (let i = 0; i < prg * 16384; i++) bytes[16 + i] = 0xEA;
  bytes[16 + 0x7FFC] = 0x00; // reset vector lo = $C000
  bytes[16 + 0x7FFD] = 0xC0; // reset vector hi = $C000
  bytes[16 + 0x7FFE] = 0x00; // NMI vector
  bytes[16 + 0x7FFF] = 0xC0; // IRQ vector
  let s = '';
  for (let i = 0; i < size; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 0x8000, size)));
  }
  return s;
}
const ROM = makeValidRom();

function createNES() {
  return new jsnes.NES({
    onFrame: function () {},
    onAudioSample: null,
    onStatusUpdate: function () {},
    preferredFrameRate: 60,
    emulateSound: false,
    sampleRate: 44100
  });
}

function loadRomString(str) {
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i) & 0xFF;
  const nes = createNES();
  let dataStr = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    dataStr += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 0x8000, bytes.length)));
  }
  nes.loadROM(dataStr);
  return nes;
}

// Mirror app.js NES_BUTTONS ids (jsnes Controller constants).
const NES_CTRL = jsnes.Controller;
const NES_BUTTONS = [
  NES_CTRL.BUTTON_UP, NES_CTRL.BUTTON_DOWN, NES_CTRL.BUTTON_LEFT,
  NES_CTRL.BUTTON_RIGHT, NES_CTRL.BUTTON_A, NES_CTRL.BUTTON_B,
  NES_CTRL.BUTTON_SELECT, NES_CTRL.BUTTON_START
];
const BUTTON_ORDER = [0, 1, 2, 3, 4, 5, 6, 7];

function makeClient(name, isHost) {
  const c = {
    name, ws: null, active: false, role: isHost ? 'host' : 'guest',
    player: isHost ? 1 : 2, room: null, romReady: false, frame: 0,
    haveRemote: false, remoteInput: { p1: new Array(8).fill(0), p2: new Array(8).fill(0) },
    localInput: { p1: new Array(8).fill(0), p2: new Array(8).fill(0) },
    pending: [], lastSentFrame: -1, lastStep: 0,
    STALL_TIMEOUT: 3000, closed: false, nes: null, inputPrev: {},
    errors: 0
  };
  c.log = (m) => console.log(`[${name}] ${m}`);
  c.send = (obj) => { if (c.ws && c.ws.readyState === 1) c.ws.send(JSON.stringify(obj)); };
  c.sendInput = () => {
    c.send({ type: 'p2p', data: {
      type: 'input', frame: c.frame,
      p1: c.localInput.p1.reduce((b, v, i) => b | (v ? (1 << i) : 0), 0),
      p2: c.localInput.p2.reduce((b, v, i) => b | (v ? (1 << i) : 0), 0)
    } });
  };
  c.becomeReady = () => {
    c.romReady = true; c.frame = 0;
    c.pending = c.pending.filter((p) => p.frame > 0);
    c.lastSentFrame = -1; c.lastStep = Date.now();
  };
  c.bailLockstep = () => { c.romReady = false; c.haveRemote = false; c.pending = []; c.lastSentFrame = -1; };
  // Mirror app.js netplayFeed: host -> p1, guest -> p2.
  c.netplayFeed = () => {
    const p1 = [], p2 = [];
    for (let j = 0; j < NES_BUTTONS.length; j++) {
      const on = c.inputPrev[NES_BUTTONS[j]] ? 1 : 0;
      if (c.role === 'guest') p2.push(on); else p1.push(on);
    }
    while (p1.length < 8) p1.push(0);
    while (p2.length < 8) p2.push(0);
    c.localInput = { p1, p2 };
  };
  // Mirror app.js GG.applyRemote: host(player1) applies peer p2 to ctrl2.
  c.applyRemote = (nesObj) => {
    if (!c.active || !c.romReady) return;
    const arr = c.player === 1 ? c.remoteInput.p2 : c.remoteInput.p1;
    const target = c.player === 1 ? 2 : 1;
    for (let i = 0; i < 8; i++) {
      const btn = BUTTON_ORDER[i];
      if (arr[i]) nesObj.buttonDown(target, btn); else nesObj.buttonUp(target, btn);
    }
  };
  // Mirror app.js GG.step() exactly.
  c.step = () => {
    if (!c.active || !c.romReady) return false;
    if (c.lastSentFrame < c.frame) { c.sendInput(); c.lastSentFrame = c.frame; }
    if (!c.haveRemote && Date.now() - c.lastStep > c.STALL_TIMEOUT) {
      c.log('*** STALL GUARD -> bailLockstep ***');
      c.bailLockstep();
      return true;
    }
    if (c.haveRemote) {
      c.frame++;
      c.haveRemote = false;
      c.lastStep = Date.now();
      for (let i = 0; i < c.pending.length; i++) {
        if (c.pending[i].frame === c.frame) {
          const p = c.pending[i];
          c.remoteInput.p1 = new Array(8).fill(0);
          c.remoteInput.p2 = new Array(8).fill(0);
          for (let b = 0; b < 8; b++) {
            if ((p.p1 >> b) & 1) c.remoteInput.p1[b] = 1;
            if ((p.p2 >> b) & 1) c.remoteInput.p2[b] = 1;
          }
          c.haveRemote = true;
          c.pending.splice(i, 1);
          break;
        }
      }
      if (c.frame % 10 === 0) c.log(`advanced to frame ${c.frame}`);
      return true;
    }
    return false;
  };
  // The full per-frame step mirroring stepEmulator's netplay block + nes.frame.
  c.runFrame = () => {
    const netplayActive = !!(c.active && c.romReady);
    if (netplayActive) {
      try {
        c.netplayFeed();
        if (!c.step()) return;               // wait for peer input
        c.applyRemote(c.nes);                // apply peer input to other pad
      } catch (err) {
        c.errors++;
        c.log('*** LOCKSTEP ERROR: ' + (err && err.stack || err) + ' ***');
        c.active = false; c.romReady = false;  // GG.disconnect()
      }
    }
    // applyCheats omitted (none). Then nes.frame().
    try {
      c.nes.frame();
      // mirror maybeCaptureRewind -> toJSON every 10 frames
      if (c.frame % 10 === 0) { try { c.nes.toJSON(); } catch (e) { c.log('*** toJSON error: ' + e + ' ***'); } }
    } catch (err) {
      c.errors++;
      c.log('*** nes.frame ERROR: ' + (err && err.stack || err) + ' ***');
    }
  };
  c.disconnect = () => {
    if (c.ws) { try { c.send({ type: 'leave' }); } catch (e) {} try { c.ws.close(); } catch (e) {} }
    c.ws = null; c.closed = true; c.active = false; c.romReady = false;
    c.log('disconnected');
  };
  c.handlePeer = (data) => {
    if (!data) return;
    if (data.type === 'guest-joined' && c.role === 'host') {
      c.log('guest-joined -> reset nes + send ROM');
      try { if (c.nes && c.nes.reset) c.nes.reset(); } catch (e) {}
      c.send({ type: 'p2p', data: { type: 'rom', name: 'g.nes', bytes: ROM } });
      return;
    }
    if (data.type === 'rom' && c.role === 'guest') {
      c.log('got ROM -> loadRomString...');
      try {
        c.nes = loadRomString(data.bytes);
        c.send({ type: 'p2p', data: { type: 'ready' } });
      } catch (e) { c.log('*** loadRomString FAILED: ' + e + ' ***'); }
      return;
    }
    if (data.type === 'ready' && c.role === 'host') {
      c.log('got guest ready -> ack back + becomeReady');
      c.send({ type: 'p2p', data: { type: 'ready' } });
      c.becomeReady();
      return;
    }
    if (data.type === 'ready' && c.role === 'guest') {
      c.log('got host ready ack -> becomeReady');
      c.becomeReady();
      return;
    }
    if (data.type === 'input') {
      if (data.frame === c.frame) {
        c.haveRemote = true;
        c.remoteInput.p1 = new Array(8).fill(0);
        c.remoteInput.p2 = new Array(8).fill(0);
        for (let b = 0; b < 8; b++) {
          if ((data.p1 >> b) & 1) c.remoteInput.p1[b] = 1;
          if ((data.p2 >> b) & 1) c.remoteInput.p2[b] = 1;
        }
      } else if (data.frame > c.frame) {
        c.pending.push({ frame: data.frame, p1: data.p1, p2: data.p2 });
      }
      return;
    }
    if (data.type === 'peer-left') {
      c.log('*** PEER-LEFT ***');
      c.active = false; c.romReady = false;
    }
  };
  return c;
}

const host = makeClient('HOST', true);
const guest = makeClient('GUEST', false);
host.nes = createNES(); // host already has a ROM loaded (single-player)
host.nes.loadROM(ROM);

host.ws = new WebSocket(URL);
host.ws.on('open', () => host.send({ type: 'create' }));
host.ws.on('message', (d) => {
  const m = JSON.parse(d);
  if (m.type === 'created') {
    host.room = m.room; host.active = true;
    host.log(`created room ${m.room}`);
    guest.ws = new WebSocket(URL);
    guest.ws.on('open', () => guest.send({ type: 'join', room: m.room }));
    guest.ws.on('message', (dg) => {
      const gm = JSON.parse(dg);
      if (gm.type === 'joined') { guest.active = true; guest.log(`joined room ${gm.room}`); }
      else if (gm.type === 'peer') guest.handlePeer(gm.data);
    });
    guest.ws.on('close', () => guest.log('*** GUEST WS CLOSED ***'));
  } else if (m.type === 'peer') host.handlePeer(m.data);
});
host.ws.on('close', () => host.log('*** HOST WS CLOSED ***'));

let frames = 0;
const timer = setInterval(() => {
  host.runFrame();
  guest.runFrame();
  frames++;
  if (frames > 400) {
    clearInterval(timer);
    console.log('\n=== APP-LEVEL RESULT ===');
    console.log('host frame:', host.frame, 'host closed:', host.closed, 'host errors:', host.errors);
    console.log('guest frame:', guest.frame, 'guest closed:', guest.closed, 'guest errors:', guest.errors);
    if (host.errors > 0 || guest.errors > 0) console.log('FAIL: an exception was thrown during lockstep');
    else if (host.frame > 1 && guest.frame > 1) console.log('SUCCESS: both advanced, no exceptions');
    else console.log('FAIL: deadlock');
    process.exit(0);
  }
}, 20);
