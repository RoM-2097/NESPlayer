/* ============================================================
   NESPLAYER — Netplay Relay Server (Node.js + ws)
   ------------------------------------------------------------
   Serves the static app AND relays WebSocket messages between
   the two players of a netplay room (host = Player 1, guest =
   Player 2). This lets a single process host both the page and
   the WebSocket, so a same-origin `ws://`/`wss://` connection
   just works on free cloud hosts (Render / Railway / Glitch).

   Run:  npm install   (installs `ws`)
         npm start     (or: node server/relay.js)
   ============================================================ */
'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const ROOT = path.resolve(__dirname, '..');

/* ---------- Static file serving (so the app + relay share a host) ---------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json'
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

/* ---------- WebSocket relay ---------- */
const wss = new WebSocketServer({ server });

// rooms: code -> { host: ws, guest: ws|null }
const rooms = {};

// Room codes: 4 chars from an unambiguous alphabet (no 0/O/1/I/L).
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function genCode() {
  let code = '';
  for (let i = 0; i < 4; i++) code += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
  return code;
}

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function cleanup(ws) {
  if (!ws.room) return;
  const r = rooms[ws.room];
  if (!r) { ws.room = null; return; }
  if (r.host === ws) {
    if (r.guest && r.guest.readyState === 1) {
      send(r.guest, { type: 'peer', data: { type: 'peer-left' } });
    }
    delete rooms[ws.room];
  } else if (r.guest === ws) {
    r.guest = null;
    if (r.host.readyState === 1) {
      send(r.host, { type: 'peer', data: { type: 'peer-left' } });
    }
  }
  ws.room = null;
}

function handleMessage(ws, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch (e) { return; }

  switch (msg.type) {
    case 'create': {
      let code = genCode();
      while (rooms[code]) code = genCode();
      rooms[code] = { host: ws, guest: null };
      ws.room = code;
      ws.player = 1;
      send(ws, { type: 'created', room: code, player: 1 });
      break;
    }
    case 'join': {
      const code = String(msg.room || '').toUpperCase();
      const room = rooms[code];
      if (!room) { send(ws, { type: 'error', message: 'Room not found' }); break; }
      if (room.guest) { send(ws, { type: 'error', message: 'Room is full' }); break; }
      room.guest = ws;
      ws.room = code;
      ws.player = 2;
      send(ws, { type: 'joined', room: code, player: 2 });
      send(room.host, { type: 'peer', data: { type: 'guest-joined' } });
      break;
    }
    case 'p2p': {
      if (!ws.room) break;
      const room = rooms[ws.room];
      if (!room) break;
      const peer = ws.player === 1 ? room.guest : room.host;
      if (peer && peer.readyState === 1) {
        send(peer, { type: 'peer', data: msg.data });
      }
      break;
    }
    case 'leave':
      cleanup(ws);
      break;
    default:
      break;
  }
}

wss.on('connection', (ws) => {
  ws.room = null;
  ws.player = null;
  ws.on('message', (data) => handleMessage(ws, data));
  ws.on('close', () => cleanup(ws));
  ws.on('error', () => cleanup(ws));
});

server.listen(PORT, () => {
  console.log('[nesplayer] netplay relay + static server on port ' + PORT);
});
