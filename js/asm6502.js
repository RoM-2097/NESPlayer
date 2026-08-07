/* ============================================================
   ASM6502 — MOS 6502 assembler & disassembler
   NOVA · NESPLAYER v2.9 debugger library
   ------------------------------------------------------------
   - `assemble(source, origin)`  → { bytes:Number[], labels:Object,
                                    errors:String[], length:Number }
   - `disassemble(readByte, pc, count)` → [{ addr, bytes, text }]
   - Exposes `OPCODES` (official) + `UNOFFICIAL` (common illegal ops)
     for disassembly of arbitrary ROM bytes.
   Works in the browser (window.ASM6502) and under CommonJS.
   ============================================================ */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ASM6502 = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------- Addressing-mode keys ---------- */
  var MODES = {
    imp: { len: 1, label: 'implied' },
    acc: { len: 1, label: 'accumulator' },
    imm: { len: 2, label: 'immediate' },
    zp:  { len: 2, label: 'zero-page' },
    zpx: { len: 2, label: 'zero-page,X' },
    zpy: { len: 2, label: 'zero-page,Y' },
    rel: { len: 2, label: 'relative' },
    abs: { len: 3, label: 'absolute' },
    abx: { len: 3, label: 'absolute,X' },
    aby: { len: 3, label: 'absolute,Y' },
    ind: { len: 3, label: 'indirect' },
    izx: { len: 2, label: '(indirect,X)' },
    izy: { len: 2, label: '(indirect),Y' }
  };

  /* ---------- Official instruction table ----------
     Each mnemonic lists its [mode, opcode] variants. */
  var INS = {
    ADC: [['imm',0x69],['zp',0x65],['zpx',0x75],['abs',0x6D],['abx',0x7D],['aby',0x79],['izx',0x61],['izy',0x71]],
    AND: [['imm',0x29],['zp',0x25],['zpx',0x35],['abs',0x2D],['abx',0x3D],['aby',0x39],['izx',0x21],['izy',0x31]],
    ASL: [['acc',0x0A],['zp',0x06],['zpx',0x16],['abs',0x0E],['abx',0x1E]],
    BCC: [['rel',0x90]],
    BCS: [['rel',0xB0]],
    BEQ: [['rel',0xF0]],
    BIT: [['zp',0x24],['abs',0x2C]],
    BMI: [['rel',0x30]],
    BNE: [['rel',0xD0]],
    BPL: [['rel',0x10]],
    BRK: [['imp',0x00]],
    BVC: [['rel',0x50]],
    BVS: [['rel',0x70]],
    CLC: [['imp',0x18]],
    CLD: [['imp',0xD8]],
    CLI: [['imp',0x58]],
    CLV: [['imp',0xB8]],
    CMP: [['imm',0xC9],['zp',0xC5],['zpx',0xD5],['abs',0xCD],['abx',0xDD],['aby',0xD9],['izx',0xC1],['izy',0xD1]],
    CPX: [['imm',0xE0],['zp',0xE4],['abs',0xEC]],
    CPY: [['imm',0xC0],['zp',0xC4],['abs',0xCC]],
    DEC: [['zp',0xC6],['zpx',0xD6],['abs',0xCE],['abx',0xDE]],
    DEX: [['imp',0xCA]],
    DEY: [['imp',0x88]],
    EOR: [['imm',0x49],['zp',0x45],['zpx',0x55],['abs',0x4D],['abx',0x5D],['aby',0x59],['izx',0x41],['izy',0x51]],
    INC: [['zp',0xE6],['zpx',0xF6],['abs',0xEE],['abx',0xFE]],
    INX: [['imp',0xE8]],
    INY: [['imp',0xC8]],
    JMP: [['abs',0x4C],['ind',0x6C]],
    JSR: [['abs',0x20]],
    LDA: [['imm',0xA9],['zp',0xA5],['zpx',0xB5],['abs',0xAD],['abx',0xBD],['aby',0xB9],['izx',0xA1],['izy',0xB1]],
    LDX: [['imm',0xA2],['zp',0xA6],['zpy',0xB6],['abs',0xAE],['aby',0xBE]],
    LDY: [['imm',0xA0],['zp',0xA4],['zpx',0xB4],['abs',0xAC],['abx',0xBC]],
    LSR: [['acc',0x4A],['zp',0x46],['zpx',0x56],['abs',0x4E],['abx',0x5E]],
    NOP: [['imp',0xEA]],
    ORA: [['imm',0x09],['zp',0x05],['zpx',0x15],['abs',0x0D],['abx',0x1D],['aby',0x19],['izx',0x01],['izy',0x11]],
    PHA: [['imp',0x48]],
    PHP: [['imp',0x08]],
    PLA: [['imp',0x68]],
    PLP: [['imp',0x28]],
    ROL: [['acc',0x2A],['zp',0x26],['zpx',0x36],['abs',0x2E],['abx',0x3E]],
    ROR: [['acc',0x6A],['zp',0x66],['zpx',0x76],['abs',0x6E],['abx',0x7E]],
    RTI: [['imp',0x40]],
    RTS: [['imp',0x60]],
    SBC: [['imm',0xE9],['zp',0xE5],['zpx',0xF5],['abs',0xED],['abx',0xFD],['aby',0xF9],['izx',0xE1],['izy',0xF1]],
    SEC: [['imp',0x38]],
    SED: [['imp',0xF8]],
    SEI: [['imp',0x78]],
    STA: [['zp',0x85],['zpx',0x95],['abs',0x8D],['abx',0x9D],['aby',0x99],['izx',0x81],['izy',0x91]],
    STX: [['zp',0x86],['zpy',0x96],['abs',0x8E]],
    STY: [['zp',0x84],['zpx',0x94],['abs',0x8C]],
    TAX: [['imp',0xAA]],
    TAY: [['imp',0xA8]],
    TSX: [['imp',0xBA]],
    TXA: [['imp',0x8A]],
    TXS: [['imp',0x9A]],
    TYA: [['imp',0x98]]
  };

  /* Build the official opcode lookup: byte -> { mn, mode, len } */
  var OPCODES = {};
  Object.keys(INS).forEach(function (mn) {
    INS[mn].forEach(function (v) {
      OPCODES[v[1]] = { mn: mn, mode: v[0], len: MODES[v[0]].len };
    });
  });

  /* ---------- Common unofficial (illegal) opcodes ----------
     Included so ROM disassembly of games that use undocumented
     opcodes still shows something useful instead of "???". */
  var UNOFFICIAL = {};
  function uno(byte, mn, mode) {
    UNOFFICIAL[byte] = { mn: mn, mode: mode, len: MODES[mode].len };
  }
  // NOP variants
  [0x1A,0x3A,0x5A,0x7A,0xDA,0xFA].forEach(function (b) { uno(b, 'NOP', 'imp'); });
  // NOP immediate
  [0x80,0x82,0x89,0xC2,0xE2].forEach(function (b) { uno(b, 'NOP', 'imm'); });
  // NOP zero-page / abs forms (ignore)
  [[0x04,'zp'],[0x44,'zp'],[0x64,'zp'],[0x14,'zpx'],[0x34,'zpx'],[0x54,'zpx'],
   [0x74,'zpx'],[0xD4,'zpx'],[0xF4,'zpx'],[0x0C,'abs'],[0x1C,'abx'],[0x3C,'abx'],
   [0x5C,'abx'],[0x7C,'abx'],[0xDC,'abx'],[0xFC,'abx']].forEach(function (v) {
    uno(v[0], 'NOP', v[1]);
  });
  // LAX
  uno(0xA3,'LAX','izx'); uno(0xA7,'LAX','zp'); uno(0xB7,'LAX','zpy');
  uno(0xAF,'LAX','abs'); uno(0xBF,'LAX','aby'); uno(0xB3,'LAX','izy');
  uno(0xAB,'LAX','imm');
  // SAX
  uno(0x83,'SAX','izx'); uno(0x87,'SAX','zp'); uno(0x97,'SAX','zpy'); uno(0x8F,'SAX','abs');
  // DCP
  uno(0xC3,'DCP','izx'); uno(0xC7,'DCP','zp'); uno(0xD7,'DCP','zpx');
  uno(0xCF,'DCP','abs'); uno(0xDF,'DCP','abx'); uno(0xDB,'DCP','aby'); uno(0xD3,'DCP','izy');
  // ISC / ISB
  uno(0xE3,'ISC','izx'); uno(0xE7,'ISC','zp'); uno(0xF7,'ISC','zpx');
  uno(0xEF,'ISC','abs'); uno(0xFF,'ISC','abx'); uno(0xFB,'ISC','aby'); uno(0xF3,'ISC','izy');
  // SLO
  uno(0x03,'SLO','izx'); uno(0x07,'SLO','zp'); uno(0x17,'SLO','zpx');
  uno(0x0F,'SLO','abs'); uno(0x1F,'SLO','abx'); uno(0x1B,'SLO','aby'); uno(0x13,'SLO','izy');
  // RLA
  uno(0x23,'RLA','izx'); uno(0x27,'RLA','zp'); uno(0x37,'RLA','zpx');
  uno(0x2F,'RLA','abs'); uno(0x3F,'RLA','abx'); uno(0x3B,'RLA','aby'); uno(0x33,'RLA','izy');
  // SRE
  uno(0x43,'SRE','izx'); uno(0x47,'SRE','zp'); uno(0x57,'SRE','zpx');
  uno(0x4F,'SRE','abs'); uno(0x5F,'SRE','abx'); uno(0x5B,'SRE','aby'); uno(0x53,'SRE','izy');
  // RRA
  uno(0x63,'RRA','izx'); uno(0x67,'RRA','zp'); uno(0x77,'RRA','zpx');
  uno(0x6F,'RRA','abs'); uno(0x7F,'RRA','abx'); uno(0x7B,'RRA','aby'); uno(0x73,'RRA','izy');
  // ALR / ANC / ARR / AXS / LAS / SHY / SHX / AHX / TAS
  uno(0x4B,'ALR','imm'); uno(0x0B,'ANC','imm'); uno(0x2B,'ANC','imm');
  uno(0x6B,'ARR','imm'); uno(0xCB,'AXS','imm');
  uno(0xBB,'LAS','aby'); uno(0x9C,'SHY','abs'); uno(0x9E,'SHX','aby');
  uno(0x9F,'AHX','aby'); uno(0x93,'AHX','izy'); uno(0x9B,'TAS','aby');

  /* ---------- Small helpers ---------- */
  function isHex(s) { return /^[0-9a-fA-F]+$/.test(s); }
  function isBin(s) { return /^[01]+$/.test(s); }
  function isDec(s) { return /^\d+$/.test(s); }

  // Parse a numeric/identifier expression: returns { value, ok, msg }
  // labelResolve(label) -> number | null (null = unknown in current pass)
  function parseExpr(str, labelResolve) {
    str = str.trim();
    if (!str) return { ok: false, msg: 'Empty operand' };
    if (str[0] === '$') {
      var h = str.slice(1);
      if (!isHex(h)) return { ok: false, msg: 'Bad hex: ' + str };
      return { ok: true, value: parseInt(h, 16) & 0xFFFF };
    }
    if (str[0] === '%') {
      var bin = str.slice(1);
      if (!isBin(bin)) return { ok: false, msg: 'Bad binary: ' + str };
      return { ok: true, value: parseInt(bin, 2) & 0xFFFF };
    }
    if (isDec(str)) return { ok: true, value: parseInt(str, 10) & 0xFFFF };
    if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(str)) {
      var up = str.toUpperCase();
      var v = labelResolve(up);
      if (v === null || v === undefined) return { ok: true, value: null, isLabel: true, name: up };
      return { ok: true, value: v & 0xFFFF, isLabel: true, name: up };
    }
    // simple +N / -N relative to label or '*'
    var m = /^([a-zA-Z_][a-zA-Z0-9_]*|\*)\s*([+-])\s*(\d+)$/.exec(str);
    if (m) {
      var base;
      var lname = m[1].toUpperCase();
      if (m[1] === '*') base = null; // resolved later via currentPc
      else {
        var bv = labelResolve(lname);
        if (bv === null || bv === undefined) return { ok: true, value: null, isLabel: true, name: lname, offset: (m[2] === '+' ? +m[3] : -m[3]) };
        base = bv;
      }
      var off = (m[2] === '+' ? +m[3] : -m[3]);
      return { ok: true, value: base !== null ? (base + off) & 0xFFFF : null, isLabel: true, name: lname, offset: off, usesPc: m[1] === '*' };
    }
    return { ok: false, msg: 'Unknown operand: ' + str };
  }

  /* ---------- Assembler ---------- */
  // Tokenize source into lines: { label, mnemonic, operand, raw, line }
  function tokenize(source) {
    var lines = [];
    var rawLines = source.split(/\r?\n/);
    for (var i = 0; i < rawLines.length; i++) {
      var raw = rawLines[i];
      var code = raw.replace(/;.*$/, '').trim();
      if (!code) { continue; }
      var label = null;
      // Leading label: "name: rest" or a lone label definition
      var colon = code.indexOf(':');
      if (colon !== -1) {
        label = code.slice(0, colon).trim();
        code = code.slice(colon + 1).trim();
      }
      if (!code) {
        if (label) lines.push({ label: label, line: i + 1, raw: raw });
        continue;
      }
      var parts = code.split(/\s+/);
      var mnemonic = parts[0].toUpperCase();
      var operand = parts.slice(1).join(' ').trim();
      lines.push({ label: label, mnemonic: mnemonic, operand: operand, line: i + 1, raw: raw });
    }
    return lines;
  }

  // Build a mode-class result from a parseExpr result, carrying label name/offset.
  function fromExpr(mode, r, extra) {
    var out = { mode: mode, value: r.value, isLabel: !!r.isLabel, resolved: r.ok, err: r.msg };
    if (r.name !== undefined) out.name = r.name;
    if (r.offset !== undefined) out.offset = r.offset;
    if (extra) for (var k in extra) out[k] = extra[k];
    return out;
  }

  // Classify an operand string into a mode candidate set + parsed value.
  function classifyOperand(operand, labelResolve, currentPc) {
    var o = operand.trim();
    if (!o) return { mode: 'imp' };
    if (o === 'A' || o === 'a') return { mode: 'acc' };
    if (o[0] === '#') {
      return fromExpr('imm', parseExpr(o.slice(1), labelResolve, currentPc));
    }
    var m;
    m = /^\(\s*(.+)\s*,\s*X\s*\)$/i.exec(o);
    if (m) return fromExpr('izx', parseExpr(m[1], labelResolve, currentPc));
    m = /^\(\s*(.+)\s*\)\s*,\s*Y\s*$/i.exec(o);
    if (m) return fromExpr('izy', parseExpr(m[1], labelResolve, currentPc));
    m = /^\(\s*(.+)\s*\)$/i.exec(o);
    if (m) return fromExpr('ind', parseExpr(m[1], labelResolve, currentPc));
    m = /^(.+)\s*,\s*X$/i.exec(o);
    if (m) return fromExpr('idx', parseExpr(m[1], labelResolve, currentPc), { index: 'X' });
    m = /^(.+)\s*,\s*Y$/i.exec(o);
    if (m) return fromExpr('idy', parseExpr(m[1], labelResolve, currentPc), { index: 'Y' });
    return fromExpr('mem', parseExpr(o, labelResolve, currentPc));
  }

  // Pick the concrete addressing mode for a mnemonic given a classified operand.
  // Returns { mode, opcode, len } or { error }.
  function pickMode(mn, cls) {
    var variants = INS[mn];
    if (!variants) return { error: 'Unknown mnemonic: ' + mn };
    if (cls.mode === 'imp' || cls.mode === 'acc') {
      for (var i = 0; i < variants.length; i++) {
        if (variants[i][0] === cls.mode) return { mode: cls.mode, opcode: variants[i][1], len: MODES[cls.mode].len };
      }
      return { error: mn + ' does not support ' + (cls.mode === 'acc' ? 'accumulator' : 'implied') + ' addressing' };
    }
    // Explicit modes
    if (cls.mode === 'imm') return pickExact(mn, variants, 'imm', cls);
    if (cls.mode === 'izx') return pickExact(mn, variants, 'izx', cls);
    if (cls.mode === 'izy') return pickExact(mn, variants, 'izy', cls);
    if (cls.mode === 'ind') return pickExact(mn, variants, 'ind', cls);
    if (cls.mode === 'idx') return pickIndexed(mn, variants, 'X', cls);
    if (cls.mode === 'idy') return pickIndexed(mn, variants, 'Y', cls);
    // Relative branch: mnemonic is one of the branches
    if (cls.mode === 'mem' || cls.mode === 'rel') {
      var isBranch = /^(BCC|BCS|BEQ|BMI|BNE|BPL|BVC|BVS)$/.test(mn);
      if (isBranch) return pickExact(mn, variants, 'rel', cls);
    }
    // Plain memory operand: zp vs abs
    if (cls.mode === 'mem') {
      var hasZp = hasMode(variants, 'zp');
      var hasAbs = hasMode(variants, 'abs');
      if (hasZp && hasAbs) {
        var useZp = !cls.isLabel && cls.value !== null && cls.value <= 0xFF;
        if (!useZp && cls.isLabel) {
          // prefer zp if we KNOW it fits, else abs
          useZp = cls.value !== null && cls.value <= 0xFF;
        }
        return useZp ? pickExact(mn, variants, 'zp', cls) : pickExact(mn, variants, 'abs', cls);
      }
      if (hasZp) return pickExact(mn, variants, 'zp', cls);
      if (hasAbs) return pickExact(mn, variants, 'abs', cls);
      return { error: mn + ' needs a memory operand' };
    }
    return { error: 'Unsupported operand' };
  }

  function hasMode(variants, mode) {
    for (var i = 0; i < variants.length; i++) if (variants[i][0] === mode) return true;
    return false;
  }

  function pickExact(mn, variants, mode, cls) {
    for (var i = 0; i < variants.length; i++) {
      if (variants[i][0] === mode) {
        if (cls.value !== null && cls.value > 0xFF && (mode === 'zp' || mode === 'zpx' || mode === 'zpy' || mode === 'izx' || mode === 'izy')) {
          return { error: mn + ' ' + mode + ' operand out of range ($00–$FF): $' + cls.value.toString(16).toUpperCase() };
        }
        return { mode: mode, opcode: variants[i][1], len: MODES[mode].len };
      }
    }
    return { error: mn + ' does not support ' + MODES[mode].label + ' addressing' };
  }

  function pickIndexed(mn, variants, idx, cls) {
    var zpMode = idx === 'X' ? 'zpx' : 'zpy';
    var absMode = idx === 'X' ? 'abx' : 'aby';
    var hasZp = hasMode(variants, zpMode);
    var hasAbs = hasMode(variants, absMode);
    if (hasZp && hasAbs) {
      var useZp = cls.value !== null && cls.value <= 0xFF;
      if (cls.isLabel && cls.value === null) useZp = false;
      return useZp ? pickExact(mn, variants, zpMode, cls) : pickExact(mn, variants, absMode, cls);
    }
    if (hasZp) return pickExact(mn, variants, zpMode, cls);
    if (hasAbs) return pickExact(mn, variants, absMode, cls);
    return { error: mn + ' does not support ' + idx + '-indexed addressing' };
  }

  // Data directive: returns bytes or error
  function directiveBytes(mnemonic, operand, labelResolve) {
    var isHex = (mnemonic === 'HEX' || mnemonic === '.HEX');
    if (mnemonic !== 'DB' && mnemonic !== '.BYTE' && mnemonic !== 'BYTE' &&
        mnemonic !== 'DW' && mnemonic !== '.WORD' && mnemonic !== 'WORD' &&
        !isHex) return null;
    var isWord = (mnemonic === 'DW' || mnemonic === '.WORD' || mnemonic === 'WORD');
    var bytes = [];
    if (isHex) {
      // HEX "AABBCC" or "AA BB CC" — every 1-2 hex chars is one byte.
      var h = operand.replace(/[\s,]/g, '');
      if (!h.length || h.length % 2 !== 0) return { error: 'HEX expects an even number of hex digits' };
      if (!/^[0-9a-fA-F]+$/.test(h)) return { error: 'HEX contains non-hex characters: ' + operand };
      for (var hi = 0; hi < h.length; hi += 2) bytes.push(parseInt(h.substr(hi, 2), 16));
      return { bytes: bytes };
    }
    var parts = operand.split(',').map(function (s) { return s.trim(); });
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (!p) return { error: 'Empty value in data directive' };
      var r = parseExpr(p, labelResolve);
      if (!r.ok) return { error: r.msg };
      if (r.value === null) return { error: 'Forward label in data directive not supported: ' + p };
      if (isWord) {
        bytes.push(r.value & 0xFF);
        bytes.push((r.value >> 8) & 0xFF);
      } else {
        if (r.value > 0xFF) return { error: 'Byte value out of range: ' + p };
        bytes.push(r.value & 0xFF);
      }
    }
    return { bytes: bytes };
  }

  // Main assemble() — iterative passes so zp/abs sizing converges.
  function assemble(source, origin) {
    if (Array.isArray(source)) source = source.join('\n');
    source = String(source || '');
    origin = (origin === undefined) ? 0x8000 : (origin & 0xFFFF);
    var lines = tokenize(source);

    var labels = {};          // label addresses from previous pass (seed)
    var instructions = [];    // resolved per pass: { line, mode, opcode, len, cls, isData, dataBytes }
    var errors = [];
    var prevSig = null;
    var stable = false;
    var pass;

    for (pass = 0; pass < 12 && !stable; pass++) {
      var nextLabels = {};
      var pc = origin;
      var passInstrs = [];
      var passErrors = [];

      function resolveLabel(name) {
        return (name in labels) ? labels[name] : null;
      }

      for (var li = 0; li < lines.length; li++) {
        var line = lines[li];
        if (line.label) {
          var lkey = line.label.toUpperCase();
          if (lkey in nextLabels) passErrors.push('Duplicate label: ' + line.label + ' (line ' + line.line + ')');
          else nextLabels[lkey] = pc;
        }
        if (!line.mnemonic) { continue; }
        var entry = { line: line, pc: pc };
        // Data directive?
        var d = directiveBytes(line.mnemonic, line.operand || '', resolveLabel);
        if (d) {
          if (d.error) { passErrors.push('Line ' + line.line + ': ' + d.error); entry.mode = 'skip'; entry.len = 0; }
          else { entry.isData = true; entry.dataBytes = d.bytes; entry.len = d.bytes.length; }
        } else {
          var cls = classifyOperand(line.operand || '', resolveLabel, pc);
          if (cls.err) { passErrors.push('Line ' + line.line + ': ' + cls.err); entry.mode = 'skip'; entry.len = 0; }
          else {
            var picked = pickMode(line.mnemonic, cls);
            if (picked.error) { passErrors.push('Line ' + line.line + ': ' + picked.error); entry.mode = 'skip'; entry.len = 0; }
            else { entry.mode = picked.mode; entry.opcode = picked.opcode; entry.len = picked.len; entry.cls = cls; }
          }
        }
        pc += entry.len;
        passInstrs.push(entry);
      }

      var sig = JSON.stringify(passInstrs.map(function (e) { return e.len; }));
      if (pass > 0 && sig === prevSig) stable = true;
      prevSig = sig;
      instructions = passInstrs;
      errors = passErrors;
      labels = nextLabels;
    }
    if (!stable && pass >= 12) {
      // fall through with last known lengths
    }

    // Final pass: emit bytes.
    var bytes = [];
    var outErrors = [];
    var usedLabels = {};
    for (var e = 0; e < instructions.length; e++) {
      var ent = instructions[e];
      if (ent.mode === 'skip') continue;
      if (ent.isData) {
        for (var di = 0; di < ent.dataBytes.length; di++) bytes.push(ent.dataBytes[di]);
        continue;
      }
      var ln = ent.line.line;
      var mn = ent.line.mnemonic;
      bytes.push(ent.opcode);
      // Forward-label references captured a null value during sizing passes;
      // re-resolve now that every label is known.
      var val = ent.cls.value;
      if (val === null && ent.cls.isLabel && ent.cls.name) {
        if (ent.cls.name in labels) val = labels[ent.cls.name];
        if (val !== null && ent.cls.offset) val = (val + ent.cls.offset) & 0xFFFF;
      }
      if (ent.cls.mode === 'imm') {
        if (val === null) { outErrors.push('Line ' + ln + ': unresolved label in immediate operand'); continue; }
        bytes.push(val & 0xFF);
      } else if (ent.mode === 'izx' || ent.mode === 'izy' || ent.mode === 'zp' || ent.mode === 'zpx' || ent.mode === 'zpy') {
        if (val === null) { outErrors.push('Line ' + ln + ': unresolved label in zero-page operand'); continue; }
        bytes.push(val & 0xFF);
      } else if (ent.mode === 'abs' || ent.mode === 'abx' || ent.mode === 'aby' || ent.mode === 'ind') {
        if (val === null) { outErrors.push('Line ' + ln + ': unresolved label in absolute operand'); continue; }
        bytes.push(val & 0xFF);
        bytes.push((val >> 8) & 0xFF);
      } else if (ent.mode === 'rel') {
        if (val === null) { outErrors.push('Line ' + ln + ': unresolved branch target'); continue; }
        var offset = val - (ent.pc + 2);
        if (offset < -128 || offset > 127) {
          outErrors.push('Line ' + ln + ': branch out of range (' + offset + ' bytes)');
          continue;
        }
        bytes.push(offset & 0xFF);
      }
    }

    if (outErrors.length) errors = errors.concat(outErrors);

    return { bytes: bytes, labels: labels, errors: errors, length: bytes.length, origin: origin };
  }

  /* ---------- Disassembler ---------- */
  var MODE_FMT = {
    imp: function (op, bytes) { return op.mn; },
    acc: function (op, bytes) { return op.mn + ' A'; },
    imm: function (op, bytes) { return op.mn + ' #$' + pad2(bytes[1]); },
    zp:  function (op, bytes) { return op.mn + ' $' + pad2(bytes[1]); },
    zpx: function (op, bytes) { return op.mn + ' $' + pad2(bytes[1]) + ',X'; },
    zpy: function (op, bytes) { return op.mn + ' $' + pad2(bytes[1]) + ',Y'; },
    abs: function (op, bytes, addr) { return op.mn + ' $' + pad4(wordAt(bytes, 1)); },
    abx: function (op, bytes, addr) { return op.mn + ' $' + pad4(wordAt(bytes, 1)) + ',X'; },
    aby: function (op, bytes, addr) { return op.mn + ' $' + pad4(wordAt(bytes, 1)) + ',Y'; },
    ind: function (op, bytes, addr) { return op.mn + ' ($' + pad4(wordAt(bytes, 1)) + ')'; },
    izx: function (op, bytes, addr) { return op.mn + ' ($' + pad2(bytes[1]) + ',X)'; },
    izy: function (op, bytes, addr) { return op.mn + ' ($' + pad2(bytes[1]) + '),Y'; },
    rel: function (op, bytes, addr) {
      var off = (bytes[1] << 24) >> 24; // sign extend
      var target = ((addr + 2 + off) & 0xFFFF);
      return op.mn + ' $' + pad4(target);
    }
  };

  function wordAt(bytes, i) {
    return (bytes[i] | (bytes[i + 1] << 8)) & 0xFFFF;
  }
  function pad2(n) { n = n & 0xFF; return (n < 16 ? '0' : '') + n.toString(16).toUpperCase(); }
  function pad4(n) { n = n & 0xFFFF; return (n < 4096 ? (n < 256 ? (n < 16 ? '000' : '00') : '0') : '') + n.toString(16).toUpperCase(); }

  function disassemble(readByte, pc, count) {
    var out = [];
    var addr = pc & 0xFFFF;
    for (var i = 0; i < count; i++) {
      var b = readByte(addr);
      var op = OPCODES[b] || UNOFFICIAL[b];
      var len = op ? op.len : 1;
      var bytes = [];
      for (var j = 0; j < len; j++) bytes.push(readByte((addr + j) & 0xFFFF));
      var text;
      if (!op) {
        text = '??? $' + pad2(b);
      } else {
        text = MODE_FMT[op.mode](op, bytes, addr);
      }
      out.push({ addr: addr, bytes: bytes, text: text });
      addr = (addr + len) & 0xFFFF;
    }
    return out;
  }

  // Convenience: assemble from hex string "A9 05 8D 00 02"
  function fromHexString(hexStr) {
    var parts = hexStr.split(/[\s,]+/).filter(function (s) { return s.length; });
    var bytes = [];
    for (var i = 0; i < parts.length; i++) {
      var v = parseInt(parts[i], 16);
      if (isNaN(v) || v < 0 || v > 255) return null;
      bytes.push(v);
    }
    return bytes;
  }

  return {
    OPCODES: OPCODES,
    UNOFFICIAL: UNOFFICIAL,
    MODES: MODES,
    assemble: assemble,
    disassemble: disassemble,
    fromHexString: fromHexString,
    pad2: pad2,
    pad4: pad4
  };
});

