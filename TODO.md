# NESPLAYER - NES Emulator Web App — TASK CHECKLIST

## Continuing the "complete debugger" task after extension crash

### v2.9 Assembler/Debugger (already complete pre-crash)
- [x] 1. `js/asm6502.js` — `window.ASM6502` library (opcode table, 2-pass assembler, disassembler)
- [x] 2. `js/debugger.js` — `window.NESDebugger` (registers, disasm at PC, hex editor RAM/PRG, assembler box, Step/Run/Close)
- [x] 3. `index.html` — `#btnDebug` toolbar button, `#debugModal` markup, script tags for `asm6502.js` + `debugger.js`
- [x] 4. `css/style.css` — debug modal layout, register grid, disasm rows, hex-table cells, assembler styles
- [x] 5. `js/app.js` — debug button/modal wiring, open/close lifecycle (auto-pause), one-frame Step hook, `G` shortcut
- [x] 6. Docs — README debugger section + tech notes
- [x] 7. Verify — `node --check` on `asm6502.js`, `debugger.js`, `app.js`

### v2.10 Game Genie-style Cheat Overlay (remaining work after crash)
- [x] 1. `index.html` — `#btnCheats` toolbar button, `#cheatModal` markup, `C` shortcut panel entry, cache-bust `?v=20240915.11`, badge `v2.10`
- [x] 2. `css/style.css` — cheat modal layout, cheat list rows, input row
- [x] 3. `js/app.js` — cheats state, hex code parser (`ADDR:VALUE` / `ADDR:VALUE:COMPARE`), Game Genie decoder, `applyCheats()` frame hook, open/close wiring, `C` shortcut, clear-on-ROM-load, toast feedback
- [x] 4. `README.md` — document Cheats (controls, code format, Game Genie support)
- [x] 5. Final verify — `node --check js/app.js` passes

### Current work (v2.10 completion, resumed after crash)
- [x] A. `js/app.js` — add `GG_ALPHABET` + `decodeGameGenie()` (6- and 8-letter codes → addr/value/compare) wired into `addCheatFromInput()`
- [x] B. `css/style.css` — add cheat modal styles (`.cheat-input-row`, `.cheat-input`, `.cheat-list`, `.cheat-empty`, `.cheat-row` + parts)
- [x] C. `README.md` — add Cheat Codes section / feature bullet / keyboard `C`
- [x] D. Mark v2.10 steps 3-5 complete + `node --check js/app.js`

### v2.10.1 Fix Game Genie decode (resumed after crash)
- [x] 1. `js/app.js` — replace broken `swapBits()` nibble-swap decoder with the patent-accurate bit-field formulas
- [x] 2. `README.md` — document the corrected Game Genie decoding algorithm
- [x] 3. `index.html` — bump cache-bust query string so the fixed `app.js` is served fresh (`?v=20240916.03`)
- [x] 4. Verify — `node --check` on `js/app.js` + confirm `GZUXNGEI` decodes to `$2C3F` (verified via standalone node script: `GZUXNGEI -> addr=0x2C3F value=0x24` PASS)

### Final verify (v2.10)
- [x] `node --check` passes on `js/app.js`, `js/asm6502.js`, `js/debugger.js`
- [x] Cache-bust `?v=20240915.11` + badge `v2.10` confirmed in `index.html`
- [x] Full-stack grep confirmations: `btnDebug`/`cheatModal`/`asm6502.js`/`debugger.js` script tags present; `dbg-*`/`cheat-*` CSS present; `NESDebugger`/`GG_ALPHABET`/`decodeGameGenie`/`applyCheats` wiring present in `app.js`

### v2.10 Game Genie decoder fix (after crash)
- [x] `js/app.js` — `decodeGameGenie()` replaced with patent-accurate bit-field formulas
  (6-letter: address/data; 8-letter bank-switch: address/data/compare)
- [x] `js/app.js` — decoder now returns the **15-bit PRG offset** (e.g. `GZUXNG` → `$2C3F`);
  `addCheatFromInput` ORs in `$8000` before storing so the mapper read-hook matches the
  full `$8000-$FFFF` CPU window, while the UI label shows the user-facing offset
- [x] `README.md` — Game Genie section documents the bit-field layout + offset convention
- [x] Verified with `node`: `GZUXNG` → offset `$2C3F` value `$24` ; 8-char `GZUXNGEI` →
  `$2D38` value `$24` compare `$C7` ; famous ref `SXIOPO` → `$11D9`=`$AD` (full `$91D9`)
- [x] `node --check js/app.js` → SYNTAX_OK

## Final Project Structure
```
index.html                  # App shell + landing + player views
css/style.css               # Modern dark glassmorphism UI
js/app.js                   # Full application logic (incl. cheats)
js/asm6502.js               # 6502 assembler + disassembler library
js/debugger.js              # RAM/PRG hex editor + CPU debugger
js/neslib/jsnes.min.js      # Vendored emulator core (1.2.1)
README.md                   # Setup & usage docs
```

