import {
  startNativeVoiceService,
  stopNativeVoiceService,
  updateNativeVoiceService,
} from './nativeVoiceService';

export interface MobileKeepAliveStartOptions {
  channelName: string;
  serverName: string;
  muted: boolean;
  onToggleMute: () => void;
  onLeaveVoice: () => void;
  onResumeCall: () => void;
}

interface WakeLockSentinelLike {
  released?: boolean;
  release: () => Promise<void>;
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
}

interface NavigatorWithMobileApis {
  mediaSession?: {
    metadata: MediaMetadata | null;
    playbackState: 'none' | 'paused' | 'playing';
    setActionHandler?: (action: string, handler: (() => void) | null) => void;
    setMicrophoneActive?: (active: boolean) => void;
  };
  wakeLock?: {
    request: (type: 'screen') => Promise<WakeLockSentinelLike>;
  };
}

let cachedSilentWavUrl: string | null = null;

/**
 * Generates a tiny 1-second 8 kHz 8-bit mono PCM WAV filled with digital silence (0x80).
 * Chrome Android / iOS Safari require a real actively-playing audio track (>= ~0.5s) to
 * keep the MediaSession lock-screen notification and renderer audio thread alive even
 * when everyone else in the voice room is quiet.
 */
export function createSilentWavDataUrl(): string {
  if (cachedSilentWavUrl) return cachedSilentWavUrl;

  const sampleRate = 8000;
  const numSamples = sampleRate; // 1 second
  const buffer = new ArrayBuffer(44 + numSamples);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + numSamples, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate, true); // byte rate (8-bit mono)
  view.setUint16(32, 1, true); // block align
  view.setUint16(34, 8, true); // bits per sample
  writeAscii(36, 'data');
  view.setUint32(40, numSamples, true);
  bytes.fill(0x80, 44); // unsigned 8-bit silence

  let binary = '';
  const chunkSize = 0x1000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  cachedSilentWavUrl = `data:audio/wav;base64,${btoa(binary)}`;
  return cachedSilentWavUrl;
}

const REGISTERED_ACTIONS = ['togglemicrophone', 'hangup', 'play', 'pause'] as const;

export interface MobileKeepAliveEnv {
  nav?: NavigatorWithMobileApis;
  doc?: Document;
  win?: Window;
  createAudio?: () => HTMLAudioElement;
  resumeDebounceMs?: number;
}

/**
 * Keeps mobile web / PWA voice calls alive as long as the OS permits and recovers
 * audio/mic/WebRTC immediately when returning from background or screen-lock:
 * 1. MediaSession lock-screen / notification call card (with Mute & Hangup actions)
 *    backed by an inaudible 1s silent WAV loop so Android Chrome keeps the tab prioritized.
 * 2. Screen Wake Lock while the tab is foregrounded so the phone doesn't auto-sleep mid-call.
 * 3. Foreground & network resume listeners (visibilitychange, pageshow, online) that
 *    re-acquire Wake Lock and invoke the caller's audio/mic/ICE recovery hook.
 */
export class MobileVoiceKeepAlive {
  private active = false;
  private opSeq = 0;
  private options: MobileKeepAliveStartOptions | null = null;

  private audioEl: HTMLAudioElement | null = null;
  private wakeLock: WakeLockSentinelLike | null = null;
  private wakeLockReleaseListener: (() => void) | null = null;
  private resumeTimer: number | null = null;

  private readonly nav: NavigatorWithMobileApis | undefined;
  private readonly doc: Document | undefined;
  private readonly win: Window | undefined;
  private readonly createAudio: () => HTMLAudioElement;
  private readonly resumeDebounceMs: number;

  constructor(env: MobileKeepAliveEnv = {}) {
    this.nav =
      env.nav ?? (typeof navigator !== 'undefined' ? (navigator as NavigatorWithMobileApis) : undefined);
    this.doc = env.doc ?? (typeof document !== 'undefined' ? document : undefined);
    this.win = env.win ?? (typeof window !== 'undefined' ? window : undefined);
    this.createAudio =
      env.createAudio ??
      (() => {
        const el = this.doc!.createElement('audio');
        el.loop = true;
        el.preload = 'auto';
        el.setAttribute('playsinline', 'true');
        el.setAttribute('webkit-playsinline', 'true');
        // Must stay unmuted with minimal volume so Android/iOS activate MediaSession;
        // the PCM samples are pure digital zeros (0x80) so output is completely silent.
        el.muted = false;
        el.volume = 0.001;
        el.style.position = 'fixed';
        el.style.left = '-9999px';
        el.style.width = '1px';
        el.style.height = '1px';
        el.style.opacity = '0.01';
        el.style.pointerEvents = 'none';
        return el;
      });
    this.resumeDebounceMs = env.resumeDebounceMs ?? 250;
  }

  isActive(): boolean {
    return this.active;
  }

  /**
   * Starts the silent keep-alive <audio> element synchronously inside the user's tap/click
   * gesture (before async getUserMedia / Firebase awaits expire user activation on mobile).
   */
  primeKeepAliveAudio(): void {
    this.ensureKeepAliveAudio();
  }

  start(options: MobileKeepAliveStartOptions): void {
    this.options = options;
    const wasActive = this.active;
    this.active = true;
    const seq = ++this.opSeq;

    this.ensureKeepAliveAudio();
    this.applyMediaSessionMetadata(options.channelName, options.serverName);
    this.registerMediaSessionHandlers();
    this.setMuted(options.muted);
    this.setPlaybackState('playing');

    if (!wasActive) {
      this.attachLifecycleListeners();
    }
    void this.acquireWakeLock(seq);
    void startNativeVoiceService({
      channelName: options.channelName,
      serverName: options.serverName,
      muted: options.muted,
      onToggleMute: options.onToggleMute,
      onHangup: options.onLeaveVoice,
    });
  }

  updateMetadata(channelName: string, serverName: string): void {
    if (!this.active || !this.options) return;
    this.options = { ...this.options, channelName, serverName };
    this.applyMediaSessionMetadata(channelName, serverName);
    updateNativeVoiceService({ channelName, serverName });
  }

  setMuted(muted: boolean): void {
    if (!this.active) return;
    if (this.options) {
      this.options = { ...this.options, muted };
    }
    try {
      this.nav?.mediaSession?.setMicrophoneActive?.(!muted);
    } catch {
      // Ignore browsers without setMicrophoneActive
    }
    updateNativeVoiceService({ muted });
  }

  /** Re-attempts silent keep-alive playback (safe to invoke from a user-gesture unlock). */
  ensureKeepAlivePlaying(): void {
    if (!this.active) return;
    this.ensureKeepAliveAudio();
    this.setPlaybackState('playing');
  }

  stop(): void {
    if (!this.active && !this.audioEl && !this.wakeLock) return;
    this.active = false;
    this.opSeq += 1;
    this.options = null;

    if (this.resumeTimer !== null && this.win) {
      this.win.clearTimeout(this.resumeTimer);
      this.resumeTimer = null;
    }

    this.detachLifecycleListeners();
    this.teardownKeepAliveAudio();
    this.clearMediaSession();
    this.releaseWakeLock();
    stopNativeVoiceService();
  }

  private setPlaybackState(state: 'none' | 'paused' | 'playing'): void {
    try {
      if (this.nav?.mediaSession) {
        this.nav.mediaSession.playbackState = state;
      }
    } catch {
      // Ignore read-only/unsupported playbackState
    }
  }

  private applyMediaSessionMetadata(channelName: string, serverName: string): void {
    const ms = this.nav?.mediaSession;
    if (!ms) return;
    try {
      if (typeof MediaMetadata === 'function') {
        ms.metadata = new MediaMetadata({
          title: channelName || 'Ses Kanalı',
          artist: serverName || 'SquadVoice',
          album: 'SquadVoice Sesli Sohbet',
          artwork: [
            { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          ],
        });
      }
    } catch {
      // Ignore MediaMetadata errors in headless/older browsers
    }
  }

  private registerMediaSessionHandlers(): void {
    const ms = this.nav?.mediaSession;
    if (!ms?.setActionHandler) return;

    const trySet = (action: string, handler: (() => void) | null) => {
      try {
        ms.setActionHandler?.(action, handler);
      } catch {
        // Browsers throw TypeError for unsupported MediaSession actions
      }
    };

    trySet('togglemicrophone', () => {
      this.options?.onToggleMute();
    });
    trySet('hangup', () => {
      this.options?.onLeaveVoice();
    });
    trySet('play', () => {
      this.ensureKeepAlivePlaying();
      this.options?.onResumeCall();
    });
    trySet('pause', () => {
      // Keep the voice call active rather than letting an accidental headset/lockscreen
      // pause silence remote friends; mute/hangup controls handle call actions explicitly.
      this.setPlaybackState('playing');
    });
  }

  private clearMediaSession(): void {
    const ms = this.nav?.mediaSession;
    if (!ms) return;
    for (const action of REGISTERED_ACTIONS) {
      try {
        ms.setActionHandler?.(action, null);
      } catch {
        // Ignore unsupported actions
      }
    }
    try {
      ms.metadata = null;
    } catch {
      // Ignore
    }
    this.setPlaybackState('none');
  }

  private ensureKeepAliveAudio(): void {
    if (!this.doc) return;
    try {
      if (!this.audioEl) {
        const el = this.createAudio();
        el.src = createSilentWavDataUrl();
        this.doc.body?.appendChild(el);
        this.audioEl = el;
      }
      if (this.audioEl.paused) {
        const playPromise = this.audioEl.play();
        if (playPromise && typeof playPromise.catch === 'function') {
          playPromise.catch(() => {});
        }
      }
    } catch {
      // Ignore audio element creation/playback failures in non-browser environments
    }
  }

  private teardownKeepAliveAudio(): void {
    if (!this.audioEl) return;
    try {
      this.audioEl.pause();
      this.audioEl.removeAttribute('src');
      this.audioEl.load();
      this.audioEl.remove();
    } catch {
      // Ignore teardown errors
    }
    this.audioEl = null;
  }

  private async acquireWakeLock(seq: number): Promise<void> {
    if (!this.active || seq !== this.opSeq) return;
    if (this.doc && this.doc.visibilityState === 'hidden') return;
    if (this.wakeLock && !this.wakeLock.released) return;
    const request = this.nav?.wakeLock?.request;
    if (typeof request !== 'function') return;

    try {
      const sentinel = await request.call(this.nav!.wakeLock, 'screen');
      if (!this.active || seq !== this.opSeq) {
        sentinel.release().catch(() => {});
        return;
      }
      this.wakeLock = sentinel;
      const onRelease = () => {
        if (this.wakeLock === sentinel) {
          this.wakeLock = null;
          this.wakeLockReleaseListener = null;
        }
      };
      this.wakeLockReleaseListener = onRelease;
      sentinel.addEventListener?.('release', onRelease);
    } catch {
      // Battery saver, denied permission, or unsupported environment
    }
  }

  private releaseWakeLock(): void {
    const sentinel = this.wakeLock;
    const listener = this.wakeLockReleaseListener;
    this.wakeLock = null;
    this.wakeLockReleaseListener = null;
    if (!sentinel) return;
    if (listener) {
      sentinel.removeEventListener?.('release', listener);
    }
    sentinel.release().catch(() => {});
  }

  private readonly handleVisibilityChange = () => {
    if (!this.active || !this.doc) return;
    if (this.doc.visibilityState === 'visible') {
      void this.acquireWakeLock(this.opSeq);
      this.scheduleResume();
    }
  };

  private readonly handlePageShow = (event: PageTransitionEvent) => {
    if (!this.active) return;
    if (event.persisted || this.doc?.visibilityState === 'visible') {
      void this.acquireWakeLock(this.opSeq);
      this.scheduleResume();
    }
  };

  private readonly handleOnline = () => {
    if (!this.active) return;
    this.scheduleResume();
  };

  private scheduleResume(): void {
    if (!this.active || !this.win) return;
    if (this.resumeTimer !== null) {
      this.win.clearTimeout(this.resumeTimer);
    }
    const seq = this.opSeq;
    this.resumeTimer = this.win.setTimeout(() => {
      this.resumeTimer = null;
      if (!this.active || seq !== this.opSeq) return;
      this.ensureKeepAlivePlaying();
      this.options?.onResumeCall();
    }, this.resumeDebounceMs);
  }

  private attachLifecycleListeners(): void {
    this.doc?.addEventListener('visibilitychange', this.handleVisibilityChange);
    this.win?.addEventListener('pageshow', this.handlePageShow);
    this.win?.addEventListener('online', this.handleOnline);
  }

  private detachLifecycleListeners(): void {
    this.doc?.removeEventListener('visibilitychange', this.handleVisibilityChange);
    this.win?.removeEventListener('pageshow', this.handlePageShow);
    this.win?.removeEventListener('online', this.handleOnline);
  }
}

export const mobileVoiceKeepAlive = new MobileVoiceKeepAlive();
