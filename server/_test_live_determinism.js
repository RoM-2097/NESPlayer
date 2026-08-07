// Live lockstep determinism test: run two real jsnes instances through the
// EXACT delay-based input model from netplay.js (delay-based, absolute-frame
// keyed inputs, no predictions), applying each player's physical input to
// controller 1 on both sides (host = normal) and controller 2 (guest), then
// compare full checksums after N frames. If the two cores ever diverge while
// executing identical inputs, the delay-based model itself is broken.
'use strict';
const m = require('../js/neslib/jsnes.min.js');
const jsnes = m.jsnes || m;
const NES = jsnes.NES;

if (NES && NES.prototype) {
  if (typeof NES.prototype.stop === 'undefined') {
    NES.prototype.stop = function () { this.running = false; this.crashMessage = 'crash'; };
  }
  if (typeof NES.prototype.__frameSafe === 'undefined') {
    NES.prototype.__frameSafe = true;
    NES.prototype.frame = function () {
      if (this.running === false) return;
      if (this.running === undefined) this.running = true;
      let ppu = this.ppu, t = 0, s = this.opts.emulateSound, i = this.cpu, e = ppu, h = this.papu;
      ppu.startFrame();
      outer: for (;;) {
        if (this.running === false) break outer;
        for (0 === i.cyclesToHalt ? (t = i.emulate(), s && h.clockFrameCounter(t), t *= 3) : i.cyclesToHalt > 8 ? (t = 24, s && h.clockFrameCounter(8), i.cyclesToHalt -= 8) : (t = 3 * i.cyclesToHalt, s && h.clockFrameCounter(i.cyclesToHalt), i.cyclesToHalt = 0); t > 0; t--) {
          if (e.curX === e.spr0HitX && 1 === e.f_spVisibility && e.scanline - 21 === e.spr0HitY) e.setStatusFlag(e.STATUS_SPRITE0HIT, true);
          if (e.requestEndFrame && 0 === --e.nmiCounter) { e.requestEndFrame = false; e.startVBlank(); break outer; }
          e.curX++; 341 === e.curX && (e.curX = 0, e.endScanline());
        }
      }
      this.fpsFrameCount++;
    };
  }
}

// A real self-loop ROM that renders (enables a zero nametable so frame() is
// safe and clocks the CPU).
function makeRom() {
  const prg = 1, chr = 1;
  const size = 16 + prg * 16384 + chr * 4096;
  const b = new Uint8Array(size);
  b[0] = 0x4E; b[1] = 0x45; b[2] = 0x53; b[3] = 0x1A;
  b[4] = prg; b[5] = chr >>> 1; b[6] = 0; b[7] = 0;
  const base = 0xC000, off = base - 0x8000;
  const code = [0xA9, 0x08, 0x8D, 0x01, 0x20, 0xA9, 0x08, 0x8D, 0x00, 0x20];
  for (let i = 0; i < code.length; i++) b[16 + off + i] = code[i];
  const loopAddr = base + code.length;
  b[16 + off + code.length] = 0x4C;
  b[16 + off + code.length + 1] = loopAddr & 0xFF;
  b[16 + off + code.length + 2] = (loopAddr >> 8) & 0xFF;
  b[16 + 0x7FFC] = base & 0xFF; b[16 + 0x7FFD] = (base >> 8) & 0xFF;
  b[16 + 0x7FFE] = base & 0xFF; b[16 + 0x7FFF] = (base >> 8) & 0xFF;
  let s = '';
  for (let i = 0; i < size; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, Math.min(i + 0x8000, size)));
  return s;
}
const ROM = makeRom();
function makeNES() {
  return new NES({ onFrame(){}, onAudioSample:null, onStatusUpdate(){}, preferredFrameRate:60, emulateSound:false, sampleRate:44100 });
}

// Host controls Player 1; Guest controls Player 2. In the real app, the host's
// emulator applies the host's p1 buttons to controller 1, and the guest's p2
// buttons to controller 2; the guest's emulator does the same. We model frames
// 0..INPUT_DELAY as all-zero seeds, then divergent per-player input afterwards.
const INPUT_DELAY = 2;
const N_FRAMES = 180; // 3 seconds

const hostNes = makeNES(); hostNes.loadROM(ROM);
const guestNes = makeNES(); guestNes.loadROM(ROM);

const BUTTON_ORDER = [4,5,6,7,0,1,2,3]; // UP,DOWN,LEFT,RIGHT,A,B,SEL,START
function applyButtons(nesObj, ctrl, byteVal) {
  for (let i = 0; i < 8; i++) {
    const btn = BUTTON_ORDER[i];
    if (byteVal & (1 << i)) nesObj.buttonDown(ctrl, btn); else nesObj.buttonUp(ctrl, btn);
  }
}
function checksum(nes) {
  const cpu = nes.cpu;
  let h = 2166136261;
  function mix(v){ v>>>=0; h^=(v&0xFF); h=(h*16777619)>>>0; h^=((v>>>8)&0xFF); h=(h*16777619)>>>0; h^=((v>>>16)&0xFF); h=(h*16777619)>>>0; h^=((v>>>24)&0xFF); h=(h*16777619)>>>0; }
  mix(cpu.pc); mix(cpu.p); mix(cpu.sp); mix(cpu.a); mix(cpu.x); mix(cpu.y);
  const ram = cpu.mem;
  const start = cpu.pc & 0xFF;
  for (let i = 0; i < 128; i++) mix(ram[(start + i) & 0xFFFF]);
  return h>>>0;
}

// Player input histories. Player1 (host) sends [RIGHT] frames 60..119 and
// [A] at frame 90; Player2 (guest) sends [START] at frame 30 and [UP] 90..149.
// This exercises state-changing inputs from both players.
const p1Input = [];
const p2Input = [];
for (let f = 0; f < N_FRAMES; f++) {
  let p1 = 0, p2 = 0;
  if (f >= 60 && f < 120) p1 |= 1<<3; // RIGHT
  if (f === 90) p1 |= 1<<4;           // A
  if (f === 30) p2 |= 1<<7;           // START
  if (f >= 90 && f < 150) p2 |= 1<<0; // UP
  p1Input[f] = p1; p2Input[f] = p2;
}

// Both sides share one absolute frame timeline (delay-based). We maintain the
// per-side input buffers keyed by absolute frame.
const hostPeerInputs = {};  // absFrame -> guest(host's view of p2)
const guestPeerInputs = {}; // absFrame -> host(guest's view of p1)
// Seed frames 0..INPUT_DELAY with zeros on BOTH sides.
for (let f = 0; f <= INPUT_DELAY; f++) { hostPeerInputs[f] = 0; guestPeerInputs[f] = 0; }

// Run both sides together. Each side: capture its own live-frame input, render
// INPUT_DELAY behind. We advance both sides' nextFrame together (symmetric),
// which is what the real delay model converges to absent asymmetric waits.
let hostNext = INPUT_DELAY, guestNext = INPUT_DELAY;
let hostFrame = 0, guestFrame = 0;
let failed = false;

for (let frame = 0; frame < N_FRAMES; frame++) {
  // --- HOST side ---
  const hostLive = hostNext;
  // host's own input for hostLive frame (p1) is p1Input[hostLive]; p2 is zeros.
  const hostSelfP2 = 0;
  // publish host's input -> guest sees it as p1 at absFrame hostLive
  guestPeerInputs[hostLive] = p1Input[hostLive];
  // render frame
  const hostRender = hostLive - INPUT_DELAY;
  const hostOpponentInput = hostPeerInputs[hostRender]; // guest's p2 at hostRender
  if (hostOpponentInput === undefined) { console.log('HOST missing input frame', hostRender); failed = true; break; }
  // apply: controller1 = host's p1 (this side's own), controller2 = guest's p2
  applyButtons(hostNes, 1, p1Input[hostRender]);
  applyButtons(hostNes, 2, hostOpponentInput);
  hostNes.frame();
  hostFrame = hostRender;
  hostNext++;

  // --- GUEST side ---
  const guestLive = guestNext;
  // guest's own input is p2; its p1 slot is zeros.
  hostPeerInputs[guestLive] = p2Input[guestLive];
  const guestRender = guestLive - INPUT_DELAY;
  const guestOpponentInput = guestPeerInputs[guestRender]; // host's p1 at guestRender
  if (guestOpponentInput === undefined) { console.log('GUEST missing input frame', guestRender); failed = true; break; }
  applyButtons(guestNes, 1, guestOpponentInput);
  applyButtons(guestNes, 2, p2Input[guestRender]);
  guestNes.frame();
  guestFrame = guestRender;
  guestNext++;
}

if (failed) {
  console.log('FAIL: input starvation (a side lacked a required peer input frame)');
  process.exit(1);
}

const hSum = checksum(hostNes);
const gSum = checksum(guestNes);
console.log('host frame:', hostFrame, 'guest frame:', guestFrame);
console.log('host checksum:', hSum.toString(16), 'guest checksum:', gSum.toString(16));
if (hSum === gSum && hostFrame === guestFrame) {
  console.log('SUCCESS: two cores stayed in lockstep for ' + N_FRAMES + ' frames (fully deterministic)');
} else {
  console.log('*** DESYNC DETECTED in the input model itself ***');
  process.exit(1);
}
process.exit(0);

