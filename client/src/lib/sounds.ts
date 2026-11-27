import type { BuiltinSoundboardId, SoundboardId } from '../types/protocol';

export interface BuiltinSoundItem {
  id: BuiltinSoundboardId;
  label: string;
  emoji: string;
  category: 'meme' | 'tepki' | 'efekt';
}

export const SOUNDBOARD_ITEMS: BuiltinSoundItem[] = [
  { id: 'vineboom', label: 'Vine Boom', emoji: '💥', category: 'meme' },
  { id: 'airhorn', label: 'Havalı Korna', emoji: '📯', category: 'meme' },
  { id: 'bonk', label: 'Bonk!', emoji: '🔨', category: 'meme' },
  { id: 'dramatic', label: 'Dun Dun Duuun', emoji: '😱', category: 'meme' },
  { id: 'applause', label: 'Alkış', emoji: '👏', category: 'tepki' },
  { id: 'drumroll', label: 'Ba Dum Tss', emoji: '🥁', category: 'tepki' },
  { id: 'fail', label: 'Womp Womp', emoji: '🎺', category: 'tepki' },
  { id: 'cricket', label: 'Cırcır Böceği', emoji: '🦗', category: 'tepki' },
  { id: 'gg', label: 'Zafer Fanfarı', emoji: '🏆', category: 'efekt' },
  { id: 'quack', label: 'Vak Vak', emoji: '🦆', category: 'efekt' },
  { id: 'alarm', label: 'Kırmızı Alarm', emoji: '🚨', category: 'efekt' },
  { id: 'levelup', label: 'Level Up', emoji: '✨', category: 'efekt' },
];

export const MAX_CUSTOM_SOUND_BYTES = 185 * 1024; // ~247 KB base64 (< 260 KB DB rule)

let sharedCtx: AudioContext | null = null;
let cachedNoiseBuffer: AudioBuffer | null = null;
let cachedReverbBuffer: AudioBuffer | null = null;
let cachedWarmDriveCurve: Float32Array<ArrayBuffer> | null = null;
const activeHtmlAudios = new Set<HTMLAudioElement>();
let activeSoundboardMaster: GainNode | null = null;

function getCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtx) return null;
  if (!sharedCtx || sharedCtx.state === 'closed') {
    sharedCtx = new AudioCtx();
    cachedNoiseBuffer = null;
    cachedReverbBuffer = null;
  }
  if (sharedCtx.state === 'suspended') {
    sharedCtx.resume().catch(() => {});
  }
  return sharedCtx;
}

function getNoiseBuffer(ctx: AudioContext): AudioBuffer {
  if (cachedNoiseBuffer && cachedNoiseBuffer.sampleRate === ctx.sampleRate) {
    return cachedNoiseBuffer;
  }
  const len = Math.floor(ctx.sampleRate * 2.5);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch += 1) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < len; i += 1) {
      data[i] = Math.random() * 2 - 1;
    }
  }
  cachedNoiseBuffer = buf;
  return buf;
}

function getReverbBuffer(ctx: AudioContext): AudioBuffer {
  if (cachedReverbBuffer && cachedReverbBuffer.sampleRate === ctx.sampleRate) {
    return cachedReverbBuffer;
  }
  const duration = 1.1;
  const len = Math.floor(ctx.sampleRate * duration);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch += 1) {
    const data = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i += 1) {
      const decay = Math.pow(1 - i / len, 2.8);
      const white = Math.random() * 2 - 1;
      lp = lp * 0.65 + white * 0.35;
      data[i] = lp * decay * 0.65;
    }
  }
  cachedReverbBuffer = buf;
  return buf;
}

function getDriveCurve(amount = 22): Float32Array<ArrayBuffer> {
  if (cachedWarmDriveCurve && amount === 22) return cachedWarmDriveCurve;
  const samples = 1024;
  const curve = new Float32Array(new ArrayBuffer(samples * 4));
  const k = amount;
  for (let i = 0; i < samples; i += 1) {
    const x = (i * 2) / samples - 1;
    curve[i] = ((3 + k) * x * 20 * (Math.PI / 180)) / (Math.PI + k * Math.abs(x));
  }
  if (amount === 22) cachedWarmDriveCurve = curve;
  return curve;
}

function createMasterBus(ctx: AudioContext, volume: number): { dry: GainNode; wet: GainNode } {
  const clamped = Math.max(0, Math.min(1, volume));
  const master = ctx.createGain();
  master.gain.value = clamped;

  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -8;
  comp.knee.value = 12;
  comp.ratio.value = 6;
  comp.attack.value = 0.003;
  comp.release.value = 0.15;

  const dry = ctx.createGain();
  dry.gain.value = 0.9;

  const wet = ctx.createGain();
  wet.gain.value = 0.32;
  const convolver = ctx.createConvolver();
  convolver.buffer = getReverbBuffer(ctx);

  dry.connect(comp);
  wet.connect(convolver);
  convolver.connect(comp);
  comp.connect(master);
  master.connect(ctx.destination);

  activeSoundboardMaster = master;
  return { dry, wet };
}

function uiTone(
  ctx: AudioContext,
  freq: number,
  startOffset: number,
  duration: number,
  type: OscillatorType = 'sine',
  gainPeak = 0.11,
  endFreq?: number,
) {
  const now = ctx.currentTime + startOffset;
  const osc = ctx.createOscillator();
  const filter = ctx.createBiquadFilter();
  const gain = ctx.createGain();

  osc.type = type;
  osc.frequency.setValueAtTime(freq, now);
  if (endFreq !== undefined) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, endFreq), now + duration);
  }

  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(3200, now);

  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.linearRampToValueAtTime(gainPeak, now + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

  osc.connect(filter);
  filter.connect(gain);
  gain.connect(ctx.destination);
  osc.start(now);
  osc.stop(now + duration + 0.02);
}

export type UiSoundKind =
  | 'join'
  | 'leave'
  | 'peer_join'
  | 'peer_leave'
  | 'mute'
  | 'unmute'
  | 'deafen'
  | 'undeafen'
  | 'message';

export function playUiSound(kind: UiSoundKind) {
  const ctx = getCtx();
  if (!ctx) return;

  switch (kind) {
    case 'join':
      uiTone(ctx, 440, 0, 0.09, 'sine', 0.1);
      uiTone(ctx, 587.33, 0.07, 0.14, 'sine', 0.11);
      break;
    case 'leave':
      uiTone(ctx, 493.88, 0, 0.09, 'sine', 0.09);
      uiTone(ctx, 349.23, 0.07, 0.14, 'sine', 0.1);
      break;
    case 'peer_join':
      uiTone(ctx, 523.25, 0, 0.08, 'triangle', 0.08);
      uiTone(ctx, 659.25, 0.06, 0.11, 'triangle', 0.09);
      break;
    case 'peer_leave':
      uiTone(ctx, 415.3, 0, 0.08, 'triangle', 0.08);
      uiTone(ctx, 311.13, 0.06, 0.11, 'triangle', 0.08);
      break;
    case 'mute':
      uiTone(ctx, 340, 0, 0.07, 'sine', 0.09, 210);
      break;
    case 'unmute':
      uiTone(ctx, 350, 0, 0.07, 'sine', 0.09, 530);
      break;
    case 'deafen':
      uiTone(ctx, 270, 0, 0.09, 'sine', 0.09, 175);
      break;
    case 'undeafen':
      uiTone(ctx, 320, 0, 0.09, 'sine', 0.09, 490);
      break;
    case 'message':
      uiTone(ctx, 784, 0, 0.065, 'sine', 0.065);
      uiTone(ctx, 1046.5, 0.045, 0.08, 'sine', 0.05);
      break;
  }
}

export function stopAllSoundboard() {
  if (activeSoundboardMaster && sharedCtx) {
    try {
      activeSoundboardMaster.gain.cancelScheduledValues(sharedCtx.currentTime);
      activeSoundboardMaster.gain.setTargetAtTime(0.0001, sharedCtx.currentTime, 0.015);
    } catch {
      // Ignore
    }
    activeSoundboardMaster = null;
  }
  for (const el of Array.from(activeHtmlAudios)) {
    try {
      el.pause();
      el.currentTime = 0;
    } catch {
      // Ignore
    }
    activeHtmlAudios.delete(el);
  }
}

/** Plays a custom uploaded audio clip (data URL or remote URL). */
export function playCustomAudioClip(audioUrl: string, volume = 0.85) {
  if (typeof window === 'undefined' || !audioUrl) return;
  const el = new Audio(audioUrl);
  el.volume = Math.max(0, Math.min(1, volume));
  activeHtmlAudios.add(el);
  const cleanup = () => activeHtmlAudios.delete(el);
  el.onended = cleanup;
  el.onerror = cleanup;
  el.play().catch(cleanup);
}

/** Reads a user-picked audio file (MP3/WAV/OGG/WebM/M4A) into a bounded data URL. */
export async function readCustomAudioFile(file: File): Promise<string> {
  if (!file.type.startsWith('audio/') && !/\.(mp3|wav|ogg|webm|m4a)$/i.test(file.name)) {
    throw new Error('Lütfen MP3, WAV, OGG, WebM veya M4A ses dosyası seç.');
  }
  if (file.size > MAX_CUSTOM_SOUND_BYTES) {
    const kb = Math.round(file.size / 1024);
    throw new Error(
      `Ses dosyası çok büyük (${kb} KB). En fazla 185 KB boyutunda kısa (2-5 sn) bir klip yükle.`,
    );
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
      } else {
        reject(new Error('Ses dosyası okunamadı.'));
      }
    };
    reader.onerror = () => reject(new Error('Ses dosyası okunamadı.'));
    reader.readAsDataURL(file);
  });
}

function playAirhornBlast(
  ctx: AudioContext,
  bus: { dry: GainNode; wet: GainNode },
  offset: number,
  duration: number,
) {
  const now = ctx.currentTime + offset;
  const freqs = [392.0, 493.88, 587.33, 783.99, 396.5];
  const drive = ctx.createWaveShaper();
  drive.curve = getDriveCurve(34);
  drive.oversample = '2x';

  const formant = ctx.createBiquadFilter();
  formant.type = 'bandpass';
  formant.frequency.setValueAtTime(1150, now);
  formant.Q.value = 1.1;

  const env = ctx.createGain();
  env.gain.setValueAtTime(0.0001, now);
  env.gain.linearRampToValueAtTime(0.45, now + 0.018);
  env.gain.setValueAtTime(0.42, now + Math.max(0.03, duration - 0.04));
  env.gain.exponentialRampToValueAtTime(0.0001, now + duration);

  drive.connect(formant);
  formant.connect(env);
  env.connect(bus.dry);
  env.connect(bus.wet);

  for (const f of freqs) {
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(f * 0.94, now);
    osc.frequency.exponentialRampToValueAtTime(f, now + 0.025);
    osc.frequency.setValueAtTime(f, now + duration * 0.85);
    osc.frequency.exponentialRampToValueAtTime(f * 0.985, now + duration);
    osc.connect(drive);
    osc.start(now);
    osc.stop(now + duration + 0.03);
  }
}

function playVineBoom(ctx: AudioContext, bus: { dry: GainNode; wet: GainNode }) {
  const now = ctx.currentTime;

  // Deep 808 pitch-drop sub impact
  const sub = ctx.createOscillator();
  sub.type = 'sine';
  sub.frequency.setValueAtTime(115, now);
  sub.frequency.exponentialRampToValueAtTime(42, now + 0.14);
  sub.frequency.exponentialRampToValueAtTime(26, now + 1.05);

  const subDrive = ctx.createWaveShaper();
  subDrive.curve = getDriveCurve(16);

  const subGain = ctx.createGain();
  subGain.gain.setValueAtTime(0.0001, now);
  subGain.gain.linearRampToValueAtTime(0.95, now + 0.008);
  subGain.gain.exponentialRampToValueAtTime(0.0001, now + 1.15);

  sub.connect(subDrive);
  subDrive.connect(subGain);
  subGain.connect(bus.dry);
  subGain.connect(bus.wet);
  sub.start(now);
  sub.stop(now + 1.2);

  // Low punch transient thud
  const noise = ctx.createBufferSource();
  noise.buffer = getNoiseBuffer(ctx);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(900, now);
  lp.frequency.exponentialRampToValueAtTime(110, now + 0.18);
  const nGain = ctx.createGain();
  nGain.gain.setValueAtTime(0.6, now);
  nGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.2);

  noise.connect(lp);
  lp.connect(nGain);
  nGain.connect(bus.dry);
  nGain.connect(bus.wet);
  noise.start(now);
  noise.stop(now + 0.24);
}

function playApplause(ctx: AudioContext, bus: { dry: GainNode; wet: GainNode }) {
  const now = ctx.currentTime;
  const noiseBuf = getNoiseBuffer(ctx);
  const totalClaps = 46;
  const totalDuration = 1.95;

  for (let i = 0; i < totalClaps; i += 1) {
    // Natural crowd envelope: builds up quickly then fades out
    const progress = i / totalClaps;
    const jitter = (Math.random() - 0.5) * 0.055;
    const t = now + Math.max(0, progress * (totalDuration - 0.25) + jitter);

    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const offset = Math.random() * 1.4;

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 880 + Math.random() * 1350;
    bp.Q.value = 1.6 + Math.random() * 1.5;

    const env = ctx.createGain();
    const swell = Math.sin(Math.min(1, progress) * Math.PI);
    const peak = (0.09 + Math.random() * 0.11) * (0.45 + 0.55 * swell);
    const dur = 0.032 + Math.random() * 0.03;

    env.gain.setValueAtTime(0.0001, t);
    env.gain.linearRampToValueAtTime(peak, t + 0.004);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    src.connect(bp);
    bp.connect(env);
    if (typeof ctx.createStereoPanner === 'function') {
      const pan = ctx.createStereoPanner();
      pan.pan.value = Math.random() * 1.6 - 0.8;
      env.connect(pan);
      pan.connect(bus.dry);
      pan.connect(bus.wet);
    } else {
      env.connect(bus.dry);
      env.connect(bus.wet);
    }

    src.start(t, offset, dur + 0.02);
  }
}

function playRimshot(ctx: AudioContext, bus: { dry: GainNode; wet: GainNode }) {
  const now = ctx.currentTime;
  const noiseBuf = getNoiseBuffer(ctx);

  const kick = (t: number, pitchStart: number, pitchEnd: number, level: number) => {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(pitchStart, t);
    osc.frequency.exponentialRampToValueAtTime(pitchEnd, t + 0.09);
    const g = ctx.createGain();
    g.gain.setValueAtTime(level, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    osc.connect(g);
    g.connect(bus.dry);
    g.connect(bus.wet);
    osc.start(t);
    osc.stop(t + 0.18);
  };

  const snare = (t: number, level: number) => {
    // Snare body
    kick(t, 210, 125, level * 0.55);
    // Snare wires
    const n = ctx.createBufferSource();
    n.buffer = noiseBuf;
    const hp = ctx.createBiquadFilter();
    hp.type = 'bandpass';
    hp.frequency.value = 1800;
    hp.Q.value = 0.9;
    const g = ctx.createGain();
    g.gain.setValueAtTime(level, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    n.connect(hp);
    hp.connect(g);
    g.connect(bus.dry);
    g.connect(bus.wet);
    n.start(t, Math.random(), 0.18);
  };

  // Ba - Dum - Tss!
  snare(now + 0.0, 0.5);
  kick(now + 0.17, 155, 52, 0.7);
  snare(now + 0.3, 0.55);

  // Crash cymbal ("Tsssss")
  const cymTime = now + 0.52;
  const cymNoise = ctx.createBufferSource();
  cymNoise.buffer = noiseBuf;
  const cymHp = ctx.createBiquadFilter();
  cymHp.type = 'highpass';
  cymHp.frequency.value = 5400;
  const cymGain = ctx.createGain();
  cymGain.gain.setValueAtTime(0.0001, cymTime);
  cymGain.gain.linearRampToValueAtTime(0.42, cymTime + 0.01);
  cymGain.gain.exponentialRampToValueAtTime(0.0001, cymTime + 1.05);
  cymNoise.connect(cymHp);
  cymHp.connect(cymGain);
  cymGain.connect(bus.dry);
  cymGain.connect(bus.wet);
  cymNoise.start(cymTime, 0, 1.1);

  // Metallic shimmer overtones
  for (const mf of [3140, 4120, 5430, 6790]) {
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = mf;
    const mg = ctx.createGain();
    mg.gain.setValueAtTime(0.025, cymTime);
    mg.gain.exponentialRampToValueAtTime(0.0001, cymTime + 0.55);
    osc.connect(cymHp);
    cymHp.connect(mg);
    mg.connect(bus.dry);
    osc.start(cymTime);
    osc.stop(cymTime + 0.6);
  }
}

function playSadTrombone(ctx: AudioContext, bus: { dry: GainNode; wet: GainNode }) {
  const now = ctx.currentTime;
  const notes = [
    { start: 0.0, dur: 0.34, f1: 233.08, f2: 231.0, wah: 1100 }, // Bb3
    { start: 0.36, dur: 0.34, f1: 220.0, f2: 218.0, wah: 980 }, // A3
    { start: 0.72, dur: 0.34, f1: 207.65, f2: 205.5, wah: 860 }, // Ab3
    { start: 1.08, dur: 0.85, f1: 196.0, f2: 162.0, wah: 740 }, // G3 slide down
  ];

  for (const n of notes) {
    const t = now + n.start;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(n.f1, t);
    osc.frequency.exponentialRampToValueAtTime(n.f2, t + n.dur);

    // Subtle trombone vibrato on last note
    if (n.dur > 0.5) {
      const lfo = ctx.createOscillator();
      const lfoGain = ctx.createGain();
      lfo.frequency.value = 5.4;
      lfoGain.gain.value = 4.2;
      lfo.connect(lfoGain);
      lfoGain.connect(osc.frequency);
      lfo.start(t + 0.15);
      lfo.stop(t + n.dur + 0.05);
    }

    const drive = ctx.createWaveShaper();
    drive.curve = getDriveCurve(18);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 3.2;
    lp.frequency.setValueAtTime(340, t);
    lp.frequency.exponentialRampToValueAtTime(n.wah, t + 0.08);
    lp.frequency.exponentialRampToValueAtTime(320, t + n.dur);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.linearRampToValueAtTime(0.38, t + 0.035);
    env.gain.setValueAtTime(0.32, t + n.dur - 0.08);
    env.gain.exponentialRampToValueAtTime(0.0001, t + n.dur);

    osc.connect(drive);
    drive.connect(lp);
    lp.connect(env);
    env.connect(bus.dry);
    env.connect(bus.wet);
    osc.start(t);
    osc.stop(t + n.dur + 0.04);
  }
}

function playDramaticStab(ctx: AudioContext, bus: { dry: GainNode; wet: GainNode }) {
  const now = ctx.currentTime;
  const stabs = [
    { start: 0.0, dur: 0.26, notes: [130.81, 261.63, 311.13, 392.0] }, // Cm
    { start: 0.3, dur: 0.26, notes: [123.47, 246.94, 293.66, 369.99] }, // Bm
    { start: 0.62, dur: 1.15, notes: [98.0, 196.0, 233.08, 293.66, 369.99] }, // Dramatic dim/minor
  ];

  for (const s of stabs) {
    const t = now + s.start;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(2400, t);
    lp.frequency.exponentialRampToValueAtTime(700, t + s.dur);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.linearRampToValueAtTime(0.32, t + 0.02);
    env.gain.exponentialRampToValueAtTime(0.0001, t + s.dur);

    lp.connect(env);
    env.connect(bus.dry);
    env.connect(bus.wet);

    for (const f of s.notes) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(f, t);
      osc.connect(lp);
      osc.start(t);
      osc.stop(t + s.dur + 0.04);
    }
  }
}

function playVictoryFanfare(ctx: AudioContext, bus: { dry: GainNode; wet: GainNode }) {
  const now = ctx.currentTime;
  const seq = [
    { t: 0.0, d: 0.14, freqs: [523.25, 659.25] },
    { t: 0.14, d: 0.14, freqs: [659.25, 783.99] },
    { t: 0.28, d: 0.14, freqs: [783.99, 987.77] },
    { t: 0.44, d: 0.72, freqs: [523.25, 659.25, 783.99, 1046.5] },
  ];

  for (const step of seq) {
    const t = now + step.t;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(3600, t);
    lp.frequency.exponentialRampToValueAtTime(1400, t + step.d);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.linearRampToValueAtTime(0.24, t + 0.015);
    env.gain.exponentialRampToValueAtTime(0.0001, t + step.d);

    lp.connect(env);
    env.connect(bus.dry);
    env.connect(bus.wet);

    for (const f of step.freqs) {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(f, t);
      const bright = ctx.createOscillator();
      bright.type = 'sawtooth';
      bright.frequency.setValueAtTime(f * 2, t);
      const bGain = ctx.createGain();
      bGain.gain.value = 0.18;

      osc.connect(lp);
      bright.connect(bGain);
      bGain.connect(lp);

      osc.start(t);
      bright.start(t);
      osc.stop(t + step.d + 0.03);
      bright.stop(t + step.d + 0.03);
    }
  }
}

function playBonk(ctx: AudioContext, bus: { dry: GainNode; wet: GainNode }) {
  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(520, now);
  osc.frequency.exponentialRampToValueAtTime(185, now + 0.09);

  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.setValueAtTime(680, now);
  bp.Q.value = 4.2;

  const env = ctx.createGain();
  env.gain.setValueAtTime(0.0001, now);
  env.gain.linearRampToValueAtTime(0.85, now + 0.005);
  env.gain.exponentialRampToValueAtTime(0.0001, now + 0.16);

  osc.connect(bp);
  bp.connect(env);
  env.connect(bus.dry);
  env.connect(bus.wet);
  osc.start(now);
  osc.stop(now + 0.2);

  // Hollow knock transient
  const n = ctx.createBufferSource();
  n.buffer = getNoiseBuffer(ctx);
  const kn = ctx.createBiquadFilter();
  kn.type = 'bandpass';
  kn.frequency.value = 1150;
  kn.Q.value = 5.5;
  const ng = ctx.createGain();
  ng.gain.setValueAtTime(0.55, now);
  ng.gain.exponentialRampToValueAtTime(0.0001, now + 0.045);
  n.connect(kn);
  kn.connect(ng);
  ng.connect(bus.dry);
  n.start(now, 0, 0.06);
}

function playQuack(ctx: AudioContext, bus: { dry: GainNode; wet: GainNode }) {
  const now = ctx.currentTime;
  for (const offset of [0, 0.19]) {
    const t = now + offset;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(340, t);
    osc.frequency.exponentialRampToValueAtTime(240, t + 0.13);

    const formant1 = ctx.createBiquadFilter();
    formant1.type = 'bandpass';
    formant1.frequency.setValueAtTime(1550, t);
    formant1.frequency.exponentialRampToValueAtTime(820, t + 0.13);
    formant1.Q.value = 4.5;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.linearRampToValueAtTime(0.65, t + 0.012);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);

    osc.connect(formant1);
    formant1.connect(env);
    env.connect(bus.dry);
    env.connect(bus.wet);
    osc.start(t);
    osc.stop(t + 0.16);
  }
}

function playCricket(ctx: AudioContext, bus: { dry: GainNode; wet: GainNode }) {
  const now = ctx.currentTime;
  for (const chirp of [0, 0.52, 1.04]) {
    for (let p = 0; p < 4; p += 1) {
      const t = now + chirp + p * 0.042;
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(4250 + (p % 2) * 140, t);

      const env = ctx.createGain();
      env.gain.setValueAtTime(0.0001, t);
      env.gain.linearRampToValueAtTime(0.18, t + 0.006);
      env.gain.exponentialRampToValueAtTime(0.0001, t + 0.028);

      osc.connect(env);
      env.connect(bus.dry);
      env.connect(bus.wet);
      osc.start(t);
      osc.stop(t + 0.032);
    }
  }
}

function playAlarm(ctx: AudioContext, bus: { dry: GainNode; wet: GainNode }) {
  const now = ctx.currentTime;
  for (let i = 0; i < 3; i += 1) {
    const t = now + i * 0.34;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(560, t);
    osc.frequency.linearRampToValueAtTime(920, t + 0.16);
    osc.frequency.linearRampToValueAtTime(560, t + 0.3);

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1100;
    bp.Q.value = 1.4;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.linearRampToValueAtTime(0.32, t + 0.015);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.31);

    osc.connect(bp);
    bp.connect(env);
    env.connect(bus.dry);
    env.connect(bus.wet);
    osc.start(t);
    osc.stop(t + 0.33);
  }
}

function playLevelUp(ctx: AudioContext, bus: { dry: GainNode; wet: GainNode }) {
  const now = ctx.currentTime;
  const notes = [523.25, 659.25, 783.99, 1046.5, 1318.51];
  notes.forEach((f, idx) => {
    const t = now + idx * 0.075;
    const isLast = idx === notes.length - 1;
    const dur = isLast ? 0.52 : 0.16;

    const carrier = ctx.createOscillator();
    carrier.type = 'sine';
    carrier.frequency.setValueAtTime(f, t);

    const mod = ctx.createOscillator();
    mod.type = 'sine';
    mod.frequency.setValueAtTime(f * 2, t);
    const modGain = ctx.createGain();
    modGain.gain.setValueAtTime(f * 0.4, t);
    modGain.gain.exponentialRampToValueAtTime(0.1, t + dur);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.linearRampToValueAtTime(isLast ? 0.3 : 0.22, t + 0.01);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    mod.connect(modGain);
    modGain.connect(carrier.frequency);
    carrier.connect(env);
    env.connect(bus.dry);
    env.connect(bus.wet);

    carrier.start(t);
    mod.start(t);
    carrier.stop(t + dur + 0.03);
    mod.stop(t + dur + 0.03);
  });
}

export function playSoundboard(
  sound: SoundboardId,
  options?: { volume?: number; customAudioUrl?: string | null },
) {
  const volume = options?.volume ?? 0.85;
  if (options?.customAudioUrl) {
    playCustomAudioClip(options.customAudioUrl, volume);
    return;
  }

  const ctx = getCtx();
  if (!ctx) return;
  const bus = createMasterBus(ctx, volume);

  switch (sound) {
    case 'airhorn':
      playAirhornBlast(ctx, bus, 0, 0.16);
      playAirhornBlast(ctx, bus, 0.19, 0.16);
      playAirhornBlast(ctx, bus, 0.39, 0.56);
      break;
    case 'vineboom':
      playVineBoom(ctx, bus);
      break;
    case 'gg':
      playVictoryFanfare(ctx, bus);
      break;
    case 'drumroll':
      playRimshot(ctx, bus);
      break;
    case 'applause':
      playApplause(ctx, bus);
      break;
    case 'fail':
      playSadTrombone(ctx, bus);
      break;
    case 'dramatic':
      playDramaticStab(ctx, bus);
      break;
    case 'bonk':
      playBonk(ctx, bus);
      break;
    case 'quack':
      playQuack(ctx, bus);
      break;
    case 'cricket':
      playCricket(ctx, bus);
      break;
    case 'alarm':
      playAlarm(ctx, bus);
      break;
    case 'levelup':
      playLevelUp(ctx, bus);
      break;
    default:
      playLevelUp(ctx, bus);
      break;
  }
}
