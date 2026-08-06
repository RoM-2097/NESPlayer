// Reproduction: mirrors netplay.js exactly (ready-handshake + stall guard +
// guest not ready until host ack-back) against the relay, to find the guest
// disconnect after it receives the ROM.
'use strict';
const { WebSocket } = require('ws');
const URL = 'ws://localhost:3000';

function makeClient(name, isHost) {
  const c = {
    name, ws: null, active: false, role: isHost ? 'host' : 'guest',
    player: isHost ? 1 : 2, room: null, romReady: false, frame: 0,
    haveRemote: false, pending: [], lastSentFrame: -1, lastStep: 0,
    STALL_TIMEOUT: 3000, closed: false
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
      c.log('STALL GUARD -> disconnect');
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
      const bytes = 'F'.repeat(4096); // pretend a ROM
      c.send({ type: 'p2p', data: { type: 'rom', name: 'g.nes', bytes } });
      return;
    }
    if (data.type === 'rom' && c.role === 'guest') {
      c.log(`got ROM (${data.bytes.length} bytes) -> loading (NOT ready yet)`);
      // app.js loadRom runs synchronously here; assume success
      c.send({ type: 'p2p', data: { type: 'ready' } });
      c.log('sent ready ack (still not romReady)');
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
    guest.ws.on('error', (e) => guest.log('*** GUEST WS ERROR ***'));
  } else if (m.type === 'peer') host.handlePeer(m.data);
});
host.ws.on('close', () => host.log('*** HOST WS CLOSED ***'));
host.ws.on('error', () => host.log('*** HOST WS ERROR ***'));

let frames = 0;
const timer = setInterval(() => {
  host.step();
  guest.step();
  frames++;
  if (frames > 120) {
    clearInterval(timer);
    console.log('\n=== RESULT ===');
    console.log('host frame:', host.frame, 'host closed:', host.closed);
    console.log('guest frame:', guest.frame, 'guest closed:', guest.closed);
    if (host.frame > 1 && guest.frame > 1) console.log('SUCCESS: both advanced past frame 0');
    else console.log('FAIL: deadlock or disconnect');
    process.exit(0);
  }
}, 20);
