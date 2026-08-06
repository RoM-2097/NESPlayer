// Confirm: with the CURRENT stop() polyfill (sets running=false only), an
// illegal-opcode ROM makes frame() INFINITE-LOOP. Then confirm the FIXED
// polyfill (stop sets _stop + patched frame checks it) halts cleanly.
'use strict';
const m = require('../js/neslib/jsnes.min.js');
const jsnes = m.jsnes || m;
const NES = jsnes.NES;

// Capture the ORIGINAL frame + stop implementations ONCE.
// (Fresh module load each run via a fresh process, so prototype is pristine here.)
const origFrame = NES.prototype.frame;
const origStop = NES.prototype.stop;

function makeCrashRom() {
  const prg = 1, chr = 1;
  const size = 16 + prg * 16384 + chr * 4096;
  const b = new Uint8Array(size);
  b[0] = 0x4E; b[1] = 0x45; b[2] = 0x53; b[3] = 0x1A;
  b[4] = prg; b[5] = chr >>> 1; b[6] = 0; b[7] = 0;
  b[16 + 0x7FFC] = 0x02; b[16 + 0x7FFD] = 0x80; // reset -> $8002
  b[16 + 2] = 0x02; // illegal opcode at $8002
  let s = '';
  for (let i = 0; i < size; i += 0x8000) {
    s += String.fromCharCode.apply(null, b.subarray(i, Math.min(i + 0x8000, size)));
  }
  return s;
}

function makeNES() {
  return new jsnes.NES({ onFrame: function(){}, onAudioSample: null, onStatusUpdate: function(){}, preferredFrameRate: 60, emulateSound: false, sampleRate: 44100 });
}

// Restore original implems before each scenario.
function restore() {
  NES.prototype.stop = origStop;
  NES.prototype.frame = origFrame;
  delete NES.prototype._stop;
}

// The FIXED polyfill: stop sets _stop, and frame() checks _stop to break out.
function installFixed() {
  NES.prototype.stop = function () {
    this.running = false;
    this._stop = true;
    this.crashMessage = 'Game crashed: invalid opcode';
  };
  NES.prototype.frame = function () {
    this.ppu.startFrame();
    var cycles = 0, emulateSound = this.opts.emulateSound, cpu = this.cpu, ppu = this.ppu, papu = this.papu;
    this._stop = false;
    outer:
    while (!this._stop) {
      if (cpu.cyclesToHalt === 0) {
        cycles = cpu.emulate();
        if (emulateSound) papu.clockFrameCounter(cycles);
        cycles *= 3;
      } else if (cpu.cyclesToHalt > 8) {
        cycles = 24;
        if (emulateSound) papu.clockFrameCounter(8);
        cpu.cyclesToHalt -= 8;
      } else {
        cycles = 3 * cpu.cyclesToHalt;
        if (emulateSound) papu.clockFrameCounter(cpu.cyclesToHalt);
        cpu.cyclesToHalt = 0;
      }
      for (; cycles > 0; cycles--) {
        if (ppu.curX === ppu.spr0HitX && ppu.f_spVisibility === 1 && ppu.scanline - 21 === ppu.spr0HitY) {
          ppu.setStatusFlag(ppu.STATUS_SPRITE0HIT, true);
        }
        if (ppu.requestEndFrame && --ppu.nmiCounter === 0) {
          ppu.requestEndFrame = false;
          ppu.startVBlank();
          break outer;
        }
        ppu.curX++;
        if (ppu.curX === 341) { ppu.curX = 0; ppu.endScanline(); }
      }
    }
    this._stop = false;
    this.fpsFrameCount++;
  };
}

function run(label, useFixed) {
  restore();
  const rom = makeCrashRom();

  if (useFixed) {
    installFixed();
  } else {
    // CURRENT (buggy) polyfill: only sets running=false
    NES.prototype.stop = function () { this.running = false; this.crashMessage = 'Game crashed: invalid opcode'; };
    NES.prototype.frame = origFrame;
  }

  const nes = makeNES();
  nes.loadROM(rom);

  const result = { completed: false, threw: false };
  const to = setTimeout(() => {}, 2000);
  try {
    nes.frame();
    result.completed = true;
  } catch (e) {
    result.threw = true;
    result.completed = true;
    result.err = e.message;
  }
  clearTimeout(to);
  console.log('--- ' + label + ' ---');
  console.log('frame() returned=' + result.completed + ' threw=' + result.threw + (result.err ? ' err=' + result.err : ''));
  console.log('crashMessage=' + (nes.crashMessage || '(none)') + ' _stop=' + nes._stop);
  process.exit(0);
}

// Run CURRENT first (will hang -> watchdog via child in shell). We run it in a
// child process so a hang won't block this script.
const { spawn } = require('child_process');
const path = require('path');
const script = path.join(__dirname, '_test_stop3_child.js');
require('fs').writeFileSync(script, `
'use strict';
const m = require('../js/neslib/jsnes.min.js');
const jsnes = m.jsnes || m; const NES = jsnes.NES;
const origFrame = NES.prototype.frame;
function makeCrashRom(){const sz=16+16384+4096;const b=new Uint8Array(sz);b[0]=0x4E;b[1]=0x45;b[2]=0x53;b[3]=0x1A;b[4]=1;b[5]=0;b[6]=0;b[7]=0;b[16+0x7FFC]=0x02;b[16+0x7FFD]=0x80;b[16+2]=0x02;let s='';for(let i=0;i<sz;i+=0x8000)s+=String.fromCharCode.apply(null,b.subarray(i,Math.min(i+0x8000,sz)));return s;}
const nes = new jsnes.NES({onFrame:function(){},onAudioSample:null,onStatusUpdate:function(){},preferredFrameRate:60,emulateSound:false,sampleRate:44100});
nes.loadROM(makeCrashRom());
// CURRENT polyfill
NES.prototype.stop=function(){this.running=false;this.crashMessage='crash';};
NES.prototype.frame=origFrame;
console.log('CURRENT polyfill: calling frame()...');
try { nes.frame(); console.log('frame RETURNED (no hang)'); }
catch(e){ console.log('frame THREW:', e.message); }
console.log('EXIT');
process.exit(0);
`);
const child = spawn(process.execPath, [script], { cwd: __dirname });
let out = '';
child.stdout.on('data', d => out += d.toString());
child.on('exit', () => {
  console.log(out);
  console.log('--- FIXED polyfill (this process) ---');
  run('FIXED', true);
});
child.on('error', e => console.error('spawn error', e));
