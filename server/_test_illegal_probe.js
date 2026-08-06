// Definitive probe: build a ROM that executes an ILLEGAL 6502 opcode, apply
// the SAME polyfill that netplay.js now installs (stop() + frame() override
// that checks `running`), and confirm frame() returns instead of spinning
// forever in the minified `t:for(;;)` loop.
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

// Build a ROM whose reset vector points to an ILLEGAL 6502 opcode (0x02, not
// a real instruction) so the CPU immediately calls nes.stop().
function makeIllegalRom() {
  const prg = 1, chr = 1;
  const size = 16 + prg * 16384 + chr * 4096;
  const b = new Uint8Array(size);
  b[0] = 0x4E; b[1] = 0x45; b[2] = 0x53; b[3] = 0x1A;
  b[4] = prg; b[5] = chr >>> 1; b[6] = 0; b[7] = 0;
  // Reset vector -> $C000. At $C000 place the ILLEGAL opcode 0x02.
  const base = 0xC000, prgOff = base - 0x8000;
  b[16 + prgOff] = 0x02;          // illegal opcode
  b[16 + 0x7FFC] = base & 0xFF;
  b[16 + 0x7FFD] = (base >> 8) & 0xFF;
  b[16 + 0x7FFE] = base & 0xFF;
  b[16 + 0x7FFF] = (base >> 8) & 0xFF;
  let s = '';
  for (let i = 0; i < size; i += 0x8000) {
    s += String.fromCharCode.apply(null, b.subarray(i, Math.min(i + 0x8000, size)));
  }
  return s;
}

const rom = makeIllegalRom();
const nes = new jsnes.NES({
  onFrame: function () {},
  onAudioSample: null,
  onStatusUpdate: function () {},
  preferredFrameRate: 60,
  emulateSound: false,
  sampleRate: 44100
});
nes.loadROM(rom);

// Call frame() with a hard wall-clock guard: if it hangs in the infinite loop,
// the process would never reach this writeFileSync. We also run it in a child
// subprocess style by just timing it here.
const out = [];
out.push('stop defined: ' + typeof NES.prototype.stop);
out.push('frame overridden: ' + (NES.prototype.frame !== NES.prototype.frameSafe));
const t0 = Date.now();
let frames = 0;
try {
  for (let i = 0; i < 3; i++) { nes.frame(); frames++; }
  out.push('frame() returned ' + frames + ' times in ' + (Date.now() - t0) + 'ms (NO HANG)');
  out.push('running after crash: ' + nes.running);
  out.push('crashMessage: ' + nes.crashMessage);
  out.push('PASS: illegal opcode halted gracefully instead of freezing');
} catch (e) {
  out.push('FAIL: threw ' + (e && e.message));
}
fs.writeFileSync('_test_illegal_out.txt', out.join('\n'), 'utf8');
console.log(out.join('\n'));
process.exit(0);
