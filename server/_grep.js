'use strict';
const fs = require('fs');
const file = process.argv[2];
const pats = process.argv.slice(3);
if (!file) { console.log('usage: node _grep.js <file> <pat...>'); process.exit(1); }
const src = fs.readFileSync(file, 'utf8');
const lines = src.split('\n');
pats.forEach(p => {
  const re = new RegExp(p);
  console.log('=== /' + p + '/ ===');
  lines.forEach((l, i) => {
    if (re.test(l)) console.log((i + 1) + ': ' + l);
  });
});
