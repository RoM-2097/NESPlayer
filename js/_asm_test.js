var A = require('./asm6502.js');

var src = [
  'LDA #$05',
  'STA $0200',
  'loop: DEX',
  'BNE loop',
  'JMP $8000',
  'LDX #$10',
  'ldy $0200,X'
].join('\n');

var r = A.assemble(src, 0x8000);
console.log('length', r.length);
console.log('errors', r.errors);
console.log('bytes', r.bytes.map(function (b) { return b.toString(16).padStart(2, '0'); }).join(' '));
console.log('labels', JSON.stringify(r.labels));
console.log('expected A9 05 8D 00 02 CA D0 FD 4C 00 80');

// Disassembly test on known bytes
var readFn = (function () {
  var mem = {};
  function rb(addr) {
    if (mem[addr] === undefined) mem[addr] = 0;
    return mem[addr];
  }
  return { rb: rb, mem: mem };
})();
var mem = readFn.mem;
mem[0x8000] = 0xA9; mem[0x8001] = 0x05;
mem[0x8002] = 0x8D; mem[0x8003] = 0x00; mem[0x8004] = 0x02;
mem[0x8005] = 0xCA;
mem[0x8006] = 0xD0; mem[0x8007] = 0xFD;
mem[0x8008] = 0x4C; mem[0x8009] = 0x00; mem[0x800A] = 0x80;

var d = A.disassemble(readFn.rb, 0x8000, 6);
d.forEach(function (x) {
  console.log('$' + x.addr.toString(16).padStart(4, '0').toUpperCase() + '  ' +
    x.bytes.map(function (b) { return b.toString(16).padStart(2, '0').toUpperCase(); }).join(' ') +
    '  ' + x.text);
});

