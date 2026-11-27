// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildKeepAliveWavBuffer,
  createSilentWavDataUrl,
  KEEP_ALIVE_WAV_DURATION_SEC,
  MobileVoiceKeepAlive,
} from './mobileVoiceKeepAlive';

function makeFakeAudio() {
  const el = document.createElement('audio');
  let paused = true;
  Object.defineProperty(el, 'paused', {
    configurable: true,
    get: () => paused,
  });
  el.play = vi.fn(() => {
    paused = false;
    return Promise.resolve();
  });
  el.pause = vi.fn(() => {
    paused = true;
    el.dispatchEvent(new Event('pause'));
  });
  el.load = vi.fn();
  return el;
}

describe('buildKeepAliveWavBuffer & createSilentWavDataUrl', () => {
  it('builds a valid 15-second 8 kHz 16-bit PCM WAV above Chromium duration and audibility minimums', () => {
    const buf = buildKeepAliveWavBuffer();
    const raw = Buffer.from(buf);
    const view = new DataView(buf);
    expect(raw.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(raw.subarray(8, 12).toString('ascii')).toBe('WAVE');

    const sampleRate = view.getUint32(24, true);
    const bitsPerSample = view.getUint16(34, true);
    const dataBytes = view.getUint32(40, true);
    expect(sampleRate).toBe(8000);
    expect(bitsPerSample).toBe(16);
    expect(dataBytes).toBe(sampleRate * KEEP_ALIVE_WAV_DURATION_SEC * 2);
    expect(KEEP_ALIVE_WAV_DURATION_SEC).toBeGreaterThanOrEqual(5);

    // Verify RMS is above Chromium's -50 dBFS silence threshold yet completely inaudible (< -40 dBFS)
    let sumSq = 0;
    const totalSamples = dataBytes / 2;
    for (let i = 0; i < totalSamples; i += 1) {
      const normalized = view.getInt16(44 + i * 2, true) / 32768;
      sumSq += normalized * normalized;
    }
    const rmsDb = 20 * Math.log10(Math.sqrt(sumSq / totalSamples));
    expect(rmsDb).toBeGreaterThan(-50);
    expect(rmsDb).toBeLessThan(-40);

    const uri = createSilentWavDataUrl();
    expect(uri.startsWith('data:audio/wav;base64,')).toBe(true);
  });
});

describe('MobileVoiceKeepAlive', () => {
  let handlers: Map<string, (() => void) | null>;
  let wakeLockRequests: number;
  let wakeLockReleases: number;
  let fakeAudio: HTMLAudioElement;
  let setMicrophoneActive: ReturnType<typeof vi.fn>;
  let setPositionState: ReturnType<typeof vi.fn>;
  let mediaSession: {
    metadata: MediaMetadata | null;
    playbackState: 'none' | 'paused' | 'playing';
    setActionHandler: (action: string, handler: (() => void) | null) => void;
    setMicrophoneActive: (active: boolean) => void;
    setPositionState: (state?: { duration?: number; playbackRate?: number; position?: number }) => void;
  };
  let keepAlive: MobileVoiceKeepAlive;

  beforeEach(() => {
    vi.useFakeTimers();
    handlers = new Map();
    wakeLockRequests = 0;
    wakeLockReleases = 0;
    fakeAudio = makeFakeAudio();
    setMicrophoneActive = vi.fn();
    setPositionState = vi.fn();

    mediaSession = {
      metadata: null,
      playbackState: 'none',
      setActionHandler: (action, handler) => {
        handlers.set(action, handler);
      },
      setMicrophoneActive,
      setPositionState,
    };

    const wakeLock = {
      request: vi.fn(async () => {
        wakeLockRequests += 1;
        return {
          released: false,
          release: async () => {
            wakeLockReleases += 1;
          },
          addEventListener: () => {},
          removeEventListener: () => {},
        };
      }),
    };

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });

    keepAlive = new MobileVoiceKeepAlive({
      nav: { mediaSession, wakeLock },
      doc: document,
      win: window,
      createAudio: () => fakeAudio,
      resumeDebounceMs: 200,
    });
  });

  afterEach(() => {
    keepAlive.stop();
    vi.useRealTimers();
  });

  it('activates MediaSession lock-screen controls, position state, keep-alive audio, and WakeLock on start', async () => {
    const onToggleMute = vi.fn();
    const onLeaveVoice = vi.fn();
    const onResumeCall = vi.fn();

    keepAlive.start({
      channelName: 'Oyun Odası',
      serverName: 'SquadVoice',
      muted: false,
      onToggleMute,
      onLeaveVoice,
      onResumeCall,
    });
    await Promise.resolve();

    expect(keepAlive.isActive()).toBe(true);
    expect(mediaSession.playbackState).toBe('playing');
    expect(setMicrophoneActive).toHaveBeenCalledWith(true);
    expect(setPositionState).toHaveBeenCalledWith(
      expect.objectContaining({ duration: KEEP_ALIVE_WAV_DURATION_SEC, playbackRate: 1 }),
    );
    expect(fakeAudio.play).toHaveBeenCalledTimes(1);
    expect(wakeLockRequests).toBe(1);

    // Lock-screen Spotify-style Play/Pause & call actions work without pausing keep-alive audio
    handlers.get('togglemicrophone')?.();
    expect(onToggleMute).toHaveBeenCalledTimes(1);

    handlers.get('pause')?.();
    expect(onToggleMute).toHaveBeenCalledTimes(2);
    expect(mediaSession.playbackState).toBe('playing');

    handlers.get('hangup')?.();
    expect(onLeaveVoice).toHaveBeenCalledTimes(1);

    handlers.get('stop')?.();
    expect(onLeaveVoice).toHaveBeenCalledTimes(2);

    // Mute sync updates MediaSession mic indicator
    keepAlive.setMuted(true);
    expect(setMicrophoneActive).toHaveBeenLastCalledWith(false);

    // Stop tears down MediaSession, keep-alive audio, and WakeLock cleanly
    keepAlive.stop();
    await Promise.resolve();
    expect(keepAlive.isActive()).toBe(false);
    expect(mediaSession.playbackState).toBe('none');
    expect(handlers.get('togglemicrophone')).toBeNull();
    expect(handlers.get('hangup')).toBeNull();
    expect(handlers.get('stop')).toBeNull();
    expect(fakeAudio.pause).toHaveBeenCalled();
    expect(wakeLockReleases).toBe(1);
  });

  it('auto-resumes keep-alive audio if OS pauses it mid-call and recovers call on foreground resume', async () => {
    const onResumeCall = vi.fn();

    keepAlive.start({
      channelName: 'Genel Ses',
      serverName: 'SquadVoice',
      muted: false,
      onToggleMute: vi.fn(),
      onLeaveVoice: vi.fn(),
      onResumeCall,
    });
    await Promise.resolve();
    expect(fakeAudio.play).toHaveBeenCalledTimes(1);

    // Simulate OS pausing audio when going to background / screen lock
    fakeAudio.pause();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    // Visibility -> hidden immediately nudges keep-alive audio back on
    expect(fakeAudio.play).toHaveBeenCalledTimes(2);

    // Return to foreground + network online fires together -> coalesced into one recovery pass
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('online'));

    expect(onResumeCall).not.toHaveBeenCalled();
    vi.advanceTimersByTime(250);

    expect(onResumeCall).toHaveBeenCalledTimes(1);
  });

  it('releases a late-resolving WakeLock if the user already left voice', async () => {
    let resolveSentinel!: (s: { released: boolean; release: () => Promise<void> }) => void;
    const lateRelease = vi.fn(async () => {});
    const slowKeepAlive = new MobileVoiceKeepAlive({
      nav: {
        mediaSession,
        wakeLock: {
          request: () =>
            new Promise((resolve) => {
              resolveSentinel = resolve;
            }),
        },
      },
      doc: document,
      win: window,
      createAudio: () => makeFakeAudio(),
    });

    slowKeepAlive.start({
      channelName: 'Oda',
      serverName: 'Squad',
      muted: false,
      onToggleMute: vi.fn(),
      onLeaveVoice: vi.fn(),
      onResumeCall: vi.fn(),
    });
    slowKeepAlive.stop();

    resolveSentinel({ released: false, release: lateRelease });
    await Promise.resolve();
    expect(lateRelease).toHaveBeenCalledTimes(1);
  });

  it('cleans up primed keep-alive audio even if stop is called before start', () => {
    keepAlive.primeKeepAliveAudio();
    expect(fakeAudio.play).toHaveBeenCalledTimes(1);

    keepAlive.stop();
    expect(fakeAudio.pause).toHaveBeenCalledTimes(1);
  });
});
