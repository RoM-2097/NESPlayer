/* The 8-letter GG code: letters 1-4 => address (15 bits), 5-6 => value, 7-8 => compare.
   But the patent bit-interleave uses ALL letters with the address spread across
   letters 1-4 (each letter contributes 4 bits, minus 1 dropped). Let's search:
   pick the exact 4 letters that produce address $2C3F under swapPairs + patent. */
'use strict';
const ALPHABET = 'APZLGITYEOXUKSVN';
const code = 'GZUXNGEI';
const n = [...code].map(c => ALPHABET.indexOf(c));

const scramble = v => ((v >> 2) & 3) | ((v & 3) << 2); // swapPairs

// Patent interleave using 4 letters [a,b,c,d] for the 16-bit address:
//   addr[0..3]  = a.bit0, c.bit0, b.bit0, d.bit0? Let's try both layouts.
// Standard: letters 1,2,3,4 map to addr bits:
//   L1: bits 0,4,8,12  L2: bits 1,5,9,13  L3: bits 2,6,10,14  L4: bits 3,7,11,15
function decode4(L, mode) {
  // L = [l1,l2,l3,l4] each scrambled
  const s = L.map(scramble);
  let addr = 0;
  if (mode === 'col') {
    // column interleave
    for (let li = 0; li < 4; li++) {
      for (let bit = 0; bit < 4; bit++) {
        if ((s[li] >> bit) & 1) addr |= (1 << (li + bit * 4));
      }
    }
  } else if (mode === 'col-swap') {
    // l1,l2 -> low byte; l3,l4 -> high byte with interleave
    for (let li = 0; li < 2; li++) {
      for (let bit = 0; bit < 4; bit++) {
        if ((s[li] >> bit) & 1) addr |= (1 << (li + bit * 2));
      }
    }
    for (let li = 0; li < 2; li++) {
      for (let bit = 0; bit < 4; bit++) {
        if ((s[2 + li] >> bit) & 1) addr |= (1 << (8 + li + bit * 2));
      }
    }
  } else if (mode === 'row') {
    for (let li = 0; li < 4; li++) {
      for (let bit = 0; bit < 4; bit++) {
        if ((s[li] >> bit) & 1) addr |= (1 << (bit + li * 4));
      }
    }
  } else if (mode === 'row-swap') {
    // bit0 -> addr[0..3] via li, bit1 -> addr[4..7], etc. using l1,l2,l3,l4
    for (let bit = 0; bit < 4; bit++) {
      for (let li = 0; li < 4; li++) {
        if ((s[li] >> bit) & 1) addr |= (1 << (bit * 4 + li));
      }
    }
  }
  return addr;
}

const modes = ['col', 'col-swap', 'row', 'row-swap'];
const TARGET = 0x2C3F;
let found = false;
for (const mode of modes) {
  // pick 4 letters (order matters) out of 8 = 8P4 = 1680
  for (let a = 0; a < 8; a++) for (let b = 0; b < 8; b++) if (b !== a)
  for (let c = 0; c < 8; c++) if (c !== a && c !== b)
  for (let d = 0; d < 8; d++) if (d !== a && d !== b && d !== c) {
    const L = [n[a], n[b], n[c], n[d]];
    const addr = decode4(L, mode);
    const full = addr | 0x8000;
    if (addr === TARGET || full === TARGET || (addr & 0x7FFF) === TARGET) {
      console.log(`MATCH mode=${mode} letters=[${code[a]}${code[b]}${code[c]}${code[d]}] addr=$${addr.toString(16).toUpperCase()} full=$${full.toString(16).toUpperCase()}`);
      found = true;
    }
  }
}
if (!found) console.log('No match with swapPairs across 8P4 letter selections.');

