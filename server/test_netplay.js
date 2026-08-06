// End-to-end test: simulate the netplay.js client logic against the relay.
// Host creates a room, sends a "ROM", guest acks 'ready', then both exchange
// frame input. Logs exactly what each side sends/receives to find deadlocks.
'use strict';
const { WebSocket } = require('ws');

const URL = 'ws://localhost:3000';

function makeClient(logName) {
  const c = { ws: null, active: false, role: null, player: null, room: null,
              romReady: false, frame: 0, haveRemote: false, lastSentFrame: -1,
              pending: [], remoteInput: { p1: [0,0,0,0,0,0,0,0], p2: [0,0,0,0,0,0,0,0] },
              logName };
  c.log = (m) => console.log(`[${logName}] ${m}`);
  c.send = (obj) => { if (c.ws && c.ws.readyState === 1) c.ws.send(JSON.stringify(obj)); };
  c.sendInput = () => {
    c.send({ type: 'p2p', data: { type: 'input', frame: c.frame, p1: 0, p2: 0 } });
    c.log(`sent input frame ${c.frame}`);
  };
  c.step = () => {
    if (!c.active || !c.romReady) return false;
    if (c.lastSentFrame < c.frame) { c.sendInput(); c.lastSentFrame = c.frame; }
    if (c.haveRemote) {
      c.frame++;
      c.haveRemote = false;
      c.log(`advanced to frame ${c.frame}`);
      return true;
    }
    return false;
  };
  c.handlePeer = (data) => {
    if (!data) return;
    if (data.type === 'rom' && c.role === 'guest') {
      c.log(`got ROM (${data.name}, ${data.bytes ? data.bytes.length : 0} bytes)`);
      c.romReady = true;
      c.send({ type: 'p2p', data: { type: 'ready' } });
      c.log('sent ready ack');
      return;
    }
    if (data.type === 'ready' && c.role === 'host') {
      c.log('got ready ack');
      c.romReady = true;
      c.frame = 0; c.haveRemote = false; c.pending = []; c.lastSentFrame = -1;
      return;
    }
    if (data.type === 'input') {
      if (data.frame === c.frame) {
        c.haveRemote = true;
        c.remoteInput.p1 = data.p1; c.remoteInput.p2 = data.p2;
        c.log(`got input frame ${data.frame} (current ${c.frame})`);
      } else if (data.frame > c.frame) {
        c.pending.push({ frame: data.frame, p1: data.p1, p2: data.p2 });
        c.log(`buffered input frame ${data.frame} (current ${c.frame})`);
      } else {
        c.log(`DROPPED stale input frame ${data.frame} (current ${c.frame})`);
      }
      return;
    }
  };
  return c;
}

const host = makeClient('HOST');
const guest = makeClient('GUEST');

host.ws = new WebSocket(URL);
host.ws.on('open', () => host.send({ type: 'create' }));
host.ws.on('message', (d) => {
  const m = JSON.parse(d);
  if (m.type === 'created') {
    host.role = 'host'; host.player = 1; host.active = true; host.room = m.room;
    host.log(`created room ${m.room}`);
    // Connect guest now
    guest.ws = new WebSocket(URL);
    guest.ws.on('open', () => guest.send({ type: 'join', room: m.room }));
    guest.ws.on('message', (dg) => {
      const gm = JSON.parse(dg);
      if (gm.type === 'joined') { guest.role = 'guest'; guest.player = 2; guest.active = true; guest.room = gm.room;
        guest.log(`joined room ${gm.room}`);
        // host would send rom on guest-joined; simulate
        host.send({ type: 'p2p', data: { type: 'rom', name: 'test.nes', bytes: 'FAKE_ROM_BYTES' } });
        host.log('sent ROM');
      } else if (gm.type === 'peer') { guest.handlePeer(gm.data); }
    });
  } else if (m.type === 'peer') { host.handlePeer(m.data); }
});

// Run lockstep for both sides
let frames = 0;
const timer = setInterval(() => {
  if (host.romReady) host.step();
  if (guest.romReady) guest.step();
  frames++;
  if (frames > 60) {
    clearInterval(timer);
    console.log('\n=== RESULT ===');
    console.log('host frame:', host.frame, 'haveRemote:', host.haveRemote);
    console.log('guest frame:', guest.frame, 'haveRemote:', guest.haveRemote);
    if (host.frame > 1 && guest.frame > 1) {
      console.log('SUCCESS: both sides advanced past frame 0');
    } else {
      console.log('DEADLOCK: one or both sides stuck at frame 0');
    }
    process.exit(0);
  }
}, 20);
