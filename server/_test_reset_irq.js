// Verify whether nes.reset() alone re-requests the RESET IRQ, or whether the
// CPU is left at PC=0x7FFF executing garbage (which never drives the PPU to
// VBlank, so frame() loops forever). Each case runs in a CHILD process because
// a hung frame() blocks the event loop synchronously and would take the test
// harness down with it.
'use strict';
const { spawnSync } = require('child_process');
const path = require('path');

const JSNES = path.resolve(__dirname, '../js/neslib/jsnes.min.js');

const worker = `
'use strict';
const m=require(${JSON.stringify(JSNES)});
const jsnes=m.jsnes||m;
if (jsnes.NES && jsnes.NES.prototype && typeof jsnes.NES.prototype.stop==="undefined") {
  jsnes.NES.prototype.stop=function(){this.running=false;this.crashMessage="crash";};
}
function makeRom(){
  const prg=1,chr=1,size=16+prg*16384+chr*4096;
  const b=new Uint8Array(size);
  b[0]=0x4E;b[1]=0x45;b[2]=0x53;b[3]=0x1A;b[4]=prg;b[5]=chr>>>1;
  const base=0xC000,off=base-0x8000;
  const code=[0xA9,0x08,0x8D,0x01,0x20,0xA9,0x08,0x8D,0x00,0x20]; // enable rendering
  for(let i=0;i<code.length;i++) b[16+off+i]=code[i];
  const loop=base+code.length;
  b[16+off+code.length]=0x4C;
  b[16+off+code.length+1]=loop&0xFF;
  b[16+off+code.length+2]=(loop>>8)&0xFF;
  b[16+0x7FFC]=base&0xFF; b[16+0x7FFD]=(base>>8)&0xFF;
  b[16+0x7FFE]=base&0xFF; b[16+0x7FFF]=(base>>8)&0xFF;
  let s="";
  for(let i=0;i<size;i+=0x8000) s+=String.fromCharCode.apply(null,b.subarray(i,Math.min(i+0x8000,size)));
  return s;
}
const rom=makeRom();
const doIrq = process.env.DO_IRQ === '1';
const nes=new jsnes.NES({onFrame:function(){},onAudioSample:null,onStatusUpdate:function(){},preferredFrameRate:60,emulateSound:false,sampleRate:44100});
nes.loadROM(rom);
for(let i=0;i<3;i++) nes.frame();
nes.reset();
if (doIrq) nes.cpu.requestIrq(nes.cpu.IRQ_RESET);
const t0=Date.now();
nes.frame();
const ms=Date.now()-t0;
console.log(JSON.stringify({doIrq, ms, pc: nes.cpu.REG_PC.toString(16)}));
process.exit(0);
`;

function run(label, env) {
  const r = spawnSync(process.execPath, ['-e', worker], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, env),
    timeout: 3000
  });
  if (r.error && r.error.code === 'ETIMEDOUT') {
    console.log(label + ': HUNG (timeout)');
  } else if (r.status !== 0) {
    console.log(label + ': exited status ' + r.status + ' stderr=' + (r.stderr || '').trim());
  } else {
    console.log(label + ': ' + (r.stdout || '').trim());
  }
}

run('WITHOUT requestIrq', { DO_IRQ: '0' });
run('WITH    requestIrq', { DO_IRQ: '1' });
