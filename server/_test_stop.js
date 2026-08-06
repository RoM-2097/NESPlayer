'use strict';
const m = require('../js/neslib/jsnes.min.js');
const jsnes = m.jsnes || m;
const NES = jsnes.NES;

// Apply same polyfill as netplay.js
if (NES.prototype && typeof NES.prototype.stop === 'undefined') {
  NES.prototype.stop = function () { this.running = false; this.crashMessage = 'Game crashed: invalid opcode'; };
}

function makeRom() {
  const prg = 1, chr = 1, size = 16 + prg * 16384 + chr * 4096;
  const b = new Uint8Array(size);
  b[0] = 0x4E; b[1] = 0x45; b[2] = 0x53; b[3] = 0x1A;
  b[4] = prg; b[5] = chr >>> 1; b[6] = 0; b[7] = 0;
  // Fill PRG with NOPs but set a valid reset vector to $C000 (self-NOP loop).
  for (let i = 0; i < prg * 16384; i++) {
    if (i >= 0x7FF0 && i < prg * 16384) b[16 + i] = 0x00; // clear vector area
    else b[16 + i] = 0xEA; // NOP
  }
  // Reset vector at $FFFC (last 4 bytes of PRG): $C000
  // PRG base = 16 (header). $FFFC-$FFFD relative -> within last bank.
  // offset in PRG = 0xFFFC - 0x8000 = 0x7FFC
  b[16 + 0x7FFC] = 0x00;
  b[16 + 0x7FFD] = 0xC0;
  b[16 + 0x7FFE] = 0x00;
  b[16 + 0x7FFF] = 0xC0;
  let s = '';
  for (let i = 0; i < size; i += 0x8000) {
    s += String.fromCharCode.apply(null, b.subarray(i, Math.min(i + 0x8000, size)));
  }
  return s;
}

const rom = makeRom();
const nes = new jsnes.NES({
  onFrame: function () {},
  onAudioSample: null,
  onStatusUpdate: function () {},
  preferredFrameRate: 60,
  emulateSound: false,
  sampleRate: 44100
});
nes.loadROM(rom);

let threw = 'NO THROW';
let frames = 0;
try {
  for (let i = 0; i < 3; i++) { nes.frame(); frames++; }
} catch (e) {
  threw = 'THREW: ' + e.message;
}
require('fs').writeFileSync('_test_out.txt',
  'P1.5 RESULT: ' + threw + '\n' +
  'stop defined: ' + typeof NES.prototype.stop + '\n' +
  'frames ran: ' + frames + '\n',
  'utf8');
// Also console.log so it shows if the terminal captures it.
console.log('P1.5 RESULT:', threw, '| stop:', typeof NES.prototype.stop, '| frames:', frames);
