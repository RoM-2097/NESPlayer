/* Find the correct NES Game Genie decode for GZUXNGEI -> address $2C3F.
   The standard GG layout bit-INTERLEAVES address/value/compare across the
   8 code characters, so a per-nibble swap can never be correct. We search
   over structured bit permutations (affine mod-32) for one that reproduces
   the known-good (code -> address) pair. */
'use strict';
const ALPHABET = 'APZLGITYEOXUKSVN';
const code = 'GZUXNGEI';
const n = [...code].map(c => ALPHABET.indexOf(c));
const TARGET = 0x2C3F;   // user says GZUXNGEI must decode here

// Build 32-bit stream: char0 = bits 31..28 ... char7 = bits 3..0
let bits = 0;
for (let i = 0; i < 8; i++) bits = (bits << 4) | n[i];

function bit(bits, idx) { return (bits >> idx) & 1; }
function setVal(stream, targetStart, permuted, outStart, len) {
  // copy 'len' bits from permuted starting at outStart into stream at targetStart
  let v = 0;
  for (let i = 0; i < len; i++) {
    const srcBit = bit(permuted, outStart + i);
    if (srcBit) v |= (1 << i);
  }
  return v;
}

// Try affine permutations: output_bit_position j reads from input bit (a*j+b)%32
const results = [];
for (let a = 1; a < 32; a += 2) {
  for (let b = 0; b < 32; b++) {
    const perm = [];
    for (let j = 0; j < 32; j++) perm[j] = bit(bits, (a * j + b) % 32);
    // Candidate: address = perm bits 31..16 (upper 16) OR 30..16 (15 bits)
    for (const [label, lo, hi] of [['addr16_31_16', 16, 32], ['addr15_30_16', 16, 31]]) {
      let addr = 0;
      for (let j = lo; j < hi; j++) addr = (addr << 1) | perm[j];
      if (addr === TARGET || (addr & 0x7FFF) === TARGET || (addr | 0x8000) === TARGET) {
        results.push({ a, b, label, addr, full: addr | 0x8000 });
      }
    }
  }
}

console.log('Input letters:', code, '-> values', n.join(','));
console.log('Target address: $' + TARGET.toString(16).toUpperCase());
console.log('\nAffine permutation matches:');
if (!results.length) console.log('  NONE');
results.slice(0, 40).forEach(r => {
  console.log(`  a=${r.a} b=${r.b} ${r.label} => $${r.addr.toString(16).toUpperCase()} (full $${r.full.toString(16).toUpperCase()})`);
});

// Also: try the bit-reversal of the 32-bit stream then affine
console.log('\nReverse-stream + affine matches:');
const rev = [];
for (let j = 0; j < 32; j++) rev[j] = bit(bits, 31 - j);
let found2 = 0;
for (let a = 1; a < 32; a += 2) {
  for (let b = 0; b < 32; b++) {
    const perm = [];
    for (let j = 0; j < 32; j++) perm[j] = rev[(a * j + b) % 32];
    for (const [label, lo, hi] of [['addr16_31_16', 16, 32], ['addr15_30_16', 16, 31]]) {
      let addr = 0;
      for (let j = lo; j < hi; j++) addr = (addr << 1) | perm[j];
      if (addr === TARGET || (addr & 0x7FFF) === TARGET || (addr | 0x8000) === TARGET) {
        console.log(`  a=${a} b=${b} ${label} => $${addr.toString(16).toUpperCase()} (full $${(addr|0x8000).toString(16).toUpperCase()})`);
        found2++;
        if (found2 > 40) break;
      }
    }
    if (found2 > 40) break;
  }
}
if (!found2) console.log('  NONE');

