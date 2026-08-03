# Nova · NESPLAYER — NES Emulator for the Web

**A [Nova](/) brand.** A modern, browser-based NES emulator with a sleek dark glassmorphism UI. Load individual `.nes` ROMs and play with keyboard or an Xbox/Gamepad controller.

## Getting Started

1. **Open** `index.html` in any modern browser (Chrome, Edge, Firefox recommended).
2. **Load a ROM** — click the "Browse" button or drag-and-drop a `.nes` file onto the landing zone.
3. **Play!**

## Controls

### Keyboard
| Key | NES Button |
|-----|-----------|
| Arrow Keys / WASD | D-Pad |
| Z | B |
| X | A |
| Shift | Select |
| Enter | Start |
| P | Pause/Resume |
| F | Toggle Fullscreen |
| G | Open CPU Debugger |
| C | Open Cheat Codes |
| R | Reset Game |
| Backspace | Hold to Rewind |
| M | Toggle Mute |
| T | RGB Self-Test Pattern (diagnostic) |

### Video Filters

Use the **🎛 Filters** toolbar button to open the video filter menu:

- **Scanlines** — retro CRT scanline overlay (toggle switch)
- **Static** — subtle animated TV-static noise overlay (toggle switch)
- **Color Mode** — remap the full picture to a new palette:
  **Original** (default), **Gameboy** (4-shade green), **EGA** (16-color),
  **CGA** (4-color cyan/magenta), or **B&W** (luminance grayscale).
  Color modes apply at the pixel level via a precomputed 32k-entry LUT, so the
  effect is visible live and baked into recordings.

### Gamepad (Xbox / Standard Layout)
| Gamepad Button | NES Button |
|---------------|-----------|
| A (green) | A |
| B (red) | B |
| Back | Select |
| Start | Start |
| D-Pad / Left Stick | D-Pad |
| RT | Hold to Rewind |
| X / Y / Triggers | Unbound by default — remap via **Bind** |

## Features

- **🎮 ROM Loading** — File picker + drag-and-drop with automatic header validation
- **⌨️ Custom Bindings** — Remap every key and gamepad button in the **Bind** modal (persisted to localStorage)
- **🎛️ Video Filters** — Scanlines + subtle animated static overlays, and color modes: **Original**, **Gameboy**, **EGA**, **CGA**, and **B&W** (pixel-level LUT remap, baked into recordings)
- **🔊 Audio** — Web Audio API with mute toggle and volume slider
- **💾 Save States** — Save/load progress to localStorage (slot 1)
- **📜 Recent ROMs** — Quick-access list of previously loaded games (session cache)
- **🎮 Gamepad Support** — Automatic detection via Gamepad API (Xbox/joystick), incl. analog stick D-Pad emulation
- **📐 FPS Monitor** — Real-time display of **emulated** frames per second
- **⏸️ Pause/Resume** — Freeze gameplay at any time
- **⛶ Fullscreen controls** — Exit button + 4:3 / 16:9 aspect-ratio switcher
- **⏺ Screen Recording** — Record gameplay + audio to WebM via MediaRecorder (V to toggle) — captures **60 FPS** from a crisp **4× nearest-neighbour** capture canvas
- **⟲ Hold-to-Rewind** — Hold Backspace (or gamepad RT) to step back through ~8 seconds of gameplay via a ring buffer of snapshots
- **🐞 CPU Debugger** — Inspect CPU registers (A, X, Y, SP, PC, NV-BDIZC flags), step through code one frame at a time, view PC-following disassembly, edit RAM ($0000) and PRG ROM ($8000) bytes in a click-to-edit hex editor, and assemble 6502 routines (labels, all addressing modes) that write directly into memory
- **✦ Cheat Codes** — Add RAM-poke cheats in `ADDR:VALUE` or `ADDR:VALUE:COMPARE` hex format, or paste Game Genie 6/8-letter codes (auto-decoded). Cheats are re-applied every frame and cleared on ROM load
- **✨ Nova branding** — Studio badge in nav, footer, and console bezel

## Technical Notes

- Uses the [jsnes](https://github.com/bfirsh/jsnes) emulator core (v1.2.1) vendored locally.
- Pure client-side — no server, no network requests after page load.
- Runs at a **fixed 60 FPS timestep** (accumulator-driven `requestAnimationFrame` loop), so gameplay and recordings stay real-time on any display refresh rate (60/120/144 Hz).
- Audio ring buffer prevents underruns.
- **Screen recording** — while recording, each emulated frame is stamped to an
  offscreen 1024×960 canvas (nearest-neighbour 4× upscale) and captured via
  `captureStream(60)` at 12 Mbps — smooth 60 FPS WebM with crisp pixels.
  On stop, the app reports the **measured** average FPS (frames captured ÷ wall-clock
  duration) in the console and the download toast, so a recording's true frame rate is
  verified rather than assumed.
- **Framebuffer format** — jsnes delivers each pixel as a `0x00RRGGBB` integer
  (verified empirically against the vendored bundle; `getRgb(R,G,B) = (R<<16)|(G<<8)|B`).
  `app.js` expands each value to explicit RGBA bytes, so colors are correct
  regardless of CPU endianness or pixel-packing.
- **R↔B channel swap (v2.1)** — Games were observed rendering with red/blue swapped.
  The `onFrame` decode now applies the standard bit-shift channel swap
  (`0xRRGGBB → 0xBBGGRR`): the R byte is read from the original B field and the B byte
  from the original R field, with G unchanged. The RGB self-test (T key) bypasses the
  swap so the diagnostic still reads R·G·B·Y·M·C·W in order for pipeline verification.
- **Cache busting** — assets load with `?v=20240915.11` query strings so an updated
  `app.js` is never shadowed by a stale browser cache. Confirm the nav badge reads
  **v2.10**; if you still see an old build, hard-refresh (Ctrl+Shift+R).

- **CPU Debugger** — The debugger (`G` key or 🐞 toolbar button) auto-pauses the
  emulator and opens a modal with live register readout, PC-following disassembly
  (12 instructions), a click-to-edit hex editor for RAM `$0000` and PRG ROM `$8000`,
  and a 6502 assembler box. The **Step** button runs exactly one emulated frame, then
  re-pauses. The **Run** button closes the debugger and resumes the game. The
  assembler's **Write** button patches bytes directly into CPU memory via
  `cpu.write()` — this works for RAM (any address) and on NROM/CNROM/UNROM mappers
  that accept PRG writes; mapper-controlled cartridges (MMC1, MMC3) may ignore writes
  to ROM areas (a documented hardware limitation). **Reset & Apply** resets the
  console, writes the routine, and sets the PC to the origin address, so the game
  boots into the assembled code.
- **Cheat Codes** — The cheats panel (`C` key or ✦ toolbar button) accepts raw hex
  pokes as `ADDR:VALUE` (e.g. `$8000:A9`) or conditional `ADDR:VALUE:COMPARE`
  (writes only fire while the byte at `ADDR` matches `COMPARE`). Addresses use the
  standard `$NNNN` prefix (plain 1-4 digit hex also works). 6- and 8-letter Game
  Genie codes (e.g. `SXIOPO`) are decoded automatically via the built-in
  `decodeGameGenie()` using the patent-accurate bit-field layout
  (Game Genie letter alphabet `APZLGITYEOXUKSVN`):
  - **6-letter codes** (no bank switching) → address + value
  - **8-letter codes** (bank switching) → address + value + compare
  Each letter contributes scattered single bits to the fields (each code
  letter's low 3 bits and high bit land in different address/data/compare
  positions), so decoding is *not* a simple nibble-per-letter map. The decoder
  returns the **15-bit PRG-ROM offset** in Game Genie convention — for example
  `GZUXNG` decodes to offset `$2C3F` (full CPU address `$AC3F`) with value
  `$24`. Cheats are re-applied to live CPU memory every frame via
  `applyCheats()`, so they survive the game overwriting a value,
  and are cleared whenever a new ROM is loaded. All writes route through
  `cpu.write()`, so addresses above `$1FFF` are forwarded to the mapper (battery
  SRAM or CHR as the mapper dictates) — the same universal memory-writer used by
  the debugger.

## RGB Self-Test (Diagnostic)

Press **T** while in the player view to toggle a test pattern of pure **R · G · B · Y · M · C · W**
bars drawn directly into the canvas (bypassing the emulator). Use it to verify the display pipeline:

- Bars appear with correct color order → the canvas/ImageData pipeline is correct, so any
  incorrect colors in a game come from the ROM itself or the emulator core.
- If bars appear swapped → the browser is serving a **stale cached `app.js`** or a display/color
  override (e.g. OS night/red-green color filter) is active.

## Browser Compatibility

- Chrome 80+
- Edge 80+
- Firefox 85+
- Safari 14.1+

## Project Structure

```
NESPLAYER/
├── index.html          # App shell
├── css/
│   └── style.css       # Full UI styles (dark glassmorphism)
├── js/
│   ├── app.js          # Emulator logic, UI, input handling
│   ├── asm6502.js      # 6502 assembler & disassembler library
│   ├── debugger.js     # CPU debugger: registers, disasm, hex editor, assembler
│   └── neslib/
│       └── jsnes.min.js # Vendored NES emulator core
├── README.md
└── TODO.md
