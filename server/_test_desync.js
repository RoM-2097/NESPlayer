// DEFINITIVE desync test: does the HOST's reloadROM() boot state match the
// GUEST's fresh loadROM() boot state? If they differ, the lockstep diverges
// and one side hits an illegal opcode -> that side freezes while the other
// keeps running (the reported "host freezes after player disconnected" bug).
//
// This test does NOT run any frames (so a NOP-ROM crash can't hang it). It
// compares the two post-load toJSON() states field-by-field.
'use strict';
const m = require('../js/neslib/jsnes.min.js');
const jsnes = m.jsnes || m;
const NES = jsnes.NES;

// Install the SAME stop+frame polyfills netplay.js uses (so illegal-opcode
// crashes halt gracefully instead of throwing/hanging).
if (NES && NES.prototype) {
  if (typeof NES.prototype.stop === 'undefined') {
    NES.prototype.stop = function () { this.running = false; this.crashMessage = 'Game crashed: invalid opcode'; };
  }
  if (typeof NES.prototype.__frameSafe === 'undefined') {
    NES.prototype.__frameSafe = true;
    NES.prototype.frame = function () {
      if (this.running === false) return;
      if (this.running === undefined) this.running = true;
      var ppu = this.ppu, t = 0, s = this.opts.emulateSound, i = this.cpu, e = ppu, h = this.papu;
      ppu.startFrame();
      outer: for (;;) {
        if (this.running === false) break outer;
        for (0 === i.cyclesToHalt ? (t = i.emulate(), s && h.clockFrameCounter(t), t *= 3) : i.cyclesToHalt > 8 ? (t = 24, s && h.clockFrameCounter(8), i.cyclesToHalt -= 8) : (t = 3 * i.cyclesToHalt, s && h.clockFrameCounter(i.cyclesToHalt), i.cyclesToHalt = 0); t > 0; t--) {
          if (e.curX === e.spr0HitX && 1 === e.f_spVisibility && e.scanline - 21 === e.spr0HitY) e.setStatusFlag(e.STATUS_SPRITE0HIT, true);
          if (e.requestEndFrame && 0 === --e.nmiCounter) { e.requestEndFrame = false; e.startVBlank(); break outer; }
          e.curX++; 341 === e.curX && (e.curX = 0, e.endScanline());
        }
      }
      this.fpsFrameCount++;
    };
  }
}

// A ROM that actually renders (valid reset vector to a self-loop that enables
// rendering) so frame() is safe and realistic.
function makeRom() {
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
const ROM = makeRom();

function makeNES() {
  return new NES({ onFrame: function(){}, onAudioSample: null, onStatusUpdate: function(){}, preferredFrameRate: 60, emulateSound: false, sampleRate: 44100 });
}

// HOST: load, play a few frames (joining a session mid-game), then reloadROM.
const host = makeNES();
host.loadROM(ROM);
for (let i = 0; i < 5; i++) host.frame();   // play some single-player frames
host.reloadROM();                            // guest-join handler
const hostState = host.toJSON();

// GUEST: fresh create + load (mirrors guest loadRomString).
const guest = makeNES();
guest.loadROM(ROM);
const guestState = guest.toJSON();

// Deep-compare, skipping the heavy PPU buffers (rebuilt each frame) + romData.
function compare(a, b, path, out, depth) {
  if (depth > 4) return true;
  let same = true;
  for (const k in a) {
    const av = a[k], bv = b[k];
    if (typeof av === 'object' && av !== null && typeof bv === 'object' && bv !== null) {
      if (!compare(av, bv, path + '.' + k, out, depth + 1)) same = false;
    } else if (av !== bv) {
      out.push('DIFF ' + path + '.' + k + ': host=' + av + ' guest=' + bv);
      same = false;
    }
  }
  return same;
}
const out = [];
const same = compare(hostState, guestState, 'state', out, 0);
console.log('=== host reloadROM() vs guest fresh load() ===');
if (same) {
  console.log('IDENTICAL: host reloadROM == guest fresh load (NO desync)');
} else {
  console.log('*** DESYNC: ' + out.length + ' differences ***');
  out.slice(0, 40).forEach(l => console.log('  ' + l));
}
process.exit(0);
