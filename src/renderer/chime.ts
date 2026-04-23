// Short, percussive notification sounds — a small library the user can try and
// pick from. Everything is synthesized via Web Audio so we ship no assets.

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noiseBuffer: AudioBuffer | null = null;

interface Env {
  ctx: AudioContext;
  master: GainNode;
  noise: AudioBuffer;
  now: number;
}

function getCtx(): AudioContext | null {
  if (ctx) return ctx;
  const Ctor: typeof AudioContext | undefined =
    typeof window !== 'undefined'
      ? window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      : undefined;
  if (!Ctor) return null;
  ctx = new Ctor();
  master = ctx.createGain();
  master.gain.value = 0.9;
  master.connect(ctx.destination);

  const rate = ctx.sampleRate;
  noiseBuffer = ctx.createBuffer(1, rate, rate);
  const ch = noiseBuffer.getChannelData(0);
  for (let i = 0; i < ch.length; i++) ch[i] = Math.random() * 2 - 1;
  return ctx;
}

function env(): Env | null {
  const c = getCtx();
  if (!c || !master || !noiseBuffer) return null;
  if (c.state === 'suspended') c.resume().catch(() => {});
  return { ctx: c, master, noise: noiseBuffer, now: c.currentTime };
}

// ---- Sound definitions ----

function knock({ ctx, master, noise, now }: Env) {
  // Low kick-thud + brushy tick — Slack-ish knock.
  const body = ctx.createOscillator();
  const bodyGain = ctx.createGain();
  body.type = 'sine';
  body.frequency.setValueAtTime(180, now);
  body.frequency.exponentialRampToValueAtTime(70, now + 0.09);
  bodyGain.gain.setValueAtTime(0.0001, now);
  bodyGain.gain.exponentialRampToValueAtTime(0.45, now + 0.004);
  bodyGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.11);
  body.connect(bodyGain).connect(master);
  body.start(now);
  body.stop(now + 0.13);

  const tick = ctx.createBufferSource();
  tick.buffer = noise;
  const tickFilter = ctx.createBiquadFilter();
  tickFilter.type = 'bandpass';
  tickFilter.frequency.value = 1800;
  tickFilter.Q.value = 0.9;
  const tickGain = ctx.createGain();
  tickGain.gain.setValueAtTime(0.0001, now);
  tickGain.gain.exponentialRampToValueAtTime(0.18, now + 0.002);
  tickGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.055);
  tick.connect(tickFilter).connect(tickGain).connect(master);
  tick.start(now);
  tick.stop(now + 0.08);
}

function pop({ ctx, master, now }: Env) {
  // Snappy UI "pop" — pitched blip with fast decay.
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(680, now);
  osc.frequency.exponentialRampToValueAtTime(220, now + 0.07);
  g.gain.setValueAtTime(0.0001, now);
  g.gain.exponentialRampToValueAtTime(0.35, now + 0.003);
  g.gain.exponentialRampToValueAtTime(0.0001, now + 0.09);
  osc.connect(g).connect(master);
  osc.start(now);
  osc.stop(now + 0.1);
}

function tap({ ctx, master, noise, now }: Env) {
  // Dry wood-tap — very short filtered noise burst, no body.
  const src = ctx.createBufferSource();
  src.buffer = noise;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 2600;
  bp.Q.value = 4;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, now);
  g.gain.exponentialRampToValueAtTime(0.3, now + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, now + 0.04);
  src.connect(bp).connect(g).connect(master);
  src.start(now);
  src.stop(now + 0.05);
}

function thud({ ctx, master, now }: Env) {
  // Deep soft thud — no high transient.
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(120, now);
  osc.frequency.exponentialRampToValueAtTime(55, now + 0.15);
  g.gain.setValueAtTime(0.0001, now);
  g.gain.exponentialRampToValueAtTime(0.5, now + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
  osc.connect(g).connect(master);
  osc.start(now);
  osc.stop(now + 0.2);
}

function click({ ctx, master, noise, now }: Env) {
  // Mechanical "tok" — two quick taps, very short.
  for (const delay of [0, 0.055]) {
    const t = now + delay;
    const src = ctx.createBufferSource();
    src.buffer = noise;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 3500;
    bp.Q.value = 2.5;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.22, t + 0.001);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.025);
    src.connect(bp).connect(g).connect(master);
    src.start(t);
    src.stop(t + 0.04);
  }
}

function ping({ ctx, master, now }: Env) {
  // Single crisp triangle ping with a short decay — a touch of tone.
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = 'triangle';
  osc.frequency.value = 880;
  g.gain.setValueAtTime(0.0001, now);
  g.gain.exponentialRampToValueAtTime(0.18, now + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, now + 0.14);
  osc.connect(g).connect(master);
  osc.start(now);
  osc.stop(now + 0.16);
}

function drop({ ctx, master, now }: Env) {
  // Water drop — sine sweeping rapidly upward then decaying.
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(380, now);
  osc.frequency.exponentialRampToValueAtTime(1800, now + 0.09);
  g.gain.setValueAtTime(0.0001, now);
  g.gain.exponentialRampToValueAtTime(0.22, now + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, now + 0.14);
  osc.connect(g).connect(master);
  osc.start(now);
  osc.stop(now + 0.16);
}

function bloop({ ctx, master, now }: Env) {
  // Two quick ascending sine blips — friendly and upbeat.
  for (let i = 0; i < 2; i++) {
    const t = now + i * 0.08;
    const freq = i === 0 ? 520 : 780;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.24, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    osc.connect(g).connect(master);
    osc.start(t);
    osc.stop(t + 0.11);
  }
}

function coin({ ctx, master, now }: Env) {
  // Retro game coin pickup — square wave, quick up-arpeggio.
  const notes = [784, 1175]; // G5, D6
  for (let i = 0; i < notes.length; i++) {
    const t = now + i * 0.09;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = notes[i];
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.08, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    osc.connect(g).connect(master);
    osc.start(t);
    osc.stop(t + 0.13);
  }
}

function chirp({ ctx, master, now }: Env) {
  // Short upward pitch sweep — birdy, attention-getting.
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(1100, now);
  osc.frequency.exponentialRampToValueAtTime(2400, now + 0.07);
  g.gain.setValueAtTime(0.0001, now);
  g.gain.exponentialRampToValueAtTime(0.14, now + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, now + 0.09);
  osc.connect(g).connect(master);
  osc.start(now);
  osc.stop(now + 0.1);
}

function swoosh({ ctx, master, noise, now }: Env) {
  // Brush-like sweep — filtered noise whose center frequency rises.
  const src = ctx.createBufferSource();
  src.buffer = noise;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.Q.value = 3;
  bp.frequency.setValueAtTime(800, now);
  bp.frequency.exponentialRampToValueAtTime(3200, now + 0.18);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, now);
  g.gain.exponentialRampToValueAtTime(0.22, now + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);
  src.connect(bp).connect(g).connect(master);
  src.start(now);
  src.stop(now + 0.24);
}

function marimba({ ctx, master, now }: Env) {
  // Woody marimba: fundamental + a quiet octave, fast pluck.
  const base = 523.25; // C5
  for (const [freq, vol] of [
    [base, 0.22],
    [base * 2, 0.06],
  ]) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(vol, now + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.28);
    osc.connect(g).connect(master);
    osc.start(now);
    osc.stop(now + 0.3);
  }
}

function zap({ ctx, master, now }: Env) {
  // Synthy downward pitch drop — sharp, sci-fi.
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(1400, now);
  osc.frequency.exponentialRampToValueAtTime(220, now + 0.12);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 3500;
  g.gain.setValueAtTime(0.0001, now);
  g.gain.exponentialRampToValueAtTime(0.1, now + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, now + 0.14);
  osc.connect(lp).connect(g).connect(master);
  osc.start(now);
  osc.stop(now + 0.16);
}

function pluck({ ctx, master, now }: Env) {
  // Short string pluck — sawtooth through lowpass with fast decay.
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = 'sawtooth';
  osc.frequency.value = 440; // A4
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(2800, now);
  lp.frequency.exponentialRampToValueAtTime(500, now + 0.25);
  lp.Q.value = 2;
  g.gain.setValueAtTime(0.0001, now);
  g.gain.exponentialRampToValueAtTime(0.12, now + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, now + 0.3);
  osc.connect(lp).connect(g).connect(master);
  osc.start(now);
  osc.stop(now + 0.32);
}

function bubble({ ctx, master, now }: Env) {
  // Short pitched bubble — sine with quick rise then fall.
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(500, now);
  osc.frequency.exponentialRampToValueAtTime(900, now + 0.05);
  osc.frequency.exponentialRampToValueAtTime(600, now + 0.12);
  g.gain.setValueAtTime(0.0001, now);
  g.gain.exponentialRampToValueAtTime(0.2, now + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, now + 0.14);
  osc.connect(g).connect(master);
  osc.start(now);
  osc.stop(now + 0.16);
}

function tada({ ctx, master, now }: Env) {
  // Triad chord — C5 + E5 + G5 together, gentle bell-free envelope.
  const freqs = [523.25, 659.25, 784];
  for (const f of freqs) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = f;
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.08, now + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.35);
    osc.connect(g).connect(master);
    osc.start(now);
    osc.stop(now + 0.37);
  }
}

export interface SoundDef {
  id: string;
  name: string;
  description: string;
  play: (e: Env) => void;
}

function doubleKnock({ ctx, master, noise, now }: Env) {
  // Two soft Slack-style knocks in quick succession.
  for (const t of [now, now + 0.14]) {
    const body = ctx.createOscillator();
    const bodyGain = ctx.createGain();
    body.type = 'sine';
    body.frequency.setValueAtTime(180, t);
    body.frequency.exponentialRampToValueAtTime(70, t + 0.09);
    bodyGain.gain.setValueAtTime(0.0001, t);
    bodyGain.gain.exponentialRampToValueAtTime(0.4, t + 0.004);
    bodyGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
    body.connect(bodyGain).connect(master);
    body.start(t);
    body.stop(t + 0.12);

    const tick = ctx.createBufferSource();
    tick.buffer = noise;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1800;
    bp.Q.value = 0.9;
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(0.0001, t);
    tg.gain.exponentialRampToValueAtTime(0.15, t + 0.002);
    tg.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    tick.connect(bp).connect(tg).connect(master);
    tick.start(t);
    tick.stop(t + 0.07);
  }
}

function doubleTap({ ctx, master, noise, now }: Env) {
  // Two dry wooden taps, tight spacing.
  for (const t of [now, now + 0.09]) {
    const src = ctx.createBufferSource();
    src.buffer = noise;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2600;
    bp.Q.value = 4;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.28, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);
    src.connect(bp).connect(g).connect(master);
    src.start(t);
    src.stop(t + 0.05);
  }
}

function doubleThud({ ctx, master, now }: Env) {
  // Two deep thuds — muted, grounded.
  for (const t of [now, now + 0.16]) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(140, t);
    osc.frequency.exponentialRampToValueAtTime(60, t + 0.13);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.42, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
    osc.connect(g).connect(master);
    osc.start(t);
    osc.stop(t + 0.17);
  }
}

function doublePop({ ctx, master, now }: Env) {
  // Two pitched blips going up — friendly.
  const pitches = [520, 760];
  for (let i = 0; i < pitches.length; i++) {
    const t = now + i * 0.1;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(pitches[i] * 1.25, t);
    osc.frequency.exponentialRampToValueAtTime(pitches[i], t + 0.05);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.3, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    osc.connect(g).connect(master);
    osc.start(t);
    osc.stop(t + 0.11);
  }
}

function doublePing({ ctx, master, now }: Env) {
  // Two crisp triangle pings — major third up (E5 → G5).
  const pitches = [659.25, 784];
  for (let i = 0; i < pitches.length; i++) {
    const t = now + i * 0.12;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = pitches[i];
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.16, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
    osc.connect(g).connect(master);
    osc.start(t);
    osc.stop(t + 0.16);
  }
}

function doubleDrop({ ctx, master, now }: Env) {
  // Two water-drop chirps — fast upward sweeps.
  for (const t of [now, now + 0.12]) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(380, t);
    osc.frequency.exponentialRampToValueAtTime(1700, t + 0.07);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.2, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
    osc.connect(g).connect(master);
    osc.start(t);
    osc.stop(t + 0.12);
  }
}

export const SOUNDS: SoundDef[] = [
  // Two-note percussion variants (user-preferred style first).
  { id: 'double-knock', name: 'Double knock', description: 'Two soft Slack-style knocks', play: doubleKnock },
  { id: 'double-tap', name: 'Double tap', description: 'Two crisp wooden taps', play: doubleTap },
  { id: 'double-thud', name: 'Double thud', description: 'Two deep muted thumps', play: doubleThud },
  { id: 'double-pop', name: 'Double pop', description: 'Two rising blips', play: doublePop },
  { id: 'double-ping', name: 'Double ping', description: 'Two-note ping, major third up', play: doublePing },
  { id: 'double-drop', name: 'Double drop', description: 'Two water-drop chirps', play: doubleDrop },
  { id: 'click', name: 'Click', description: 'Two quick mechanical taps', play: click },
  { id: 'bloop', name: 'Bloop', description: 'Two ascending sine blips', play: bloop },
  { id: 'coin', name: 'Coin', description: 'Retro pickup, two-note up', play: coin },

  // Single-hit variants.
  { id: 'knock', name: 'Knock', description: 'Slack-style soft knock', play: knock },
  { id: 'pop', name: 'Pop', description: 'Short pitched blip', play: pop },
  { id: 'tap', name: 'Tap', description: 'Dry wooden tap', play: tap },
  { id: 'thud', name: 'Thud', description: 'Deep muted thump', play: thud },
  { id: 'ping', name: 'Ping', description: 'Short crisp tone', play: ping },
  { id: 'drop', name: 'Drop', description: 'Water-drop chirp', play: drop },
  { id: 'chirp', name: 'Chirp', description: 'Quick upward sweep', play: chirp },
  { id: 'swoosh', name: 'Swoosh', description: 'Brushy filtered sweep', play: swoosh },
  { id: 'marimba', name: 'Marimba', description: 'Woody plucked note', play: marimba },
  { id: 'pluck', name: 'Pluck', description: 'Soft string pluck', play: pluck },
  { id: 'bubble', name: 'Bubble', description: 'Pitched sine bubble', play: bubble },
  { id: 'zap', name: 'Zap', description: 'Synthy descending drop', play: zap },
  { id: 'tada', name: 'Tada', description: 'Triad chord', play: tada },

  { id: 'none', name: 'Silent', description: 'No sound', play: () => {} },
];

const STORAGE_KEY = 'orchestra.notificationSound';
const DEFAULT_ID = 'knock';

export function getSelectedSoundId(): string {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v && SOUNDS.some((s) => s.id === v)) return v;
  } catch {
    /* ignore */
  }
  return DEFAULT_ID;
}

export function setSelectedSoundId(id: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* ignore */
  }
}

export function playSoundById(id: string): void {
  const e = env();
  if (!e) return;
  const s = SOUNDS.find((x) => x.id === id);
  if (!s) return;
  s.play(e);
}

export function playFinishedChime(): void {
  playSoundById(getSelectedSoundId());
}
