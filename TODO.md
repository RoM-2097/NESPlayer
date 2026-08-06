# Netplay Full Game-Loop Integration

## Tasks
- [x] 1. netplay.js: Set host's `romReady`/start when the guest joins (host currently never becomes ready).
- [x] 2. netplay.js: Fix frame-0 deadlock — each player must send their input for the current frame even before receiving the peer's (track `lastSentFrame`).
- [x] 3. netplay.js: Reset host emulator on guest join so both sides boot from the same reset state.
- [x] 4. app.js: Fix host `romBytes` getter (it wrongly passes the binary string through `buildBinaryString`).
- [x] 5. app.js: Add `loadRomString` to `window.__nesplayer` so the guest can load the received ROM bytes.
- [x] 6. app.js: Make `applyInput` target controller 2 when the local player is the guest.
- [x] 7. app.js: Make `releaseAllInput` target the correct controller in netplay mode.
- [x] 8. app.js: Make `netplayFeed` send local input into the correct controller slot (p1 for host, p2 for guest).
- [x] 9. app.js: Wire `netplayFeed()` + `GG.step()` + `GG.applyRemote()` into `stepEmulator()` (gate frames on peer input).
- [x] 10. Validate with `node --check`.

## Additional Fix
- [x] Install missing `ws` dependency in `server/` so the relay server can start (root cause of "create room does nothing").
- [x] netplay.js: Surface WebSocket connect failures (onerror/onclose/timeout) so the UI doesn't hang on "Connecting…".
- [x] netplay.js: Add a default server URL fallback derived from the page origin (or `ws://localhost:3000`).
- [x] netplay.js: Add a ready-handshake so the host starts the lockstep only after the guest has loaded the ROM and connected (fixes host freeze / guest gray-screen deadlock).

## Post-fix (this session)
- [x] netplay.js: Add `GG.isReady()` (active && romReady) so the host does NOT freeze
      while waiting for a guest to join/sync.
- [x] app.js: Gate `stepEmulator()` lockstep on `GG.isReady()` instead of `GG.isActive()`.
- [x] index.html: Bump `netplay.js`/`app.js` cache-buster.

## Post-fix round 2 (connection-loss / freeze hardening)
- [x] netplay.js: Add a lockstep stall guard (`lastActivity` + `STALL_TIMEOUT`) in `GG.step()`.
- [x] netplay.js: `ws.onclose` fully resets lockstep state.
- [x] netplay.js: `peer-left` handler fully resets lockstep state.
- [x] Validate: `node --check` + lockstep protocol test passes.

## Current fixes (user feedback: host froze + guest had to load a ROM)
- [x] 1. index.html: Add a "Netplay" button to the main (landing) menu so both host and
      guest can open netplay without loading a ROM first.
- [x] 2. netplay.js: Fix the stall guard — track time since the last *received* peer
      message (lastRx) instead of refreshing on every send, so a silently-dead peer
      reliably triggers a disconnect instead of leaving the host frozen.
- [x] 3. netplay.js: Expose `GG.isReady()` and make the host's lockstep gating robust so
      the host never freezes regardless of whether ROM transfer completes.
- [x] 4. Validate with `node --check` and re-run the lockstep protocol test.

## This session (modal polish)
- [x] app.js: Suppress game input while the netplay modal is open (the game was still
      running / receiving input underneath the modal).
- [x] app.js: Escape now closes the netplay modal, and `netplayModalOpen` is included in
      `anyModal` so game shortcuts don't fire while it's open.

## This session (definitive netplay disconnect/freeze fix)
- [x] Reproduce the guest-disconnect / host-freeze bug with the protocol + app-level repros.
- [x] Identify root cause: the ready-handshake in netplay.js resets `haveRemote=false`,
      dropping the peer's already-received frame-0 input (arrives during 'syncing' due to
      message coalescing), deadlocking the guest -> stall-guard disconnect -> host sees
      "Player disconnected" then freezes.
- [x] netplay.js: Add `becomeReady()` that preserves `haveRemote`/`remoteInput` across the
      ready handshake (only filters pending to frames > 0), and use it in both host and
      guest ready handlers so the peer's frame-0 input is never dropped.
- [x] Validate with `node --check js/netplay.js` and re-run the lockstep repros against the live relay.
      - `node --check js/netplay.js` -> OK
      - `server/repro3.js` (real jsnes) -> SUCCESS, both advanced to frame 199
      - `server/repro4.js` (frame-0 race) -> PASS, frame-0 input preserved, no stall/disconnect
