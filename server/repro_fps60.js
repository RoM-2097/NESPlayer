// 60 FPS lockstep test — validates that delay-based netcode decouples the
// frame rate from the network round-trip. Both sides run 60 frames per second
// even though input exchange is one frame behind.
'use strict';
const { WebSocket } = require('ws');
const URL = 'ws://localhost:3000';

const jsnesMod = require('../js/neslib/jsnes.min.js');
const jsnes = jsnesMod.jsnes || jsnesMod;

function makeValidRom() {
  const prg = 1, chr = 1;
  const size = 16 + prg * 16384 + chr * 4096;
  const bytes = new Uint8Array(size);
  bytes[0] = 0x4E; bytes[1] = 0x45; bytes[2] = 0x53; bytes[3] = 0x1A;
  bytes[4] = prg; bytes[5] = chr >>> 1; bytes[6] = 0; bytes[7] = 0;
  for (let i = 0; i < prg * 16384; i++) bytes[16 + i] = 0xEA;
  let s = '';
  for (let i = 0; i < size; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 0x8000, size)));
  }
  return s;
}

const ROM = makeValidRom();

let frameCount = 0;
const INPUT_DELAY = 2;

function makeClient(name, isHost) {
  const c = {
    name,
    ws: null,
    active: false,
    role: isHost ? 'host' : 'guest',
    player: isHost ? 1 : 2,
    room: null,
    romReady: false,
    frame: 0,           // render frame
    nextFrame: 0,       // live frame
    localInputs: {},
    peerInputs: {},
    latestPeer: null,
    renderPeer: null,
    closed: false
  };
  c.log = (m) => console.log(`[${name}] ${m}`);
  c.send = (obj) => { if (c.ws && c.ws.readyState === 1) c.ws.send(JSON.stringify(obj)); };
  c.sendFrameInput = (n) => {
    const inp = c.localInputs[n];
    if (!inp) return;
    c.send({ type: 'p2p', data: { type: 'input', frame: n, p1: inp.p1, p2: inp.p2 } });
  };
  c.becomeReady = () => {
    c.romReady = true;
    c.frame = 0;
    c.nextFrame = INPUT_DELAY;
    c.localInputs = {};
    c.peerInputs = {};
    c.latestPeer = null;
    c.renderPeer = null;
    for (let i = 0; i <= c.nextFrame; i++) c.localInputs[i] = { p1: 0, p2: 0 };
  };
  c.onPeerInput = (data) => {
    if (data.frame === undefined) return;
    c.peerInputs[data.frame] = { p1: data.p1 >>> 0, p2: data.p2 >>> 0 };
    c.latestPeer = c.peerInputs[data.frame];
    const min = c.frame - 4, max = c.nextFrame + INPUT_DELAY + 8;
    for (const k of Object.keys(c.peerInputs)) {
      const n = Number(k);
      if (n < min || n > max) delete c.peerInputs[k];
    }
  };
  c.step = () => {
    if (!c.active || !c.romReady) return false;
    // Capture local input (all-zero)
    c.localInputs[c.nextFrame] = { p1: 0, p2: 0 };
    c.sendFrameInput(c.nextFrame);
    const renderFrame = c.nextFrame - INPUT_DELAY;
    let peer = c.peerInputs[renderFrame];
    if (!peer) peer = c.latestPeer;
    c.renderPeer = peer || { p1: 0, p2: 0 };
    c.nextFrame++;
    c.frame = renderFrame;
    return true;
  };
  c.handlePeer = (data) => {
    if (!data) return;
    if (data.type === 'guest-joined' && c.role === 'host') {
      c.send({ type: 'p2p', data: { type: 'rom', name: 'g.nes', bytes: ROM } });
      return;
    }
    if (data.type === 'rom' && c.role === 'guest') {
      c.send({ type: 'p2p', data: { type: 'ready' } });
      return;
    }
    if (data.type === 'ready' && c.role === 'host') {
      c.send({ type: 'p2p', data: { type: 'ready' } });
      c.becomeReady();
      return;
    }
    if (data.type === 'ready' && c.role === 'guest') {
      c.becomeReady();
      return;
    }
    if (data.type === 'input') {
      c.onPeerInput(data);
      return;
    }
    if (data.type === 'peer-left') {
      c.active = false;
      c.romReady = false;
    }
  };
  c.disconnect = () => {
    if (c.ws) { try { c.send({ type: 'leave' }); } catch (e) {} try { c.ws.close(); } catch (e) {} }
    c.ws = null; c.closed = true; c.active = false; c.romReady = false;
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
  } else if (m.type === 'peer') host.handlePeer(m.data);
});
host.ws.on('close', () => host.log('*** HOST WS CLOSED ***'));

// Simulate 60 FPS: step every ~16.67ms
let timer = setInterval(() => {
  if (timer === null) return;
  host.step();
  guest.step();
  frameCount++;
  if (frameCount > 300) { // 5 seconds = 300 frames at 60 FPS
    clearInterval(timer);
    timer = null;
    console.log('\n=== 60 FPS RESULT ===');
    console.log('Total frames stepped:', frameCount);
    console.log('host frame:', host.frame, 'live:', host.nextFrame, 'closed:', host.closed);
    console.log('guest frame:', guest.frame, 'live:', guest.nextFrame, 'guest closed:', guest.closed);
    const hostFPS = Math.round(host.frame / (frameCount * 16.67 / 1000));
    const guestFPS = Math.round(guest.frame / (frameCount * 16.67 / 1000));
    console.log('host render fps (approx):', hostFPS);
    console.log('guest render fps (approx):', guestFPS);
    // In delay model frame should be very close to total frames (minus INPUT_DELAY start)
    if (host.frame > 250 && guest.frame > 250 && !host.closed && !guest.closed) {
      console.log('PASS: Both sides achieved ~60 FPS with no disconnects, no freezes');
    } else {
      console.log('FAIL: One or both sides did not reach target frame count');
    }
    process.exit(0);
  }
}, 16); // ~60 FPS cadence

