// Deeply compare reset strategies against a real ROM boot, each case in its
// own CHILD process so a hang (reset without IRQ) can't block the others.
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
  const prg=1,chr=1;
  const size=16+prg*16384+chr*4096;
  const b=new Uint8Array(size);
  b[0]=0x4E;b[1]=0x45;b[2]=0x53;b[3]=0x1A;
  b[4]=prg;b[5]=chr>>>1;b[6]=0;b[7]=0;
  const base=0xC000,off=base-0x8000;
  const code=[
    0xAD,0x10,0x00,0x18,0x69,0x01,0x8D,0x10,0x00,0x8D,0x01,0x20,0x4C,0x00,0xC0
  ];
  for(let i=0;i<code.length;i++) b[16+off+i]=code[i];
  b[16+0x7FFC]=base&0xFF;b[16+0x7FFD]=(base>>8)&0xFF;
  b[16+0x7FFE]=base&0xFF;b[16+0x7FFF]=(base>>8)&0xFF;
  let s="";
  for(let i=0;i<size;i+=0x8000) s+=String.fromCharCode.apply(null,b.subarray(i,Math.min(i+0x8000,size)));
  return s;
}
const how=process.env.HOW;
let lastFrame=null;
const nes=new jsnes.NES({onFrame:function(buf){lastFrame=buf.slice(0,256);},onAudioSample:null,onStatusUpdate:function(){},preferredFrameRate:60,emulateSound:false,sampleRate:44100});
nes.loadROM(makeRom());
for(let i=0;i<10;i++) nes.frame();
const bootPc=nes.cpu.REG_PC, bootN=nes.cpu.mem[0x10];
const t0=Date.now();
let ok=false,err=null;
try{
  if(how==="reset+irq"){nes.reset();nes.cpu.requestIrq(nes.cpu.IRQ_RESET);}
  else if(how==="reloadROM"){nes.reloadROM();}
  else if(how==="reset-only"){nes.reset();}
  for(let i=0;i<5;i++) nes.frame();
  ok=true;
}catch(e){err=e.message;}
const ms=Date.now()-t0;
const pc=nes.cpu.REG_PC, n=nes.cpu.mem[0x10];
const top=lastFrame?lastFrame.slice(0,256):null;
const nonzero=top?top.filter(v=>v!==0).length:-1;
console.log(JSON.stringify({how,ok,err,ms,bootPc:bootPc.toString(16),afterPc:pc.toString(16),bootN,afterN:n,nonzero}));
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

run('reset only', { HOW: 'reset-only' });
run('reset + IRQ', { HOW: 'reset+irq' });
run('reloadROM', { HOW: 'reloadROM' });
