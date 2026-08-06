// Validation for the CURRENT netplay.js logic (simple deterministic lockstep,
// no INPUT_DELAY lookahead). This mirrors js/netplay.js EXACTLY against the
// relay, using the real jsnes, to confirm both sides advance past frame 0 with
// NO stall, NO disconnect, NO freeze. This is the definitive regression test
// for the "guest connects, receives ROM, then host gets 'player disconnected'
// and freezes" bug.
'use strict';
const { WebSocket } = require('ws');
const URL = 'ws://localhost:3000';

const jsnesMod = require('../js/neslib/jsnes.min.js');
const jsnes = jsnesMod.jsnes || jsnesMod;

// Polyfill stop() like netplay.js does.
if (jsnes.NES && jsnes.NES.prototype && typeof jsnes.NES.prototype.stop === 'undefined') {
  jsnes.NES.prototype.stop = function () { this.running = false; this.crashMessage = 'crash'; };
}
// frame() override like netplay.js so an illegal opcode halts gracefully.
if (jsnes.NES && jsnes.NES.prototype && typeof jsnes.NES.prototype.__frameSafe === 'undefined') {
  jsnes.NES.prototype.__frameSafe = true;
  jsnes.NES.prototype.frame = function () {
    if (this.running === false) return;
    if (this.running === undefined) this.running = true;
    var ppu = this.ppu, t = 0, s = this.opts.emulateSound, i = this.cpu, e = ppu, h = this.papu;
    ppu.startFrame();
    outer: for (;;) {
      if (this.running === false) break outer;
      for (0 === i.cyclesToHalt ? (t = i.emulate(), s && h.clockFrameCounter(t), t *= 3) : i.cyclesToHalt > 8 ? (t = 24, s && h.clockFrameCounter(8), i.cyclesToHalt -= 8) : (t = 3 * i.cyclesToHalt, s && h.clockFrameCounter(i.cyclesToHalt), i.cyclesToHalt = 0); t > 0; t--) {
        if (e.curX === e.spr0HitX && 1 === e.f_spVisibility && e.scanline - 21 === e.spr0HitY) e.setStatusFlag(e.STATUS_SPRITE0HIT, true);
        if (e.requestEndFrame && 0 === --e.nmiCounter) { e.requestEndFrame = false; e.startVBlank(); break outer; }
        e.curX++; 341 === e.curX && (e.curX = 0, e.endScanline());
      }
    }
    this.fpsFrameCount++;
  };
}

function makeValidRom() {
  const prg = 1, chr = 1;
  const size = 16 + prg * 16384 + chr * 4096;
  const bytes = new Uint8Array(size);
  bytes[0] = 0x4E; bytes[1] = 0x45; bytes[2] = 0x53; bytes[3] = 0x1A;
  bytes[4] = prg; bytes[5] = chr >>> 1; bytes[6] = 0; bytes[7] = 0;
  for (let i = 0; i < prg * 16384; i++) bytes[16 + i] = 0xEA;
  bytes[16 + 0x7FFC] = 0x00; bytes[16 + 0x7FFD] = 0xC0;
  bytes[16 + 0x7FFE] = 0x00; bytes[16 + 0x7FFF] = 0xC0;
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

// Same corrected button order as netplay.js.
const BUTTON_ORDER = [4, 5, 6, 7, 0, 1, 2, 3]; // UP,DOWN,LEFT,RIGHT,A,B,SEL,START

function maskToByte(arr) {
  let b = 0;
  for (let i = 0; i < 8; i++) if (arr[i]) b |= (1 << i);
  return b;
}
function byteToMask(b) {
  const arr = new Array(8).fill(0);
  for (let i = 0; i < 8; i++) if ((b >> i) & 1) arr[i] = 1;
  return arr;
}

function makeClient(name, isHost) {
  const c = {
    name, ws: null, active: false, role: isHost ? 'host' : 'guest',
    player: isHost ? 1 : 2, room: null, romReady: false, frame: 0,
    haveRemote: false,
    remoteInput: { p1: new Array(8).fill(0), p2: new Array(8).fill(0) },
    localInput: { p1: new Array(8).fill(0), p2: new Array(8).fill(0) },
    pending: [], lastSentFrame: -1, lastRx: 0, lastStep: 0,
    STALL_TIMEOUT: 3000, closed: false, nes: null, errors: 0
  };
  c.log = (m) => console.log(`[${name}] ${m}`);
  c.send = (obj) => { if (c.ws && c.ws.readyState === 1) c.ws.send(JSON.stringify(obj)); };
  c.sendInput = () => {
    c.send({ type: 'p2p', data: { type: 'input', frame: c.frame, p1: maskToByte(c.localInput.p1), p2: maskToByte(c.localInput.p2) } });
  };
  c.becomeReady = () => {
    c.romReady = true; c.frame = 0;
    // Preserve frame-0 input that may have arrived during 'syncing' (the bug fix).
    c.pending = c.pending.filter((p) => p.frame > 0);
    c.lastSentFrame = -1; c.lastStep = Date.now();
  };
  // Mirror GG.step() exactly.
  c.step = () => {
    if (!c.active || !c.romReady) return false;
    if (c.lastSentFrame < c.frame) { c.sendInput(); c.lastSentFrame = c.frame; }
    if (Date.now() - c.lastStep > c.STALL_TIMEOUT) {
      c.log('*** STALL GUARD -> bailLockstep (single-player) ***');
      c.romReady = false; c.haveRemote = false; c.pending = []; c.lastSentFrame = -1;
      return true;
    }
    if (c.haveRemote) {
      c.frame++;
      c.haveRemote = false;
      c.lastStep = Date.now();
      for (let i = 0; i < c.pending.length; i++) {
        if (c.pending[i].frame === c.frame) {
          c.remoteInput.p1 = byteToMask(c.pending[i].p1);
          c.remoteInput.p2 = byteToMask(c.pending[i].p2);
          c.haveRemote = true;
          c.pending.splice(i, 1);
          break;
        }
      }
      return true;
    }
    return false;
  };
  c.maybeLog = () => {
    if (c.romReady && c.frame > 0 && c.frame % 25 === 0) c.log(`frame ${c.frame}`);
  };
  c.applyRemote = (nesObj) => {
    if (!c.active || !c.romReady) return;
    const arr = c.player === 1 ? c.remoteInput.p2 : c.remoteInput.p1;
    const target = c.player === 1 ? 2 : 1;
    for (let i = 0; i < 8; i++) {
      const btn = BUTTON_ORDER[i];
      if (arr[i]) nesObj.buttonDown(target, btn); else nesObj.buttonUp(target, btn);
    }
  };
  c.runFrame = () => {
    if (!(c.active && c.romReady)) return;
    c.maybeLog();
    try {
      if (!c.step()) return;
      c.applyRemote(c.nes);
    } catch (err) {
      c.errors++;
      c.log('*** LOCKSTEP ERROR: ' + ((err && err.stack) || err) + ' ***');
      c.active = false; c.romReady = false;
    }
    try { c.nes.frame(); } catch (err) {
      c.errors++;
      c.log('*** nes.frame ERROR: ' + ((err && err.stack) || err) + ' ***');
    }
  };
  c.disconnect = () => {
    if (c.ws) { try { c.send({ type: 'leave' }); } catch (e) {} try { c.ws.close(); } catch (e) {} }
    c.ws = null; c.closed = true; c.active = false; c.romReady = false;
  };
  c.handlePeer = (data) => {
    if (!data) return;
    c.lastRx = Date.now();
    if (data.type === 'guest-joined' && c.role === 'host') {
      c.log('guest-joined -> reset + send ROM');
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
        c.remoteInput.p1 = byteToMask(data.p1);
        c.remoteInput.p2 = byteToMask(data.p2);
      } else if (data.frame > c.frame) {
        c.pending.push({ frame: data.frame, p1: data.p1, p2: data.p2 });
      }
      return;
    }
    if (data.type === 'peer-left') {
      c.log('*** PEER-LEFT (this is the bug we must NOT hit) ***');
      c.active = false; c.romReady = false;
    }
  };
  return c;
}

const host = makeClient('HOST', true);
const guest = makeClient('GUEST', false);
host.nes = createNES();
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
    console.log('\n=== NETPLAY RESULT ===');
    console.log('host frame:', host.frame, 'closed:', host.closed, 'errors:', host.errors);
    console.log('guest frame:', guest.frame, 'closed:', guest.closed, 'errors:', guest.errors);
    if (host.errors > 0 || guest.errors > 0) console.log('FAIL: exception during lockstep');
    else if (host.closed || guest.closed) console.log('FAIL: a side disconnected');
    else if (host.frame > 1 && guest.frame > 1) console.log('SUCCESS: both advanced past frame 0, no stall/disconnect/freeze');
    else console.log('FAIL: deadlock');
    process.exit(0);
  }
}, 20);
