'use strict';
const m = require('../js/neslib/jsnes.min.js');
const jsnes = m.jsnes || m;
console.log('=== reloadROM ===');
console.log(jsnes.NES.prototype.reloadROM.toString());
console.log('=== reset ===');
console.log(jsnes.NES.prototype.reset.toString());
console.log('=== loadROM ===');
console.log(jsnes.NES.prototype.loadROM.toString());
