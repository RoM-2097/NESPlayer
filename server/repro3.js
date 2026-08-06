// Faithful browser simulation using the REAL jsnes: the guest receives the ROM
// bytes and calls the exact app.js load path (loadRomString -> loadROM ->
// createNES -> nes.loadROM). This heavy synchronous load blocks the event loop
// just like in the browser. We check whether the guest's WS stays open and
// whether lockstep proceeds.
'use strict';
const { WebSocket } = require('ws');
const URL = 'ws://localhost:3000';

// Load the real jsnes (UMD, works in Node via module.exports).
const jsnesMod = require('../js/neslib/jsnes.min.js');
const jsnes = jsnesMod.jsnes || jsnesMod;

// Build a minimal, valid NES ROM (16-byte header + 16KB PRG + 8KB CHR).
function makeValidRom() {
  const prg = 1, chr = 1;
  const size = 16 + prg * 16384 + chr * 4096;
  const bytes = new Uint8Array(size);
  bytes[0] = 0x4E; bytes[1] = 0x45; bytes[2] = 0x53; bytes[3] = 0x1A; // "NES\x1a"
  bytes[4] = prg; bytes[5] = chr >>> 1; bytes[6] = 0; bytes[7] = 0;
  // Fill PRG with an infinite loop (0x4C self-jump) so frame() is safe.
  for (let i = 0; i < prg * 16384; i++) bytes[16 + i] = 0xEA; // NOPs
  // Build binary string exactly like app.js buildBinaryString.
  let s = '';
  for (let i = 0; i < size; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 0x8000, size)));
  }
  return s;
}

const ROM = makeValidRom();

// Mirror app.js createNES enough to run a frame (need onFrame + onAudioSample).
function createNES() {
  return new jsnes.NES({
    onFrame: function () {},
    onAudioSample: null,
    onStatusUpdate: function (m) { console.log('[jsnes]', m); },
    preferredFrameRate: 60,
    emulateSound: false,
    sampleRate: 44100
  });
}

// Mirror app.js loadRomString -> loadROM.
function loadRomString(str, fileName) {
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i) & 0xFF;
  const nes = createNES();
  const dataStr = (() => {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 0x8000, bytes.length)));
    }
    return s;
  })();
  nes.loadROM(dataStr);
  return nes;
}

function makeClient(name, isHost) {
  const c = {
    name, ws: null, active: false, role: isHost ? 'host' : 'guest',
    player: isHost ? 1 : 2, room: null, romReady: false, frame: 0,
    haveRemote: false, pending: [], lastSentFrame: -1, lastStep: 0,
    STALL_TIMEOUT: 3000, closed: false, loadMs: 0
  };
  c.log = (m) => console.log(`[${name}] ${m}`);
  c.send = (obj) => { if (c.ws && c.ws.readyState === 1) c.ws.send(JSON.stringify(obj)); };
  c.sendInput = () => {
    c.send({ type: 'p2p', data: { type: 'input', frame: c.frame, p1: 0, p2: 0 } });
  };
  c.step = () => {
    if (!c.active || !c.romReady) return false;
    if (c.lastSentFrame < c.frame) { c.sendInput(); c.lastSentFrame = c.frame; }
    if (!c.haveRemote && Date.now() - c.lastStep > c.STALL_TIMEOUT) {
      c.log('*** STALL GUARD -> disconnect ***');
      c.disconnect();
      return true;
    }
    if (c.haveRemote) {
      c.frame++;
      c.haveRemote = false;
      c.lastStep = Date.now();
      for (let i = 0; i < c.pending.length; i++) {
        if (c.pending[i].frame === c.frame) {
          c.remoteInput = c.pending[i]; c.haveRemote = true;
          c.pending.splice(i, 1); break;
        }
      }
      if (c.frame % 10 === 0) c.log(`advanced to frame ${c.frame}`);
      return true;
    }
    return false;
  };
  c.disconnect = () => {
    if (c.ws) { try { c.send({ type: 'leave' }); } catch (e) {} try { c.ws.close(); } catch (e) {} }
    c.ws = null; c.closed = true; c.active = false; c.romReady = false;
    c.log('disconnected');
  };
  c.handlePeer = (data) => {
    if (!data) return;
    if (data.type === 'guest-joined' && c.role === 'host') {
      c.log('guest-joined -> sending ROM');
      c.send({ type: 'p2p', data: { type: 'rom', name: 'g.nes', bytes: ROM } });
      return;
    }
    if (data.type === 'rom' && c.role === 'guest') {
      c.log(`got ROM (${data.bytes.length} chars) -> loadRomString...`);
      const t0 = Date.now();
      try {
        c.nes = loadRomString(data.bytes, data.name);
        c.loadMs = Date.now() - t0;
        c.log(`loadRomString done in ${c.loadMs}ms -> sending ready (romReady still false)`);
        c.send({ type: 'p2p', data: { type: 'ready' } });
      } catch (e) {
        c.log('*** loadRomString FAILED: ' + e.message);
      }
      return;
    }
    if (data.type === 'ready' && c.role === 'host') {
      c.log('got guest ready -> ack back + become ready');
      c.send({ type: 'p2p', data: { type: 'ready' } });
      c.romReady = true; c.frame = 0; c.haveRemote = false;
      c.pending = []; c.lastSentFrame = -1; c.lastStep = Date.now();
      return;
    }
    if (data.type === 'ready' && c.role === 'guest') {
      c.log('got host ready ack -> become ready');
      c.romReady = true; c.frame = 0; c.haveRemote = false;
      c.pending = []; c.lastSentFrame = -1; c.lastStep = Date.now();
      return;
    }
    if (data.type === 'input') {
      if (data.frame === c.frame) { c.haveRemote = true; c.remoteInput = data; }
      else if (data.frame > c.frame) c.pending.push(data);
      return;
    }
    if (data.type === 'peer-left') {
      c.log('*** PEER-LEFT (peer disconnected) ***');
      c.active = false; c.romReady = false;
    }
  };
  return c;
}

const host = makeClient('HOST', true);
const guest = makeClient('GUEST', false);

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
    guest.ws.on('error', (e) => guest.log('*** GUEST WS ERROR: ' + (e && e.message) + ' ***'));
  } else if (m.type === 'peer') host.handlePeer(m.data);
});
host.ws.on('close', () => host.log('*** HOST WS CLOSED ***'));
host.ws.on('error', () => host.log('*** HOST WS ERROR ***'));

let frames = 0;
const timer = setInterval(() => {
  host.step();
  guest.step();
  frames++;
  if (frames > 400) {
    clearInterval(timer);
    console.log('\n=== RESULT ===');
    console.log('guest load took:', guest.loadMs + 'ms');
    console.log('host frame:', host.frame, 'host closed:', host.closed);
    console.log('guest frame:', guest.frame, 'guest closed:', guest.closed);
    if (host.frame > 1 && guest.frame > 1) console.log('SUCCESS: both advanced past frame 0');
    else console.log('FAIL: deadlock or disconnect');
    process.exit(0);
  }
}, 20);
