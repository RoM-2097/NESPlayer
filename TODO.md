# NESPLAYER — WebRTC Netplay Migration (replace WebSocket relay)

## Goal
Fix the host/guest desync by replacing the TCP WebSocket relay with **WebRTC
peer-to-peer data channels** (UDP, unordered, unreliable) for game input, using
a lightweight **Socket.io signaling server** only to exchange SDP/ICE during
connection setup. Once connected, traffic is strictly peer-to-peer. Inputs are
packed into a compact binary format (4 bytes/frame).

## Rationale
- WebSockets run on **TCP** (reliable + ordered). A single dropped packet
  triggers retransmission that stalls ALL frames behind it (head-of-line
  blocking) — catastrophic for real-time games.
- **WebRTC `RTCDataChannel`** runs over **UDP**. With `ordered:false` and
  `maxRetransmits:0`, each frame is fire-and-forget: a lost frame just means
  we hold the last received input for one frame (delay-based prediction), so
  the game never stalls and never desyncs.
- The signaling server does NOT relay game data — only SDP offers, answers,
  and ICE candidates during the handshake.

## Tasks
- [ ] Vendor the Socket.io client locally under `js/neslib/`.
- [ ] `server/signal.js`: Socket.io signaling server (create-room / join-room /
      signal relay) + static file host. Reads `PORT` from env.
- [ ] `server/package.json`: add `socket.io`, point `main`/`start` to
      `signal.js`.
- [ ] `server/relay.js`: keep as a legacy WebSocket option (or remove).
- [ ] `js/netplay.js`: rewrite to use `RTCPeerConnection` + two data channels
      (`reliable` for ROM/chat, `input` unordered/unreliable for game inputs)
      + binary input packing (frame hi/lo + p1 byte + p2 byte = 4 bytes).
- [ ] `js/netplay.js`: keep the SAME public API (`window.NESNetplay`) so
      `app.js` needs no changes.
- [ ] `index.html`: load the vendored Socket.io client; bump `netplay.js` cache
      version.
- [ ] `README.md`: document the WebRTC + signaling architecture.
- [ ] Verify: `npm install` in `server/`; `node --check` on JS files.

## Verification
- [ ] Local test: two browser tabs on `http://localhost:3000` create/join a
      room and stay in lockstep.
