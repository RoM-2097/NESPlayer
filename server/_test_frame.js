// Prove the real jsnes frame() behavior with a ROM that enables PPU rendering
// and loops, so VBlank (scanline 261) triggers and frame() returns. This is
// the definitive test for whether the stop() polyfill lets lockstep run.
'use strict';
const m = require('../js/neslib/jsnes.min.js');
const jsnes = m.jsnes || m;
const NES = jsnes.NES;
const fs = require('fs');

// Apply the same stop() polyfill as netplay.js BEFORE creating NES instances.
if (NES.prototype && typeof NES.prototype.stop === 'undefined') {
  NES.prototype.stop = function () { this.running = false; this.crashMessage = 'Game crashed: invalid opcode'; };
}

// Build a ROM whose reset vector points to a tiny routine that enables
// rendering (write $08 to $2001, $08 to $2000) then JMPs to itself.
function makeRom() {
  const prg = 1, chr = 1;
  const size = 16 + prg * 16384 + chr * 4096;
  const b = new Uint8Array(size);
  b[0] = 0x4E; b[1] = 0x45; b[2] = 0x53; b[3] = 0x1A;
  b[4] = prg; b[5] = chr >>> 1; b[6] = 0; b[7] = 0;
  // 6502 code at $C000:
  //   LDA #$08   (A9 08)
  //   STA $2001  (8D 01 20)
  //   LDA #$08   (A9 08)
  //   STA $2000  (8D 00 20)
  // loop: JMP loop (4C xx xx)
  const base = 0xC000;            // absolute address
  const prgOff = base - 0x8000;   // offset within PRG data (after 16-byte header)
  const code = [0xA9, 0x08, 0x8D, 0x01, 0x20, 0xA9, 0x08, 0x8D, 0x00, 0x20];
  for (let i = 0; i < code.length; i++) b[16 + prgOff + i] = code[i];
  // JMP loop (self) at address base+code.length
  const loopAddr = base + code.length;
  b[16 + prgOff + code.length] = 0x4C;
  b[16 + prgOff + code.length + 1] = loopAddr & 0xFF;
  b[16 + prgOff + code.length + 2] = (loopAddr >> 8) & 0xFF;
  // Reset vector at $FFFC-$FFFD -> $C000
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

const rom = makeRom();
const out = [];
const nes = new jsnes.NES({
  onFrame: function () {},
  onAudioSample: null,
  onStatusUpdate: function () {},
  preferredFrameRate: 60,
  emulateSound: false,
  sampleRate: 44100
});
try {
  nes.loadROM(rom);
  out.push('loadROM OK');
  let frames = 0;
  for (let i = 0; i < 5; i++) { nes.frame(); frames++; }
  out.push('frame() ran ' + frames + ' times WITHOUT hanging/throwing');
  out.push('crashMessage: ' + (nes.crashMessage || '(none)'));
} catch (e) {
  out.push('THREW: ' + e.message);
}
fs.writeFileSync('_test_frame_out.txt', out.join('\n'), 'utf8');
console.log(out.join('\n'));
process.exit(0);
