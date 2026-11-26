import type { AudioSettings } from '../types/protocol';

const IS_MOBILE =
  typeof navigator !== 'undefined' &&
  /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

interface RemotePeerAudio {
  stream: MediaStream;
  audioEl: HTMLAudioElement;
  sourceNode: MediaStreamAudioSourceNode | null;
  gainNode: GainNode | null;
  volume: number; // 0.0 to 2.0
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private hostContainer: HTMLDivElement | null = null;
  private micStream: MediaStream | null = null;
  private vadSource: MediaStreamAudioSourceNode | null = null;
  private vadAnalyser: AnalyserNode | null = null;
  private vadTimer: number | null = null;
  private hangoverUntil = 0;
  private currentlySpeaking = false;
  private deafened = false;
  private outputDeviceId = 'default';

  private remotePeers = new Map<string, RemotePeerAudio>();
  private peerVolumes = new Map<string, number>();

  private onSpeakingChange: (speaking: boolean) => void;
  private onMicLevel: (level: number) => void;
  private onAutoplayBlocked: (blocked: boolean) => void;

  private vadThreshold = 14; // 0..100

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
      this.ctx = new AudioCtx({ latencyHint: 'interactive' });
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
    if (!deviceId || deviceId === 'default') return;
    const ctx = this.ctx as (AudioContext & { setSinkId?: (id: string) => Promise<void> }) | null;
    if (ctx && typeof ctx.setSinkId === 'function') {
      await ctx.setSinkId(deviceId).catch(() => {});
    }
    for (const peer of this.remotePeers.values()) {
      const el = peer.audioEl as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
      if (typeof el.setSinkId === 'function') {
        await el.setSinkId(deviceId).catch(() => {});
      }
    }
  }

  setVadThreshold(threshold: number) {
    this.vadThreshold = Math.max(1, Math.min(95, threshold));
  }

  async acquireMic(settings: AudioSettings): Promise<MediaStream> {
    this.stopMic();
    this.setVadThreshold(settings.vadThreshold);

    const audioConstraints: MediaTrackConstraints = {
      echoCancellation: settings.echoCancellation,
      noiseSuppression: settings.noiseSuppression,
      autoGainControl: settings.autoGainControl,
    };

    if (!IS_MOBILE) {
      audioConstraints.channelCount = settings.stereo ? 2 : 1;
      audioConstraints.sampleRate = 48000;
    }

    if (settings.inputDeviceId && settings.inputDeviceId !== 'default') {
      audioConstraints.deviceId = { exact: settings.inputDeviceId };
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints,
        video: false,
      });
    } catch {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false,
      });
    }

    this.micStream = stream;
    this.setupVad(stream);
    if (settings.outputDeviceId) {
      this.setOutputDevice(settings.outputDeviceId).catch(() => {});
    }
    return stream;
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
      this.vadSource.connect(this.vadAnalyser);

      const buf = new Float32Array(this.vadAnalyser.fftSize);
      this.vadTimer = window.setInterval(() => {
        if (!this.vadAnalyser) return;
        this.vadAnalyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i += 1) {
          sum += buf[i] * buf[i];
        }
        const rms = Math.sqrt(sum / buf.length);
        const level = Math.min(100, Math.round(rms * 350));
        this.onMicLevel(level);

        const now = performance.now();
        if (level >= this.vadThreshold) {
          this.hangoverUntil = now + 260;
          if (!this.currentlySpeaking) {
            this.currentlySpeaking = true;
            this.onSpeakingChange(true);
          }
        } else if (this.currentlySpeaking && now > this.hangoverUntil) {
          this.currentlySpeaking = false;
          this.onSpeakingChange(false);
        }
      }, 60);
    } catch {
      // VAD optional if AudioContext restricted
    }
  }

  setMicEnabled(enabled: boolean) {
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
          peer.sourceNode.connect(peer.gainNode);
          peer.gainNode.connect(ctx.destination);
        } catch {
          peer.sourceNode = null;
          peer.gainNode = null;
        }
      }

      if (peer.gainNode) {
        peer.audioEl.muted = true;
        peer.gainNode.gain.value = effective;
        return;
      }
    }

    if (peer.gainNode) {
      try {
        peer.sourceNode?.disconnect();
        peer.gainNode.disconnect();
      } catch {
        // Ignore
      }
      peer.sourceNode = null;
      peer.gainNode = null;
    }

    peer.audioEl.volume = Math.max(0, Math.min(1, effective));
    peer.audioEl.muted = this.deafened || effective === 0;
  }

  removePeer(userId: string) {
    const existing = this.remotePeers.get(userId);
    if (!existing) return;
    existing.audioEl.onplaying = null;
    existing.audioEl.onpause = null;
    try {
      existing.sourceNode?.disconnect();
      existing.gainNode?.disconnect();
    } catch {
      // Ignore disconnect errors
    }
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
