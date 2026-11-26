import { describe, expect, it } from 'vitest';
import { computeRmsLevel, evaluateNoiseGate, limiterMakeupGain } from './audioGate';

describe('limiterMakeupGain', () => {
  it('matches the Web Audio spec formula for the boost limiter (-3 dB, 20:1)', () => {
    // full-scale gain -2.85 dB -> makeup (10^(2.85/20))^0.6 ≈ 1.218 (+1.71 dB)
    expect(limiterMakeupGain(-3, 20)).toBeCloseTo(1.2178, 3);
  });

  it('is neutral when the curve does nothing at full scale', () => {
    expect(limiterMakeupGain(0, 20)).toBeCloseTo(1, 6);
    expect(limiterMakeupGain(-12, 1)).toBeCloseTo(1, 6);
  });
});

describe('audioGate helpers', () => {
  it('computes normalized RMS levels from PCM samples', () => {
    expect(computeRmsLevel([])).toBe(0);
    expect(computeRmsLevel([0, 0, 0, 0])).toBe(0);
    expect(computeRmsLevel([0.1, -0.1, 0.1, -0.1])).toBe(35);
    expect(computeRmsLevel([1, 1])).toBe(100);
  });

  it('opens at threshold, holds across hysteresis and hangover, and closes afterward', () => {
    const closed = { open: false, hangoverUntil: 0 };
    expect(evaluateNoiseGate(closed, 12, 20, 1000).open).toBe(false);

    const opened = evaluateNoiseGate(closed, 22, 20, 1000);
    expect(opened.open).toBe(true);
    expect(opened.hangoverUntil).toBe(1320);

    // Between 0.65 * 20 (13) and 20 stays open and refreshes hangover
    const heldByHysteresis = evaluateNoiseGate(opened, 14, 20, 1200);
    expect(heldByHysteresis.open).toBe(true);
    expect(heldByHysteresis.hangoverUntil).toBe(1520);

    // Below hysteresis but within hangover still stays open
    const heldByHangover = evaluateNoiseGate(heldByHysteresis, 2, 20, 1450);
    expect(heldByHangover.open).toBe(true);

    // After hangover expires, gate closes cleanly
    const closedAgain = evaluateNoiseGate(heldByHangover, 2, 20, 1600);
    expect(closedAgain.open).toBe(false);
  });

  it('stays always open when threshold is 0', () => {
    const res = evaluateNoiseGate({ open: false, hangoverUntil: 0 }, 0, 0, 500);
    expect(res.open).toBe(true);
  });
});
