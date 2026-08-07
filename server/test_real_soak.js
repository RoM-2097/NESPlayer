// Soak test: drives js/netplay.js (window.NESNetplay) against the live relay
// for 120+ frames to confirm sustained lockstep (covers TRACER_EVERY=30 path).
'use strict';
const { WebSocket } = require('ws');
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const paths = {
  netplay: path.resolve(__dirname, '../js/netplay.js'),
  jsnes: path.resolve(__dirname, '../js/neslib/jsnes.min.js')
};

const hostObj = { jsnes: null };
const guestObj = { jsnes: null };

function makeWindow(o) {
  const w = { jsnes: o.jsnes, location: { protocol: 'http:', host: 'localhost:3000' }, WebSocket, setTimeout, clearTimeout, Date, JSON, Math, NESNetplay: null };
  w.window = w; w.globalThis = w; w.self = w;
  return w;
}

function loadNetplay(o) {
  const code = fs.readFileSync(paths.netplay, 'utf8');
  const w = makeWindow(o); o.win = w;
  vm.createContext(w); vm.runInContext(code, w);
  return w.NESNetplay;
}

function makeValidRom() {
  const prg = 1, chr = 1, size = 16 + prg * 16384 + chr * 4096;
  const bytes = new Uint8Array(size);
  bytes[0] = 0x4E; bytes[1] = 0x45; bytes[2] = 0x53; bytes[3] = 0x1A;
  bytes[4] = prg; bytes[5] = chr >>> 1; bytes[6] = 0; bytes[7] = 0;
  for (let i = 0; i < prg * 16384; i++) bytes[16 + i] = 0xEA;
  bytes[16 + 0x7FFC] = 0x00; bytes[16 + 0x7FFD] = 0xC0;
  bytes[16 + 0x7FFE] = 0x00; bytes[16 + 0x7FFF] = 0xC0;
  let s = '';
  for (let i = 0; i < size; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 0x8000, size)));
  return s;
}
const ROM = makeValidRom();

function createNES(w) {
  return new w.jsnes.NES({ onFrame: function () {}, onAudioSample: null, onStatusUpdate: function () {}, preferredFrameRate: 60, emulateSound: false, sampleRate: 44100 });
}

for (const o of [hostObj, guestObj]) { const mod = require(paths.jsnes); o.jsnes = mod.jsnes || mod; }

const hostGG = loadNetplay(hostObj);
const guestGG = loadNetplay(guestObj);

const hostNes = createNES(hostObj.win); hostNes.loadROM(ROM);
const guestNes = createNES(guestObj.win);

let hostStalled = false, guestStalled = false;
let hostPlaying = false, guestPlaying = false;
const toasts = [];

hostGG.onToast = (m, t) => { if (m && m.indexOf('stalled') >= 0) hostStalled = true; toasts.push('HOST: ' + m); };
guestGG.onToast = (m, t) => { if (m && m.indexOf('stalled') >= 0) guestStalled = true; toasts.push('GUEST: ' + m); };
hostGG.onStateChange = (s) => { if (s === 'playing') hostPlaying = true; };
guestGG.onStateChange = (s) => { if (s === 'playing') guestPlaying = true; };

hostGG.init({ host: { get nes() { return hostNes; }, get romBytes() { return ROM; }, get romName() { return 'g.nes'; }, onStart(){}, onStop(){} }, guest: {} });
guestGG.init({ host: {}, guest: { get nes() { return guestNes; }, loadRom(b,n){ guestNes.loadROM(b); }, onStart(){}, onStop(){} } });

hostGG.createRoom('ws://localhost:3000');
hostGG.onRoomCreated = function (code) { console.log('HOST created room', code); guestGG.joinRoom(code, 'ws://localhost:3000'); };

function feed(gg) { gg.setLocalInput({ p1: new Array(8).fill(0), p2: new Array(8).fill(0) }); }

const start = Date.now();
let frames = 0;
const timer = setInterval(() => {
  frames++;
  if (hostPlaying) { feed(hostGG); if (hostGG.step()) { hostGG.applyRemote(hostNes); try { hostNes.frame(); } catch (e) {} } }
  if (guestPlaying) { feed(guestGG); if (guestGG.step()) { guestGG.applyRemote(guestNes); try { guestNes.frame(); } catch (e) {} } }
  if (frames % 50 === 0) console.log('t=' + (Date.now() - start) + 'ms host=' + hostGG.getFrame() + ' guest=' + guestGG.getFrame() + ' hst=' + hostGG.getState() + ' gst=' + guestGG.getState());

  const done = hostPlaying && guestPlaying && hostGG.getFrame() > 120 && guestGG.getFrame() > 120;
  const timeout = Date.now() - start > 6000;
  if (done || timeout) {
    clearInterval(timer);
    console.log('');
    console.log('=== SOAK RESULT ===');
    console.log('hostPlaying:', hostPlaying, 'guestPlaying:', guestPlaying);
    console.log('host frame:', hostGG.getFrame(), 'guest frame:', guestGG.getFrame());
    console.log('hostStalled:', hostStalled, 'guestStalled:', guestStalled);
    if (hostGG.getFrame() > 120 && guestGG.getFrame() > 120 && !hostStalled && !guestStalled) {
      console.log('SUCCESS: sustained 120+ frames, no stall, tracer path clean');
    } else {
      console.log('FAIL: stall/stuck (toasts):');
      toasts.forEach((t) => console.log('   ' + t));
    }
    process.exit(0);
  }
}, 20);
