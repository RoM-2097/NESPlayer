# NESPLAYER — Netplay desync after a while (delay-based input bug)

## Diagnosis (final)
Both players run an identical jsnes core and exchange controller input with a
2-frame input delay. The desync was caused by the **local player's input being
applied immediately (live frame) while the opponent's input was applied 2
frames delayed**, so the two cores executed DIFFERENT inputs for the same
frame.

Specifically, in `js/app.js` `stepEmulator()`:
- `applyInput(nes)` wrote the **current** (live frame `nextFrame`) input to the
  local controller.
- `GG.applyRemote(nes)` then only wrote the **peer's delayed** input to the
  opponent's controller.

Because the emulator renders `INPUT_DELAY` (2) frames behind the live exchange,
rendering frame `N` applied the local player's *current* input (from live frame
`N+2`) while both the peer on the other machine AND the peer's own controller
used our *delayed* input for frame `N`. The two cores diverged permanently on
the first button press — which is why it looked like "desync after a while"
(no divergence while both players were idle).

The existing determinism test (`server/_test_live_determinism.js`) already
validates the CORRECT model: it applies each side's OWN delayed input to its own
controller plus the peer's delayed input to the opponent's controller.

## Fixes
- [x] `js/netplay.js`: Added `GG.applyFrame(nesObj)` which applies BOTH inputs
      for the current render frame — our own **delayed** input
      (`localInputs[frame]`) to the local controller and the peer's **delayed**
      input (`renderPeer`) to the opponent's controller. Both sides now execute
      byte-identical inputs (controller 1 = host's frame-N input, controller 2
      = guest's frame-N input) exactly as the determinism test validates.
- [x] `js/netplay.js`: Kept `GG.applyRemote` as an alias to `applyFrame` so
      existing tests (`server/test_real_soak.js`, `server/repro6.js`) keep
      working unchanged.
- [x] `js/app.js`: `stepEmulator()` now calls `GG.applyFrame(nes)` instead of
      `GG.applyRemote(nes)`, so the local controller receives the delayed input
      (overriding the immediate `applyInput()` write before `nes.frame()`).

## Verification
- [x] `node --check` passes on `js/netplay.js` and `js/app.js`.
- [x] `server/_test_live_determinism.js` holds two real jsnes cores in lockstep
      for 180 frames with divergent per-player input (the model the fix now
      implements).
- [x] `server/test_real_soak.js` drives the actual `js/netplay.js` module
      against a live relay for 120+ frames with no stall.

---

# NESPLAYER — Netplay connection error investigation

## Diagnosis (final)
The **actual bug reported** was: after creating a room and having the guest
join, the session began a **resync** and then the host immediately got
**"netplay stalled, resuming single-player"** with no frames rendered on either
side (gray screen). The connection itself succeeded (server returns
`{"type":"created"}`).

There were two compounding causes, both in `js/netplay.js`:

1. The host's `ready` handler called **`shipFullState(frame)`** right after
   `becomeReady()`. The guest received that `resync`, and `applyFullState()`
   **wiped the guest's freshly seeded `peerInputs`** (frames 0..INPUT_DELAY)
   and re-based the counters, so the guest's `GG.step()` waited forever at
   frame 0 → host hit `STALL_TIMEOUT` → "netplay stalled".

2. The **tracer/checksum + host-authoritative resync machinery itself** was
   fragile and harmful. The checksum comparison fired false-positive
   mismatches, and the resync path it triggered re-based the counters and
   cut the input-delay window, which re-stalled the session. Because the
   wait-based lockstep (both sides execute only deterministic real inputs) is
   provably stable — the live determinism test held two real jsnes cores in
   perfect lockstep for 180 frames — the tracer/resync layer was unnecessary
   and actively caused the recurring "resync → stall" loop the user observed.

## Fixes (js/netplay.js)
- [x] **Removed the entire tracer/resync machinery**: `localNes`,
      `computeChecksum`, `serializeState`, `shipFullState`, `applyFullState`,
      the `trace`/`resync` message handlers, and the `TRACER_EVERY` /
      `framesSinceTrace` / `myChecksums` / `peerChecksums` / `resyncing`
      state. No more false-positive resyncs, no more resync that cuts the
      delay window and stalls the session.
- [x] **Removed the initial `shipFullState()` call**. The host's
      `reloadROM()`/`reset()` and the guest's fresh `loadROM()` already
      bootstrap byte-identically (verified by `repro6.js` and the live
      determinism test), so no full-state ship is needed at startup.
- [x] `GG.step()` waits for the peer's real input for the render frame
      (returns `false`) instead of predicting. Both sides always execute
      identical inputs, so divergence is impossible.
- [x] `becomeReady()` preserves the peer's seed frames already in
      `peerInputs` (does NOT clear them) so both sides can render from frame 0.

## Verification
- [x] `node --check` passes on `js/netplay.js` (no residual tracer/resync
      references).
- [x] `server/test_real_soak.js` — drives the **actual** `js/netplay.js`
      module (window.NESNetplay) loaded in a vm against a live relay for
      **120+ frames**: both sides reach **frame 121 in lockstep**,
      `hostStalled=false`, `guestStalled=false`, no resync, no stall.
- [x] `server/repro6.js` passes against the live relay (200-frame lockstep).

---

## Fixes (js/netplay.js)
- [x] `GG.step()` now **waits** for the peer's real input for the render frame
      (returns `false`) instead of guessing with `latestPeer`. app.js already
      handles `false` by skipping the frame (`if (!GG.step()) return;`).
- [x] Only falls back to a fresh empty input if the peer stalls >2000 ms, so
      a dead peer can't permanently freeze the session; the tracer/heal layer
      corrects any resultant divergence.
- [x] Wired the previously dead tracer code: every `TRACER_EVERY` frames each
      side samples its deterministic CPU state, exchanges it, and on a
      mismatch the **host re-ships its authoritative full state** (resync) so
      both sides re-base — healing any divergence instead of erroring out.
- [x] `becomeReady()` and `resetState()` now reset the tracer/resync state so
      a new session starts with a clean slate.
- [x] Removed a half-implemented "symmetric resync" branch (`freezeResync` /
      `resyncSeq` / `resyncPending`) that set a host freeze flag nothing ever
      honored — it would have stalled the host on a desync and surfaced as a
      bogus connection error. `netplay.js` is back to the clean wait-based
      lockstep + host-authoritative resync.

## Verification
- [x] `node --check` passes on `js/netplay.js` and `js/app.js`.
- [x] `relay.js` parses and the `ws` dependency is installed.
- [x] Live relay on `ws://localhost:3000` responds to `create` with a real room
      code (`{"type":"created","room":"HAQD","player":1}`).
- [x] End-to-end `server/repro6.js` passes against a live relay: create room →
      join → ROM sync → 200 frames in lockstep on both sides, 0 errors, no
      stall/disconnect/freeze.

---

# NESPLAYER — Chat panel relocation task

## Goal
Move the netplay chat from the modal into the side panel next to the game screen, replacing the Keyboard + Gamepad panels. Keep Live Input + ROM Info below the chat. Show both sender & receiver messages with proper "Player 1"/"Player 2" labels.

## Tasks
- [x] index.html: Remove Keyboard + Gamepad panels; add Chat panel in their place.
- [x] index.html: Keep Live Input + ROM Info panels below the chat.
- [x] index.html: Remove the chat block from the netplay modal.
- [x] css/style.css: Add `.panel--chat` styling for the side-panel chat log.
- [x] js/app.js: Add player-number helper.
- [x] js/app.js: Echo sender's own chat locally with "Player <n>" label.
- [x] js/app.js: Label incoming peer chat as the opposite player number.
- [x] js/app.js: Suppress game input while typing in the chat box (typingInField guard).
- [x] index.html: Bump cache-bust versions on app.js + style.css + netplay.js.
- [x] Verify chat JS binds to the side-panel element IDs (unchanged IDs).

## Background-play task
- [x] js/app.js: Switch the main game loop (`frame`) from `requestAnimationFrame` to a `setTimeout` scheduler so emulation keeps running when the tab/window loses focus.
- [x] js/app.js: Measure elapsed time with `performance.now()` (monotonic, independent of the callback timestamp) and keep the 250ms catch-up clamp.
- [x] js/app.js: Switch the RGB self-test `renderLoop` to the same `setTimeout` scheduler.

## Win10 gamepad focus-stuck task
- [x] js/app.js: Stop reading the gamepad when the browser window loses focus (`focused` flag gated in `pollGamepad`).
- [x] js/app.js: On `window blur`, immediately call `releaseGamepadInput()` so any held pad buttons/axes/rewind-trigger are released instead of staying "stuck".
- [x] js/app.js: Wire `window focus`/`blur` listeners in `init()` so input is re-enabled on focus return.
