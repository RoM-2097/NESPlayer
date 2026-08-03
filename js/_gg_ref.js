/* Reference implementation from the "Game Genie decoding" described widely
   (used in many emus). We test both directions and report what code GZUXNGEI
   should decode to under these formulas. */
'use strict';
const ALPHABET = 'APZLGITYEOXUKSVN';
const code = 'GZUXNGEI';
const n = [...code].map(c => ALPHABET.indexOf(c));

// Standard nibble transform in Game Genie patent: bit order (b2,b0,b1,b3)
function ggScramble(v) {
  return ((v & 8) >> 3) | ((v & 4) >> 1) | ((v & 2) << 1) | ((v & 1) << 3);
  // maps bit3->bit0, bit2->bit1, bit1->bit2, bit0->bit3 : i.e. reversal? let's define explicitly
}
// Actually define as: output bit0 = input bit2, output bit1 = input bit0,
//                     output bit2 = input bit1, output bit3 = input bit3
function ggX(v) {
  return ((v >> 2) & 1) | ((v & 1) << 1) | ((v >> 1 & 1) << 2) | ((v & 8));
}

// Try: address = 0x8000 | (swap32 order of letters)
// Letters combine as: addr = (swap(n0)<<12)|(swap(n1)<<8)|(swap(n2)<<4)|swap(n3)
// but with the more-scramble and different ordering

const transforms = {
  ggX, ggScramble,
  id: v => v,
  swp: v => ((v >> 2) & 3) | ((v & 3) << 2),
  rev: v => ((v >> 3) & 1) | ((v >> 1) & 2) | ((v << 1) & 4) | ((v << 3) & 8),
};

function perms(arr) {
  if (arr.length <= 1) return [arr];
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const rest = arr.slice(0, i).concat(arr.slice(i + 1));
    for (const p of perms(rest)) out.push([arr[i]].concat(p));
  }
  return out;
}
const PERMS = perms([0, 1, 2, 3]);

// Standard documented approach from the GG patent: the 24 bits are grouped
// A,B,C,D as 4·6 bits? no...

// Let's try: address assembled from ALL letters (not just 4). For an 8-letter
// code, bits are: [addr15][addr14..0 in some interleave with value and compare]
// The decoders I've seen use:
//   addr = ((n[0]&0xF)<<12)|((n[1]&0xF)<<8)|((n[2]&0xF)<<4)|(n[3]&0xF)
//   apply nibble transform to each
// with transform = swap halves of nibble, then the RESULT letter order is
// exactly as in the code. Let's test against known real codes.

// Instead of guessing, print the full truth-table of what current impl and a
// couple candidate impls produce for GZUXNGEI.
console.log('Raw letters (hex):', n.map(x => x.toString(16)).join(' '));

// Candidate 1: our current (imm nibble swap) with 0x8000 OR
let a1 = ((n[0] >> 2 & 3) | (n[0] & 3) << 2) << 12 |
         ((n[1] >> 2 & 3) | (n[1] & 3) << 2) << 8 |
         ((n[2] >> 2 & 3) | (n[2] & 3) << 2) << 4 |
         ((n[3] >> 2 & 3) | (n[3] & 3) << 2);
console.log('cand1 (swapPairs, n0..n3): $' + (a1 | 0x8000).toString(16).toUpperCase());

// Candidate 2: bit-reverse each nibble
function br(v) { return ((v & 1) << 3) | ((v & 2) << 1) | ((v & 4) >> 1) | ((v & 8) >> 3); }
let a2 = (br(n[0]) << 12) | (br(n[1]) << 8) | (br(n[2]) << 4) | br(n[3]);
console.log('cand2 (bitRev, n0..n3):  $' + (a2 | 0x8000).toString(16).toUpperCase());

// Candidate 3: patent scramble (b2,b0,b1,b3)
function c3(v) { return ((v & 4) >> 2) | ((v & 1) << 1) | ((v & 2) << 1) | (v & 8); }
let a3 = (c3(n[0]) << 12) | (c3(n[1]) << 8) | (c3(n[2]) << 4) | c3(n[3]);
console.log('cand3 (patent, n0..n3):  $' + (a3 | 0x8000).toString(16).toUpperCase());

// Candidate 4: no transform, letters reordered (n3,n2,n1,n0)
let a4 = (n[3] << 12) | (n[2] << 8) | (n[1] << 4) | n[0];
console.log('cand4 (no transform, reversed order): $' + (a4 | 0x8000).toString(16).toUpperCase());

