// Verify the netplay.js polyfill (stop + frame override) does NOT break normal
// playback: a ROM that enables PPU rendering must still render frames (fpsFrameCount
// increments) exactly like the original core. Then verify that a ROM that never
// enables rendering (which made the ORIGINAL minified frame() spin forever) now
// returns cleanly.
'use strict';
const m = require('../js/neslib/jsnes.min.js');
const jsnes = m.jsnes || m;
const NES = jsnes.NES;
const fs = require('fs');

// ---- Mirror the polyfill from js/netplay.js ----
(function polyfillJSNESStop() {
  try {
    var NESCLS = jsnes.NES;
    if (NESCLS && NESCLS.prototype) {
      if (typeof NESCLS.prototype.stop === 'undefined') {
        NESCLS.prototype.stop = function () {
          this.running = false;
          this.crashMessage = 'Game crashed: invalid opcode';
        };
      }
      if (typeof NESCLS.prototype.__frameSafe === 'undefined') {
        NESCLS.prototype.__frameSafe = true;
        var ORIG_FRAME = NESCLS.prototype.frame;
        NESCLS.prototype.frame = function () {
          if (this.running === false) return;
          if (this.running === undefined) this.running = true;
          var ppu = this.ppu;
          ppu.startFrame();
          var t = 0, s = this.opts.emulateSound, i = this.cpu, e = ppu, h = this.papu;
          outer: for (;;) {
            if (this.running === false) break outer;
            for (0 === i.cyclesToHalt ? (t = i.emulate(), s && h.clockFrameCounter(t), t *= 3) : i.cyclesToHalt > 8 ? (t = 24, s && h.clockFrameCounter(8), i.cyclesToHalt -= 8) : (t = 3 * i.cyclesToHalt, s && h.clockFrameCounter(i.cyclesToHalt), i.cyclesToHalt = 0); t > 0; t--) {
              if (e.curX === e.spr0HitX && 1 === e.f_spVisibility && e.scanline - 21 === e.spr0HitY && e.setStatusFlag(e.STATUS_SPRITE0HIT, !0), e.requestEndFrame && 0 === --e.nmiCounter) { e.requestEndFrame = !1; e.startVBlank(); break outer; }
              e.curX++; 341 === e.curX && (e.curX = 0, e.endScanline());
            }
          }
          this.fpsFrameCount++;
        };
        NESCLS.prototype.frameSafe = ORIG_FRAME;
      }
    }
  } catch (e) { /* ignore */ }
})();

// Build a ROM that enables rendering (writes $08 to $2001/$2000) then self-loops.
function makeRenderRom() {
  const prg = 1, chr = 1;
  const size = 16 + prg * 16384 + chr * 4096;
  const b = new Uint8Array(size);
  b[0] = 0x4E; b[1] = 0x45; b[2] = 0x53; b[3] = 0x1A;
  b[4] = prg; b[5] = chr >>> 1; b[6] = 0; b[7] = 0;
  const base = 0xC000, prgOff = base - 0x8000;
  const code = [0xA9, 0x08, 0x8D, 0x01, 0x20, 0xA9, 0x08, 0x8D, 0x00, 0x20];
  for (let i = 0; i < code.length; i++) b[16 + prgOff + i] = code[i];
  const loopAddr = base + code.length;
  b[16 + prgOff + code.length] = 0x4C;
  b[16 + prgOff + code.length + 1] = loopAddr & 0xFF;
  b[16 + prgOff + code.length + 2] = (loopAddr >> 8) & 0xFF;
  b[16 + 0x7FFC] = base & 0xFF; b[16 + 0x7FFD] = (base >> 8) & 0xFF;
  b[16 + 0x7FFE] = base & 0xFF; b[16 + 0x7FFF] = (base >> 8) & 0xFF;
  let s = '';
  for (let i = 0; i < size; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, Math.min(i + 0x8000, size)));
  return s;
}

// Build a ROM that NEVER enables rendering (all NOPs, self-loop) — the case that
// made the ORIGINAL minified frame() spin forever.
function makeNoRenderRom() {
  const prg = 1, chr = 1;
  const size = 16 + prg * 16384 + chr * 4096;
  const b = new Uint8Array(size);
  b[0] = 0x4E; b[1] = 0x45; b[2] = 0x53; b[3] = 0x1A;
  b[4] = prg; b[5] = chr >>> 1; b[6] = 0; b[7] = 0;
  for (let i = 0; i < prg * 16384; i++) b[16 + i] = 0xEA; // NOPs
  b[16 + 0x7FFC] = 0x00; b[16 + 0x7FFD] = 0xC0;
  b[16 + 0x7FFE] = 0x00; b[16 + 0x7FFF] = 0xC0;
  let s = '';
  for (let i = 0; i < size; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, Math.min(i + 0x8000, size)));
  return s;
}

const out = [];
function makeNes() {
  return new jsnes.NES({
    onFrame: function () {}, onAudioSample: null, onStatusUpdate: function () {},
    preferredFrameRate: 60, emulateSound: false, sampleRate: 44100
  });
}

// Case 1: rendering ROM -> must render normally (no hang, fpsFrameCount increments).
const r1 = makeNes();
r1.loadROM(makeRenderRom());
let f1 = 0;
const t1 = Date.now();
for (let i = 0; i < 5; i++) { r1.frame(); f1++; }
out.push('Case1 (rendering ROM): frame() ran ' + f1 + 'x in ' + (Date.now() - t1) + 'ms, fpsFrameCount=' + r1.fpsFrameCount + ' -> ' + (f1 === 5 && r1.fpsFrameCount >= 5 ? 'RENDERS NORMALLY' : 'FAIL'));

// Case 2: no-render ROM -> the ORIGINAL would hang forever; the override must return.
const r2 = makeNes();
r2.loadROM(makeNoRenderRom());
let f2 = 0;
const t2 = Date.now();
for (let i = 0; i < 3; i++) { r2.frame(); f2++; }
out.push('Case2 (no-render ROM): frame() returned ' + f2 + 'x in ' + (Date.now() - t2) + 'ms -> ' + (f2 === 3 ? 'NO HANG (fixed)' : 'POSSIBLE HANG'));

fs.writeFileSync('_test_render_safe_out.txt', out.join('\n'), 'utf8');
console.log(out.join('\n'));
process.exit(0);
