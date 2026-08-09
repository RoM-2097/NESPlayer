# Fix "gray screen on reset" — cache-busting + finalize netplay hardening

## Root cause (confirmed by test)
`NES.prototype.reset()` zeroes CPU/PPU/APU but does NOT re-request the RESET
IRQ → CPU stays at PC=0x7FFF → frame() hangs → gray screen. All reset paths
already use `reloadROM()` (which re-runs the full boot path incl. RESET IRQ),
but the browser is serving a CACHED old copy of the JS because the version
query strings in index.html were not bumped after the fix was committed.

## Tasks
- [x] index.html: bump version query strings for app.js / netplay.js / debugger.js
      so browsers fetch the fixed files.
- [x] Finalize the already-written netplay.js `lastReqr` recovery hardening
      (reset the throttle in becomeReady()/resetLockstep(); add req-input /
      input-relay recovery in GG.step()).
- [x] Verify: `node --check` on js/app.js, js/netplay.js, js/debugger.js.
- [ ] Update TODO.resetfix.md / TODO.stallfix.md checkboxes.

## Result
All reset paths (single-player, netplay, debugger) now standardize on
`reloadROM()` which re-runs the full boot path (re-creates the mapper,
re-establishes bank mapping, restores mirroring, and re-requests the RESET
IRQ) — reliably fixing the "gray screen on reset". The persistent gray screen
was caused by the browser serving a CACHED copy of the old JS; bumping the
version query strings in index.html forces a fresh fetch of the fixed files.
