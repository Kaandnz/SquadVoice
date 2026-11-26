export interface GateState {
  open: boolean;
  hangoverUntil: number;
}

export interface GateOptions {
  hangoverMs?: number;
  hysteresisRatio?: number;
}

/** Computes normalized 0..100 RMS microphone level from time-domain PCM samples. */
export function computeRmsLevel(samples: ArrayLike<number>): number {
  if (!samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const s = samples[i];
    sum += s * s;
  }
  const rms = Math.sqrt(sum / samples.length);
  return Math.min(100, Math.round(rms * 350));
}

/** Evaluates hysteresis + hangover noise gate state to prevent choppiness and background hiss. */
export function evaluateNoiseGate(
  state: GateState,
  level: number,
  threshold: number,
  nowMs: number,
  options?: GateOptions,
): GateState {
  const hangoverMs = options?.hangoverMs ?? 320;
  const hysteresisRatio = options?.hysteresisRatio ?? 0.65;

  if (threshold <= 0) {
    return { open: true, hangoverUntil: nowMs + hangoverMs };
  }

  if (level >= threshold) {
    return { open: true, hangoverUntil: nowMs + hangoverMs };
  }

  if (state.open) {
    if (level >= threshold * hysteresisRatio) {
      return { open: true, hangoverUntil: nowMs + hangoverMs };
    }
    if (nowMs <= state.hangoverUntil) {
      return { open: true, hangoverUntil: state.hangoverUntil };
    }
  }

  return { open: false, hangoverUntil: state.hangoverUntil };
}
