import type { AudioSettings } from '../types/protocol';
import { computeRmsLevel, evaluateNoiseGate, type GateState } from './audioGate';

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

  private onSpeakingChange: (speaking: boolean) => void;
  private onMicLevel: (level: number) => void;
  private onAutoplayBlocked: (blocked: boolean) => void;

  private vadThreshold = 14; // 1..95

  constructor(callbacks: {
    onSpeakingChange: (speaking: boolean) => void;
    onMicLevel: (level: number) => void;
    onAutoplayBlocked: (blocked: boolean) => void;
  }) {
    this.onSpeakingChange = callbacks.onSpeakingChange;
    this.onMicLevel = callbacks.onMicLevel;
    this.onAutoplayBlocked = callbacks.onAutoplayBlocked;
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

    for (const peer of this.remotePeers.values()) {
      try {
        await peer.audioEl.play();
      } catch {
        allPlayed = false;
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
  }

  setVadThreshold(threshold: number) {
    this.vadThreshold = Math.max(1, Math.min(95, threshold));
  }

  async acquireMic(
    settings: AudioSettings,
    options?: { settleMs?: number },
  ): Promise<MediaStream> {
    this.stopMic();
    this.setVadThreshold(settings.vadThreshold);

    if (options?.settleMs && options.settleMs > 0) {
      await new Promise((r) => window.setTimeout(r, options.settleMs));
    }

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

    // Transmit the direct native getUserMedia stream so WebRTC uses native C++ AEC3 / NS / AGC
    this.micStream = stream;
    this.setMicEnabled(this.micTransmissionEnabled);
    this.setupVad(stream);
    if (settings.outputDeviceId) {
      this.setOutputDevice(settings.outputDeviceId).catch(() => {});
    }
    return stream;
  }

  async applyAudioConstraints(
    settings: AudioSettings,
  ): Promise<{ stream: MediaStream; replaced: boolean }> {
    this.setVadThreshold(settings.vadThreshold);
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
    try {
      const ctx = this.ensureContext();
      if (ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
      }
      this.vadSource = ctx.createMediaStreamSource(stream);
      this.vadAnalyser = ctx.createAnalyser();
      this.vadAnalyser.fftSize = 512;
      // Passive tap only — never routed to destination or WebRTC transmit
      this.vadSource.connect(this.vadAnalyser);

      const buf = new Float32Array(this.vadAnalyser.fftSize);
      this.gateState = { open: false, hangoverUntil: 0 };
      this.vadTimer = window.setInterval(() => {
        if (!this.vadAnalyser) return;
        this.vadAnalyser.getFloatTimeDomainData(buf);
        const level = computeRmsLevel(buf);
        this.onMicLevel(level);

        this.gateState = evaluateNoiseGate(
          this.gateState,
          level,
          this.vadThreshold,
          performance.now(),
        );
        const shouldSpeak = this.micTransmissionEnabled && this.gateState.open;
        if (shouldSpeak !== this.currentlySpeaking) {
          this.currentlySpeaking = shouldSpeak;
          this.onSpeakingChange(shouldSpeak);
        }
      }, 60);
    } catch {
      // VAD optional if AudioContext restricted
    }
  }

  setMicEnabled(enabled: boolean) {
    this.micTransmissionEnabled = enabled;
    if (!this.micStream) return;
    for (const track of this.micStream.getAudioTracks()) {
      track.enabled = enabled;
    }
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

  setPeerStream(userId: string, stream: MediaStream) {
    const existing = this.remotePeers.get(userId);
    if (existing && existing.stream.id === stream.id) {
      existing.audioEl.play().catch(() => {
        this.onAutoplayBlocked(true);
      });
      return;
    }

    this.removePeer(userId);

    const volume = this.peerVolumes.get(userId) ?? 1.0;
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
          limiter.threshold.value = -3;
          limiter.knee.value = 0;
          limiter.ratio.value = 20;
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
        peer.gainNode.gain.value = effective;
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

  removePeer(userId: string) {
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
    this.gateState = { open: false, hangoverUntil: 0 };
    if (this.micStream) {
      for (const t of this.micStream.getTracks()) {
        t.stop();
      }
      this.micStream = null;
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
    this.onAutoplayBlocked(false);
  }
}
