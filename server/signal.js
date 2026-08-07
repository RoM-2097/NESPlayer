/* ============================================================
   NESPLAYER — WebRTC Signaling Server (Socket.io)
   ------------------------------------------------------------
   Serves the static app AND relays WebRTC signaling messages
   (SDP offers/answers + ICE candidates) between the Host and
   Guest of a netplay room. This server does NOT relay game data
   — once the two peers have exchanged SDP/ICE through this
   signaling channel, they connect directly peer-to-peer over
   WebRTC data channels (UDP, unordered, unreliable) and all
   gameplay traffic flows strictly between the two browsers.

   Why WebRTC instead of WebSockets?
   --------------------------------
   WebSockets run over TCP (reliable + ordered). A single dropped
   packet triggers retransmission that blocks every frame behind
   it (head-of-line blocking) — catastrophic for a real-time game.
   WebRTC RTCDataChannel runs over UDP. With ordered:false and
   maxRetransmits:0, each input frame is fire-and-forget: a lost
   frame just means we hold the last received input for one frame,
   so the game keeps running at full speed and never desyncs.

   Run:  npm install   (installs `socket.io`)
         npm start     (or: node server/signal.js)
   ============================================================ */
'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const ROOT = path.resolve(__dirname, '..');

/* ---------- Static file serving (so the app + signaling share a host) ---------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.map': 'application/json'
};

function serveStatic(req, res) {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  // Path traversal guard.
  const filePath = path.normalize(path.join(ROOT, urlPath));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: Object.keys(rooms).length }));
    return;
  }
  serveStatic(req, res);
});

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

/* ---------- WebRTC signaling relay ---------- */
// rooms: code -> { host: socketId, guest: socketId|null }
const rooms = {};

// Room codes: 4 chars from an unambiguous alphabet (no 0/O/1/I/L).
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function genCode() {
  let code = '';
  for (let i = 0; i < 4; i++) code += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
  return code;
}

function getSockets(room) {
  const r = rooms[room];
  if (!r) return {};
  return { host: io.sockets.sockets.get(r.host) || null, guest: r.guest ? io.sockets.sockets.get(r.guest) || null : null };
}

function to(socket, event, data) {
  if (socket && socket.connected) socket.emit(event, data);
}

io.on('connection', (socket) => {
  socket.room = null;
  socket.player = null;

  socket.on('create-room', (cb) => {
    let code = genCode();
    while (rooms[code]) code = genCode();
    rooms[code] = { host: socket.id, guest: null };
    socket.room = code;
    socket.player = 1;
    if (typeof cb === 'function') cb({ ok: true, room: code, player: 1 });
  });

  socket.on('join-room', (payload, cb) => {
    const code = String((payload && payload.room) || '').toUpperCase();
    const room = rooms[code];
    if (!room) {
      if (typeof cb === 'function') cb({ ok: false, error: 'Room not found' });
      return;
    }
    if (room.guest) {
      if (typeof cb === 'function') cb({ ok: false, error: 'Room is full' });
      return;
    }
    room.guest = socket.id;
    socket.room = code;
    socket.player = 2;
    if (typeof cb === 'function') cb({ ok: true, room: code, player: 2 });
    // Tell the host a guest has joined so it can start offering.
    const { host } = getSockets(code);
    to(host, 'peer-joined', {});
  });

  // Relay signaling packets (SDP offer/answer, ICE candidates) to the peer.
  socket.on('signal', (payload) => {
    if (!socket.room) return;
    const room = rooms[socket.room];
    if (!room) return;
    const peer = socket.player === 1 ? room.guest : room.host;
    if (!peer) return;
    const peerSocket = io.sockets.sockets.get(peer);
    if (peerSocket && peerSocket.connected) {
      peerSocket.emit('signal', { from: socket.player, data: payload });
    }
  });

  socket.on('disconnect', () => {
    if (!socket.room) return;
    const code = socket.room;
    const room = rooms[code];
    if (!room) { socket.room = null; return; }
    if (room.host === socket.id) {
      delete rooms[code];
      const { guest } = getSockets(code);
      to(guest, 'peer-left', {});
    } else if (room.guest === socket.id) {
      room.guest = null;
      const { host } = getSockets(code);
      to(host, 'peer-left', {});
    }
    socket.room = null;
  });
});

server.listen(PORT, () => {
  console.log('[nesplayer] WebRTC signaling + static server on port ' + PORT);
});
