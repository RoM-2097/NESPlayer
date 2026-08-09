// Test reset strategies on a MAPPER-based ROM (MMC1 / mapper 1). A real game
// uses a mapper with bank switching; nes.reset() calls mmap.reset() but does
// NOT re-run mmap.loadROM() (the bank setup). reloadROM() re-runs the full
// loadROM() path. Compare reset+IRQ vs reloadROM.
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
function makeMmc1Rom(){
  // Mapper 1 (MMC1): 2 PRG banks, 1 CHR bank. Header: flag6=0, flag7=1 (mapper 1).
  const prg=2, chr=1;
  const size=16+prg*16384+chr*4096;
  const b=new Uint8Array(size);
  b[0]=0x4E;b[1]=0x45;b[2]=0x53;b[3]=0x1A;
  b[4]=prg;b[5]=chr>>>1;b[6]=0;b[7]=1; // mapper 1
  // Reset vector at $FFFC -> $C000 (last PRG bank, fixed for MMC1).
  const base=0xC000, off=base-0x8000;
  // Which PRG bank does $C000 map to? For MMC1 the last bank is at $C000.
  // Write our code into the last bank: offset within last bank.
  const bankOffset = (prg-1)*0x4000; // bytes into PRG data
  const code=[
    0xAD,0x10,0x00,0x18,0x69,0x01,0x8D,0x10,0x00,0x8D,0x01,0x20,0x4C,0x00,0xC0
  ];
  // $C000 - $8000 = bank slot 1 (second 16KB of the 32KB window). For MMC1
  // with 2 banks, the last bank (bank 1) is mapped to $C000 by loadROM default.
  for(let i=0;i<code.length;i++) b[16+bankOffset+off+i]=code[i];
  // Reset vector in the last bank at $FFFC.
  b[16+ ((prg*0x4000)-0x4000) + 0x3FFC ] = base & 0xFF;
  b[16+ ((prg*0x4000)-0x4000) + 0x3FFD ] = (base >> 8) & 0xFF;
  let s="";
  for(let i=0;i<size;i+=0x8000) s+=String.fromCharCode.apply(null,b.subarray(i,Math.min(i+0x8000,size)));
  return s;
}
const how=process.env.HOW;
let lastFrame=null;
const nes=new jsnes.NES({onFrame:function(buf){lastFrame=buf.slice(0,256);},onAudioSample:null,onStatusUpdate:function(){},preferredFrameRate:60,emulateSound:false,sampleRate:44100});
nes.loadROM(makeMmc1Rom());
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

run('MMC1 reset only', { HOW: 'reset-only' });
run('MMC1 reset + IRQ', { HOW: 'reset+irq' });
run('MMC1 reloadROM', { HOW: 'reloadROM' });
