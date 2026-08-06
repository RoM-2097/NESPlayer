'use strict';
const m = require('../js/neslib/jsnes.min.js');
const jsnes = m.jsnes || m;
const NES = jsnes.NES;
const fs = require('fs');

// 1. Confirm WITHOUT polyfill that stop is undefined.
const out = [];
out.push('stop before polyfill: ' + typeof NES.prototype.stop);

// 2. Apply polyfill (same as netplay.js).
if (NES.prototype && typeof NES.prototype.stop === 'undefined') {
  NES.prototype.stop = function () { this.running = false; this.crashMessage = 'Game crashed: invalid opcode'; };
}
out.push('stop after polyfill: ' + typeof NES.prototype.stop);

// 3. Directly call the invalid-opcode path by making a NES + CPU and invoking
//    the execute handler with an illegal opcode. We simulate by calling stop()
//    on a fake nes object to prove the polyfill signature works.
const fake = {};
fake.running = true;
try {
  NES.prototype.stop.call(fake);
  out.push('stop.call(fake) OK, running=' + fake.running + ', crash=' + fake.crashMessage);
} catch (e) {
  out.push('stop.call FAILED: ' + e.message);
}

fs.writeFileSync('_test_out2.txt', out.join('\n'), 'utf8');
console.log(out.join('\n'));
