# Fix "gray screen on reset"

## Root cause
`NES.prototype.reset()` zeroes the CPU/PPU/APU but does NOT re-request the
RESET IRQ. Without it the CPU stays at PC=0x7FFF executing garbage and never
drives the PPU to VBlank, so `frame()` hangs forever → gray/black screen.

## Existing (uncommitted) fix — already correct
- `js/app.js` `resetNES()`: `nes.reset()` + `nes.cpu.requestIrq(IRQ_RESET)` —
  used by the toolbar Reset button and Key-R.
- `js/netplay.js` `resetCore()`/`GG.reset()`/`resetLockstep()`: same IRQ fix +
  netplay lockstep frame counter re-sync.

## Remaining gap
- [x] `js/debugger.js` `resetApply()` (Reset & Apply button) calls bare
      `nes.reset()` → same gray screen. Apply the IRQ_RESET re-request there.

## Verification
- [x] `node --check js/debugger.js`
- [x] `node --check js/app.js`
- [x] `node --check js/netplay.js`
