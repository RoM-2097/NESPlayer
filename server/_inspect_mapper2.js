'use strict';
const m = require('../js/neslib/jsnes.min.js');
const jsnes = m.jsnes || m;

// Construct a valid MMC1 ROM (mapper 1) and inspect the mapper's loadROM / reset.
function makeMmc1Rom() {
  const prg = 2, chr = 1;
  const size = 16 + prg * 16384 + chr * 4096;
  const b = new Uint8Array(size);
  b[0] = 0x4E; b[1] = 0x45; b[2] = 0x53; b[3] = 0x1A;
  b[4] = prg; b[5] = chr >>> 1; b[6] = 0; b[7] = 1; // mapper 1
  let s = '';
  for (let i = 0; i < size; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, Math.min(i + 0x8000, size)));
  return s;
}

const nes = new jsnes.NES({ onFrame: function () {}, onAudioSample: null, onStatusUpdate: function () {}, preferredFrameRate: 60, emulateSound: false, sampleRate: 44100 });
nes.loadROM(makeMmc1Rom());
console.log('mapper:', nes.rom.getMapperName());
console.log('mmap type:', nes.mmap.constructor && nes.mmap.constructor.name);
console.log('=== mmap.loadROM ===');
console.log(nes.mmap.loadROM.toString());
console.log('=== mmap.reset ===');
console.log(nes.mmap.reset && nes.mmap.reset.toString());
console.log('=== mmap has requestIrq? ===');
console.log(typeof nes.mmap.nes, typeof nes.mmap.requestIrq);
