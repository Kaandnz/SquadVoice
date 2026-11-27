import {
  startNativeVoiceService,
  stopNativeVoiceService,
  updateNativeVoiceService,
} from './nativeVoiceService';

export interface MobileKeepAliveStartOptions {
  channelName: string;
  serverName: string;
  muted: boolean;
  deafened?: boolean;
  onToggleMute: () => void;
  onToggleDeafen?: () => void;
  onLeaveVoice: () => void;
  onResumeCall: () => void;
}

interface WakeLockSentinelLike {
  released?: boolean;
  release: () => Promise<void>;
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
}

interface MediaPositionStateLike {
  duration?: number;
  playbackRate?: number;
  position?: number;
}

interface NavigatorWithMobileApis {
  mediaSession?: {
    metadata: MediaMetadata | null;
    playbackState: 'none' | 'paused' | 'playing';
    setActionHandler?: (action: string, handler: (() => void) | null) => void;
    setMicrophoneActive?: (active: boolean) => void;
    setPositionState?: (state?: MediaPositionStateLike) => void;
  };
  wakeLock?: {
    request: (type: 'screen') => Promise<WakeLockSentinelLike>;
  };
}

/**
 * Duration of the generated keep-alive PCM WAV track in seconds.
 * Chromium's MediaSessionController requires >= 5 seconds to grant full Android
 * AudioFocus and display the persistent Lock Screen / Quick Settings media player card.
 * 15 seconds comfortably clears both Chrome Android and iOS Safari Now Playing rules.
 */
export const KEEP_ALIVE_WAV_DURATION_SEC = 15;
const KEEP_ALIVE_SAMPLE_RATE = 8000;
/**
 * 22 Hz pure sine wave: 22 * 15 = 330 exact integer cycles -> seamless loop with zero click.
 * Amplitude 200 / 32768 => RMS = -47.3 dBFS:
 * - Safely clears Chromium's AudioPowerMonitor (~ -50 dBFS) IsAudible check so Chrome does
 *   not optimize it away as digital silence or freeze the tab on screen lock.
 * - Completely inaudible on human ears, phone speakers, and headphones (ISO 226 hearing
 *   threshold at 22 Hz is ~75 dB SPL, and mobile speakers roll off sharply below 150 Hz).
 */
const KEEP_ALIVE_TONE_HZ = 22;
const KEEP_ALIVE_AMPLITUDE_INT16 = 200;

let cachedWavBuffer: ArrayBuffer | null = null;
let cachedSilentWavUrl: string | null = null;
let cachedWavObjectUrl: string | null = null;

/**
 * Builds a 15-second 8 kHz 16-bit mono PCM WAV buffer containing a seamless
 * inaudible 22 Hz sub-bass carrier (-47.3 dBFS) so Chrome Android & iOS Safari treat
 * the voice call as active background media and display the Lock Screen / Control Center card.
 */
export function buildKeepAliveWavBuffer(): ArrayBuffer {
  if (cachedWavBuffer) return cachedWavBuffer;

  const sampleRate = KEEP_ALIVE_SAMPLE_RATE;
  const numSamples = sampleRate * KEEP_ALIVE_WAV_DURATION_SEC;
  const dataBytes = numSamples * 2; // 16-bit signed little-endian PCM
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate (16-bit mono)
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(36, 'data');
  view.setUint32(40, dataBytes, true);

  const angularStep = (2 * Math.PI * KEEP_ALIVE_TONE_HZ) / sampleRate;
  for (let i = 0; i < numSamples; i += 1) {
    const sample = Math.round(KEEP_ALIVE_AMPLITUDE_INT16 * Math.sin(angularStep * i));
    view.setInt16(44 + i * 2, sample, true);
  }

  cachedWavBuffer = buffer;
  return buffer;
}

/**
 * Returns a base64 WAV data URI of the keep-alive carrier (used in tests and environments
 * without Blob URL support).
 */
export function createSilentWavDataUrl(): string {
  if (cachedSilentWavUrl) return cachedSilentWavUrl;

  const bytes = new Uint8Array(buildKeepAliveWavBuffer());
  let binary = '';
  const chunkSize = 0x4000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  cachedSilentWavUrl = `data:audio/wav;base64,${btoa(binary)}`;
  return cachedSilentWavUrl;
}

function getKeepAliveAudioUrl(): string {
  if (cachedWavObjectUrl) return cachedWavObjectUrl;
  if (typeof Blob !== 'undefined' && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
    try {
      cachedWavObjectUrl = URL.createObjectURL(
        new Blob([buildKeepAliveWavBuffer()], { type: 'audio/wav' }),
      );
      return cachedWavObjectUrl;
    } catch {
      // Fall back to data URI below
    }
  }
  return createSilentWavDataUrl();
}

function resolveArtworkUrl(path: string): string {
  try {
    if (typeof window !== 'undefined' && window.location?.origin && window.location.origin !== 'null') {
      return new URL(path, window.location.origin).href;
    }
  } catch {
    // Fall back to relative path
  }
  return path;
}

const REGISTERED_ACTIONS = [
  'togglemicrophone',
  'hangup',
  'stop',
  'play',
  'pause',
  'previoustrack',
  'nexttrack',
  'seekbackward',
  'seekforward',
  'seekto',
] as const;

export interface MobileKeepAliveEnv {
  nav?: NavigatorWithMobileApis;
  doc?: Document;
  win?: Window;
  createAudio?: () => HTMLAudioElement;
  resumeDebounceMs?: number;
}

/**
 * Keeps mobile web / PWA / native Android voice calls alive on screen-lock & app-switch
 * and displays a Spotify-style MediaSession control card in the Lock Screen / Control Center /
 * Android Quick Settings shade:
 * 1. MediaSession lock-screen & pull-down media card (with Mute/Play-Pause & Hangup actions)
 *    backed by a 15-second inaudible (-47 dBFS 22 Hz) WAV loop so Chrome Android & iOS Safari
 *    grant full media focus and keep the audio/WebRTC pipeline alive.
 * 2. Native Android Foreground Service with MediaStyle + MediaSession + WakeLock + WifiLock.
 * 3. Screen Wake Lock while the tab is foregrounded so the phone doesn't auto-sleep mid-call.
 * 4. Foreground & network resume listeners (visibilitychange, pageshow, online) + keep-alive
 *    audio auto-resume that recover WebRTC, mic, AudioContext, and Firebase RTDB immediately.
 */
export class MobileVoiceKeepAlive {
  private active = false;
  private opSeq = 0;
  private options: MobileKeepAliveStartOptions | null = null;

  private audioEl: HTMLAudioElement | null = null;
  private audioPauseListener: (() => void) | null = null;
  private wakeLock: WakeLockSentinelLike | null = null;
  private wakeLockReleaseListener: (() => void) | null = null;
  private resumeTimer: number | null = null;
  private keepAliveRetryTimer: number | null = null;

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
        // Volume MUST stay at 1.0 so the -47 dBFS carrier isn't attenuated below
        // Chromium's AudioPowerMonitor silence threshold (-50 dBFS).
        el.muted = false;
        el.volume = 1.0;
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
   * Starts the keep-alive <audio> element synchronously inside the user's tap/click
   * gesture (before async getUserMedia / Firebase awaits expire user activation on mobile).
   */
  primeKeepAliveAudio(): void {
    this.ensureKeepAliveAudio();
  }

  start(options: MobileKeepAliveStartOptions): void {
    this.options = { ...options, deafened: Boolean(options.deafened) };
    const wasActive = this.active;
    this.active = true;
    const seq = ++this.opSeq;

    this.ensureKeepAliveAudio();
    this.applyMediaSessionMetadata();
    this.registerMediaSessionHandlers();
    this.setMuted(options.muted, Boolean(options.deafened));
    this.setPlaybackState('playing');
    this.updatePositionState();

    if (!wasActive) {
      this.attachLifecycleListeners();
    }
    void this.acquireWakeLock(seq);
    void startNativeVoiceService({
      channelName: options.channelName,
      serverName: options.serverName,
      muted: options.muted,
      deafened: Boolean(options.deafened),
      onToggleMute: options.onToggleMute,
      onToggleDeafen: options.onToggleDeafen,
      onHangup: options.onLeaveVoice,
    });
  }

  updateMetadata(channelName: string, serverName: string): void {
    if (!this.active || !this.options) return;
    this.options = { ...this.options, channelName, serverName };
    this.applyMediaSessionMetadata();
    updateNativeVoiceService({ channelName, serverName });
  }

  setMuted(muted: boolean, deafened?: boolean): void {
    if (!this.active) return;
    const nextDeafened = deafened !== undefined ? deafened : Boolean(this.options?.deafened);
    if (this.options) {
      this.options = { ...this.options, muted, deafened: nextDeafened };
    }
    try {
      this.nav?.mediaSession?.setMicrophoneActive?.(!muted && !nextDeafened);
    } catch {
      // Ignore browsers without setMicrophoneActive
    }
    this.applyMediaSessionMetadata();
    updateNativeVoiceService({ muted, deafened: nextDeafened });
  }

  /** Re-attempts keep-alive playback (safe to invoke from a user-gesture unlock or post-getUserMedia). */
  ensureKeepAlivePlaying(): void {
    if (!this.active && !this.audioEl) return;
    this.ensureKeepAliveAudio();
    if (this.active) {
      this.setPlaybackState('playing');
      this.updatePositionState();
    }
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
    if (this.keepAliveRetryTimer !== null && this.win) {
      this.win.clearTimeout(this.keepAliveRetryTimer);
      this.keepAliveRetryTimer = null;
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

  private updatePositionState(): void {
    try {
      const setPos = this.nav?.mediaSession?.setPositionState;
      if (typeof setPos !== 'function') return;
      const duration = KEEP_ALIVE_WAV_DURATION_SEC;
      const rawPos = this.audioEl?.currentTime;
      const position =
        typeof rawPos === 'number' && Number.isFinite(rawPos) && rawPos >= 0 && rawPos <= duration
          ? rawPos
          : 0;
      setPos.call(this.nav!.mediaSession, {
        duration,
        playbackRate: 1,
        position,
      });
    } catch {
      // Ignore browsers that reject setPositionState
    }
  }

  private applyMediaSessionMetadata(): void {
    const ms = this.nav?.mediaSession;
    const opts = this.options;
    if (!ms || !opts) return;
    try {
      if (typeof MediaMetadata === 'function') {
        const channel = opts.channelName || 'Ses Kanalı';
        const server = opts.serverName || 'SquadVoice';
        const statusPrefix = opts.deafened ? '🔇 Sağır · ' : opts.muted ? '🔇 Sessiz · ' : '🎙️ ';
        const statusLabel = opts.deafened
          ? 'Kulaklık kapalı'
          : opts.muted
            ? 'Mikrofon sessiz'
            : 'Sesli sohbet aktif';
        ms.metadata = new MediaMetadata({
          title: `${statusPrefix}${channel}`,
          artist: `${server} · ${statusLabel}`,
          album: 'SquadVoice',
          artwork: [
            { src: resolveArtworkUrl('/icon-192.png'), sizes: '192x192', type: 'image/png' },
            { src: resolveArtworkUrl('/icon-512.png'), sizes: '512x512', type: 'image/png' },
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
    trySet('stop', () => {
      this.options?.onLeaveVoice();
    });
    trySet('play', () => {
      this.ensureKeepAlivePlaying();
      if (this.options?.muted) {
        this.options.onToggleMute();
      }
      this.options?.onResumeCall();
    });
    trySet('pause', () => {
      // On iOS Control Center / Android Media Shade, tapping Pause/Play acts as a quick
      // microphone Mute toggle while keeping the keep-alive stream playing so the OS
      // never freezes the tab or disconnects the voice call.
      this.options?.onToggleMute();
      this.ensureKeepAlivePlaying();
    });

    // Clear unused transport actions so the Lock Screen / Control Center stays clean
    for (const unused of ['previoustrack', 'nexttrack', 'seekbackward', 'seekforward', 'seekto']) {
      trySet(unused, null);
    }
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
      ms.setPositionState?.();
    } catch {
      // Ignore
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
        el.src = getKeepAliveAudioUrl();
        const onUnexpectedPause = () => {
          if (!this.active || !this.audioEl || this.audioEl !== el) return;
          // If iOS/Android pauses keep-alive audio after getUserMedia or a notification sound,
          // nudge it back so the Lock Screen media card and background audio stay alive.
          if (this.keepAliveRetryTimer !== null && this.win) {
            this.win.clearTimeout(this.keepAliveRetryTimer);
          }
          if (this.win) {
            this.keepAliveRetryTimer = this.win.setTimeout(() => {
              this.keepAliveRetryTimer = null;
              if (!this.active || !this.audioEl || !this.audioEl.paused) return;
              const p = this.audioEl.play();
              if (p && typeof p.catch === 'function') p.catch(() => {});
            }, 150);
          }
        };
        this.audioPauseListener = onUnexpectedPause;
        el.addEventListener?.('pause', onUnexpectedPause);
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
    const el = this.audioEl;
    const listener = this.audioPauseListener;
    this.audioEl = null;
    this.audioPauseListener = null;
    try {
      if (listener) {
        el.removeEventListener?.('pause', listener);
      }
      el.pause();
      el.removeAttribute('src');
      el.load();
      el.remove();
    } catch {
      // Ignore teardown errors
    }
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
    } else {
      // Going to background / screen lock: make sure the keep-alive media element & MediaSession
      // are actively playing right as the OS evaluates whether to suspend this tab.
      this.ensureKeepAlivePlaying();
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
    this.resumeTimer = this.win.setTimeout(() => {
      this.resumeTimer = null;
      if (!this.active) return;
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
