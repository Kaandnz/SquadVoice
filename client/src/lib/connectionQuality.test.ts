import { describe, expect, it } from 'vitest';
import { appendSample, rateConnection, sparkGeometry, summarize } from './connectionQuality';

const s = (t: number, rttMs: number | null = 20) => ({ t, rttMs, lossPct: 0, jitterMs: 5 });

describe('connection quality', () => {
  it('keeps only the newest samples', () => {
    let h = appendSample(undefined, s(1), 3);
    h = appendSample(h, s(2), 3);
    h = appendSample(h, s(3), 3);
    h = appendSample(h, s(4), 3);
    expect(h.map((x) => x.t)).toEqual([2, 3, 4]);
  });

  it('rates calls by the worst of ping, loss and jitter', () => {
    expect(rateConnection({ rttMs: 40, lossPct: 0, jitterMs: 4 })).toBe('good');
    expect(rateConnection({ rttMs: 200, lossPct: 0, jitterMs: 4 })).toBe('fair');
    expect(rateConnection({ rttMs: 40, lossPct: 5, jitterMs: 4 })).toBe('fair');
    expect(rateConnection({ rttMs: 40, lossPct: 0, jitterMs: 80 })).toBe('poor');
    expect(rateConnection({ rttMs: 400, lossPct: 0, jitterMs: 0 })).toBe('poor');
    expect(rateConnection({ rttMs: null, lossPct: null, jitterMs: null })).toBe('unknown');
  });

  it('summarizes ignoring unknown values', () => {
    expect(summarize([10, null, 30])).toEqual({ min: 10, avg: 20, max: 30 });
    expect(summarize([null])).toBeNull();
  });

  it('maps values to a baseline-anchored path and breaks lines on gaps', () => {
    const g = sparkGeometry([0, 50, null, 100], 30, 26, 10, 3);
    expect(g.points[0]).toEqual({ x: 0, y: 23 }); // baseline
    expect(g.points[3]).toEqual({ x: 30, y: 3 }); // max at top padding
    expect(g.points[2]).toBeNull();
    expect(g.segments).toEqual(['0,23 10,13', '30,3']);
  });

  it('does not stretch tiny values to full height', () => {
    const g = sparkGeometry([3, 3], 10, 26, 100, 3);
    expect(g.points[0]?.y).toBeGreaterThan(20);
  });
});
