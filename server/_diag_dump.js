'use strict';
const fs = require('fs');
const s = fs.readFileSync('js/app.js', 'utf8');
let i = s.indexOf('function resetNES');
if (i === -1) i = s.indexOf('resetNES');
console.log(s.slice(i - 200, i + 900));
