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
  const prg=2, chr=1;
  const size=16+prg*16384+chr*4096;
  const b=new Uint8Array(size);
  b[0]=0x4E;b[1]=0x45;b[2]=0x53;b[3]=0x1A;
  b[4]=prg;b[5]=chr>>>1;
  b[6]=0x10;b[7]=0; // mapper 1 (MMC1)
  const base=0xC000;
  const code=[0xA9,0x08,0x8D,0x01,0x20,0xAD,0x10,0x00,0x18,0x69,0x01,0x8D,0x10,0x00,0x4C,0x00,0xC0];
  const lastBankStart=(prg-1)*0x4000;
  const slotOffset=0x4000;
  for(let i=0;i<code.length;i++) b[16+lastBankStart+slotOffset+i]=code[i];
  b[16+lastBankStart+0x3FFC]=base&0xFF;
  b[16+lastBankStart+0x3FFD]=(base>>8)&0xFF;
  let s="";
  for(let i=0;i<size;i+=0x8000) s+=String.fromCharCode.apply(null,b.subarray(i,Math.min(i+0x8000,size)));
  return s;
}
const how=process.env.HOW;
let frames=0;
const nes=new jsnes.NES({onFrame:function(){frames++;},onAudioSample:null,onStatusUpdate:function(){},preferredFrameRate:60,emulateSound:false,sampleRate:44100});
nes.loadROM(makeMmc1Rom());
console.log('mapper:'+nes.rom.getMapperName()+';bootPc:'+nes.cpu.REG_PC.toString(16));
for(let i=0;i<10;i++) nes.frame();
const bootN=nes.cpu.mem[0x10];
const t0=Date.now();
let ok=false,err=null;
try{
  if(how==="reset") nes.reset();
  else if(how==="reset+irq"){nes.reset();nes.cpu.requestIrq(nes.cpu.IRQ_RESET);}
  else if(how==="reload") nes.reloadROM();
  for(let i=0;i<5;i++) nes.frame();
  ok=true;
}catch(e){err=e.message;}
const ms=Date.now()-t0;
console.log(JSON.stringify({how,ok,err,ms,afterPc:nes.cpu.REG_PC.toString(16),bootN,afterN:nes.cpu.mem[0x10],frames}));
process.exit(0);
`;

function run(label, env) {
  const r = spawnSync(process.execPath, ['-e', worker], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, env),
    timeout: 4000
  });
  if (r.error && r.error.code === 'ETIMEDOUT') {
    console.log(label + ': HUNG (timeout)');
  } else if (r.status !== 0) {
    console.log(label + ': exit ' + r.status + ' stderr=' + (r.stderr || '').trim());
  } else {
    console.log(label + ': ' + (r.stdout || '').trim());
  }
}

run('MMC1 reset      ', { HOW: 'reset' });
run('MMC1 reset+IRQ  ', { HOW: 'reset+irq' });
run('MMC1 reloadROM  ', { HOW: 'reload' });
console.log('done');
