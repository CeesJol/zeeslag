// All sounds are made with the Web Audio API, so there are no sound files.

const STORE_KEY = 'zeeslag:sound';

let ctx = null;
let master = null;
let noiseBuffer = null;
const settings = loadSettings();

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY));
    if (saved && typeof saved.volume === 'number') return { volume: saved.volume, muted: Boolean(saved.muted) };
  } catch { /* no storage */ }
  return { volume: 0.6, muted: false };
}

function saveSettings() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch { /* no storage */ }
}

// The sounds peak near 1.0 at gain 1, so full volume gets headroom for overlaps.
const HEADROOM = 0.5;
const level = () => (settings.muted ? 0 : settings.volume * HEADROOM);

// Browsers start audio only after a user gesture, so this runs on the first
// click or key press and the sounds of the opponent's shots can play later.
export function unlock() {
  if (!ctx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    ctx = new Ctx();
    master = ctx.createGain();
    master.gain.value = level();
    // Explosions that overlap at full volume would clip without a limiter.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -10;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.15;
    master.connect(limiter).connect(ctx.destination);
    noiseBuffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

export const getVolume = () => settings.volume;
export const isMuted = () => settings.muted;

export function setVolume(volume) {
  settings.volume = Math.min(1, Math.max(0, volume));
  settings.muted = settings.volume === 0 ? settings.muted : false;
  apply();
}

export function setMuted(muted) {
  settings.muted = muted;
  apply();
}

function apply() {
  saveSettings();
  if (master) master.gain.setTargetAtTime(level(), ctx.currentTime, 0.02);
}

function ready() {
  if (!ctx || level() === 0) return false;
  if (ctx.state === 'suspended') ctx.resume();
  return true;
}

function envelope(gain, t, attack, peak, decay) {
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(peak, t + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
}

function noise(t, { type = 'lowpass', from, to, q = 1, attack = 0.01, peak = 0.6, decay = 0.5 }) {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  const filter = ctx.createBiquadFilter();
  filter.type = type;
  filter.Q.value = q;
  filter.frequency.setValueAtTime(from, t);
  filter.frequency.exponentialRampToValueAtTime(to, t + attack + decay);
  const gain = ctx.createGain();
  envelope(gain, t, attack, peak, decay);
  src.connect(filter).connect(gain).connect(master);
  src.start(t, Math.random());
  src.stop(t + attack + decay + 0.05);
}

function tone(t, { type = 'sine', from, to = from, attack = 0.005, peak = 0.4, decay = 0.3 }) {
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(from, t);
  if (to !== from) osc.frequency.exponentialRampToValueAtTime(to, t + attack + decay);
  const gain = ctx.createGain();
  envelope(gain, t, attack, peak, decay);
  osc.connect(gain).connect(master);
  osc.start(t);
  osc.stop(t + attack + decay + 0.05);
}

export function fire() {
  if (!ready()) return;
  const t = ctx.currentTime;
  tone(t, { from: 140, to: 45, peak: 0.7, decay: 0.18 });
  noise(t, { type: 'bandpass', from: 2500, to: 400, q: 0.8, attack: 0.02, peak: 0.35, decay: 0.35 });
}

export function miss() {
  if (!ready()) return;
  const t = ctx.currentTime;
  noise(t, { from: 3000, to: 250, attack: 0.01, peak: 0.5, decay: 0.7 });
  for (let i = 0; i < 3; i++) {
    tone(t + 0.12 + i * 0.09, { from: 700 - i * 120, to: 250, peak: 0.12, decay: 0.08 });
  }
}

export function hit() {
  if (!ready()) return;
  const t = ctx.currentTime;
  tone(t, { from: 110, to: 35, peak: 0.9, decay: 0.6 });
  noise(t, { from: 1800, to: 120, attack: 0.005, peak: 0.8, decay: 0.9 });
}

export function sunk() {
  if (!ready()) return;
  const t = ctx.currentTime;
  hit();
  tone(t + 0.25, { from: 80, to: 30, peak: 0.8, decay: 0.8 });
  noise(t + 0.25, { from: 1000, to: 80, attack: 0.01, peak: 0.6, decay: 1.2 });
  tone(t + 0.4, { type: 'sawtooth', from: 320, to: 60, attack: 0.05, peak: 0.08, decay: 1.4 });
  for (let i = 0; i < 5; i++) {
    tone(t + 0.9 + i * 0.12, { from: 500 - i * 60, to: 180, peak: 0.08, decay: 0.07 });
  }
}

function melody(notes, type, step, peak) {
  if (!ready()) return;
  const t = ctx.currentTime;
  notes.forEach((freq, i) => tone(t + i * step, { type, from: freq, attack: 0.01, peak, decay: step * 2.5 }));
}

export const win = () => melody([523, 659, 784, 1047], 'triangle', 0.13, 0.3);
export const lose = () => melody([392, 349, 311, 262], 'triangle', 0.2, 0.25);
export const love = () => melody([880, 1319], 'sine', 0.16, 0.18);
export const tick = () => melody([660], 'sine', 0.05, 0.2);
