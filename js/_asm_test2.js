var A = require('./asm6502.js');

function check(name, src, origin, expectedHex) {
  var r = A.assemble(src, origin);
  var got = r.bytes.map(function (b) { return b.toString(16).padStart(2, '0'); }).join(' ');
  var ok = got === expectedHex;
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name);
  if (!ok) {
    console.log('  src:    ' + src.split('\n').join(' | '));
    console.log('  got:    ' + got);
    console.log('  want:   ' + expectedHex);
    if (r.errors.length) console.log('  errors: ' + r.errors.join('; '));
  }
}

// start at $8000: NOP, NOP, BEQ start (off -4 = FC), BNE start (off -6 = FA)
check('branch fwd/bwd', ['start: NOP', 'NOP', 'BEQ start', 'BNE start'].join('\n'), 0x8000, 'ea ea f0 fc d0 fa');

check('imm/zp/abs auto', ['LDA #$FF', 'LDA $10', 'LDA $1234', 'STA $20', 'STA $2000', 'JMP $1234'].join('\n'), 0x8000, 'a9 ff a5 10 ad 34 12 85 20 8d 00 20 4c 34 12');

check('indexed', ['LDX $10', 'LDY $20,X', 'LDA ($30),Y', 'STA ($40,X)', 'JMP ($1234)'].join('\n'), 0x8000, 'a6 10 b4 20 b1 30 81 40 6c 34 12');

check('data directives', ['DB $01,$02,03', 'DW $1234', 'HEX 0A0B0C'].join('\n'), 0x8000, '01 02 03 34 12 0a 0b 0c');

// JSR at $8000 (3 bytes) -> sub at $8003
check('label abs via forward', ['JSR sub', 'sub: RTS'].join('\n'), 0x8000, '20 03 80 60');

// zpv at $8000 (not zp), far at $8003 (not zp) -> both abs
check('labels with abs auto', ['zpv: NOP', 'LDA zpv', 'LDA far', 'far: NOP'].join('\n'), 0x8000, 'ea ad 00 80 ad 03 80 ea');

// zpv2 in zero page: LDA zpv2 where zpv2 label is at $0010
check('zero-page label', ['LDA zpv2', 'zpv2: NOP'].join('\n'), 0x0000, 'a5 0e ea');

// error cases
var e1 = A.assemble(['LDA #$1FF', 'XXX $12'].join('\n'), 0x8000);
console.log((e1.errors.length === 2 ? 'PASS' : 'FAIL') + '  out-of-range imm + unknown mnemonic, got: ' + JSON.stringify(e1.errors));

var e2 = A.assemble(['BNE $9000'], 0x8000);
console.log((e2.errors.length ? 'PASS' : 'FAIL') + '  branch out of range, got: ' + JSON.stringify(e2.errors));

