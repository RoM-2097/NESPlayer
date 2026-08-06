// VERIFY deterministic lockstep: does reseting an EXISTING nes (host path:
// nes.reset()) produce the SAME state as creating a FRESH nes and loading the
// ROM (guest path: loadRomString -> loadROM -> createNES + loadROM)?
// If they differ, the host and guest run different code -> desync -> one side
// hits an illegal opcode and freezes (while the other keeps working).
'use strict';
const m = require('../js/neslib/jsnes.min.js');
const jsnes = m.jsnes || m;
const fs = require('fs');

// Apply the same stop() polyfill as netplay.js so illegal opcodes set
// running=false instead of throwing (so we can SEE the host halt).
(function polyfillJSNESStop() {
  try {
    const NESCLS = jsnes.NES;
    if (NESCLS && NESCLS.prototype && typeof NESCLS.prototype.stop === 'undefined') {
      NESCLS.prototype.stop = function () { this.running = false; this.crashMessage = 'Game crashed: invalid opcode'; };
    }
  } catch (e) {}
})();

function makeValidRom() {
  const prg = 1, chr = 1;
  const size = 16 + prg * 16384 + chr * 4096;
  const b = new Uint8Array(size);
  b[0] = 0x4E; b[1] = 0x45; b[2] = 0x53; b[3] = 0x1A;
  b[4] = prg; b[5] = chr >>> 1; b[6] = 0; b[7] = 0;
  for (let i = 0; i < prg * 16384; i++) b[16 + i] = 0xEA;
  b[16 + 0x7FFC] = 0x00; b[16 + 0x7FFD] = 0xC0;
  b[16 + 0x7FFE] = 0x00; b[16 + 0x7FFF] = 0xC0;
  let s = '';
  for (let i = 0; i < size; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, Math.min(i + 0x8000, size)));
  return s;
}
const ROM = makeValidRom();

function makeNes() {
  return new jsnes.NES({
    onFrame: function () {}, onAudioSample: null, onStatusUpdate: function () {},
    preferredFrameRate: 60, emulateSound: false, sampleRate: 44100
  });
}

const out = [];

// HOST path: load, play a bit, then reset (mirrors guest-join -> nes.reset()).
const host = makeNes();
host.loadROM(ROM);
for (let i = 0; i < 30; i++) host.frame();   // play some frames single-player
host.reset();                                 // guest-join handler resets
const hostState = host.toJSON();

// GUEST path: fresh create + load (mirrors guest loadRomString).
const guest = makeNes();
guest.loadROM(ROM);
const guestState = guest.toJSON();

// Compare a few key fields (skip the heavy PPU buffers / romData string).
function compare(a, b, path, out, depth) {
  if (depth > 3) return true;
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
const path = 'state';
const same = compare(hostState, guestState, path, out, 0);
out.unshift('=== host reset() vs guest fresh-load ===');
out.push(same ? 'IDENTICAL: host reset == guest fresh load (no desync)' : 'DESYNC: host reset != guest fresh load (' + out.length + ' diffs)');
fs.writeFileSync('_test_hostreset_out.txt', out.join('\n'), 'utf8');
console.log(out.join('\n'));
process.exit(0);
