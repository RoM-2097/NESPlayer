/* Expanded brute-force: NES Game Genie address layout is bit-interleaved.
   The 15-bit address comes from 4 letters (16 bits) minus one dropped bit,
   OR letter3's nibble is split (3 bits addr + 1 bit value[7]). */
'use strict';
const ALPHABET = 'APZLGITYEOXUKSVN';
const code = 'GZUXNGEI';
const n = [...code].map(c => ALPHABET.indexOf(c));
const TARGET = 0x2C3F;

const T = {
  id:           v => v,
  swapPairs:    v => ((v >> 2) & 3) | ((v & 3) << 2),
  bitRev:       v => ((v >> 3) & 1) | ((v >> 1) & 2) | ((v << 1) & 4) | ((v << 3) & 8),
  rotL:         v => ((v << 1) & 15) | ((v >> 3) & 1),
  rotR:         v => ((v >> 1) & 7) | ((v << 3) & 8),
  swapAdjacent: v => ((v & 8) >> 1) | ((v & 4) << 1) | ((v & 2) >> 1) | ((v & 1) << 1),
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

let found = [];

// Hypothesis A: drop exactly one bit from the 16-bit value (any position),
// leaving a 15-bit address.
for (const tname of Object.keys(T)) {
  const t = T[tname];
  for (const p of PERMS) {
    const raw = (t(n[p[0]]) << 12) | (t(n[p[1]]) << 8) | (t(n[p[2]]) << 4) | t(n[p[3]]);
    for (let drop = 0; drop < 16; drop++) {
      // build 15-bit by removing bit 'drop'
      const low = raw & ((1 << drop) - 1);
      const high = (raw >> (drop + 1)) << drop;
      const addr15 = low | high;
      if (addr15 === TARGET) {
        found.push({ tname, p, raw, drop, desc: 'drop-bit' });
      }
    }
    // Hypothesis B: letter3 nibble split — use 3 of its 4 bits as addr[2:0]
    for (let sh = 0; sh < 4; sh++) {
      const addr = (t(n[p[0]]) << 12) | (t(n[p[1]]) << 8) | (t(n[p[2]]) << 4) | ((t(n[p[3]]) >> sh) & 7);
      if ((addr & 0x7FFF) === TARGET || (addr | 0x8000) === TARGET) {
        found.push({ tname, p, raw: addr, drop: 'sh' + sh, desc: 'split-nibble' });
      }
    }
  }
}

console.log('Matches for address $' + TARGET.toString(16).toUpperCase() + ':');
if (!found.length) console.log('  NONE');
found.forEach(f => {
  console.log(`  ${f.desc} transform=${f.tname} order=[${f.p.map(i => n[i]).join(',')}] letters=${f.p.map(i => code[i]).join('')} raw=${f.raw.toString(16).toUpperCase()} drop=${f.drop}`);
});

// Show the current impl for reference
const cur = (T.swapPairs(n[0]) << 12) | (T.swapPairs(n[1]) << 8) | (T.swapPairs(n[2]) << 4) | T.swapPairs(n[3]);
console.log('\nCurrent impl address = $' + (cur | 0x8000).toString(16).toUpperCase());

// Also print the target expected letters under a pure-nibble scheme to see the mapping needed
console.log('\nTarget $2C3F nibbles: ' + [0x2, 0xC, 0x3, 0xF].map(x => x.toString(16)).join(' '));

