'use strict';
const m = require('../js/neslib/jsnes.min.js');
const jsnes = m.jsnes || m;
if (jsnes.NES && jsnes.NES.prototype && typeof jsnes.NES.prototype.stop === 'undefined') {
  jsnes.NES.prototype.stop = function () { this.running = false; this.crashMessage = 'crash'; };
}

// Build a correct MMC1 (mapper 1) ROM with 2 PRG banks + 1 CHR bank.
// MMC1 reset default: PRG bank 0 at $8000, LAST bank (bank 1) fixed at $C000.
function makeMmc1Rom() {
  const prg = 2, chr = 1;
  const size = 16 + prg * 16384 + chr * 4096;
  const b = new Uint8Array(size);
  b[0] = 0x4E; b[1] = 0x45; b[2] = 0x53; b[3] = 0x1A;
  b[4] = prg; b[5] = chr >>> 1;
b[6] = 0x10; b[7] = 0; // mapper = 1 (MMC1): low nibble of flag7 = 0, high nibble of flag6 = 1
  const base = 0xC000;
  // Code: increment RAM $10, enable rendering, loop.
  const code = [0xA9, 0x08, 0x8D, 0x01, 0x20, 0xAD, 0x10, 0x00, 0x18, 0x69, 0x01, 0x8D, 0x10, 0x00, 0x4C, 0x00, 0xC0];
  // Last bank (bank 1) occupies PRG data offset (prg-1)*0x4000 .. prg*0x4000.
  // $C000 within the 32KB PRG window maps to the LAST bank's offset
  // ($C000 - $8000 = 0x4000 within the window). So byte offset in PRG data =
  // lastBankStart + 0x4000.
  const lastBankStart = (prg - 1) * 0x4000;
  const slotOffset = 0x4000; // $C000-$8000
  for (let i = 0; i < code.length; i++) b[16 + lastBankStart + slotOffset + i] = code[i];
  // Reset vector at $FFFC (in last bank, offset 0x3FFC within last bank).
  b[16 + lastBankStart + 0x3FFC] = base & 0xFF;
  b[16 + lastBankStart + 0x3FFD] = (base >> 8) & 0xFF;
  let s = '';
  for (let i = 0; i < size; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, Math.min(i + 0x8000, size)));
  return s;
}

function test(how) {
  let frameCount = 0;
  const nes = new jsnes.NES({
    onFrame: function () { frameCount++; },
    onAudioSample: null, onStatusUpdate: function () {},
    preferredFrameRate: 60, emulateSound: false, sampleRate: 44100
  });
  nes.loadROM(makeMmc1Rom());
  console.log('  mapper:', nes.rom.getMapperName());
  for (let i = 0; i < 10; i++) nes.frame();
  const bootPc = nes.cpu.REG_PC.toString(16);
  const bootN = nes.cpu.mem[0x10];
  const t0 = Date.now();
  let ok = false, err = null;
  try {
    if (how === 'reset') nes.reset();
    else if (how === 'reset+irq') { nes.reset(); nes.cpu.requestIrq(nes.cpu.IRQ_RESET); }
    else if (how === 'reload') nes.reloadROM();
    for (let i = 0; i < 5; i++) nes.frame();
    ok = true;
  } catch (e) { err = e.message; }
  const ms = Date.now() - t0;
  console.log(JSON.stringify({ how, ok, err, ms, bootPc, afterPc: nes.cpu.REG_PC.toString(16), bootN, afterN: nes.cpu.mem[0x10], frameCount }));
}

for (const how of ['reset', 'reset+irq', 'reload']) {
  try { test(how); } catch (e) { console.log(how + ': threw ' + e.message); }
}
console.log('done');
