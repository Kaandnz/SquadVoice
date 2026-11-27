import { describe, expect, it } from 'vitest';
import type { AudioSettings } from '../types/protocol';
import {
  NOISE_SUPPRESSION_OPTIONS,
  buildMicTrackConstraints,
  isAiNoiseSuppressionMode,
  isSampleRateCompatible,
  mergeAudioSettings,
  resolveNoiseSuppressionMode,
} from './noiseSuppression';

const BASE_SETTINGS: AudioSettings = {
  inputDeviceId: 'default',
  outputDeviceId: 'default',
  opusBitrateKbps: 96,
  stereo: false,
  echoCancellation: true,
  noiseSuppression: true,
  noiseSuppressionMode: 'standard',
  autoGainControl: true,
  inputSensitivity: 'auto',
  gateThresholdDb: -50,
  pttEnabled: false,
  pttKey: 'Backquote',
  soundsEnabled: true,
  soundboardVolume: 0.85,
  desktopNotifications: false,
};

describe('noiseSuppression helpers', () => {
  it('migrates legacy boolean settings cleanly', () => {
    expect(resolveNoiseSuppressionMode({ noiseSuppression: true })).toBe('standard');
    expect(resolveNoiseSuppressionMode({ noiseSuppression: false })).toBe('off');
    expect(resolveNoiseSuppressionMode({})).toBe('standard');
    expect(
      resolveNoiseSuppressionMode({
        noiseSuppression: false,
        noiseSuppressionMode: 'gtcrn',
      }),
    ).toBe('gtcrn');
  });

  it('keeps noiseSuppression boolean and noiseSuppressionMode synchronized', () => {
    const gtcrn = mergeAudioSettings(BASE_SETTINGS, { noiseSuppressionMode: 'gtcrn' });
    expect(gtcrn.noiseSuppressionMode).toBe('gtcrn');
    expect(gtcrn.noiseSuppression).toBe(true);

    const off = mergeAudioSettings(gtcrn, { noiseSuppressionMode: 'off' });
    expect(off.noiseSuppressionMode).toBe('off');
    expect(off.noiseSuppression).toBe(false);

    const legacyOff = mergeAudioSettings(gtcrn, { noiseSuppression: false });
    expect(legacyOff.noiseSuppressionMode).toBe('off');
    expect(legacyOff.noiseSuppression).toBe(false);
  });

  it('disables native browser noiseSuppression in AI modes to prevent double-filtering', () => {
    expect(
      buildMicTrackConstraints({
        echoCancellation: true,
        noiseSuppression: true,
        noiseSuppressionMode: 'standard',
        autoGainControl: true,
      }),
    ).toEqual({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    });

    expect(
      buildMicTrackConstraints({
        echoCancellation: true,
        noiseSuppression: true,
        noiseSuppressionMode: 'rnnoise',
        autoGainControl: true,
      }),
    ).toEqual({
      echoCancellation: true,
      noiseSuppression: false,
      autoGainControl: true,
    });

    expect(
      buildMicTrackConstraints({
        echoCancellation: true,
        noiseSuppression: true,
        noiseSuppressionMode: 'gtcrn',
        autoGainControl: false,
      }),
    ).toEqual({
      echoCancellation: true,
      noiseSuppression: false,
      autoGainControl: false,
    });

    expect(
      buildMicTrackConstraints({
        echoCancellation: true,
        noiseSuppression: true,
        noiseSuppressionMode: 'deepfilternet',
        autoGainControl: true,
      }),
    ).toEqual({
      echoCancellation: true,
      noiseSuppression: false,
      autoGainControl: true,
    });

    expect(
      buildMicTrackConstraints({
        echoCancellation: false,
        noiseSuppression: false,
        noiseSuppressionMode: 'off',
        autoGainControl: false,
      }),
    ).toEqual({
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    });
  });

  it('validates AI mode flags and required AudioContext sample rates', () => {
    expect(isAiNoiseSuppressionMode('off')).toBe(false);
    expect(isAiNoiseSuppressionMode('standard')).toBe(false);
    expect(isAiNoiseSuppressionMode('rnnoise')).toBe(true);
    expect(isAiNoiseSuppressionMode('gtcrn')).toBe(true);
    expect(isAiNoiseSuppressionMode('deepfilternet')).toBe(true);

    expect(isSampleRateCompatible('rnnoise', 48000)).toBe(true);
    expect(isSampleRateCompatible('rnnoise', 44100)).toBe(false);
    expect(isSampleRateCompatible('rnnoise', 16000)).toBe(false);

    expect(isSampleRateCompatible('gtcrn', 48000)).toBe(true);
    expect(isSampleRateCompatible('gtcrn', 16000)).toBe(true);
    expect(isSampleRateCompatible('gtcrn', 44100)).toBe(false);

    expect(isSampleRateCompatible('deepfilternet', 48000)).toBe(true);
    expect(isSampleRateCompatible('deepfilternet', 44100)).toBe(false);
    expect(isSampleRateCompatible('deepfilternet', 16000)).toBe(false);

    expect(NOISE_SUPPRESSION_OPTIONS.map((o) => o.id)).toEqual([
      'off',
      'standard',
      'rnnoise',
      'gtcrn',
      'deepfilternet',
    ]);
  });
});
