import { describe, expect, it } from 'vitest';
import { resolveAndroidCaptureParams } from './nativeScreenShare';

describe('resolveAndroidCaptureParams', () => {
  it('picks mobile-safe resolution, fps, and JPEG quality for motion vs detail', () => {
    expect(
      resolveAndroidCaptureParams({
        width: 1280,
        height: 720,
        frameRate: 30,
        maxBitrateBps: 2_500_000,
        contentHint: 'motion',
        includeAudio: false,
      }),
    ).toEqual({ maxDimension: 960, fps: 20, quality: 66 });

    expect(
      resolveAndroidCaptureParams({
        width: 1920,
        height: 1080,
        frameRate: 60,
        maxBitrateBps: 6_000_000,
        contentHint: 'detail',
        includeAudio: false,
      }),
    ).toEqual({ maxDimension: 1280, fps: 20, quality: 78 });
  });
});
