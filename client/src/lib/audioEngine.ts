import type { AudioSettings, InputSensitivityMode } from '../types/protocol';
import {
  autoGateThreshold,
  effectiveGateMode,
  evaluateNoiseGate,
  INITIAL_NOISE_FLOOR_DB,
  levelDb,
  limiterMakeupGain,
  meterPercent,
  METER_FLOOR_DB,
  trackNoiseFloor,
  type GateState,
} from './audioGate';
import {
  enterCallAudioSession,
  leaveCallAudioSession,
  prepareAudioSessionForMic,
} from './audioSession';

/** How often the mic level / noise gate is evaluated (ms). */
const GATE_TICK_MS = 20;

const BOOST_LIMITER_THRESHOLD_DB = -3;
const BOOST_LIMITER_RATIO = 20;
const BOOST_LIMITER_MAKEUP = limiterMakeupGain(BOOST_LIMITER_THRESHOLD_DB, BOOST_LIMITER_RATIO);

const IS_MOBILE =
  typeof navigator !== 'undefined' &&
  /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

interface RemotePeerAudio {
  stream: MediaStream;
  audioEl: HTMLAudioElement;
  sourceNode: MediaStreamAudioSourceNode | null;
  gainNode: GainNode | null;
  limiterNode: DynamicsCompressorNode | null;
  volume: number; // 0.0 to 2.0
}

interface RemoteScreenAudio {
  stream: MediaStream;
  trackId: string;
  audioEl: HTMLAudioElement;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private hostContainer: HTMLDivElement | null = null;
  private micStream: MediaStream | null = null;
  private vadSource: MediaStreamAudioSourceNode | null = null;
  private vadAnalyser: AnalyserNode | null = null;
  private vadTimer: number | null = null;
  private gateState: GateState = { open: false, hangoverUntil: 0 };
  private micTransmissionEnabled = true;
  private currentlySpeaking = false;
  private deafened = false;
  private outputDeviceId = 'default';

  private remotePeers = new Map<string, RemotePeerAudio>();
  private peerVolumes = new Map<string, number>();
  private screenAudioPeers = new Map<string, RemoteScreenAudio>();
  private activeScreenUserId: string | null = null;
  private screenVolume = 0.8;
  private screenMuted = false;

  private onSpeakingChange: (speaking: boolean) => void;
  private onMicLevel: (level: number) => void;
  private onAutoplayBlocked: (blocked: boolean) => void;
  private onMicLost: (() => void) | null = null;
  private onMicTestStopped: (() => void) | null = null;
  private micTest: {
    ownStream: MediaStream | null;
    source: MediaStreamAudioSourceNode;
    gain: GainNode;
    analyser: AnalyserNode | null;
    timer: number | null;
  } | null = null;

  // Input sensitivity / noise gate. The gate switches the SENT track on and off
  // (track.enabled), so the browser's native AEC/NS/AGC pipeline stays untouched.
  private gateMode: InputSensitivityMode = 'auto';
  private manualThresholdDb = -50;
  private noiseFloorDb = INITIAL_NOISE_FLOOR_DB;
  private lastGateTickMs = 0;
  /** Clone of the mic track used only for measuring, so a closed gate can still hear you. */
  private vadTapTrack: MediaStreamTrack | null = null;
  /** False if level metering couldn't be set up: then the gate never blocks (fail open). */
  private vadAvailable = false;
  private onGateThreshold: ((meterPct: number) => void) | null = null;
  private lastReportedThresholdPct = -1;

  constructor(callbacks: {
    onSpeakingChange: (speaking: boolean) => void;
    onMicLevel: (level: number) => void;
    onAutoplayBlocked: (blocked: boolean) => void;
    /** Current gate threshold on the 0..100 meter scale (moves in auto mode). */
    onGateThreshold?: (meterPct: number) => void;
  }) {
    this.onSpeakingChange = callbacks.onSpeakingChange;
    this.onMicLevel = callbacks.onMicLevel;
    this.onAutoplayBlocked = callbacks.onAutoplayBlocked;
    this.onGateThreshold = callbacks.onGateThreshold ?? null;
  }

  private ensureContext(): AudioContext {
    if (!this.ctx) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      try {
        this.ctx = new AudioCtx({ latencyHint: 'balanced' });
      } catch {
        this.ctx = new AudioCtx();
      }
    }
    return this.ctx;
  }

  private ensureHostContainer(): HTMLDivElement | null {
    if (typeof document === 'undefined' || !document.body) return null;
    if (!this.hostContainer) {
      const existing = document.getElementById('squadvoice-audio-host') as HTMLDivElement | null;
      if (existing) {
        this.hostContainer = existing;
      } else {
        const div = document.createElement('div');
        div.id = 'squadvoice-audio-host';
        // Off-screen instead of display:none so iOS Safari / WebKit never suppresses audio playback
        div.style.position = 'fixed';
        div.style.left = '-9999px';
        div.style.top = '0';
        div.style.width = '1px';
        div.style.height = '1px';
        div.style.opacity = '0.01';
        div.style.pointerEvents = 'none';
        div.style.overflow = 'hidden';
        document.body.appendChild(div);
        this.hostContainer = div;
      }
    }
    return this.hostContainer;
  }

  private checkAutoplayState() {
    let anyBlocked = false;
    for (const peer of this.remotePeers.values()) {
      const effective = this.deafened ? 0 : peer.volume;
      if (effective > 0 && peer.audioEl.paused) {
        anyBlocked = true;
        break;
      }
    }
    if (!anyBlocked && this.activeScreenUserId) {
      const screen = this.screenAudioPeers.get(this.activeScreenUserId);
      const effective = !this.deafened && !this.screenMuted ? this.screenVolume : 0;
      if (screen && effective > 0 && screen.audioEl.paused) {
        anyBlocked = true;
      }
    }
    this.onAutoplayBlocked(anyBlocked);
  }

  async unlockAudio(): Promise<boolean> {
    let allPlayed = true;
    try {
      const ctx = this.ensureContext();
      if (ctx.state === 'suspended') {
        await ctx.resume().catch(() => {});
      }
    } catch {
      // Ignore context errors on mobile
    }

    if (this.micStream) {
      enterCallAudioSession();
    }

    for (const peer of this.remotePeers.values()) {
      try {
        await peer.audioEl.play();
      } catch {
        allPlayed = false;
      }
    }

    for (const [uid, entry] of this.screenAudioPeers.entries()) {
      const isActiveUnmuted =
        uid === this.activeScreenUserId &&
        !this.deafened &&
        !this.screenMuted &&
        this.screenVolume > 0;
      try {
        await entry.audioEl.play();
      } catch {
        if (isActiveUnmuted) {
          allPlayed = false;
        }
      }
    }

    this.onAutoplayBlocked(!allPlayed);
    return allPlayed;
  }

  async setOutputDevice(deviceId: string) {
    this.outputDeviceId = deviceId || 'default';
    const sinkId = !deviceId || deviceId === 'default' ? '' : deviceId;
    const ctx = this.ctx as (AudioContext & { setSinkId?: (id: string) => Promise<void> }) | null;
    if (ctx && typeof ctx.setSinkId === 'function') {
      await ctx.setSinkId(sinkId).catch(() => {});
    }
    for (const peer of this.remotePeers.values()) {
      const el = peer.audioEl as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
      if (typeof el.setSinkId === 'function') {
        await el.setSinkId(sinkId).catch(() => {});
      }
    }
    for (const entry of this.screenAudioPeers.values()) {
      const el = entry.audioEl as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
      if (typeof el.setSinkId === 'function') {
        await el.setSinkId(sinkId).catch(() => {});
      }
    }
  }

  /** Applies the input-sensitivity settings (push-to-talk bypasses the gate). */
  applySensitivity(settings: Pick<AudioSettings, 'pttEnabled' | 'inputSensitivity' | 'gateThresholdDb'>) {
    this.gateMode = effectiveGateMode(settings);
    this.manualThresholdDb = Math.max(METER_FLOOR_DB, Math.min(0, settings.gateThresholdDb));
    this.reportThreshold();
    this.applySentTrackEnabled();
  }

  /** Threshold in dBFS the gate opens at right now. */
  currentThresholdDb(): number {
    return this.gateMode === 'manual' ? this.manualThresholdDb : autoGateThreshold(this.noiseFloorDb);
  }

  private reportThreshold() {
    const pct = meterPercent(this.currentThresholdDb());
    if (pct !== this.lastReportedThresholdPct) {
      this.lastReportedThresholdPct = pct;
      this.onGateThreshold?.(pct);
    }
  }

  /** Feeds one level measurement through noise-floor tracking and the gate. */
  private processLevel(db: number, nowMs: number) {
    const dt = this.lastGateTickMs ? nowMs - this.lastGateTickMs : GATE_TICK_MS;
    this.lastGateTickMs = nowMs;
    this.noiseFloorDb = trackNoiseFloor(this.noiseFloorDb, db, dt);
    this.gateState = evaluateNoiseGate(this.gateState, db, this.currentThresholdDb(), nowMs);
    this.reportThreshold();
  }

  /**
   * Whether sound may go out right now. Fails open: if we can't measure (no metering,
   * suspended AudioContext after an iOS interruption) we'd rather send background noise
   * than silently drop someone's voice.
   */
  private gateAllowsSound(): boolean {
    if (this.gateMode === 'off') return true;
    const measuring = this.vadAvailable && this.ctx?.state === 'running';
    return !measuring || this.gateState.open;
  }

  private applySentTrackEnabled() {
    if (!this.micStream) return;
    const allow = this.micTransmissionEnabled && this.gateAllowsSound();
    for (const track of this.micStream.getAudioTracks()) {
      if (track.enabled !== allow) track.enabled = allow;
    }
  }

  async acquireMic(
    settings: AudioSettings,
    options?: { settleMs?: number },
  ): Promise<MediaStream> {
    this.stopMic();
    this.gateMode = effectiveGateMode(settings);
    this.manualThresholdDb = Math.max(METER_FLOOR_DB, Math.min(0, settings.gateThresholdDb));

    if (options?.settleMs && options.settleMs > 0) {
      await new Promise((r) => window.setTimeout(r, options.settleMs));
    }

    const stream = await this.openMicStream(settings);

    // Transmit the direct native getUserMedia stream so WebRTC uses native C++ AEC3 / NS / AGC
    this.micStream = stream;
    for (const track of stream.getAudioTracks()) {
      // Unplugged headset / revoked device: let the app pick another mic
      track.addEventListener('ended', () => {
        if (this.micStream === stream) this.onMicLost?.();
      });
    }
    this.setMicEnabled(this.micTransmissionEnabled);
    this.setupVad(stream);
    if (settings.outputDeviceId) {
      this.setOutputDevice(settings.outputDeviceId).catch(() => {});
    }
    return stream;
  }

  /** Called when the live mic track ends on its own (device unplugged). */
  setMicLostHandler(handler: (() => void) | null) {
    this.onMicLost = handler;
  }

  /** The live mic track, if any (for device-change checks). */
  getMicTrack(): MediaStreamTrack | null {
    return this.micStream?.getAudioTracks()[0] ?? null;
  }

  isMicTestRunning(): boolean {
    return this.micTest !== null;
  }

  /**
   * Plays your own microphone back to you (like Discord's "Let's Check") with a live level.
   * In a call it uses the very track friends receive, processing included; otherwise it
   * opens the selected mic just for the test.
   */
  async startMicTest(settings: AudioSettings): Promise<void> {
    this.stopMicTest();
    const ctx = this.ensureContext();
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});

    const liveCallMic =
      this.micStream?.getAudioTracks().some((t) => t.readyState === 'live') ?? false;
    const ownStream = liveCallMic ? null : await this.openMicStream(settings);
    const stream = ownStream ?? this.micStream;
    if (!stream) throw new Error('Mikrofon açılamadı');

    const source = ctx.createMediaStreamSource(stream);
    const gain = ctx.createGain();
    gain.gain.value = 1;
    source.connect(gain);
    gain.connect(ctx.destination);

    let analyser: AnalyserNode | null = null;
    let timer: number | null = null;
    if (ownStream) {
      // Outside a call the VAD loop isn't running: meter the mic ourselves and apply the
      // same gate to the playback, so you hear exactly what friends would receive.
      this.gateMode = effectiveGateMode(settings);
      this.manualThresholdDb = Math.max(METER_FLOOR_DB, Math.min(0, settings.gateThresholdDb));
      analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      const buf = new Float32Array(analyser.fftSize);
      const tap = analyser;
      timer = window.setInterval(() => {
        tap.getFloatTimeDomainData(buf);
        const db = levelDb(buf);
        this.onMicLevel(meterPercent(db));
        this.processLevel(db, performance.now());
        const open = this.gateMode === 'off' || this.gateState.open;
        gain.gain.setTargetAtTime(open ? 1 : 0, ctx.currentTime, open ? 0.005 : 0.03);
      }, GATE_TICK_MS);
    }
    // In a call the test plays the sent track itself, which the gate already switches
    this.micTest = { ownStream, source, gain, analyser, timer };
  }

  setMicTestStoppedHandler(handler: (() => void) | null) {
    this.onMicTestStopped = handler;
  }

  stopMicTest() {
    const test = this.micTest;
    if (!test) return;
    this.micTest = null;
    this.onMicTestStopped?.();
    if (test.timer !== null) window.clearInterval(test.timer);
    for (const node of [test.source, test.gain, test.analyser]) {
      try {
        node?.disconnect();
      } catch {
        // Ignore
      }
    }
    if (test.ownStream) {
      for (const t of test.ownStream.getTracks()) t.stop();
      if (!this.micStream) leaveCallAudioSession();
      if (!this.vadTimer) this.onMicLevel(0);
    }
  }

  /** getUserMedia with graceful fallbacks when the saved device or options are unavailable. */
  private async openMicStream(settings: AudioSettings): Promise<MediaStream> {
    const baseProcessing: MediaTrackConstraints = {
      echoCancellation: settings.echoCancellation,
      noiseSuppression: settings.noiseSuppression,
      autoGainControl: settings.autoGainControl,
    };

    const fullConstraints: MediaTrackConstraints = { ...baseProcessing };
    if (!IS_MOBILE && settings.stereo) {
      fullConstraints.channelCount = 2;
    }
    if (settings.inputDeviceId && settings.inputDeviceId !== 'default') {
      fullConstraints.deviceId = { exact: settings.inputDeviceId };
    }

    const attempts: Array<MediaTrackConstraints | boolean> = [fullConstraints];
    if (settings.inputDeviceId && settings.inputDeviceId !== 'default') {
      attempts.push({
        ...baseProcessing,
        deviceId: { ideal: settings.inputDeviceId },
      });
    }
    attempts.push(baseProcessing, true);

    prepareAudioSessionForMic();
    let stream: MediaStream | null = null;
    let lastError: unknown = null;
    for (const audio of attempts) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
        break;
      } catch (err) {
        lastError = err;
      }
    }
    if (!stream) {
      throw lastError instanceof Error ? lastError : new Error('Mikrofon açılamadı');
    }
    enterCallAudioSession();
    return stream;
  }

  async applyAudioConstraints(
    settings: AudioSettings,
  ): Promise<{ stream: MediaStream; replaced: boolean }> {
    this.applySensitivity(settings);
    const track = this.micStream?.getAudioTracks()[0];
    if (
      this.micStream &&
      track &&
      track.readyState === 'live' &&
      typeof track.applyConstraints === 'function'
    ) {
      try {
        await track.applyConstraints({
          echoCancellation: settings.echoCancellation,
          noiseSuppression: settings.noiseSuppression,
          autoGainControl: settings.autoGainControl,
        });
        if (track.readyState === 'live') {
          return { stream: this.micStream, replaced: false };
        }
      } catch {
        // Fall back to clean reacquire below
      }
    }

    const stream = await this.acquireMic(settings, { settleMs: 120 });
    return { stream, replaced: true };
  }

  private setupVad(stream: MediaStream) {
    this.vadAvailable = false;
    this.gateState = { open: false, hangoverUntil: 0 };
    this.lastGateTickMs = 0;
    try {
      const ctx = this.ensureContext();
      if (ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
      }
      // Measure a clone: the sent track gets disabled while the gate is closed, and a
      // disabled track reads as silence, so the gate could never open again.
      const sent = stream.getAudioTracks()[0];
      if (!sent) return;
      const tap = sent.clone();
      tap.enabled = true;
      this.vadTapTrack = tap;
      this.vadSource = ctx.createMediaStreamSource(new MediaStream([tap]));
      this.vadAnalyser = ctx.createAnalyser();
      this.vadAnalyser.fftSize = 512;
      // Passive tap only — never routed to destination or WebRTC transmit
      this.vadSource.connect(this.vadAnalyser);
      ctx.onstatechange = () => this.applySentTrackEnabled();

      const buf = new Float32Array(this.vadAnalyser.fftSize);
      this.vadAvailable = true;
      this.vadTimer = window.setInterval(() => {
        if (!this.vadAnalyser) return;
        this.vadAnalyser.getFloatTimeDomainData(buf);
        const db = levelDb(buf);
        this.onMicLevel(meterPercent(db));
        this.processLevel(db, performance.now());
        this.applySentTrackEnabled();

        // The speaking ring shows exactly when sound goes out
        const shouldSpeak = this.micTransmissionEnabled && this.gateState.open;
        if (shouldSpeak !== this.currentlySpeaking) {
          this.currentlySpeaking = shouldSpeak;
          this.onSpeakingChange(shouldSpeak);
        }
      }, GATE_TICK_MS);
    } catch {
      // Metering unavailable (restricted AudioContext): gate fails open
      this.vadAvailable = false;
    }
    this.applySentTrackEnabled();
  }

  setMicEnabled(enabled: boolean) {
    this.micTransmissionEnabled = enabled;
    this.applySentTrackEnabled();
    if (!enabled && this.currentlySpeaking) {
      this.currentlySpeaking = false;
      this.onSpeakingChange(false);
    }
  }

  setDeafened(deafened: boolean) {
    this.deafened = deafened;
    for (const peer of this.remotePeers.values()) {
      this.applyPeerRouting(peer);
    }
    for (const [uid, entry] of this.screenAudioPeers.entries()) {
      this.applyScreenAudioRouting(uid, entry);
    }
    this.checkAutoplayState();
  }

  setPeerVolume(userId: string, volume: number) {
    const clamped = Math.max(0, Math.min(2, volume));
    this.peerVolumes.set(userId, clamped);
    const peer = this.remotePeers.get(userId);
    if (peer) {
      peer.volume = clamped;
      this.applyPeerRouting(peer);
    }
  }

  getPeerVolume(userId: string): number {
    return this.peerVolumes.get(userId) ?? 1.0;
  }

  private createHostedAudioElement(stream: MediaStream): HTMLAudioElement {
    const audioEl = document.createElement('audio');
    audioEl.autoplay = true;
    audioEl.setAttribute('autoplay', '');
    audioEl.setAttribute('playsinline', '');
    audioEl.setAttribute('webkit-playsinline', '');
    (audioEl as HTMLAudioElement & { playsInline: boolean }).playsInline = true;
    audioEl.srcObject = stream;

    const host = this.ensureHostContainer();
    if (host) {
      host.appendChild(audioEl);
    }

    if (this.outputDeviceId && this.outputDeviceId !== 'default') {
      const el = audioEl as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
      if (typeof el.setSinkId === 'function') {
        el.setSinkId(this.outputDeviceId).catch(() => {});
      }
    }

    return audioEl;
  }

  setPeerStream(userId: string, stream: MediaStream) {
    if (this.micStream) {
      enterCallAudioSession();
    }
    const existing = this.remotePeers.get(userId);
    if (existing && existing.stream.id === stream.id) {
      existing.audioEl.play().catch(() => {
        this.onAutoplayBlocked(true);
      });
      return;
    }

    this.removePeer(userId);

    const volume = this.peerVolumes.get(userId) ?? 1.0;
    const audioEl = this.createHostedAudioElement(stream);

    const entry: RemotePeerAudio = {
      stream,
      audioEl,
      sourceNode: null,
      gainNode: null,
      limiterNode: null,
      volume,
    };

    audioEl.onplaying = () => {
      this.checkAutoplayState();
    };
    audioEl.onpause = () => {
      const eff = this.deafened ? 0 : entry.volume;
      if (eff > 0 && entry.audioEl.srcObject) {
        this.onAutoplayBlocked(true);
      }
    };

    this.remotePeers.set(userId, entry);
    this.applyPeerRouting(entry);

    audioEl
      .play()
      .then(() => {
        this.checkAutoplayState();
      })
      .catch(() => {
        this.onAutoplayBlocked(true);
      });
  }

  private applyPeerRouting(peer: RemotePeerAudio) {
    const effective = this.deafened ? 0 : peer.volume;
    const useBoostGain = !IS_MOBILE && effective > 1.0;

    if (useBoostGain) {
      if (!peer.gainNode) {
        try {
          const ctx = this.ensureContext();
          if (ctx.state === 'suspended') {
            ctx.resume().catch(() => {});
          }
          peer.sourceNode = ctx.createMediaStreamSource(peer.stream);
          peer.gainNode = ctx.createGain();
          // Brick-wall limiter: boosting past 100% would otherwise hard-clip loud
          // speech into crackle/distortion. Transparent below about -3 dBFS.
          const limiter = ctx.createDynamicsCompressor();
          limiter.threshold.value = BOOST_LIMITER_THRESHOLD_DB;
          limiter.knee.value = 0;
          limiter.ratio.value = BOOST_LIMITER_RATIO;
          limiter.attack.value = 0.002;
          limiter.release.value = 0.2;
          peer.limiterNode = limiter;
          peer.sourceNode.connect(peer.gainNode);
          peer.gainNode.connect(limiter);
          limiter.connect(ctx.destination);
        } catch {
          this.disconnectBoostChain(peer);
        }
      }

      if (peer.gainNode) {
        peer.audioEl.muted = true;
        // Undo the limiter's built-in makeup gain so 110 % on the slider is 110 %
        peer.gainNode.gain.value = effective / BOOST_LIMITER_MAKEUP;
        return;
      }
    }

    this.disconnectBoostChain(peer);

    peer.audioEl.volume = Math.max(0, Math.min(1, effective));
    peer.audioEl.muted = this.deafened || effective === 0;
  }

  private disconnectBoostChain(peer: RemotePeerAudio) {
    for (const node of [peer.sourceNode, peer.gainNode, peer.limiterNode]) {
      try {
        node?.disconnect();
      } catch {
        // Ignore disconnect errors
      }
    }
    peer.sourceNode = null;
    peer.gainNode = null;
    peer.limiterNode = null;
  }

  setScreenAudioStream(userId: string, stream: MediaStream) {
    const trackId = stream.getAudioTracks()[0]?.id ?? stream.id;
    const existing = this.screenAudioPeers.get(userId);
    if (existing && existing.trackId === trackId) {
      this.applyScreenAudioRouting(userId, existing);
      if (this.micStream) {
        enterCallAudioSession();
      }
      existing.audioEl
        .play()
        .then(() => {
          this.checkAutoplayState();
        })
        .catch(() => {
          this.checkAutoplayState();
        });
      return;
    }

    this.removeScreenAudio(userId);

    const audioEl = this.createHostedAudioElement(stream);
    const entry: RemoteScreenAudio = {
      stream,
      trackId,
      audioEl,
    };

    audioEl.onplaying = () => {
      this.checkAutoplayState();
    };
    audioEl.onpause = () => {
      this.checkAutoplayState();
    };

    this.screenAudioPeers.set(userId, entry);
    this.applyScreenAudioRouting(userId, entry);

    if (this.micStream) {
      enterCallAudioSession();
    }

    audioEl
      .play()
      .then(() => {
        this.checkAutoplayState();
      })
      .catch(() => {
        this.checkAutoplayState();
      });
  }

  removeScreenAudio(userId: string, onlyTrackId?: string) {
    const existing = this.screenAudioPeers.get(userId);
    if (!existing) return;
    if (onlyTrackId && existing.trackId !== onlyTrackId) return;
    existing.audioEl.onplaying = null;
    existing.audioEl.onpause = null;
    existing.audioEl.pause();
    existing.audioEl.srcObject = null;
    existing.audioEl.remove();
    this.screenAudioPeers.delete(userId);
    this.checkAutoplayState();
  }

  setActiveScreenAudio(userId: string | null, volume: number, muted: boolean) {
    this.activeScreenUserId = userId;
    this.screenVolume = Math.max(0, Math.min(1, volume));
    this.screenMuted = muted;

    for (const [uid, entry] of this.screenAudioPeers.entries()) {
      this.applyScreenAudioRouting(uid, entry);
      if (
        uid === userId &&
        !this.deafened &&
        !this.screenMuted &&
        this.screenVolume > 0 &&
        entry.audioEl.paused
      ) {
        entry.audioEl
          .play()
          .then(() => {
            this.checkAutoplayState();
          })
          .catch(() => {
            this.checkAutoplayState();
          });
      }
    }
    this.checkAutoplayState();
  }

  private applyScreenAudioRouting(userId: string, entry: RemoteScreenAudio) {
    const effective =
      this.activeScreenUserId === userId && !this.deafened && !this.screenMuted
        ? this.screenVolume
        : 0;
    entry.audioEl.volume = Math.max(0, Math.min(1, effective));
    entry.audioEl.muted = effective === 0;
  }

  removePeer(userId: string) {
    this.removeScreenAudio(userId);
    const existing = this.remotePeers.get(userId);
    if (!existing) return;
    existing.audioEl.onplaying = null;
    existing.audioEl.onpause = null;
    this.disconnectBoostChain(existing);
    existing.audioEl.pause();
    existing.audioEl.srcObject = null;
    existing.audioEl.remove();
    this.remotePeers.delete(userId);
  }

  stopMic() {
    // A test running on the call's mic can't outlive it
    if (this.micTest && !this.micTest.ownStream) this.stopMicTest();
    if (this.vadTimer !== null) {
      window.clearInterval(this.vadTimer);
      this.vadTimer = null;
    }
    try {
      this.vadSource?.disconnect();
      this.vadAnalyser?.disconnect();
    } catch {
      // Ignore
    }
    this.vadSource = null;
    this.vadAnalyser = null;
    this.vadTapTrack?.stop();
    this.vadTapTrack = null;
    this.vadAvailable = false;
    this.gateState = { open: false, hangoverUntil: 0 };
    if (this.micStream) {
      for (const t of this.micStream.getTracks()) {
        t.stop();
      }
      this.micStream = null;
      leaveCallAudioSession();
    }
    if (this.currentlySpeaking) {
      this.currentlySpeaking = false;
      this.onSpeakingChange(false);
    }
    this.onMicLevel(0);
  }

  destroyAll() {
    this.stopMic();
    for (const userId of Array.from(this.remotePeers.keys())) {
      this.removePeer(userId);
    }
    for (const userId of Array.from(this.screenAudioPeers.keys())) {
      this.removeScreenAudio(userId);
    }
    this.activeScreenUserId = null;
    this.onAutoplayBlocked(false);
  }
}
