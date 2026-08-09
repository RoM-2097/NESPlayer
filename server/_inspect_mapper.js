'use strict';
const m = require('../js/neslib/jsnes.min.js');
const jsnes = m.jsnes || m;
if (jsnes.NES && jsnes.NES.prototype && typeof jsnes.NES.prototype.stop === 'undefined') {
  jsnes.NES.prototype.stop = function () { this.running = false; this.crashMessage = 'crash'; };
}

// List all mapper classes in the module.
const proto = jsnes.NES.prototype;
console.log('NES proto keys:', Object.keys(proto).filter(k => typeof proto[k] === 'function'));
console.log('Module keys:', Object.keys(jsnes));

// Find MM1-like mapper. Look at proto.loadROM and createMapper.
console.log('=== loadROM ===');
console.log(proto.loadROM.toString());
console.log('=== createMapper ===');
console.log(proto.createMapper.toString());
