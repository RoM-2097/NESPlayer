/* Correct NES Game Genie decoding per the patent (US 5195135).
   Each letter value (0-15) is first bit-scrambled:
     output_bit0 = input_bit2
     output_bit1 = input_bit3  
     output_bit2 = input_bit1
     output_bit3 = input_bit0
   Then bits are interleaved column-major to form the 15-bit address and 8-bit value.
   For 8-letter codes, letters 7-8 give the 8-bit compare.
*/
'use strict';
const ALPHABET = 'APZLGITYEOXUKSVN';
const code = 'GZUXNGEI';
const n = [...code].map(c => ALPHABET.indexOf(c));
console.log('Letter values:', code, '->', n.join(','));

// Patent scramble: out_bit0 = in_bit2, out_bit1 = in_bit3, out_bit2 = in_bit1, out_bit3 = in_bit0
function patentScramble(v) {
  // Return 4-bit value with bits remapped
  return ((v >> 2) & 1) |          // bit0 = in_bit2
         (((v >> 3) & 1) << 1) |   // bit1 = in_bit3
         (((v >> 1) & 1) << 2) |   // bit2 = in_bit1
         ((v & 1) << 3);           // bit3 = in_bit0
}

// Alternative: maybe the scramble is the inverse: out_bit0 = in_bit3, out_bit1 = in_bit1, out_bit2 = in_bit2, out_bit3 = in_bit0
function patentAlt(v) {
  return ((v >> 3) & 1) |          // bit0 = in_bit3
         (((v >> 1) & 1) << 1) |   // bit1 = in_bit1
         (((v >> 2) & 1) << 2) |   // bit2 = in_bit2
         ((v & 1) << 3);           // bit3 = in_bit0
}

// Another: bit-reversal within the nibble
function bitRev(v) {
  return ((v & 1) << 3) | ((v & 2) << 1) | ((v >> 1) & 2) | ((v >> 3) & 1);
}

// swapPairs already tested
function swapPairs(v) {
  return ((v >> 2) & 3) | ((v & 3) << 2);
}

// Test all scrambles with the column-major interleave
const scrambles = [
  { name: 'patentScramble', fn: patentScramble },
  { name: 'patentAlt', fn: patentAlt },
  { name: 'bitRev', fn: bitRev },
  { name: 'swapPairs', fn: swapPairs },
  { name: 'id', fn: v => v },
];

const TARGET = 0x2C3F;
console.log('\nTesting column-major interleave (patent):');
console.log('  Address = col-major bits 0-14 from letters 1-4 scrambled');
console.log('  Value  = col-major bits 0-7 from letters 5-6 scrambled');
console.log('  Compare = col-major bits 0-7 from letters 7-8 scrambled');
console.log('');

for (const s of scrambles) {
  const scrambled = n.map(s.fn);
  
  // Column-major interleave: addr_bit[i] = letter_{floor(i/4)+1}_bit_{i%4}
  let addr = 0;
  for (let i = 0; i < 15; i++) {
    // letter index = floor(i/4)
    // letter bit = i%4
    const li = Math.floor(i / 4); // 0,0,0,0,1,1,1,1,...
    const bi = i % 4; // 0,1,2,3,0,1,2,3,...
    if (li < 8 && (scrambled[li] >> bi) & 1) addr |= (1 << i);
  }
  
  // Value: letters 5-6 (indices 4,5), column-major
  let val = 0;
  for (let i = 0; i < 8; i++) {
    const li = 4 + Math.floor(i / 4); // 4,4,4,4,5,5,5,5
    const bi = i % 4; // 0,1,2,3,0,1,2,3
    if (li < 8 && (scrambled[li] >> bi) & 1) val |= (1 << i);
  }
  
  // Compare: letters 7-8 (indices 6,7), column-major
  let comp = 0;
  for (let i = 0; i < 8; i++) {
    const li = 6 + Math.floor(i / 4);
    const bi = i % 4;
    if (li < 8 && (scrambled[li] >> bi) & 1) comp |= (1 << i);
  }
  
  const fullAddr = addr | 0x8000;
  console.log(`${s.name}: addr=$${addr.toString(16).toUpperCase().padStart(4,'0')} full=$${fullAddr.toString(16).toUpperCase().padStart(4,'0')} val=$${val.toString(16).toUpperCase()} comp=$${comp.toString(16).toUpperCase()}`);
  if (addr === TARGET || fullAddr === TARGET || (addr & 0x7FFF) === TARGET) {
    console.log('  *** MATCH! ***');
  }
}

// Also try row-major (bits from each letter go to consecutive positions)
console.log('\nTesting row-major interleave:');
console.log('  Address = letter1_bit0..3, letter2_bit0..3, ... (15 bits from letters 1-4)');
for (const s of scrambles) {
  const scrambled = n.map(s.fn);
  
  let addr = 0;
  for (let li = 0; li < 4; li++) {
    for (let bi = 0; bi < 4; bi++) {
      // Skip the 16th bit (bit 15)
      const bitPos = li * 4 + bi;
      if (bitPos >= 15) break;
      if ((scrambled[li] >> bi) & 1) addr |= (1 << bitPos);
    }
  }
  
  let val = 0;
  for (let li = 4; li < 6; li++) {
    for (let bi = 0; bi < 4; bi++) {
      const bitPos = (li - 4) * 4 + bi;
      if ((scrambled[li] >> bi) & 1) val |= (1 << bitPos);
    }
  }
  
  let comp = 0;
  for (let li = 6; li < 8; li++) {
    for (let bi = 0; bi < 4; bi++) {
      const bitPos = (li - 6) * 4 + bi;
      if ((scrambled[li] >> bi) & 1) comp |= (1 << bitPos);
    }
  }
  
  const fullAddr = addr | 0x8000;
  console.log(`${s.name}: addr=$${addr.toString(16).toUpperCase().padStart(4,'0')} full=$${fullAddr.toString(16).toUpperCase().padStart(4,'0')} val=$${val.toString(16).toUpperCase()} comp=$${comp.toString(16).toUpperCase()}`);
  if (addr === TARGET || fullAddr === TARGET || (addr & 0x7FFF) === TARGET) {
    console.log('  *** MATCH! ***');
  }
}

// Also try the 4-letter-only address (letters 1-4, no interleave, just nibble scramble)
console.log('\nNo interleave (just scrambled nibbles of letters 1-4):');
for (const s of scrambles) {
  const scrambled = n.map(s.fn);
  let addr = (scrambled[0] << 12) | (scrambled[1] << 8) | (scrambled[2] << 4) | scrambled[3];
  const fullAddr = addr | 0x8000;
  console.log(`${s.name}: addr=$${addr.toString(16).toUpperCase().padStart(4,'0')} full=$${fullAddr.toString(16).toUpperCase().padStart(4,'0')}`);
  if (addr === TARGET || fullAddr === TARGET || (addr & 0x7FFF) === TARGET) {
    console.log('  *** MATCH! ***');
  }
}
