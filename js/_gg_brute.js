/* Brute-force the correct NES Game Genie decode for GZUXNGEI -> $2C3F */
'use strict';
const ALPHABET = 'APZLGITYEOXUKSVN';
const code = 'GZUXNGEI';
const n = [...code].map(c => ALPHABET.indexOf(c));
console.log('n =', n, ' (G=4 Z=2 U=11 X=10 N=13 G=4 E=8 I=5)');

// Candidate per-nibble transforms
const T = {
  id:            v => v,
  swapPairs:     v => ((v >> 2) & 3) | ((v & 3) << 2),   // current impl
  bitRev:        v => ((v >> 3) & 1) | ((v >> 1) & 2) | ((v << 1) & 4) | ((v << 3) & 8),
  rotL:          v => ((v << 1) & 15) | ((v >> 3) & 1),
  rotR:          v => ((v >> 1) & 7) | ((v << 3) & 8),
  swapAdjacent:  v => ((v & 8) >> 1) | ((v & 4) << 1) | ((v & 2) >> 1) | ((v & 1) << 1), // 3210->2301
};

// All permutations of [0,1,2,3]
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

const TARGET = 0x2C3F;

let found = [];
for (const tname of Object.keys(T)) {
  const t = T[tname];
  for (const p of PERMS) {
    const raw = (t(n[p[0]]) << 12) | (t(n[p[1]]) << 8) | (t(n[p[2]]) << 4) | t(n[p[3]]);
    const checks = {
      raw: raw,
      mask15: raw & 0x7FFF,
      or8000: raw | 0x8000,
      mask15_or8000: (raw & 0x7FFF) | 0x8000,
    };
    for (const key of Object.keys(checks)) {
      if (checks[key] === TARGET) {
        found.push({ tname, p, key, raw });
      }
    }
  }
}

console.log('\nMatches for address ' + TARGET.toString(16).toUpperCase() + ':');
if (!found.length) console.log('  NONE');
found.forEach(f => {
  console.log(`  transform=${f.tname} order=[${f.p.map(i => n[i]).join(',')}] (letters ${f.p.map(i => code[i]).join('')}) matchAs=${f.key} raw=${f.raw.toString(16).toUpperCase()}`);
});

// Also report what the current impl produces
const cur = (T.swapPairs(n[0]) << 12) | (T.swapPairs(n[1]) << 8) | (T.swapPairs(n[2]) << 4) | T.swapPairs(n[3]);
console.log('\nCurrent impl address = $' + (cur | 0x8000).toString(16).toUpperCase());

