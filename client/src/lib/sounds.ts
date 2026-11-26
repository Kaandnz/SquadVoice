import type { SoundboardId } from '../types/protocol';

export const SOUNDBOARD_ITEMS: Array<{ id: SoundboardId; label: string; emoji: string }> = [
  { id: 'airhorn', label: 'Havalı Korna', emoji: '📯' },
  { id: 'gg', label: 'GG WP', emoji: '🏆' },
  { id: 'drumroll', label: 'Davul', emoji: '🥁' },
  { id: 'applause', label: 'Alkış', emoji: '👏' },
  { id: 'fail', label: 'Sad Trombone', emoji: '🎺' },
  { id: 'quack', label: 'Vak Vak', emoji: '🦆' },
  { id: 'alarm', label: 'Uyarı', emoji: '🚨' },
  { id: 'levelup', label: 'Level Up', emoji: '✨' },
];

let sharedCtx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtx) return null;
  if (!sharedCtx) {
    sharedCtx = new AudioCtx();
  }
  if (sharedCtx.state === 'suspended') {
    sharedCtx.resume().catch(() => {});
  }
  return sharedCtx;
}

function tone(
  ctx: AudioContext,
  freq: number,
  startOffset: number,
  duration: number,
  type: OscillatorType = 'sine',
  gainPeak = 0.12,
  endFreq?: number,
) {
  const now = ctx.currentTime + startOffset;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, now);
  if (endFreq !== undefined) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, endFreq), now + duration);
  }
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.linearRampToValueAtTime(gainPeak, now + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
  osc.connect(gain);
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
      tone(ctx, 440, 0, 0.09, 'sine', 0.11);
      tone(ctx, 587.3, 0.07, 0.13, 'sine', 0.11);
      break;
    case 'leave':
      tone(ctx, 493.9, 0, 0.09, 'sine', 0.1);
      tone(ctx, 349.2, 0.07, 0.14, 'sine', 0.1);
      break;
    case 'peer_join':
      tone(ctx, 523.2, 0, 0.08, 'triangle', 0.09);
      tone(ctx, 659.2, 0.06, 0.1, 'triangle', 0.09);
      break;
    case 'peer_leave':
      tone(ctx, 415.3, 0, 0.08, 'triangle', 0.08);
      tone(ctx, 311.1, 0.06, 0.1, 'triangle', 0.08);
      break;
    case 'mute':
      tone(ctx, 320, 0, 0.07, 'sine', 0.09, 220);
      break;
    case 'unmute':
      tone(ctx, 360, 0, 0.07, 'sine', 0.09, 520);
      break;
    case 'deafen':
      tone(ctx, 260, 0, 0.09, 'sine', 0.1, 180);
      break;
    case 'undeafen':
      tone(ctx, 320, 0, 0.09, 'sine', 0.1, 480);
      break;
    case 'message':
      tone(ctx, 784, 0, 0.07, 'sine', 0.07);
      break;
  }
}

export function playSoundboard(sound: SoundboardId) {
  const ctx = getCtx();
  if (!ctx) return;

  switch (sound) {
    case 'airhorn':
      tone(ctx, 392, 0, 0.16, 'sawtooth', 0.14);
      tone(ctx, 493.9, 0, 0.16, 'sawtooth', 0.1);
      tone(ctx, 392, 0.18, 0.35, 'sawtooth', 0.15);
      tone(ctx, 493.9, 0.18, 0.35, 'sawtooth', 0.11);
      break;
    case 'gg':
      tone(ctx, 523.25, 0, 0.1, 'triangle', 0.13);
      tone(ctx, 659.25, 0.1, 0.1, 'triangle', 0.13);
      tone(ctx, 783.99, 0.2, 0.12, 'triangle', 0.14);
      tone(ctx, 1046.5, 0.32, 0.25, 'triangle', 0.15);
      break;
    case 'drumroll':
      for (let i = 0; i < 8; i += 1) {
        tone(ctx, 120 + (i % 2) * 18, i * 0.055, 0.045, 'triangle', 0.14);
      }
      tone(ctx, 220, 0.46, 0.22, 'sawtooth', 0.14, 90);
      break;
    case 'applause':
      for (let i = 0; i < 10; i += 1) {
        tone(ctx, 260 + Math.random() * 520, i * 0.05, 0.04, 'square', 0.05);
      }
      break;
    case 'fail':
      tone(ctx, 311.13, 0, 0.22, 'sawtooth', 0.12);
      tone(ctx, 293.66, 0.24, 0.22, 'sawtooth', 0.12);
      tone(ctx, 277.18, 0.48, 0.22, 'sawtooth', 0.12);
      tone(ctx, 261.63, 0.72, 0.48, 'sawtooth', 0.13, 210);
      break;
    case 'quack':
      tone(ctx, 650, 0, 0.09, 'sawtooth', 0.14, 340);
      tone(ctx, 620, 0.13, 0.11, 'sawtooth', 0.14, 310);
      break;
    case 'alarm':
      tone(ctx, 880, 0, 0.12, 'square', 0.09);
      tone(ctx, 660, 0.13, 0.12, 'square', 0.09);
      tone(ctx, 880, 0.26, 0.12, 'square', 0.09);
      break;
    case 'levelup':
      tone(ctx, 440, 0, 0.08, 'sine', 0.12);
      tone(ctx, 554.37, 0.08, 0.08, 'sine', 0.12);
      tone(ctx, 659.25, 0.16, 0.08, 'sine', 0.12);
      tone(ctx, 880, 0.24, 0.24, 'sine', 0.14);
      break;
  }
}
