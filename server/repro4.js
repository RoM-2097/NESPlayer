// Reproduction: the exact frame-0 race that makes the guest drop the host's
// frame-0 input, stall, disconnect, and make the HOST see "Player disconnected"
// then freeze.
//
// Sequencing that causes the bug:
//   1. Guest connects, receives ROM, sends 'ready' (guest stays in syncing).
//   2. Host receives guest 'ready', sends input AND ack-back. The guest's
//      frame-0 input can arrive at the guest BEFORE the host's ack-back is
//      processed (network jitter / message coalescing), so the guest buffers it
//      as "haveRemote" while still in syncing.
//   3. The host's ack-back arrives -> the guest becomes ready. The OLD code
//      reset haveRemote=false here, dropping the already-received frame-0 input
//      and deadlocking the guest (it waits forever for a frame-0 input that was
//      already consumed). After STALL_TIMEOUT the guest disconnects -> the host
//      receives 'peer-left' = "Player disconnected".
//
// The fix (becomeReady) preserves haveRemote/remoteInput so the guest can
// advance instead of stalling.
'use strict';
const { WebSocket } = require('ws');
const URL = 'ws://localhost:3000';

function makeClient(name, isHost) {
  const c = {
    name, ws: null, active: false, role: isHost ? 'host' : 'guest',
    player: isHost ? 1 : 2, room: null, romReady: false, frame: 0,
    haveRemote: false, remoteInput: null, pending: [], lastSentFrame: -1,
    lastStep: 0, STALL_TIMEOUT: 3000, closed: false, gotHostInputDuringSync: false
  };
  c.log = (m) => console.log(`[${name}] ${m}`);
  c.send = (obj) => { if (c.ws && c.ws.readyState === 1) c.ws.send(JSON.stringify(obj)); };
  c.sendInput = () => { c.send({ type: 'p2p', data: { type: 'input', frame: c.frame, p1: 0, p2: 0 } }); };

  // Mirrors netplay.js becomeReady(): does NOT clobber haveRemote.
  c.becomeReady = () => {
    c.romReady = true;
    c.frame = 0;
    c.pending = c.pending.filter((p) => p.frame > 0);
    c.lastSentFrame = -1;
    c.lastStep = Date.now();
  };

  c.step = () => {
    if (!c.active || !c.romReady) return false;
    if (c.lastSentFrame < c.frame) { c.sendInput(); c.lastSentFrame = c.frame; }
    if (!c.haveRemote && Date.now() - c.lastStep > c.STALL_TIMEOUT) {
      c.log('*** STALL GUARD -> disconnect (would make the peer see "Player disconnected") ***');
      c.disconnect();
      return true;
    }
    if (c.haveRemote) {
      c.frame++; c.haveRemote = false; c.lastStep = Date.now();
      for (let i = 0; i < c.pending.length; i++) {
        if (c.pending[i].frame === c.frame) { c.haveRemote = true; c.remoteInput = c.pending[i]; c.pending.splice(i, 1); break; }
      }
      if (c.frame % 10 === 0) c.log(`advanced to frame ${c.frame}`);
      return true;
    }
    return false;
  };
  c.disconnect = () => {
    if (c.ws) { try { c.send({ type: 'leave' }); } catch (e) {} try { c.ws.close(); } catch (e) {} }
    c.ws = null; c.closed = true; c.active = false; c.romReady = false;
  };
  c.handlePeer = (data) => {
    if (!data) return;
    if (data.type === 'guest-joined' && c.role === 'host') {
      c.send({ type: 'p2p', data: { type: 'rom', name: 'g.nes', bytes: 'FAKE'.repeat(1024) } });
      return;
    }
    if (data.type === 'rom' && c.role === 'guest') {
      c.send({ type: 'p2p', data: { type: 'ready' } }); // guest stays in syncing
      return;
    }
    if (data.type === 'ready' && c.role === 'host') {
      // Host becomes ready. Under real network jitter the host's frame-0 input
      // can be sent (and arrive at the guest) BEFORE the ack-back is processed.
      // Simulate that: become ready, send frame-0 input, THEN send ack.
      c.romReady = true; c.frame = 0; c.haveRemote = false; c.pending = [];
      c.lastSentFrame = -1; c.lastStep = Date.now();
      c.sendInput();                 // host's frame-0 input -> guest
      c.send({ type: 'p2p', data: { type: 'ready' } }); // ack-back -> guest
      return;
    }
    if (data.type === 'ready' && c.role === 'guest') {
      // This is the crux: the guest already has the host's frame-0 input
      // buffered (haveRemote=true) from before the ack. becomeReady() must
      // preserve it.
      c.becomeReady();
      return;
    }
    if (data.type === 'input') {
      if (data.frame === c.frame) {
        c.haveRemote = true;
        c.remoteInput = data;
        if (!c.romReady) c.gotHostInputDuringSync = true;
      } else if (data.frame > c.frame) c.pending.push(data);
      return;
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
    guest.ws = new WebSocket(URL);
    guest.ws.on('open', () => guest.send({ type: 'join', room: m.room }));
    guest.ws.on('message', (dg) => {
      const gm = JSON.parse(dg);
      if (gm.type === 'joined') { guest.active = true; }
      else if (gm.type === 'peer') guest.handlePeer(gm.data);
    });
    guest.ws.on('close', () => guest.log('*** GUEST WS CLOSED ***'));
  } else if (m.type === 'peer') host.handlePeer(m.data);
});
host.ws.on('close', () => host.log('*** HOST WS CLOSED ***'));

let frames = 0;
const timer = setInterval(() => {
  host.step();
  guest.step();
  frames++;
  if (frames > 400) {
    clearInterval(timer);
    console.log('\n=== RACE REPRO RESULT ===');
    console.log('guest received host frame-0 input during syncing:', guest.gotHostInputDuringSync);
    console.log('host frame:', host.frame, 'host closed:', host.closed);
    console.log('guest frame:', guest.frame, 'guest closed:', guest.closed);
    if (guest.gotHostInputDuringSync && host.frame > 1 && guest.frame > 1 && !guest.closed) {
      console.log('PASS: frame-0 input preserved through the ready handshake — no stall, no disconnect.');
    } else {
      console.log('FAIL: guest stalled/disconnected (peer would see "Player disconnected").');
    }
    process.exit(0);
  }
}, 20);
