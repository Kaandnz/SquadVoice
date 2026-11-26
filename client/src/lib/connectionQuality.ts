import type { PeerStats } from '../types/protocol';

export interface QualitySample {
  /** ms timestamp */
  t: number;
  rttMs: number | null;
  lossPct: number | null;
  jitterMs: number | null;
}

/** Stats arrive every 2s, so 30 samples ≈ the last minute. */
export const HISTORY_LENGTH = 30;

export type ConnectionRating = 'good' | 'fair' | 'poor' | 'unknown';

export function sampleFromStats(stats: PeerStats, t: number): QualitySample {
  return { t, rttMs: stats.rttMs, lossPct: stats.packetLossPct, jitterMs: stats.jitterMs };
}

/** Samples closer together than this replace the newest one instead of adding a point. */
export const MIN_SAMPLE_SPACING_MS = 1500;

/**
 * Appends a sample, keeping only the newest `max`. Extra stats runs (ICE changes, new
 * tracks) can arrive moments after a regular one; those update the latest point rather
 * than squeezing the one-minute window. Returns a new array.
 */
export function appendSample(
  history: QualitySample[] | undefined,
  sample: QualitySample,
  max = HISTORY_LENGTH,
): QualitySample[] {
  const prev = history ?? [];
  const last = prev[prev.length - 1];
  const base =
    last && sample.t - last.t < MIN_SAMPLE_SPACING_MS ? prev.slice(0, -1) : prev;
  const next = [...base, sample];
  return next.length > max ? next.slice(next.length - max) : next;
}

/**
 * Voice-call thresholds (roughly ITU-T G.114 / typical VoIP guidance): under 150 ms,
 * 2 % loss and 30 ms jitter sounds clean; past 300 ms, 8 % or 60 ms it audibly breaks up.
 */
export function rateConnection(sample: Pick<QualitySample, 'rttMs' | 'lossPct' | 'jitterMs'>): ConnectionRating {
  const { rttMs, lossPct, jitterMs } = sample;
  if (rttMs === null && lossPct === null && jitterMs === null) return 'unknown';
  const rtt = rttMs ?? 0;
  const loss = lossPct ?? 0;
  const jitter = jitterMs ?? 0;
  if (rtt > 300 || loss > 8 || jitter > 60) return 'poor';
  if (rtt > 150 || loss > 2 || jitter > 30) return 'fair';
  return 'good';
}

export function summarize(values: Array<number | null>): { min: number; avg: number; max: number } | null {
  const nums = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (nums.length === 0) return null;
  const sum = nums.reduce((a, b) => a + b, 0);
  return { min: Math.min(...nums), avg: sum / nums.length, max: Math.max(...nums) };
}

export interface SparkGeometry {
  /** One polyline per run of consecutive known values (gaps break the line). */
  segments: string[];
  /** x/y per sample, null where the value is unknown. */
  points: Array<{ x: number; y: number } | null>;
}

/**
 * Maps values onto a width×height box with the baseline (0) at the bottom and a small
 * top padding. `floor` keeps tiny values from filling the whole height (e.g. 3 ms ping
 * shouldn't look like a spike).
 */
export function sparkGeometry(
  values: Array<number | null>,
  width: number,
  height: number,
  floor: number,
  pad = 3,
): SparkGeometry {
  const known = values.filter((v): v is number => v !== null && Number.isFinite(v));
  const top = Math.max(floor, ...known);
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  const usable = height - pad * 2;

  const points = values.map((v, i) =>
    v === null || !Number.isFinite(v)
      ? null
      : {
          x: Number((values.length > 1 ? i * step : width / 2).toFixed(2)),
          y: Number((pad + usable - (Math.max(0, v) / top) * usable).toFixed(2)),
        },
  );

  const segments: string[] = [];
  let run: string[] = [];
  for (const p of points) {
    if (p) {
      run.push(`${p.x},${p.y}`);
    } else if (run.length) {
      segments.push(run.join(' '));
      run = [];
    }
  }
  if (run.length) segments.push(run.join(' '));
  return { segments, points };
}
