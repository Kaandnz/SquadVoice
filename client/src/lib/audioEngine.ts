import type {
  AudioSettings,
  InputSensitivityMode,
  NoiseSuppressionMode,
  NoiseSuppressionStatus,
} from '../types/protocol';
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
import {
  buildMicTrackConstraints,
  getNoiseSuppressionLabel,
  isAiNoiseSuppressionMode,
  isSampleRateCompatible,
  resolveNoiseSuppressionMode,
  type AiNoiseSuppressionMode,
} from './noiseSuppression';
import { createAiNoiseWorkletNode, type AiNoiseWorkletNode } from './noiseWorklet';

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
  private aiCtx: AudioContext | null = null;
  private hostContainer: HTMLDivElement | null = null;

  private rawMicStream: MediaStream | null = null;
  private micStream: MediaStream | null = null;
  private aiSource: MediaStreamAudioSourceNode | null = null;
  private aiWorklet: AiNoiseWorkletNode | null = null;
  private aiDestination: MediaStreamAudioDestinationNode | null = null;
  private activeNoiseMode: NoiseSuppressionMode = 'standard';
  private micOpSeq = 0;

  private vadCtx: AudioContext | null = null;
  private vadSource: AudioNode | null = null;
  private vadOwnsSource = false;
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
  private onNoiseSuppressionStatus: ((status: NoiseSuppressionStatus) => void) | null = null;
  private onMicLost: (() => void) | null = null;
  private onMicTestStopped: (() => void) | null = null;
  private micTestOpSeq = 0;
  private micTest: {
    ownStream: MediaStream | null;
    source: MediaStreamAudioSourceNode;
    worklet: AiNoiseWorkletNode | null;
    gain: GainNode;
    analyser: AnalyserNode | null;
    timer: number | null;
    usedAiCtx: boolean;
  } | null = null;

  // Input sensitivity / noise gate. The gate switches the SENT track on and off
  // (track.enabled), so the browser's native AEC/NS/AGC (or AI worklet) stays untouched.
  private gateMode: InputSensitivityMode = 'auto';
  private manualThresholdDb = -50;
  private noiseFloorDb = INITIAL_NOISE_FLOOR_DB;
  private lastGateTickMs = 0;
  /** Clone of the mic track used only for measuring in native mode, so a closed gate can still hear you. */
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
    /** Active runtime noise suppression mode, loading state, and fallback warnings. */
    onNoiseSuppressionStatus?: (status: NoiseSuppressionStatus) => void;
  }) {
    this.onSpeakingChange = callbacks.onSpeakingChange;
    this.onMicLevel = callbacks.onMicLevel;
    this.onAutoplayBlocked = callbacks.onAutoplayBlocked;
    this.onGateThreshold = callbacks.onGateThreshold ?? null;
    this.onNoiseSuppressionStatus = callbacks.onNoiseSuppressionStatus ?? null;
  }

  private emitNoiseStatus(status: NoiseSuppressionStatus) {
    this.onNoiseSuppressionStatus?.(status);
  }

  private ensureContext(): AudioContext {
    if (!this.ctx || this.ctx.state === 'closed') {
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

  private ensureAiContext(mode: AiNoiseSuppressionMode): AudioContext {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;

    if (this.aiCtx && this.aiCtx.state !== 'closed') {
      if (isSampleRateCompatible(mode, this.aiCtx.sampleRate)) {
        return this.aiCtx;
      }
      this.aiCtx.close().catch(() => {});
      this.aiCtx = null;
    }

    const attempts: AudioContextOptions[] = [
      { sampleRate: 48000, latencyHint: 'interactive' },
      { sampleRate: 48000 },
    ];
    if (mode === 'gtcrn') {
      attempts.push({ sampleRate: 16000 });
    }

    for (const opts of attempts) {
      try {
        const candidate = new AudioCtx(opts);
        if (isSampleRateCompatible(mode, candidate.sampleRate)) {
          this.aiCtx = candidate;
          return candidate;
        }
        candidate.close().catch(() => {});
      } catch {
        // Try next sample-rate option
      }
    }

    const fallback = new AudioCtx();
    this.aiCtx = fallback;
    return fallback;
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

    if (this.aiCtx && this.aiCtx.state === 'suspended' && (this.aiWorklet || this.micTest?.usedAiCtx)) {
      await this.aiCtx.resume().catch(() => {});
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
    for (const maybeCtx of [this.ctx, this.aiCtx]) {
      const ctx = maybeCtx as (AudioContext & { setSinkId?: (id: string) => Promise<void> }) | null;
      if (ctx && typeof ctx.setSinkId === 'function') {
        await ctx.setSinkId(sinkId).catch(() => {});
      }
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
    const measuring = this.vadAvailable && this.vadCtx?.state === 'running';
    return !measuring || this.gateState.open;
  }

  private applySentTrackEnabled() {
    if (!this.micStream) return;
    const allow = this.micTransmissionEnabled && this.gateAllowsSound();
    if (allow && this.rawMicStream && this.rawMicStream !== this.micStream) {
      for (const track of this.rawMicStream.getAudioTracks()) {
        if (!track.enabled) track.enabled = true;
      }
    }
    for (const track of this.micStream.getAudioTracks()) {
      if (track.enabled !== allow) track.enabled = allow;
    }
  }

  private teardownVad() {
    if (this.vadTimer !== null) {
      window.clearInterval(this.vadTimer);
      this.vadTimer = null;
    }
    try {
      if (this.vadSource && this.vadAnalyser) {
        if (this.vadOwnsSource) {
          this.vadSource.disconnect();
        } else {
          this.vadSource.disconnect(this.vadAnalyser);
        }
      }
      this.vadAnalyser?.disconnect();
    } catch {
      // Ignore disconnect errors
    }
    this.vadCtx = null;
    this.vadSource = null;
    this.vadOwnsSource = false;
    this.vadAnalyser = null;
    this.vadTapTrack?.stop();
    this.vadTapTrack = null;
    this.vadAvailable = false;
    this.gateState = { open: false, hangoverUntil: 0 };
    this.lastGateTickMs = 0;
  }

  private teardownAiPipeline(options?: { suspendContext?: boolean }) {
    try {
      this.aiSource?.disconnect();
    } catch {
      // Ignore
    }
    try {
      this.aiWorklet?.disconnect();
      this.aiWorklet?.destroy();
    } catch {
      // Ignore
    }
    try {
      if (this.aiDestination) {
        for (const t of this.aiDestination.stream.getTracks()) {
          t.stop();
        }
      }
    } catch {
      // Ignore
    }
    this.aiSource = null;
    this.aiWorklet = null;
    this.aiDestination = null;

    if (
      options?.suspendContext !== false &&
      this.aiCtx &&
      this.aiCtx.state === 'running' &&
      !this.micTest?.usedAiCtx
    ) {
      this.aiCtx.suspend().catch(() => {});
    }
  }

  private async attachMicMode(
    rawStream: MediaStream,
    settings: AudioSettings,
    seq: number,
  ): Promise<MediaStream> {
    const requestedMode = resolveNoiseSuppressionMode(settings);
    this.teardownVad();

    if (!isAiNoiseSuppressionMode(requestedMode)) {
      this.teardownAiPipeline({ suspendContext: true });
      this.micStream = rawStream;
      this.activeNoiseMode = requestedMode;
      this.setMicEnabled(this.micTransmissionEnabled);
      this.setupVad(rawStream);
      this.emitNoiseStatus({
        activeMode: requestedMode,
        loading: false,
        fallbackMessage: null,
      });
      return rawStream;
    }

    this.emitNoiseStatus({
      activeMode: this.activeNoiseMode,
      loading: true,
      fallbackMessage: null,
    });

    this.teardownAiPipeline({ suspendContext: false });

    let createdWorklet: AiNoiseWorkletNode | null = null;
    let createdSource: MediaStreamAudioSourceNode | null = null;
    let createdDest: MediaStreamAudioDestinationNode | null = null;

    try {
      const aiCtx = this.ensureAiContext(requestedMode);
      if (aiCtx.state === 'suspended') {
        await aiCtx.resume();
      }
      if (seq !== this.micOpSeq) {
        return this.micStream ?? rawStream;
      }

      const maxChannels = !IS_MOBILE && settings.stereo ? 2 : 1;
      createdWorklet = await createAiNoiseWorkletNode(aiCtx, requestedMode, maxChannels);

      if (seq !== this.micOpSeq) {
        try {
          createdWorklet.destroy();
          createdWorklet.disconnect();
        } catch {
          // Ignore stale cleanup error
        }
        return this.micStream ?? rawStream;
      }

      createdSource = aiCtx.createMediaStreamSource(rawStream);
      createdDest = aiCtx.createMediaStreamDestination();
      createdSource.connect(createdWorklet);
      createdWorklet.connect(createdDest);

      // Keep the raw hardware track feeding the AI worklet; mute/PTT/gate controls the output track.
      for (const t of rawStream.getAudioTracks()) {
        t.enabled = true;
      }

      this.aiSource = createdSource;
      this.aiWorklet = createdWorklet;
      this.aiDestination = createdDest;
      this.micStream = createdDest.stream;
      this.activeNoiseMode = requestedMode;

      this.setMicEnabled(this.micTransmissionEnabled);
      this.setupVad(createdDest.stream, { ctx: aiCtx, sourceNode: createdWorklet });
      this.emitNoiseStatus({
        activeMode: requestedMode,
        loading: false,
        fallbackMessage: null,
      });
      return createdDest.stream;
    } catch (err) {
      try {
        createdSource?.disconnect();
        createdWorklet?.disconnect();
        createdWorklet?.destroy();
        if (createdDest) {
          for (const t of createdDest.stream.getTracks()) {
            t.stop();
          }
        }
      } catch {
        // Ignore cleanup errors
      }
      this.teardownAiPipeline({ suspendContext: true });

      if (seq !== this.micOpSeq) {
        return this.micStream ?? rawStream;
      }

      // Graceful fallback to native browser noise suppression so the user never loses voice
      const rawTrack = rawStream.getAudioTracks()[0];
      if (rawTrack && rawTrack.readyState === 'live' && typeof rawTrack.applyConstraints === 'function') {
        await rawTrack
          .applyConstraints({
            echoCancellation: settings.echoCancellation,
            noiseSuppression: true,
            autoGainControl: settings.autoGainControl,
          })
          .catch(() => {});
      }

      this.micStream = rawStream;
      this.activeNoiseMode = 'standard';
      this.setMicEnabled(this.micTransmissionEnabled);
      this.setupVad(rawStream);

      const reason = err instanceof Error ? err.message : '';
      const modeLabel = getNoiseSuppressionLabel(requestedMode);
      const fallbackMessage = reason
        ? `${modeLabel} başlatılamadı (${reason}). Standart moda geçildi.`
        : `${modeLabel} bu cihazda başlatılamadı. Standart moda geçildi.`;

      this.emitNoiseStatus({
        activeMode: 'standard',
        loading: false,
        fallbackMessage,
      });
      return rawStream;
    }
  }

  async acquireMic(
    settings: AudioSettings,
    options?: { settleMs?: number },
  ): Promise<MediaStream> {
    this.stopMic();
    const seq = ++this.micOpSeq;
    this.gateMode = effectiveGateMode(settings);
    this.manualThresholdDb = Math.max(METER_FLOOR_DB, Math.min(0, settings.gateThresholdDb));

    if (options?.settleMs && options.settleMs > 0) {
      await new Promise((r) => window.setTimeout(r, options.settleMs));
      if (seq !== this.micOpSeq) {
        throw new Error('Mikrofon başlatma iptal edildi');
      }
    }

    const rawStream = await this.openMicStream(settings);
    if (seq !== this.micOpSeq) {
      for (const t of rawStream.getTracks()) {
        t.stop();
      }
      throw new Error('Mikrofon başlatma iptal edildi');
    }

    // Standard / Off modes transmit the direct native getUserMedia stream so WebRTC uses
    // native C++ AEC3 / NS / AGC; AI modes (RNNoise / GTCRN) route through a 48 kHz WASM AudioWorklet.
    this.rawMicStream = rawStream;
    for (const track of rawStream.getAudioTracks()) {
      // Unplugged headset / revoked device: let the app pick another mic
      track.addEventListener('ended', () => {
        if (this.rawMicStream === rawStream) this.onMicLost?.();
      });
    }

    const outputStream = await this.attachMicMode(rawStream, settings, seq);
    if (settings.outputDeviceId) {
      this.setOutputDevice(settings.outputDeviceId).catch(() => {});
    }
    return outputStream;
  }

  /** Called when the live mic track ends on its own (device unplugged). */
  setMicLostHandler(handler: (() => void) | null) {
    this.onMicLost = handler;
  }

  /** The sent mic track, if any (reflects live mute/gate enabled state). */
  getMicTrack(): MediaStreamTrack | null {
    return this.micStream?.getAudioTracks()[0] ?? null;
  }

  /** The underlying hardware mic track from getUserMedia (for device-change checks). */
  getHardwareMicTrack(): MediaStreamTrack | null {
    return this.rawMicStream?.getAudioTracks()[0] ?? this.micStream?.getAudioTracks()[0] ?? null;
  }

  isMicTestRunning(): boolean {
    return this.micTest !== null;
  }

  /**
   * Plays your own microphone back to you (like Discord's "Let's Check") with a live level.
   * In a call it uses the very track friends receive, processing included; otherwise it
   * opens the selected mic just for the test (including any selected AI noise filter).
   */
  async startMicTest(settings: AudioSettings): Promise<void> {
    this.stopMicTest();
    const opSeq = ++this.micTestOpSeq;

    const liveCallMic =
      this.micStream?.getAudioTracks().some((t) => t.readyState === 'live') ?? false;

    if (liveCallMic && this.micStream) {
      const ctx = this.ensureContext();
      if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
      if (opSeq !== this.micTestOpSeq || !this.micStream) return;

      const source = ctx.createMediaStreamSource(this.micStream);
      const gain = ctx.createGain();
      gain.gain.value = 1;
      source.connect(gain);
      gain.connect(ctx.destination);
      // In a call the test plays the sent track itself, which the gate already switches
      this.micTest = {
        ownStream: null,
        source,
        worklet: null,
        gain,
        analyser: null,
        timer: null,
        usedAiCtx: false,
      };
      return;
    }

    const requestedMode = resolveNoiseSuppressionMode(settings);
    const ownStream = await this.openMicStream(settings);
    if (opSeq !== this.micTestOpSeq) {
      for (const t of ownStream.getTracks()) t.stop();
      if (!this.rawMicStream) leaveCallAudioSession();
      return;
    }

    let testCtx: AudioContext = this.ensureContext();
    let worklet: AiNoiseWorkletNode | null = null;
    let usedAiCtx = false;

    if (isAiNoiseSuppressionMode(requestedMode)) {
      this.emitNoiseStatus({
        activeMode: this.activeNoiseMode,
        loading: true,
        fallbackMessage: null,
      });
      try {
        const aiCtx = this.ensureAiContext(requestedMode);
        if (aiCtx.state === 'suspended') await aiCtx.resume();
        const maxChannels = !IS_MOBILE && settings.stereo ? 2 : 1;
        worklet = await createAiNoiseWorkletNode(aiCtx, requestedMode, maxChannels);
        if (opSeq !== this.micTestOpSeq) {
          worklet.destroy();
          worklet.disconnect();
          for (const t of ownStream.getTracks()) t.stop();
          if (!this.rawMicStream) leaveCallAudioSession();
          return;
        }
        testCtx = aiCtx;
        usedAiCtx = true;
        this.emitNoiseStatus({
          activeMode: requestedMode,
          loading: false,
          fallbackMessage: null,
        });
      } catch (err) {
        worklet = null;
        usedAiCtx = false;
        const rawTrack = ownStream.getAudioTracks()[0];
        if (rawTrack && typeof rawTrack.applyConstraints === 'function') {
          await rawTrack
            .applyConstraints({
              echoCancellation: settings.echoCancellation,
              noiseSuppression: true,
              autoGainControl: settings.autoGainControl,
            })
            .catch(() => {});
        }
        const reason = err instanceof Error ? err.message : '';
        const modeLabel = getNoiseSuppressionLabel(requestedMode);
        this.emitNoiseStatus({
          activeMode: 'standard',
          loading: false,
          fallbackMessage: reason
            ? `${modeLabel} başlatılamadı (${reason}). Standart moda geçildi.`
            : `${modeLabel} bu cihazda başlatılamadı. Standart moda geçildi.`,
        });
      }
    } else {
      this.emitNoiseStatus({
        activeMode: requestedMode,
        loading: false,
        fallbackMessage: null,
      });
    }

    if (opSeq !== this.micTestOpSeq) {
      worklet?.destroy();
      worklet?.disconnect();
      for (const t of ownStream.getTracks()) t.stop();
      if (!this.rawMicStream) leaveCallAudioSession();
      return;
    }

    if (testCtx.state === 'suspended') await testCtx.resume().catch(() => {});
    if (this.outputDeviceId && this.outputDeviceId !== 'default') {
      const sinkCtx = testCtx as AudioContext & { setSinkId?: (id: string) => Promise<void> };
      if (typeof sinkCtx.setSinkId === 'function') {
        await sinkCtx.setSinkId(this.outputDeviceId).catch(() => {});
      }
    }

    const source = testCtx.createMediaStreamSource(ownStream);
    const gain = testCtx.createGain();
    gain.gain.value = 1;
    const processedOutput: AudioNode = worklet ? source.connect(worklet) : source;
    processedOutput.connect(gain);
    gain.connect(testCtx.destination);

    // Outside a call the VAD loop isn't running: meter the processed mic ourselves and apply the
    // same gate to the playback, so you hear exactly what friends would receive.
    this.gateMode = effectiveGateMode(settings);
    this.manualThresholdDb = Math.max(METER_FLOOR_DB, Math.min(0, settings.gateThresholdDb));
    const analyser = testCtx.createAnalyser();
    analyser.fftSize = 512;
    processedOutput.connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    const tap = analyser;
    const timer = window.setInterval(() => {
      tap.getFloatTimeDomainData(buf);
      const db = levelDb(buf);
      this.onMicLevel(meterPercent(db));
      this.processLevel(db, performance.now());
      const open = this.gateMode === 'off' || this.gateState.open;
      gain.gain.setTargetAtTime(open ? 1 : 0, testCtx.currentTime, open ? 0.005 : 0.03);
    }, GATE_TICK_MS);

    this.micTest = { ownStream, source, worklet, gain, analyser, timer, usedAiCtx };
  }

  setMicTestStoppedHandler(handler: (() => void) | null) {
    this.onMicTestStopped = handler;
  }

  stopMicTest() {
    this.micTestOpSeq += 1;
    const test = this.micTest;
    if (!test) return;
    this.micTest = null;
    this.onMicTestStopped?.();
    if (test.timer !== null) window.clearInterval(test.timer);
    for (const node of [test.source, test.worklet, test.gain, test.analyser]) {
      try {
        node?.disconnect();
      } catch {
        // Ignore
      }
    }
    try {
      test.worklet?.destroy();
    } catch {
      // Ignore
    }
    if (test.usedAiCtx && !this.aiWorklet && this.aiCtx && this.aiCtx.state === 'running') {
      this.aiCtx.suspend().catch(() => {});
    }
    if (test.ownStream) {
      for (const t of test.ownStream.getTracks()) t.stop();
      if (!this.rawMicStream) leaveCallAudioSession();
      if (!this.vadTimer) this.onMicLevel(0);
    }
  }

  /** getUserMedia with graceful fallbacks when the saved device or options are unavailable. */
  private async openMicStream(settings: AudioSettings): Promise<MediaStream> {
    const baseProcessing = buildMicTrackConstraints(settings);

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
    const seq = ++this.micOpSeq;
    this.applySensitivity(settings);

    const requestedMode = resolveNoiseSuppressionMode(settings);
    const rawTrack = this.rawMicStream?.getAudioTracks()[0];

    if (
      this.rawMicStream &&
      rawTrack &&
      rawTrack.readyState === 'live' &&
      typeof rawTrack.applyConstraints === 'function'
    ) {
      try {
        await rawTrack.applyConstraints(buildMicTrackConstraints(settings));
        if (seq !== this.micOpSeq) {
          return { stream: this.micStream ?? this.rawMicStream, replaced: false };
        }

        if (rawTrack.readyState === 'live') {
          const wasAi = Boolean(this.aiWorklet);
          const wantsAi = isAiNoiseSuppressionMode(requestedMode);

          if (!wasAi && !wantsAi) {
            this.activeNoiseMode = requestedMode;
            this.emitNoiseStatus({
              activeMode: requestedMode,
              loading: false,
              fallbackMessage: null,
            });
            return { stream: this.micStream ?? this.rawMicStream, replaced: false };
          }

          if (wasAi && wantsAi && requestedMode === this.activeNoiseMode && this.micStream) {
            return { stream: this.micStream, replaced: false };
          }

          const prevStream = this.micStream;
          const nextStream = await this.attachMicMode(this.rawMicStream, settings, seq);
          return { stream: nextStream, replaced: nextStream !== prevStream };
        }
      } catch {
        // Fall back to clean reacquire below
      }
    }

    const stream = await this.acquireMic(settings, { settleMs: 120 });
    return { stream, replaced: true };
  }

  private setupVad(
    stream: MediaStream,
    existingTap?: { ctx: AudioContext; sourceNode: AudioNode },
  ) {
    this.teardownVad();
    try {
      const ctx = existingTap ? existingTap.ctx : this.ensureContext();
      if (ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
      }

      if (existingTap) {
        // In AI mode, tap the worklet output directly (upstream of aiDestination.stream)
        // so disabling the sent track when the gate closes never silences the meter.
        this.vadSource = existingTap.sourceNode;
        this.vadOwnsSource = false;
      } else {
        // Measure a clone: the sent track gets disabled while the gate is closed, and a
        // disabled track reads as silence, so the gate could never open again.
        const sent = stream.getAudioTracks()[0];
        if (!sent) return;
        const tap = sent.clone();
        tap.enabled = true;
        this.vadTapTrack = tap;
        this.vadSource = ctx.createMediaStreamSource(new MediaStream([tap]));
        this.vadOwnsSource = true;
      }

      this.vadCtx = ctx;
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
        peer.gainNode.gain.value = effective * BOOST_LIMITER_MAKEUP;
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
    this.micOpSeq += 1;
    // A test running on the call's mic can't outlive it
    if (this.micTest && !this.micTest.ownStream) this.stopMicTest();
    this.teardownVad();
    this.teardownAiPipeline({ suspendContext: true });
    if (this.rawMicStream) {
      for (const t of this.rawMicStream.getTracks()) {
        t.stop();
      }
      this.rawMicStream = null;
      leaveCallAudioSession();
    }
    this.micStream = null;
    if (this.currentlySpeaking) {
      this.currentlySpeaking = false;
      this.onSpeakingChange(false);
    }
    this.onMicLevel(0);
  }

  destroyAll() {
    this.stopMic();
    this.stopMicTest();
    if (this.aiCtx && this.aiCtx.state !== 'closed') {
      this.aiCtx.close().catch(() => {});
    }
    this.aiCtx = null;
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
