import { describe, expect, it } from 'vitest';
import {
  AUTO_MAX_THRESHOLD_DB,
  AUTO_MIN_THRESHOLD_DB,
  autoGateThreshold,
  dbFromMeterPercent,
  effectiveGateMode,
  evaluateNoiseGate,
  levelDb,
  limiterMakeupGain,
  meterPercent,
  trackNoiseFloor,
} from './audioGate';

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

describe('levels in dB', () => {
  it('measures RMS in dBFS and floors silence', () => {
    expect(levelDb([1, -1, 1, -1])).toBeCloseTo(0, 6);
    expect(levelDb([0.1, -0.1])).toBeCloseTo(-20, 6);
    expect(levelDb([0, 0, 0])).toBe(-80);
    expect(levelDb([])).toBe(-80);
  });

  it('maps -80..0 dB onto the 0..100 meter and back', () => {
    expect(meterPercent(-80)).toBe(0);
    expect(meterPercent(-40)).toBe(50);
    expect(meterPercent(0)).toBe(100);
    expect(meterPercent(-200)).toBe(0);
    expect(dbFromMeterPercent(50)).toBe(-40);
  });

  it('puts normal speech in the middle of the meter, not the bottom', () => {
    // -30 dBFS RMS is ordinary speech; the old linear scale showed it as ~11 %
    expect(meterPercent(-30)).toBeGreaterThan(55);
  });
});

describe('evaluateNoiseGate (dB)', () => {
  const closed = { open: false, hangoverUntil: 0 };

  it('opens at the threshold and holds through hysteresis and hangover', () => {
    expect(evaluateNoiseGate(closed, -55, -50, 1000).open).toBe(false);

    const opened = evaluateNoiseGate(closed, -45, -50, 1000);
    expect(opened).toEqual({ open: true, hangoverUntil: 1350 });

    // within 6 dB below the threshold: stays open and refreshes the hangover
    const held = evaluateNoiseGate(opened, -54, -50, 1200);
    expect(held).toEqual({ open: true, hangoverUntil: 1550 });

    // quiet, but the word is still ending: hangover keeps it open
    expect(evaluateNoiseGate(held, -75, -50, 1500).open).toBe(true);
    // then it closes
    expect(evaluateNoiseGate(held, -75, -50, 1600).open).toBe(false);
  });

  it('does not open on a level between close and open thresholds', () => {
    expect(evaluateNoiseGate(closed, -53, -50, 0).open).toBe(false);
  });
});

describe('automatic sensitivity', () => {
  it('drops quickly to a quieter room and rises only slowly while you talk', () => {
    let floor = -60;
    for (let i = 0; i < 25; i += 1) floor = trackNoiseFloor(floor, -70, 20); // 0.5 s quiet
    expect(floor).toBeLessThan(-69);

    for (let i = 0; i < 100; i += 1) floor = trackNoiseFloor(floor, -20, 20); // 2 s speech
    expect(floor).toBeLessThan(-55);
  });

  it('keeps the threshold a margin above the noise, within sane bounds', () => {
    expect(autoGateThreshold(-60)).toBe(-50);
    expect(autoGateThreshold(-90)).toBe(AUTO_MIN_THRESHOLD_DB);
    // a loud room never pushes the threshold above normal speech
    expect(autoGateThreshold(-20)).toBe(AUTO_MAX_THRESHOLD_DB);
  });

  it('lets push-to-talk bypass the gate', () => {
    expect(effectiveGateMode({ pttEnabled: true, inputSensitivity: 'manual' })).toBe('off');
    expect(effectiveGateMode({ pttEnabled: false, inputSensitivity: 'auto' })).toBe('auto');
  });
});
