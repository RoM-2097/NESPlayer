// Compare reset+IRQ vs reloadROM on a MAPPER ROM (MMC1 / mapper 1).
// Properly constructs an MMC1 ROM with 2 PRG banks + 1 CHR bank.
'use strict';
const m = require('../js/neslib/jsnes.min.js');
const jsnes = m.jsnes || m;
if (jsnes.NES && jsnes.NES.prototype && typeof jsnes.NES.prototype.stop === 'undefined') {
  jsnes.NES.prototype.stop = function () { this.running = false; this.crashMessage = 'crash'; };
}

function makeMmc1Rom() {
  const prg = 2, chr = 1;
  const size = 16 + prg * 16384 + chr * 4096;
  const b = new Uint8Array(size);
  b[0] = 0x4E; b[1] = 0x45; b[2] = 0x53; b[3] = 0x1A;
  b[4] = prg; b[5] = chr >>> 1; b[6] = 0; b[7] = 1; // mapper 1 (MMC1)
  // For MMC1 with 2 PRG banks, bank 0 maps to $8000, bank 1 (last) to $C000.
  // Reset vector @ $FFFC points to $C000 (last bank).
  const base = 0xC000;
  const code = [
    0xAD, 0x10, 0x00, 0x18, 0x69, 0x01, 0x8D, 0x10, 0x00, 0x8D, 0x01, 0x20, 0x4C, 0x00, 0xC0
  ];
  // Write code into the LAST PRG bank (offset prg*0x4000). $C000->$8000 window
  // slot = 0x4000 offset within the bank set starts at $C000-$8000 = 0x4000.
  const lastBankStart = (prg - 1) * 0x4000; // bytes into PRG data array
  const slotOffset = 0x4000;                // $C000 - $8000
  for (let i = 0; i < code.length; i++) b[16 + lastBankStart + slotOffset + i] = code[i];
  // Reset vector at $FFFC in the last bank (offset 0x3FFC within bank).
  b[16 + lastBankStart + 0x3FFC] = base & 0xFF;
  b[16 + lastBankStart + 0x3FFD] = (base >> 8) & 0xFF;
  let s = '';
  for (let i = 0; i < size; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, Math.min(i + 0x8000, size)));
  return s;
}

function testReset(how) {
  let lastFrame = null;
  const nes = new jsnes.NES({
    onFrame: function (buf) { lastFrame = buf.slice(0, 256); },
    onAudioSample: null, onStatusUpdate: function () {},
    preferredFrameRate: 60, emulateSound: false, sampleRate: 44100
  });
  nes.loadROM(makeMmc1Rom());
  for (let i = 0; i < 10; i++) nes.frame();
  const bootPc = nes.cpu.REG_PC;
  const bootN = nes.cpu.mem[0x10];
  const t0 = Date.now();
  let ok = false, err = null;
  try {
    if (how === 'reset+irq') { nes.reset(); nes.cpu.requestIrq(nes.cpu.IRQ_RESET); }
    else if (how === 'reload') { nes.reloadROM(); }
    else if (how === 'reset-only') { nes.reset(); }
    for (let i = 0; i < 5; i++) nes.frame();
    ok = true;
  } catch (e) { err = e.message; }
  const ms = Date.now() - t0;
  const pc = nes.cpu.REG_PC, n = nes.cpu.mem[0x10];
  const top = lastFrame ? lastFrame.slice(0, 256) : null;
  const nonzero = top ? top.filter(v => v !== 0).length : -1;
  console.log(JSON.stringify({ how, ok, err, ms, bootPc: bootPc.toString(16), afterPc: pc.toString(16), bootN, afterN: n, nonzero }));
}

// Run each in try/catch; reloadROM should not hang.
for (const how of ['reset-only', 'reset+irq', 'reload']) {
  try {
    testReset(how);
  } catch (e) {
    console.log(how + ': threw ' + e.message);
  }
}
