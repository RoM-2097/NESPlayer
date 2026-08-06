// Isolate the "host reset() hangs" hypothesis. The host loads a ROM, plays a
// few frames single-player, then calls nes.reset() on guest-join. If reset()
// never returns, the host's guest-joined handler is stuck and never sends the
// ROM -> the guest never becomes ready -> host stalls -> "Player disconnected".
'use strict';
const m = require('../js/neslib/jsnes.min.js');
const jsnes = m.jsnes || m;

function makeValidRom() {
  const prg = 1, chr = 1;
  const size = 16 + prg * 16384 + chr * 4096;
  const b = new Uint8Array(size);
  b[0] = 0x4E; b[1] = 0x45; b[2] = 0x53; b[3] = 0x1A;
  b[4] = prg; b[5] = chr >>> 1; b[6] = 0; b[7] = 0;
  for (let i = 0; i < prg * 16384; i++) b[16 + i] = 0xEA;
  let s = '';
  for (let i = 0; i < size; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, Math.min(i + 0x8000, size)));
  return s;
}
const ROM = makeValidRom();

const nes = new jsnes.NES({
  onFrame: function () {}, onAudioSample: null, onStatusUpdate: function () {},
  preferredFrameRate: 60, emulateSound: false, sampleRate: 44100
});

nes.loadROM(ROM);
console.log('loaded');
for (let i = 0; i < 30; i++) nes.frame();
console.log('played 30 frames');

// Wrap reset() with a timeout so a hang is detected.
let resetDone = false;
let resetThrew = null;
const t0 = Date.now();
try {
  nes.reset();
  resetDone = true;
} catch (e) {
  resetThrew = e;
}
const elapsed = Date.now() - t0;

console.log('reset() returned:', resetDone, 'threw:', resetThrew, 'elapsed:', elapsed + 'ms');
if (resetDone) {
  console.log('RESET OK — reset() does NOT hang');
} else {
  console.log('RESET HANG — reset() blocked the event loop');
}
process.exit(0);
