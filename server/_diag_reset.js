'use strict';
const m = require('../js/neslib/jsnes.min.js');
const jsnes = m.jsnes || m;
if (jsnes.NES && jsnes.NES.prototype && typeof jsnes.NES.prototype.stop === 'undefined') {
  jsnes.NES.prototype.stop = function () { this.running = false; this.crashMessage = 'crash'; };
}

function buildNROM() {
  const prg = 1, chr = 1;
  const size = 16 + prg * 16384 + chr * 4096;
  const b = new Uint8Array(size);
  b[0] = 0x4E; b[1] = 0x45; b[2] = 0x53; b[3] = 0x1A;
  b[4] = prg; b[5] = chr >>> 1; b[6] = 0; b[7] = 0;
  const base = 0xC000, off = base - 0x8000;
  const code = [0xA9, 0x08, 0x8D, 0x01, 0x20, 0x4C, 0x00, 0xC0];
  for (let i = 0; i < code.length; i++) b[16 + off + i] = code[i];
  b[16 + 0x7FFC] = base & 0xFF; b[16 + 0x7FFD] = (base >> 8) & 0xFF;
  let s = '';
  for (let i = 0; i < size; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, Math.min(i + 0x8000, size)));
  return s;
}

const nes = new jsnes.NES({ onFrame: function () {}, preferredFrameRate: 60, emulateSound: false });
nes.loadROM(buildNROM());
console.log('mapper:', nes.rom.getMapperName());
console.log('after loadROM PC:', nes.cpu.REG_PC.toString(16));
console.log('irqRequested:', nes.cpu.irqRequested, 'irqType:', nes.cpu.irqType);
console.log('mmap.reset?:', typeof nes.mmap.reset);
// Try a frame
let ok = false, err = null;
try { nes.frame(); ok = true; } catch (e) { err = e.message; }
console.log('first frame ok:', ok, 'err:', err, 'PC:', nes.cpu.REG_PC.toString(16));
