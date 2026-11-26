import { describe, expect, it } from 'vitest';
import { computeRmsLevel, evaluateNoiseGate } from './audioGate';

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
