import type { AudioSettings, InputSensitivityMode } from '../types/protocol';

export interface GateState {
  open: boolean;
  hangoverUntil: number;
}

export interface GateOptions {
  /** Keep the gate open this long after the voice drops, so word endings aren't cut. */
  hangoverMs?: number;
  /** Once open, stay open until the level falls this many dB below the threshold. */
  hysteresisDb?: number;
}

/**
 * DynamicsCompressorNode always adds "makeup gain" (Web Audio spec: the 0.6 power of the
 * inverse of the curve's gain at full scale). For a hard-knee limiter that is
 * (1 / 10^((T + (0 - T) / R) / 20))^0.6. Multiply by the inverse of this to keep the
 * level the user picked on the volume slider.
 */
export function limiterMakeupGain(thresholdDb: number, ratio: number): number {
  const fullRangeDb = thresholdDb + (0 - thresholdDb) / ratio;
  const fullRangeGain = 10 ** (fullRangeDb / 20);
  return (1 / fullRangeGain) ** 0.6;
}

/** Bottom of the level meter / sensitivity scale. Quieter than this counts as silence. */
export const METER_FLOOR_DB = -80;

/** RMS level of time-domain PCM samples in dBFS, floored at METER_FLOOR_DB. */
export function levelDb(samples: ArrayLike<number>): number {
  if (!samples.length) return METER_FLOOR_DB;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const s = samples[i];
    sum += s * s;
  }
  const rms = Math.sqrt(sum / samples.length);
  if (rms <= 0) return METER_FLOOR_DB;
  return Math.max(METER_FLOOR_DB, 20 * Math.log10(rms));
}

/**
 * dBFS -> 0..100 for the meter. A log scale puts normal speech (~-35..-15 dB) in the
 * middle of the bar; the old linear scale squeezed it into the bottom few percent.
 */
export function meterPercent(db: number): number {
  const pct = ((db - METER_FLOOR_DB) / -METER_FLOOR_DB) * 100;
  return Math.round(Math.min(100, Math.max(0, pct)));
}

/** Inverse of meterPercent, for the sensitivity slider. */
export function dbFromMeterPercent(pct: number): number {
  return METER_FLOOR_DB + (Math.min(100, Math.max(0, pct)) / 100) * -METER_FLOOR_DB;
}

/** Hysteresis + hangover noise gate on dB levels: opens on voice, no chattering. */
export function evaluateNoiseGate(
  state: GateState,
  levelDbValue: number,
  thresholdDb: number,
  nowMs: number,
  options?: GateOptions,
): GateState {
  const hangoverMs = options?.hangoverMs ?? 350;
  const hysteresisDb = options?.hysteresisDb ?? 6;

  if (levelDbValue >= thresholdDb) {
    return { open: true, hangoverUntil: nowMs + hangoverMs };
  }
  if (state.open) {
    if (levelDbValue >= thresholdDb - hysteresisDb) {
      return { open: true, hangoverUntil: nowMs + hangoverMs };
    }
    if (nowMs <= state.hangoverUntil) {
      return { open: true, hangoverUntil: state.hangoverUntil };
    }
  }
  return { open: false, hangoverUntil: state.hangoverUntil };
}

/** Starting guess for the room's background level before we've measured it. */
export const INITIAL_NOISE_FLOOR_DB = -60;

/**
 * Follows the background noise level: drops quickly to quiet moments, rises only very
 * slowly so talking doesn't drag the "noise" estimate up with it.
 */
export function trackNoiseFloor(floorDb: number, levelDbValue: number, dtMs: number): number {
  const tau = levelDbValue < floorDb ? 150 : 8000;
  const a = 1 - Math.exp(-Math.max(0, dtMs) / tau);
  return floorDb + (levelDbValue - floorDb) * a;
}

/** Automatic gate threshold: a margin above the measured noise, kept in a sane range. */
export const AUTO_MARGIN_DB = 10;
export const AUTO_MIN_THRESHOLD_DB = -60;
/**
 * Even in a loud room the threshold stays below quiet speech (~-36 dBFS RMS), so a soft
 * talker is never cut; hysteresis then keeps the gate open down to -42 dB.
 */
export const AUTO_MAX_THRESHOLD_DB = -36;

export function autoGateThreshold(noiseFloorDb: number): number {
  return Math.min(
    AUTO_MAX_THRESHOLD_DB,
    Math.max(AUTO_MIN_THRESHOLD_DB, noiseFloorDb + AUTO_MARGIN_DB),
  );
}

/** Push-to-talk is an explicit "send now", so it bypasses the gate. */
export function effectiveGateMode(
  settings: Pick<AudioSettings, 'pttEnabled' | 'inputSensitivity'>,
): InputSensitivityMode {
  return settings.pttEnabled ? 'off' : settings.inputSensitivity;
}
