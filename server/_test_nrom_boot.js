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
// NROM (mapper 0): 1 PRG bank (16KB) at $8000, mirrored to $C000-$FFFF.
function makeNromRom(){
  const prg=1, chr=1;
  const base=0x4000; // PRG offset for $C000 (0x4000 into the 16KB bank)
  const size=16+prg*16384+chr*4096;
  const b=new Uint8Array(size);
  b[0]=0x4E;b[1]=0x45;b[2]=0x53;b[3]=0x1A;
  b[4]=prg;b[5]=chr>>>1;b[6]=0;b[7]=0; // mapper 0
  // Code at $C000: enable rendering, increment RAM $10, loop.
  const code=[0xAD,0x10,0x00,0x18,0x69,0x01,0x8D,0x10,0x00,0xA9,0x08,0x8D,0x01,0x20,0x4C,0x00,0xC0];
  const off = 0x4000; // $C000 - $8000
  for(let i=0;i<code.length;i++) b[16+off+i]=code[i];
  // Reset vector at $FFFC -> offset 0x7FFC.
  b[16+0x7FFC]=0x00; b[16+0x7FFD]=0xC0;
  let s="";
  for(let i=0;i<size;i+=0x8000) s+=String.fromCharCode.apply(null,b.subarray(i,Math.min(i+0x8000,size)));
  return s;
}
const how=process.env.HOW;
let frames=0;
const nes=new jsnes.NES({onFrame:function(){frames++;},onAudioSample:null,onStatusUpdate:function(){},preferredFrameRate:60,emulateSound:false,sampleRate:44100});
nes.loadROM(makeNromRom());
console.log('mapper:'+nes.rom.getMapperName()+';bootPc:'+nes.cpu.REG_PC.toString(16));
for(let i=0;i<5;i++) nes.frame();
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
  const r = spawnSync(process.execPath, ['-e', worker], { encoding: 'utf8', env: Object.assign({}, process.env, env), timeout: 4000 });
  if (r.error && r.error.code === 'ETIMEDOUT') console.log(label + ': HUNG (timeout)');
  else if (r.status !== 0) console.log(label + ': exit ' + r.status + ' stderr=' + (r.stderr || '').trim());
  else console.log(label + ': ' + (r.stdout || '').trim());
}
run('NROM reset     ', { HOW: 'reset' });
run('NROM reset+IRQ ', { HOW: 'reset+irq' });
run('NROM reloadROM ', { HOW: 'reload' });
console.log('done');
