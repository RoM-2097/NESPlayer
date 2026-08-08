/* ============================================================
   NESDebugger — RAM/PRG hex editor + CPU debugger + assembler
   NOVA · NESPLAYER v2.9 debugger library
   ------------------------------------------------------------
   Built on the ASM6502 library (js/asm6502.js). Provides:
   - Live CPU register readout (A, X, Y, SP, PC, flags NV-BDIZC)
   - PC-following disassembly with scroll/offset controls
   - Click-to-edit hex editor for RAM ($0000) and PRG ($8000)
   - Assembler box (origin + source) that writes bytes directly
     into RAM or PRG memory via a universal memory writer
   - Step / Run / Close controls
   Exposes `window.NESDebugger`.
   ============================================================ */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NESDebugger = api;
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  /* ---------- Small helpers ---------- */
  function $(id) { return document.getElementById(id); }
  function pad2(n) { n &= 0xFF; return (n < 16 ? '0' : '') + n.toString(16).toUpperCase(); }
  function pad4(n) { n &= 0xFFFF; return (n < 4096 ? (n < 256 ? (n < 16 ? '000' : '00') : '0') : '') + n.toString(16).toUpperCase(); }

  // Human readable flags for the status register (bit 5 = unused, shown as -).
  function flagsText(status) {
    var f = [];
    f.push(status & 0x80 ? 'N' : 'n');
    f.push(status & 0x40 ? 'V' : 'v');
    f.push(status & 0x20 ? '-' : '-');
    f.push(status & 0x10 ? 'B' : 'b');
    f.push(status & 0x08 ? 'D' : 'd');
    f.push(status & 0x04 ? 'I' : 'i');
    f.push(status & 0x02 ? 'Z' : 'z');
    f.push(status & 0x01 ? 'C' : 'c');
    return f;
  }

  /* ============================================================
     The debugger module.
     `nes` is a jsnes.NES instance (set via open()).
     The UI is static markup inside #debugModal (index.html).
     ============================================================ */
  var NESDebugger = {

    /* ---------- State ---------- */
    nes: null,              // live emulator reference (set on open)
    active: false,          // is the debugger modal open?
    disasmBase: 0x8000,     // first address shown in the disassembly list
    followPc: true,         // when true, disasmBase follows REG_PC each refresh
    hexRegion: 'ram',       // 'ram' | 'prg'
    hexPage: 0,             // page offset in bytes (0, 0x100, 0x200, ...)
    prgOffset: 0x8000,      // base address of the PRG editor (covers $8000-$BFFF)
    editing: null,          // { input } while a hex cell input is focused
    lastPc: -1,             // last PC seen, for detecting execution in Step mode

    /* ---------- Root wiring ---------- */
    init: function () {
      var self = this;
      this.els = {
        modal: $('debugModal'),
        btnClose: $('dbgClose'),
        btnStep: $('dbgStep'),
        btnRun: $('dbgRun'),
        btnFollow: $('dbgFollow'),
        btnDisasmPrev: $('dbgDisasmPrev'),
        btnDisasmNext: $('dbgDisasmNext'),
        btnHexRam: $('dbgHexRam'),
        btnHexPrg: $('dbgHexPrg'),
        btnHexPrev: $('dbgHexPrev'),
        btnHexNext: $('dbgHexNext'),
        btnHexPc: $('dbgHexPc'),
        hexAddr: $('dbgHexAddr'),
        hexGrid: $('dbgHexGrid'),
        asmOrigin: $('dbgAsmOrigin'),
        asmSource: $('dbgAsmSource'),
        btnAssemble: $('dbgAsmAssemble'),
        btnWrite: $('dbgAsmWrite'),
        btnResetApply: $('dbgAsmResetApply'),
        asmStatus: $('dbgAsmStatus'),
        regGrid: $('dbgRegs'),
        flagsRow: $('dbgFlags'),
        disasmList: $('dbgDisasm'),
        status: $('dbgStatus')
      };

      if (!this.els.modal) return; // markup not present — no-op

      this.els.btnClose.addEventListener('click', function () { self.close(true); });
      this.els.modal.addEventListener('click', function (e) {
        if (e.target === self.els.modal) self.close(true);
      });
      this.els.btnStep.addEventListener('click', function () { self.step(); });
      this.els.btnRun.addEventListener('click', function () { self.close(true); });
      this.els.btnFollow.addEventListener('click', function () {
        self.followPc = !self.followPc;
        if (self.followPc && self.nes) self.disasmBase = self.nes.cpu.REG_PC;
        self.render();
      });
      this.els.btnDisasmPrev.addEventListener('click', function () {
        self.followPc = false;
        self.disasmBase = (self.disasmBase - 0x10) & 0xFFFF;
        self.render();
      });
      this.els.btnDisasmNext.addEventListener('click', function () {
        self.followPc = false;
        self.disasmBase = (self.disasmBase + 0x10) & 0xFFFF;
        self.render();
      });

      this.els.btnHexRam.addEventListener('click', function () {
        self.setHexRegion('ram');
      });
      this.els.btnHexPrg.addEventListener('click', function () {
        self.setHexRegion('prg');
      });
      this.els.btnHexPrev.addEventListener('click', function () {
        self.hexPage = Math.max(0, self.hexPage - 0x100);
        self.render();
      });
      this.els.btnHexNext.addEventListener('click', function () {
        self.hexPage = Math.min(self.maxHexPage(), self.hexPage + 0x100);
        self.render();
      });
      this.els.btnHexPc.addEventListener('click', function () {
        if (!self.nes) return;
        self.setHexRegion('prg');
        self.hexPage = self.nes.cpu.REG_PC & 0xFF00;
        self.render();
      });

      this.els.btnAssemble.addEventListener('click', function () { self.assemble(false); });
      this.els.btnWrite.addEventListener('click', function () { self.assemble(true); });
      this.els.btnResetApply.addEventListener('click', function () { self.resetApply(); });

      // Enter commits a hex edit; Esc cancels it.
      this.els.hexGrid.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          self.commitHexEdit();
          var cell = e.target.closest('[data-addr]');
          if (cell) {
            var next = cell.nextElementSibling;
            if (next && next.dataset && next.dataset.addr) {
              var input = document.createElement('input');
              next.textContent = '';
              input.value = '';
              input.className = 'dbg-hex-input';
              input.maxLength = 2;
              next.appendChild(input);
              self.editing = { input: input };
              input.focus();
              input.select();
            }
          }
        } else if (e.key === 'Escape') {
          self.cancelHexEdit();
        }
      });
    },

    /* ---------- Open / close ---------- */
    open: function (nes) {
      this.nes = nes;
      this.active = true;
      this.lastPc = -1;
      if (nes && nes.cpu) {
        this.disasmBase = nes.cpu.REG_PC & 0xFFFF;
        this.hexPage = (nes.cpu.REG_PC & 0xFF00);
        this.setHexRegion('prg');
      }
      this.els.modal.hidden = false;
      document.body.classList.add('no-scroll');
      this.render();
    },

    close: function (resume) {
      this.cancelHexEdit();
      this.active = false;
      this.nes = null;
      this.els.modal.hidden = true;
      document.body.classList.remove('no-scroll');
      // resume is handled by app.js (it re-enables the run loop). Notify
      // app.js that the modal was closed via its own controls (Run / ✕ /
      // backdrop) so the shared debugger-open state stays in sync.
      if (root.dispatchEvent) {
        try {
          root.dispatchEvent(new (root.CustomEvent || root.Event)('nesplayer:debugger-close'));
        } catch (err) { /* custom events unsupported — app.js still tracks state */ }
      }
    },

    /* ---------- Single frame step ---------- */
    step: function () {
      if (!this.nes) return;
      this.lastPc = this.nes.cpu.REG_PC;
      this.nes.frame();              // run exactly one 6502 frame
      this.followPc = true;
      this.render();
    },

    /* ---------- Read byte helper (works for RAM + mapped PRG) ---------- */
    readByte: function (addr) {
      if (!this.nes || !this.nes.cpu) return 0xFF;
      // cpu.load() honours RAM mirrors for <$2000 and routes $8000+ through
      // the mapper (mmap.load) so the disassembly always sees real ROM bytes.
      return this.nes.cpu.load(addr & 0xFFFF) & 0xFF;
    },

    /* ---------- Rendering ---------- */
    render: function () {
      if (!this.active) return;
      this.renderRegs();
      this.renderDisasm();
      this.renderHex();
      this.renderStatus();
    },

renderRegs: function () {
      var cpu = this.nes && this.nes.cpu;
      if (!cpu) return;
      var st = cpu.getStatus();
      var rows = [
        ['A', cpu.REG_ACC, 'X', cpu.REG_X],
        ['Y', cpu.REG_Y, 'S', cpu.REG_SP],
        ['PC', cpu.REG_PC, 'ST', st]
      ];
      var self = this;
      this.els.regGrid.innerHTML = '';
      rows.forEach(function (pair) {
        var row = document.createElement('div');
        row.className = 'dbg-reg-row';
        [[pair[0], pair[1]], [pair[2], pair[3]]].forEach(function (cell) {
          var item = document.createElement('span');
          item.className = 'dbg-reg-item';
          var name = document.createElement('span');
          name.className = 'dbg-reg-name';
          name.textContent = cell[0];
          var val = document.createElement('span');
          val.className = 'dbg-reg-value' + (cell[0] === 'PC' ? ' dbg-reg-value--pc' : '');
          val.textContent = '$' + (cell[0] === 'PC' || cell[0] === 'ST' ? pad4(cell[1]) : pad2(cell[1]));
          item.appendChild(name);
          item.appendChild(val);
          row.appendChild(item);
        });
        self.els.regGrid.appendChild(row);
      });

      var fl = flagsText(st);
      var names = ['N', 'V', '-', 'B', 'D', 'I', 'Z', 'C'];
      this.els.flagsRow.innerHTML = '';
      for (var i = 0; i < 8; i++) {
        var pill = document.createElement('span');
        pill.className = 'dbg-flag' + (fl[i] === fl[i].toUpperCase() ? ' is-set' : '');
        pill.textContent = names[i];
        this.els.flagsRow.appendChild(pill);
      }
    },

renderDisasm: function () {
      var cpu = this.nes && this.nes.cpu;
      if (!cpu) return;
      if (this.followPc) this.disasmBase = cpu.REG_PC;
      var pc = cpu.REG_PC;
      var list = ASM6502.disassemble(this.readByte.bind(this), this.disasmBase, 12);
      var self = this;
      this.els.disasmList.innerHTML = '';
      list.forEach(function (ins) {
        var row = document.createElement('div');
        row.className = 'dbg-disasm-row' + (ins.addr === pc ? ' is-pc' : '');
        var addr = document.createElement('span');
        addr.className = 'dbg-disasm-addr';
        addr.textContent = '$' + pad4(ins.addr);
        var bytes = document.createElement('span');
        bytes.className = 'dbg-disasm-bytes';
        bytes.textContent = ins.bytes.map(function (b) { return pad2(b); }).join(' ').padEnd(9, ' ');
        var text = document.createElement('span');
        text.className = 'dbg-disasm-text';
        text.textContent = ins.text;
        var marker = document.createElement('span');
        marker.className = 'dbg-disasm-marker';
        marker.textContent = ins.addr === pc ? '◄' : '';
        row.appendChild(addr);
        row.appendChild(bytes);
        row.appendChild(text);
        row.appendChild(marker);
        self.els.disasmList.appendChild(row);
      });
    },

    /* ---------- Hex editor ---------- */
    maxHexPage: function () {
      // RAM region pages cover $0000-$1FFF (the mirrored RAM + I/O + APU area);
      // PRG pages cover $8000-$BFFF (the fixed 16KB PRG window where most
      // mappers keep executable code). PRG writes are best-effort patched.
      return this.hexRegion === 'prg' ? (0xC000 - 0x8000 - 0x100) : (0x2000 - 0x100);
    },

    setHexRegion: function (r) {
      this.hexRegion = r;
      this.hexPage = r === 'prg' ? 0x8000 : 0;
      this.render();
    },

    renderHex: function () {
      var cpu = this.nes && this.nes.cpu;
      if (!cpu) return;

      var base = this.hexRegion === 'prg' ? this.prgOffset + this.hexPage : this.hexPage;
      this.els.hexAddr.textContent = '$' + pad4(base);

      this.els.btnHexRam.classList.toggle('is-active', this.hexRegion === 'ram');
      this.els.btnHexPrg.classList.toggle('is-active', this.hexRegion === 'prg');
      this.els.btnHexPrev.disabled = this.hexPage <= 0;
      this.els.btnHexNext.disabled = this.hexPage >= this.maxHexPage();

      var rowsHtml = [];
      var self = this;
      for (var row = 0; row < 16; row++) {
        var rowAddr = base + row * 16;
        var cells = [];
        for (var col = 0; col < 16; col++) {
          var a = rowAddr + col;
          var v = cpu.load(a) & 0xFF;
          var isPc = (a === cpu.REG_PC) && this.hexRegion === 'prg';
          cells.push('<td class="dbg-hex-cell' + (isPc ? ' is-pc' : '') + '" data-addr="' + a + '">' + pad2(v) + '</td>');
        }
        rowsHtml.push('<tr><td class="dbg-hex-off">$' + pad4(rowAddr) + '</td>' + cells.join('') + '</tr>');
      }
      this.els.hexGrid.innerHTML = rowsHtml.join('');

      // One delegated click handler (bound once in init) to begin an edit.
      if (!this._hexClickBound) {
        this._hexClickBound = true;
        this.els.hexGrid.addEventListener('click', function (e) {
          var cell = e.target.closest('[data-addr]');
          if (!cell) return;
          if (self.editing) self.commitHexEdit();
          var addr = parseInt(cell.dataset.addr, 10);
          cell.textContent = '';
          var input = document.createElement('input');
          input.className = 'dbg-hex-input';
          input.maxLength = 2;
          input.value = '';
          cell.appendChild(input);
          self.editing = { input: input, addr: addr, cell: cell };
          input.focus();
          input.select();
        });
      }
    },

    commitHexEdit: function () {
      if (!this.editing) return;
      var ed = this.editing;
      this.editing = null;
      var raw = ed.input.value.trim();
      var v = parseInt(raw, 16);
      if (isNaN(v) || v < 0 || v > 255) {
        // Invalid input — restore the original byte value.
        var orig = this.nes.cpu.load(ed.addr) & 0xFF;
        ed.cell.textContent = pad2(orig);
        this.renderStatus();
        return;
      }
      // Universal memory writer: cpu.write() honours RAM mirrors for $0000-$1FFF
      // and routes $8000+ through the mapper. Some mappers ignore writes to
      // ROM (a documented caveat), but most NROM-style carts accept the patch.
      this.nes.cpu.write(ed.addr, v);
      ed.cell.textContent = pad2(v);
      this.renderStatus();
    },

    cancelHexEdit: function () {
      if (!this.editing) return;
      var ed = this.editing;
      this.editing = null;
      var orig = this.nes.cpu.load(ed.addr) & 0xFF;
      ed.cell.textContent = pad2(orig);
    },

    /* ---------- Assembler ---------- */
    assemble: function (apply) {
      var self = this;
      var src = this.els.asmSource.value;
      if (!src.trim()) { this.setAsmStatus('Source is empty', 'error'); return; }

      var originStr = this.els.asmOrigin.value.trim();
      var origin = 0x8000;
      if (originStr) {
        var m = /^\$?([0-9a-fA-F]{1,4})$/.exec(originStr) || /^([0-9]{1,5})$/.exec(originStr);
        if (m && m[1] && /^[0-9a-fA-F]+$/.test(originStr.replace(/^\$/, ''))) {
          origin = parseInt(originStr.replace(/^\$/, ''), 16) & 0xFFFF;
        } else if (m && /^\d+$/.test(originStr)) {
          origin = parseInt(originStr, 10) & 0xFFFF;
        } else {
          this.setAsmStatus('Bad origin — use hex like $8000 or decimal', 'error');
          return;
        }
      }

      var res = ASM6502.assemble(src, origin);
      if (res.errors && res.errors.length) {
        this.setAsmStatus(res.errors.length + ' error(s): ' + res.errors[0], 'error');
        return;
      }
      if (!res.bytes.length) {
        this.setAsmStatus('Nothing to write', 'error');
        return;
      }

      var bytes = res.bytes;
      if (!apply) {
        // Assemble preview only — show the produced bytes without writing.
        this.setAsmStatus('OK — ' + bytes.length + ' byte(s) at $' + pad4(origin) + '  ·  ' +
          bytes.slice(0, 12).map(function (b) { return pad2(b); }).join(' ') +
          (bytes.length > 12 ? ' …' : '') + '  (press Write to apply)', 'success');
        return;
      }

      // Write the assembled routine into memory. Anything below $8000 goes
      // through the normal RAM write path (mirrors respected); $8000+ is a
      // direct PRG patch (best-effort on mapper cartridges).
      var addr = origin & 0xFFFF;
      for (var i = 0; i < bytes.length; i++) {
        if (addr < 0x8000) {
          this.nes.cpu.write(addr, bytes[i]);
        } else {
          this.nes.cpu.write(addr, bytes[i]);
        }
        addr = (addr + 1) & 0xFFFF;
      }
      this.setAsmStatus('✓ Wrote ' + bytes.length + ' byte(s) to $' + pad4(origin) + ' (' +
        bytes.map(function (b) { return pad2(b); }).join(' ') + ')', 'success');
      // Keep the disassembler looking at the routine we just wrote.
      this.followPc = false;
      this.disasmBase = origin & 0xFFFF;
      this.render();
    },

    // Reset the console (boot to the reset vector), then apply the assembled
    // routine into memory again so the game starts executing our code at
    // origin (works on carts that boot to $8000).
resetApply: function () {
      if (!this.nes) return;
      var originStr = this.els.asmOrigin.value.trim();
      var origin = 0x8000;
      if (originStr) {
        var m = /^\$?([0-9a-fA-F]{1,4})$/.exec(originStr) || /^([0-9]{1,5})$/.exec(originStr);
        if (m && m[1] && /^[0-9a-fA-F]+$/.test(originStr.replace(/^\$/, ''))) {
          origin = parseInt(originStr.replace(/^\$/, ''), 16) & 0xFFFF;
        } else if (m && /^\d+$/.test(originStr)) {
          origin = parseInt(originStr, 10) & 0xFFFF;
        } else {
          this.setAsmStatus('Bad origin — use hex like $8000 or decimal', 'error');
          return;
        }
      }
      // Reset the jsnes core to its boot state. The vendored jsnes
      // NES.prototype.reset() zeroes the CPU/PPU/APU but does NOT re-request
      // the RESET IRQ (only loadROM() does). Without it the CPU stays at
      // PC=0x7FFF executing garbage and never drives the PPU to VBlank, so the
      // next frame() hangs forever (gray/black screen). Re-requesting the
      // RESET IRQ makes the CPU jump to the ROM's reset vector so rendering
      // resumes normally — the same fix app.js's resetNES() uses.
      this.nes.reset();
      if (this.nes.cpu && typeof this.nes.cpu.requestIrq === 'function' && this.nes.cpu.IRQ_RESET !== undefined) {
        this.nes.cpu.requestIrq(this.nes.cpu.IRQ_RESET);
      }
      this.assemble(true);
      this.nes.cpu.REG_PC = origin & 0xFFFF;
      this.setAsmStatus('✓ Reset applied — PC set to $' + pad4(origin), 'success');
      this.followPc = true;
      this.render();
    },

    setAsmStatus: function (msg, type) {
      this.els.asmStatus.textContent = msg;
      this.els.asmStatus.className = 'dbg-asm-status' + (type === 'error' ? ' is-error' : '');
    },

    renderStatus: function () {
      if (!this.nes) return;
      var cpu = this.nes.cpu;
      this.els.status.textContent = 'PC $' + pad4(cpu.REG_PC) + '  ·  ' +
        'A $' + pad2(cpu.REG_ACC) + '  ·  X $' + pad2(cpu.REG_X) + '  ·  Y $' + pad2(cpu.REG_Y) + '  ·  ' +
        'SP $' + pad2(cpu.REG_SP) + '  ·  Cycle ' + (this.nes.fpsFrameCount || 0);
    }
  };

  if (root.addEventListener) root.addEventListener('DOMContentLoaded', function () { NESDebugger.init(); });
  else if (root.ASM6502) NESDebugger.init();

  return NESDebugger;
});

