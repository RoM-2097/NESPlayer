/* NES Game Genie decoding from the patent US 5195135.
   Each letter (0-15) is first scrambled, then bits are interleaved.
   GZUXNGEI -> address $2C3F must be verified.
*/
'use strict';
const ALPHABET = 'APZLGITYEOXUKSVN';
const code = 'GZUXNGEI';
const n = [...code].map(c => ALPHABET.indexOf(c));
console.log('Letter values:', code, '->', n.join(','));

// Scramble transforms to try
const scrambles = {
  'bitrev': v => ((v & 1) << 3) | ((v & 2) << 1) | ((v & 4) >> 1) | ((v & 8) >> 3), // bit-reversal
  'swapPairs': v => ((v >> 2) & 3) | ((v & 3) << 2), // swap nibble halves
  'rotL': v => ((v << 1) & 15) | ((v >> 3) & 1),
  'rotR': v => ((v >> 1) & 7) | ((v << 3) & 8),
  'ggAlt': v => ((v >> 2) & 1) | ((v & 1) << 1) | ((v >> 1 & 1) << 2) | (v & 8), // b2,b0,b1,b3
  'id': v => v,
  'swapAdj': v => ((v & 8) >> 1) | ((v & 4) << 1) | ((v & 2) >> 1) | ((v & 1) << 1), // swap adjacent pairs
};

// Interleaving patterns to try (address bits from which letter[index].bit_position)
// Pattern type: address bits mapped from (letter_idx, bit_in_letter, addr_bit_position)
const patterns = [];

// Pattern 1: addr bits 0,4,8,12 from letter 0,2,4,6 bit0, then addr bits 1,5,9,13 from letter 0,2,4,6 bit1
//            addr bits 2,6,10,14 from letter 1,3,5,7 bit0, then addr bits 3,7,11,15 from letter 1,3,5,7 bit1
//            value bits from letter 0..7 bit2, compare bits from letter 0..7 bit3
patterns.push({
  name: 'interleave-patent',
  addr: [
    [0,0,0],[2,0,1],[4,0,2],[6,0,3], // even letters bit0 -> addr[0..3]
    [0,1,4],[2,1,5],[4,1,6],[6,1,7], // even letters bit1 -> addr[4..7]
    [1,0,8],[3,0,9],[5,0,10],[7,0,11], // odd letters bit0 -> addr[8..11]
    [1,1,12],[3,1,13],[5,1,14],[7,1,15], // odd letters bit1 -> addr[12..15]
  ],
  value: [[0,2,0],[1,2,1],[2,2,2],[3,2,3],[4,2,4],[5,2,5],[6,2,6],[7,2,7]],
  comp:  [[0,3,0],[1,3,1],[2,3,2],[3,3,3],[4,3,4],[5,3,5],[6,3,6],[7,3,7]],
});

// Pattern 2: same but with bit0->addr[0..7] and bit1->addr[8..15]
patterns.push({
  name: 'interleave-alt1',
  addr: [
    [0,0,0],[1,0,1],[2,0,2],[3,0,3],[4,0,4],[5,0,5],[6,0,6],[7,0,7],
    [0,1,8],[1,1,9],[2,1,10],[3,1,11],[4,1,12],[5,1,13],[6,1,14],[7,1,15],
  ],
  value: [[0,2,0],[1,2,1],[2,2,2],[3,2,3],[4,2,4],[5,2,5],[6,2,6],[7,2,7]],
  comp:  [[0,3,0],[1,3,1],[2,3,2],[3,3,3],[4,3,4],[5,3,5],[6,3,6],[7,3,7]],
});

// Pattern 3: patent but with reversed order (high bits first)
patterns.push({
  name: 'interleave-patent-rev',
  addr: [
    [0,0,15],[2,0,14],[4,0,13],[6,0,12],
    [0,1,11],[2,1,10],[4,1,9],[6,1,8],
    [1,0,7],[3,0,6],[5,0,5],[7,0,4],
    [1,1,3],[3,1,2],[5,1,1],[7,1,0],
  ],
  value: [[0,2,0],[1,2,1],[2,2,2],[3,2,3],[4,2,4],[5,2,5],[6,2,6],[7,2,7]],
  comp:  [[0,3,0],[1,3,1],[2,3,2],[3,3,3],[4,3,4],[5,3,5],[6,3,6],[7,3,7]],
});

// Pattern 4: even letters bits 0,1 -> addr[0..7], odd letters bits 0,1 -> addr[8..15]
patterns.push({
  name: 'even-odd',
  addr: [
    [0,0,0],[2,0,1],[4,0,2],[6,0,3],
    [0,1,4],[2,1,5],[4,1,6],[6,1,7],
    [1,0,8],[3,0,9],[5,0,10],[7,0,11],
    [1,1,12],[3,1,13],[5,1,14],[7,1,15],
  ],
  value: [[0,2,0],[1,2,1],[2,2,2],[3,2,3],[4,2,4],[5,2,5],[6,2,6],[7,2,7]],
  comp:  [[0,3,0],[1,3,1],[2,3,2],[3,3,3],[4,3,4],[5,3,5],[6,3,6],[7,3,7]],
});

// Pattern 5: Patent but bit0 and bit1 swapped for even letters
patterns.push({
  name: 'patent-bit01-swap',
  addr: [
    [0,1,0],[2,1,1],[4,1,2],[6,1,3],
    [0,0,4],[2,0,5],[4,0,6],[6,0,7],
    [1,0,8],[3,0,9],[5,0,10],[7,0,11],
    [1,1,12],[3,1,13],[5,1,14],[7,1,15],
  ],
  value: [[0,2,0],[1,2,1],[2,2,2],[3,2,3],[4,2,4],[5,2,5],[6,2,6],[7,2,7]],
  comp:  [[0,3,0],[1,3,1],[2,3,2],[3,3,3],[4,3,4],[5,3,5],[6,3,6],[7,3,7]],
});

function decode(letters, scramble, pat) {
  const s = letters.map(l => scramble(l));
  let addr = 0;
  for (const [li, bit, ab] of pat.addr) {
    const v = (s[li] >> bit) & 1;
    if (v) addr |= (1 << ab);
  }
  let val = 0;
  for (const [li, bit, vb] of pat.value) {
    const v = (s[li] >> bit) & 1;
    if (v) val |= (1 << vb);
  }
  let comp = 0;
  for (const [li, bit, cb] of pat.comp) {
    const v = (s[li] >> bit) & 1;
    if (v) comp |= (1 << cb);
  }
  return { addr, val, comp };
}

const TARGET = 0x2C3F;
console.log('\nTesting all scrambles × all patterns:');
for (const [sname, scramble] of Object.entries(scrambles)) {
  for (const pat of patterns) {
    const { addr, val, comp } = decode(n, scramble, pat);
    const fullAddr = addr | 0x8000;
    if (addr === TARGET || fullAddr === TARGET || (addr & 0x7FFF) === TARGET) {
      console.log(`  MATCH: scramble=${sname} pattern=${pat.name} addr=$${addr.toString(16).toUpperCase()} val=$${val.toString(16).toUpperCase()} comp=$${comp.toString(16).toUpperCase()}`);
    }
    // Report what each combination gives
    if (sname === 'bitrev' || sname === 'swapPairs' || sname === 'id') {
      console.log(`  ${sname} ${pat.name}: addr=$${addr.toString(16).toUpperCase()} val=$${val.toString(16).toUpperCase()} comp=$${comp.toString(16).toUpperCase()}`);
    }
  }
}
