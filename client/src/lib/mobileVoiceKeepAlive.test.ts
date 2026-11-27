// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSilentWavDataUrl, MobileVoiceKeepAlive } from './mobileVoiceKeepAlive';

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
  });
  el.load = vi.fn();
  return el;
}

describe('createSilentWavDataUrl', () => {
  it('builds a valid 1-second 8 kHz PCM silent WAV data URI', () => {
    const uri = createSilentWavDataUrl();
    expect(uri.startsWith('data:audio/wav;base64,')).toBe(true);
    const raw = Buffer.from(uri.slice('data:audio/wav;base64,'.length), 'base64');
    expect(raw.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(raw.subarray(8, 12).toString('ascii')).toBe('WAVE');
    expect(raw.length).toBe(44 + 8000);
    expect(raw[44]).toBe(0x80);
    expect(raw[raw.length - 1]).toBe(0x80);
  });
});

describe('MobileVoiceKeepAlive', () => {
  let handlers: Map<string, (() => void) | null>;
  let wakeLockRequests: number;
  let wakeLockReleases: number;
  let fakeAudio: HTMLAudioElement;
  let setMicrophoneActive: ReturnType<typeof vi.fn>;
  let mediaSession: {
    metadata: MediaMetadata | null;
    playbackState: 'none' | 'paused' | 'playing';
    setActionHandler: (action: string, handler: (() => void) | null) => void;
    setMicrophoneActive: (active: boolean) => void;
  };
  let keepAlive: MobileVoiceKeepAlive;

  beforeEach(() => {
    vi.useFakeTimers();
    handlers = new Map();
    wakeLockRequests = 0;
    wakeLockReleases = 0;
    fakeAudio = makeFakeAudio();
    setMicrophoneActive = vi.fn();

    mediaSession = {
      metadata: null,
      playbackState: 'none',
      setActionHandler: (action, handler) => {
        handlers.set(action, handler);
      },
      setMicrophoneActive,
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

  it('activates MediaSession call controls, silent keep-alive audio, and WakeLock on start', async () => {
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
    expect(fakeAudio.play).toHaveBeenCalledTimes(1);
    expect(wakeLockRequests).toBe(1);

    // Lock-screen call actions work
    handlers.get('togglemicrophone')?.();
    expect(onToggleMute).toHaveBeenCalledTimes(1);

    handlers.get('hangup')?.();
    expect(onLeaveVoice).toHaveBeenCalledTimes(1);

    // Mute sync updates MediaSession mic indicator
    keepAlive.setMuted(true);
    expect(setMicrophoneActive).toHaveBeenLastCalledWith(false);

    // Stop tears down MediaSession, silent audio, and WakeLock cleanly
    keepAlive.stop();
    await Promise.resolve();
    expect(keepAlive.isActive()).toBe(false);
    expect(mediaSession.playbackState).toBe('none');
    expect(handlers.get('togglemicrophone')).toBeNull();
    expect(handlers.get('hangup')).toBeNull();
    expect(fakeAudio.pause).toHaveBeenCalled();
    expect(wakeLockReleases).toBe(1);
  });

  it('re-acquires WakeLock and runs debounced call recovery when returning from background or coming online', async () => {
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

    // Simulate OS pausing audio and releasing wake lock when tab goes hidden
    fakeAudio.pause();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));

    // Return to foreground + network online fires together -> coalesced into one recovery pass
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('online'));

    expect(onResumeCall).not.toHaveBeenCalled();
    vi.advanceTimersByTime(250);

    expect(onResumeCall).toHaveBeenCalledTimes(1);
    expect(fakeAudio.play).toHaveBeenCalledTimes(2);
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
