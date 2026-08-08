# NESPLAYER — Netplay Sync Debug Window

## Goal
Add a debug window to the netplay modal so we can diagnose the ROM-sync freeze
(host + guest connect, but both freeze when trying to sync the ROM). The window
will expose a live state snapshot (role/state/ICE/channel states/frame counters)
and a timestamped event log covering the whole handshake lifecycle.

## Why the freeze happens (working theory to confirm)
In `stepEmulator()` (app.js), if a netplay session is `active` but never becomes
`ready`, the emulator HOLDs forever with no timeout — `GG.step()` and its
`STALL_TIMEOUT` are only reached *after* readiness. So if the `rom` message is
dropped, the `ready` reply is lost, or a data channel silently fails to open,
both sides freeze on a black screen. The debug window will reveal exactly which
stage is stuck.

## Tasks
- [x] `js/netplay.js`: add internal `dbg()` log ring buffer + `onDebug` callback.
- [x] `js/netplay.js`: instrument socket, PC/ICE, data-channel, ROM transfer,
      ready handshake, becomeReady, stall/bail, and endSession with `dbg(...)`.
- [x] `js/netplay.js`: expose `GG.getDebugInfo()` (live snapshot) and
      `GG.getDebugLog()`.
- [x] `index.html`: add a collapsible debug panel inside `#netplayModal`
      (toggle button + state grid + scrolling event log).
- [x] `css/style.css`: style the netplay debug panel (monospace, dark, auto-trim).
- [x] `js/app.js`: add element refs, wire the toggle, set `GG.onDebug`, and add a
      ~250 ms poller that renders `GG.getDebugInfo()` while the panel is open.
- [x] Verify: `node --check` on `js/netplay.js` and `js/app.js`.

## Verification
- [ ] Two tabs create/join a room; open the debug window and confirm the stage
      where sync hangs is visible (ICE connecting? channels opening? ROM sent?
      ready received?).
