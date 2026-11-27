import type { AudioSettings, PeerStats, ScreenShareOptions } from '../types/protocol';
import type { AudioEngine } from './audioEngine';
import { findSelectedCandidatePair } from './rtcStats';
import {
  isInitiatorPeer,
  isPolitePeer,
  sanitizeRtcPayload,
  sdpSessionId,
  tuneOpusSdp,
} from './sdp';

/** How long a 'disconnected' ICE state may last before we actively restart ICE. */
const ICE_DISCONNECT_GRACE_MS = 4000;
/** How long we wait for an answer before sending the same offer again (doubles each time). */
const OFFER_ANSWER_TIMEOUT_MS = 8000;
const OFFER_ANSWER_TIMEOUT_MAX_MS = 60_000;
/** Shortest window used for bitrate / packet-loss figures. */
const MIN_STATS_WINDOW_MS = 1500;
/** At most one "remote rebuilt, rebuild ours" per peer in this window. */
const REBUILD_COOLDOWN_MS = 5000;

interface PeerEntry {
  userId: string;
  pc: RTCPeerConnection;
  isPolite: boolean;
  isInitiator: boolean;
  hasNegotiated: boolean;
  needsRenegotiation: boolean;
  watchdogTimer: number | null;
  iceRestartTimer: number | null;
  offerTimer: number | null;
  /** SDP o= session id of the remote RTCPeerConnection we are negotiating with. */
  remoteSdpSessionId: string | null;
  queue: Promise<void>;
  makingOffer: boolean;
  ignoreOffer: boolean;
  pendingIce: RTCIceCandidateInit[];
  micSender: RTCRtpSender | null;
  screenVideoSender: RTCRtpSender | null;
  screenAudioSender: RTCRtpSender | null;
  cameraSender: RTCRtpSender | null;
  hasAudioTrack: boolean;
  screenStream: MediaStream | null;
  cameraStream: MediaStream | null;
  prevAudioBytes: number;
  prevVideoBytes: number;
  prevPacketsLost: number;
  prevPacketsReceived: number;
  prevStatsTs: number;
  lastAudioKbps: number;
  lastVideoKbps: number;
  lastLossPct: number | null;
  /** Unanswered re-sends of the current offer, for backoff. */
  offerResends: number;
}

export interface MeshCallbacks {
  sendOffer: (
    targetUserId: string,
    sdp: RTCSessionDescriptionInit,
    screenStreamId: string | null,
    cameraStreamId: string | null,
  ) => void;
  sendAnswer: (targetUserId: string, sdp: RTCSessionDescriptionInit) => void;
  sendIceCandidate: (targetUserId: string, candidate: RTCIceCandidateInit) => void;
  onRemoteScreenStream: (userId: string, stream: MediaStream | null) => void;
  onRemoteCameraStream: (userId: string, stream: MediaStream | null) => void;
  onStatsUpdate: (stats: Record<string, PeerStats>) => void;
}

export class WebRtcMeshManager {
  private myUserId = '';
  private iceServers: RTCIceServer[] = [];
  private audioSettings: AudioSettings;
  private localMicStream: MediaStream | null = null;
  private localScreenStream: MediaStream | null = null;
  private localScreenOpts: ScreenShareOptions | null = null;
  private localCameraStream: MediaStream | null = null;
  private peerScreenStreamIds = new Map<string, string | null>();
  private peerCameraStreamIds = new Map<string, string | null>();
  private peers = new Map<string, PeerEntry>();
  private statsTimer: number | null = null;
  private statsInFlight = false;
  private statsRerunRequested = false;
  private lastRebuildAt = new Map<string, number>();

  private audioEngine: AudioEngine;
  private callbacks: MeshCallbacks;

  constructor(
    audioEngine: AudioEngine,
    audioSettings: AudioSettings,
    callbacks: MeshCallbacks,
  ) {
    this.audioEngine = audioEngine;
    this.audioSettings = audioSettings;
    this.callbacks = callbacks;
  }

  configure(myUserId: string, iceServers: RTCIceServer[], audioSettings: AudioSettings) {
    this.myUserId = myUserId;
    this.iceServers = iceServers;
    this.audioSettings = audioSettings;
  }

  updateIceServers(iceServers: RTCIceServer[]) {
    if (JSON.stringify(this.iceServers) === JSON.stringify(iceServers)) {
      return;
    }
    this.iceServers = iceServers;
    // Cloudflare TURN hands out fresh credentials on every fetch, so this changes often.
    // Swap the servers in place (used by the next ICE restart) instead of tearing down
    // calls that are working: rebuilding only our side used to strand the other side.
    for (const entry of this.peers.values()) {
      try {
        entry.pc.setConfiguration({ ...entry.pc.getConfiguration(), iceServers });
      } catch (err) {
        console.warn('ICE server update failed:', entry.userId, err);
      }
    }
  }

  private isFromRebuiltRemote(entry: PeerEntry | undefined, incomingSession: string | null) {
    return Boolean(
      entry &&
        incomingSession &&
        entry.remoteSdpSessionId &&
        entry.remoteSdpSessionId !== incomingSession,
    );
  }

  /**
   * Circuit breaker for "the remote rebuilt, so rebuild ours". If two different
   * connections answer for the same person (an old tab still open), each rebuild
   * provokes the next one; users saw that as "El sıkışıyor…/Bağlanıyor…" flipping.
   * A genuinely rebuilt remote re-sends its offer, so a skipped one is retried later.
   */
  private takeRebuildToken(userId: string): boolean {
    const now = performance.now();
    const last = this.lastRebuildAt.get(userId);
    if (last !== undefined && now - last < REBUILD_COOLDOWN_MS) return false;
    this.lastRebuildAt.set(userId, now);
    return true;
  }

  /** Sends a fresh offer right away (skipping the initiator rule) if nothing was negotiated yet. */
  private offerNowIfIdle(entry: PeerEntry) {
    if (entry.watchdogTimer !== null) {
      window.clearTimeout(entry.watchdogTimer);
      entry.watchdogTimer = null;
    }
    this.enqueue(entry, async () => {
      if (!entry.hasNegotiated && entry.pc.signalingState === 'stable') {
        await this.sendOfferNow(entry);
      }
    });
  }

  private clearIceRestartTimer(entry: PeerEntry) {
    if (entry.iceRestartTimer !== null) {
      window.clearTimeout(entry.iceRestartTimer);
      entry.iceRestartTimer = null;
    }
  }

  private clearOfferTimer(entry: PeerEntry) {
    if (entry.offerTimer !== null) {
      window.clearTimeout(entry.offerTimer);
      entry.offerTimer = null;
    }
  }

  /**
   * If the answer to this offer never arrives (signal lost, remote reloaded before
   * answering) we would sit in have-local-offer forever with no audio. Re-send the same
   * pending offer: it is valid whether the remote missed it, already answered it (answer
   * lost) or rebuilt its connection. Rolling back and re-offering is not: Chrome can
   * reorder m-lines, which a remote that already applied the first offer rejects.
   */
  private armOfferTimeout(entry: PeerEntry, isResend = false) {
    // Each new offer re-arms this and every applied answer clears it, so a timer that
    // fires while still in have-local-offer always belongs to the unanswered offer.
    this.clearOfferTimer(entry);
    entry.offerResends = isResend ? entry.offerResends + 1 : 0;
    // Back off 8s, 16s, 32s, 60s… so a peer we can't reach isn't hammered forever
    const delay = Math.min(
      OFFER_ANSWER_TIMEOUT_MS * 2 ** entry.offerResends,
      OFFER_ANSWER_TIMEOUT_MAX_MS,
    );
    entry.offerTimer = window.setTimeout(() => {
      entry.offerTimer = null;
      if (this.peers.get(entry.userId) !== entry) return;
      const { pc } = entry;
      if (pc.signalingState !== 'have-local-offer' || !pc.localDescription) return;
      console.warn('No answer from peer, re-sending offer:', entry.userId);
      this.callbacks.sendOffer(
        entry.userId,
        sanitizeRtcPayload({ type: pc.localDescription.type, sdp: pc.localDescription.sdp }),
        this.localScreenStream?.id ?? null,
        this.localCameraStream?.id ?? null,
      );
      this.armOfferTimeout(entry, true);
    }, delay);
  }

  updateAudioSettings(audioSettings: AudioSettings) {
    this.audioSettings = audioSettings;
  }

  setPeerScreenStreamId(userId: string, screenStreamId: string | null) {
    this.peerScreenStreamIds.set(userId, screenStreamId);
  }

  setPeerCameraStreamId(userId: string, cameraStreamId: string | null) {
    this.peerCameraStreamIds.set(userId, cameraStreamId);
  }

  clearRemoteScreenStream(userId: string) {
    this.audioEngine.removeScreenAudio(userId);
    const entry = this.peers.get(userId);
    if (entry && entry.screenStream) {
      entry.screenStream = null;
      this.callbacks.onRemoteScreenStream(userId, null);
    }
  }

  clearRemoteCameraStream(userId: string) {
    const entry = this.peers.get(userId);
    if (entry && entry.cameraStream) {
      entry.cameraStream = null;
      this.callbacks.onRemoteCameraStream(userId, null);
    }
  }

  private enqueue(entry: PeerEntry, task: () => Promise<void>): Promise<void> {
    const next = entry.queue
      .then(() => {
        if (this.peers.get(entry.userId) !== entry) return;
        return task();
      })
      .catch((err) => {
        console.warn('Peer signaling task error:', entry.userId, err);
      });
    entry.queue = next;
    return next;
  }

  private async triggerRenegotiation(entry: PeerEntry) {
    entry.needsRenegotiation = true;
    await this.enqueue(entry, async () => {
      if (entry.needsRenegotiation && entry.pc.signalingState === 'stable') {
        entry.needsRenegotiation = false;
        await this.sendOfferNow(entry);
      }
    });
  }

  private ensureBidirectionalAudio(entry: PeerEntry) {
    const micTrack = this.localMicStream?.getAudioTracks()[0] ?? null;
    if (!micTrack || !this.localMicStream) return;

    if (!entry.micSender) {
      const audioTransceiver = entry.pc
        .getTransceivers()
        .find((t) => t.receiver.track?.kind === 'audio');
      if (audioTransceiver) {
        audioTransceiver.direction = 'sendrecv';
        audioTransceiver.sender.replaceTrack(micTrack).catch(() => {});
        entry.micSender = audioTransceiver.sender;
      } else {
        entry.micSender = entry.pc.addTrack(micTrack, this.localMicStream);
      }
      return;
    }

    for (const transceiver of entry.pc.getTransceivers()) {
      if (transceiver.sender === entry.micSender && transceiver.direction !== 'sendrecv') {
        transceiver.direction = 'sendrecv';
      }
    }
  }

  async setMicStream(stream: MediaStream | null) {
    this.localMicStream = stream;
    const micTrack = stream?.getAudioTracks()[0] ?? null;

    for (const entry of this.peers.values()) {
      await this.enqueue(entry, async () => {
        if (entry.micSender) {
          try {
            await entry.micSender.replaceTrack(micTrack);
            let dirChanged = false;
            for (const t of entry.pc.getTransceivers()) {
              if (t.sender === entry.micSender && t.direction !== 'sendrecv') {
                t.direction = 'sendrecv';
                dirChanged = true;
              }
            }
            if (dirChanged) {
              await this.sendOfferNow(entry);
            }
          } catch {
            try {
              entry.pc.removeTrack(entry.micSender);
            } catch {
              // Ignore removeTrack failure
            }
            entry.micSender = micTrack && stream ? entry.pc.addTrack(micTrack, stream) : null;
            await this.sendOfferNow(entry);
          }
        } else if (micTrack && stream) {
          entry.micSender = entry.pc.addTrack(micTrack, stream);
          await this.sendOfferNow(entry);
        }
      });
    }
  }

  syncPeers(remoteUserIds: string[]) {
    const desired = new Set(remoteUserIds.filter((id) => id !== this.myUserId));

    for (const existingId of Array.from(this.peers.keys())) {
      if (!desired.has(existingId)) {
        this.closePeer(existingId);
      }
    }

    for (const remoteId of desired) {
      if (!this.peers.has(remoteId)) {
        this.createPeer(remoteId);
      }
    }

    if (this.peers.size > 0 && this.statsTimer === null) {
      this.statsTimer = window.setInterval(() => {
        this.collectStats().catch(() => {});
      }, 2000);
    } else if (this.peers.size === 0 && this.statsTimer !== null) {
      window.clearInterval(this.statsTimer);
      this.statsTimer = null;
      this.callbacks.onStatsUpdate({});
    }
  }

  reconnectAllPeers() {
    const ids = Array.from(this.peers.keys());
    for (const id of ids) {
      this.closePeer(id);
    }
    this.syncPeers(ids);
    // The other side still holds the old connection and doesn't know we rebuilt; offer now
    // so it sees our new session id and rebuilds too, rather than waiting on the watchdog.
    for (const id of ids) {
      const entry = this.peers.get(id);
      if (entry) this.offerNowIfIdle(entry);
    }
  }

  /**
   * Heals only peers whose ICE/connection state stalled while the mobile tab was backgrounded
   * or the screen was locked, leaving already-healthy peers untouched.
   */
  recoverStalledPeers(): number {
    let healed = 0;
    const closedIds: string[] = [];

    for (const [id, entry] of this.peers.entries()) {
      const ice = entry.pc.iceConnectionState;
      const conn = entry.pc.connectionState;
      if (ice === 'closed' || conn === 'closed') {
        closedIds.push(id);
      } else if (
        ice === 'failed' ||
        ice === 'disconnected' ||
        conn === 'failed' ||
        conn === 'disconnected'
      ) {
        this.clearIceRestartTimer(entry);
        if (typeof entry.pc.restartIce === 'function') {
          try {
            entry.pc.restartIce();
            healed += 1;
          } catch {
            // Ignore transient peer errors
          }
        }
      }
    }

    if (closedIds.length > 0) {
      const allIds = Array.from(this.peers.keys());
      for (const id of closedIds) {
        this.closePeer(id);
      }
      this.syncPeers(allIds);
      for (const id of closedIds) {
        const rebuilt = this.peers.get(id);
        if (rebuilt) this.offerNowIfIdle(rebuilt);
      }
      healed += closedIds.length;
    }

    return healed;
  }

  /**
   * Marks the voice sender as high priority so that, when a screen share saturates
   * the uplink, the bandwidth allocator and pacer starve the video instead of the voice.
   * Only meaningful after negotiation, so it is called once a description pair is applied.
   */
  private applyMicSenderPriority(entry: PeerEntry) {
    const sender = entry.micSender;
    if (!sender?.track || typeof sender.getParameters !== 'function') return;
    try {
      const params = sender.getParameters();
      const enc = params.encodings?.[0];
      if (!enc || (enc.priority === 'high' && enc.networkPriority === 'high')) return;
      enc.priority = 'high';
      enc.networkPriority = 'high';
      sender.setParameters(params).catch(() => {});
    } catch {
      // Older engines without encoding priorities
    }
  }

  private async setLocalWithOpusFallback(
    pc: RTCPeerConnection,
    desc: RTCSessionDescriptionInit,
  ) {
    const tunedSdp = tuneOpusSdp(desc.sdp || '', {
      bitrateKbps: this.audioSettings.opusBitrateKbps,
      stereo: this.audioSettings.stereo,
      dtx: false,
    });
    try {
      await pc.setLocalDescription({ type: desc.type, sdp: tunedSdp });
    } catch {
      await pc.setLocalDescription(desc);
    }
  }

  private async sendOfferNow(entry: PeerEntry) {
    const { pc } = entry;
    if (pc.signalingState !== 'stable') {
      entry.needsRenegotiation = true;
      return;
    }
    try {
      entry.makingOffer = true;
      entry.hasNegotiated = true;
      entry.needsRenegotiation = false;
      this.ensureBidirectionalAudio(entry);
      const offer = await pc.createOffer();
      await this.setLocalWithOpusFallback(pc, offer);
      this.armOfferTimeout(entry);
      if (pc.localDescription) {
        this.callbacks.sendOffer(
          entry.userId,
          sanitizeRtcPayload({
            type: pc.localDescription.type,
            sdp: pc.localDescription.sdp,
          }),
          this.localScreenStream?.id ?? null,
          this.localCameraStream?.id ?? null,
        );
      }
    } finally {
      entry.makingOffer = false;
    }
  }

  private createPeer(remoteUserId: string): PeerEntry {
    const pc = new RTCPeerConnection({
      iceServers: this.iceServers,
      iceCandidatePoolSize: 4,
    });

    const isInitiator = isInitiatorPeer(this.myUserId, remoteUserId);

    const entry: PeerEntry = {
      userId: remoteUserId,
      pc,
      isPolite: isPolitePeer(this.myUserId, remoteUserId),
      isInitiator,
      hasNegotiated: false,
      needsRenegotiation: false,
      watchdogTimer: null,
      iceRestartTimer: null,
      offerTimer: null,
      remoteSdpSessionId: null,
      queue: Promise.resolve(),
      makingOffer: false,
      ignoreOffer: false,
      pendingIce: [],
      micSender: null,
      screenVideoSender: null,
      screenAudioSender: null,
      cameraSender: null,
      hasAudioTrack: false,
      screenStream: null,
      cameraStream: null,
      prevAudioBytes: 0,
      prevVideoBytes: 0,
      prevPacketsLost: 0,
      prevPacketsReceived: 0,
      prevStatsTs: 0,
      lastAudioKbps: 0,
      lastVideoKbps: 0,
      lastLossPct: null,
      offerResends: 0,
    };

    const micTrack = this.localMicStream?.getAudioTracks()[0] ?? null;
    if (micTrack && this.localMicStream) {
      entry.micSender = pc.addTrack(micTrack, this.localMicStream);
    } else {
      pc.addTransceiver('audio', { direction: 'recvonly' });
    }

    if (this.localScreenStream) {
      this.attachLocalScreenToPeer(entry, this.localScreenStream, this.localScreenOpts);
    }
    if (this.localCameraStream) {
      const camTrack = this.localCameraStream.getVideoTracks()[0];
      if (camTrack) {
        entry.cameraSender = pc.addTrack(camTrack, this.localCameraStream);
      }
    }

    pc.onnegotiationneeded = () => {
      this.enqueue(entry, async () => {
        if (!entry.hasNegotiated && !entry.isInitiator) {
          return;
        }
        await this.sendOfferNow(entry);
      });
    };

    if (!isInitiator) {
      entry.watchdogTimer = window.setTimeout(() => {
        this.enqueue(entry, async () => {
          if (
            !entry.hasNegotiated &&
            entry.pc.signalingState === 'stable' &&
            entry.pc.iceConnectionState === 'new'
          ) {
            await this.sendOfferNow(entry);
          }
        });
      }, 3500);
    }

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        this.callbacks.sendIceCandidate(remoteUserId, sanitizeRtcPayload(candidate.toJSON()));
      }
    };

    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;
      if (state === 'failed') {
        this.clearIceRestartTimer(entry);
        if (typeof pc.restartIce === 'function') pc.restartIce();
      } else if (state === 'disconnected') {
        // Often a brief blip that heals itself; if it doesn't, restart ICE now instead of
        // sitting silent for the ~30s the browser takes to declare 'failed'.
        if (entry.iceRestartTimer === null) {
          entry.iceRestartTimer = window.setTimeout(() => {
            entry.iceRestartTimer = null;
            if (
              this.peers.get(entry.userId) === entry &&
              pc.iceConnectionState === 'disconnected' &&
              typeof pc.restartIce === 'function'
            ) {
              pc.restartIce();
            }
          }, ICE_DISCONNECT_GRACE_MS);
        }
      } else {
        this.clearIceRestartTimer(entry);
      }
      this.collectStats().catch(() => {});
    };

    pc.ontrack = (event) => {
      const { track, streams } = event;
      const stream = streams[0] ?? new MediaStream([track]);
      const expectedScreenId = this.peerScreenStreamIds.get(remoteUserId);
      const expectedCameraId = this.peerCameraStreamIds.get(remoteUserId);

      if (track.kind === 'video' && expectedCameraId && stream.id === expectedCameraId) {
        entry.cameraStream = new MediaStream([track]);
        this.callbacks.onRemoteCameraStream(remoteUserId, entry.cameraStream);
        track.onended = () => {
          entry.cameraStream = null;
          this.callbacks.onRemoteCameraStream(remoteUserId, null);
        };
        return;
      }

      const isScreenAudio =
        track.kind === 'audio' &&
        Boolean(expectedScreenId && stream.id === expectedScreenId);

      if (isScreenAudio) {
        this.audioEngine.setScreenAudioStream(remoteUserId, new MediaStream([track]));
        track.onended = () => {
          this.audioEngine.removeScreenAudio(remoteUserId, track.id);
        };
      } else if (track.kind === 'video') {
        entry.screenStream = new MediaStream([track]);
        this.callbacks.onRemoteScreenStream(remoteUserId, entry.screenStream);

        track.onended = () => {
          if (!entry.screenStream?.getTracks().some((t) => t.id === track.id)) return;
          entry.screenStream = null;
          this.callbacks.onRemoteScreenStream(remoteUserId, null);
          this.audioEngine.removeScreenAudio(remoteUserId);
        };
      } else if (track.kind === 'audio') {
        entry.hasAudioTrack = true;
        this.audioEngine.setPeerStream(remoteUserId, stream);
        this.collectStats().catch(() => {});
      }
    };

    this.peers.set(remoteUserId, entry);
    return entry;
  }

  async handleOffer(
    fromUserId: string,
    description: RTCSessionDescriptionInit,
    screenStreamId?: string | null,
    cameraStreamId?: string | null,
  ) {
    if (screenStreamId !== undefined) {
      this.peerScreenStreamIds.set(fromUserId, screenStreamId);
    }
    if (cameraStreamId !== undefined) {
      this.peerCameraStreamIds.set(fromUserId, cameraStreamId);
    }

    const incomingSession = sdpSessionId(description.sdp);
    let existing = this.peers.get(fromUserId);
    if (this.isFromRebuiltRemote(existing, incomingSession)) {
      if (!this.takeRebuildToken(fromUserId)) {
        console.warn('Ignoring offer from another connection of peer (cooldown):', fromUserId);
        return;
      }
      // The remote threw its RTCPeerConnection away (refresh button, ICE servers changed,
      // page reload). Its new DTLS identity can't be renegotiated onto our old connection,
      // which is what left calls stuck on "Bağlantı Koptu"; start fresh to match it.
      this.closePeer(fromUserId);
      existing = undefined;
    }
    const entry = existing ?? this.createPeer(fromUserId);
    if (entry.watchdogTimer !== null) {
      window.clearTimeout(entry.watchdogTimer);
      entry.watchdogTimer = null;
    }

    await this.enqueue(entry, async () => {
      const { pc } = entry;
      const offerCollision =
        description.type === 'offer' &&
        (entry.makingOffer || pc.signalingState !== 'stable');

      entry.ignoreOffer = !entry.isPolite && offerCollision;
      if (entry.ignoreOffer) {
        return;
      }

      if (offerCollision && entry.isPolite) {
        await pc.setLocalDescription({ type: 'rollback' }).catch(() => {});
      }

      await pc.setRemoteDescription(description);
      entry.remoteSdpSessionId = incomingSession ?? entry.remoteSdpSessionId;
      await this.flushPendingIce(entry);

      if (description.type === 'offer') {
        entry.hasNegotiated = true;
        this.ensureBidirectionalAudio(entry);
        const answer = await pc.createAnswer();
        await this.setLocalWithOpusFallback(pc, answer);
        this.applyMicSenderPriority(entry);
        if (pc.localDescription) {
          this.callbacks.sendAnswer(
            fromUserId,
            sanitizeRtcPayload({
              type: pc.localDescription.type,
              sdp: pc.localDescription.sdp,
            }),
          );
        }
      }

      if (entry.needsRenegotiation) {
        await this.sendOfferNow(entry);
      }
    });
  }

  async handleAnswer(fromUserId: string, description: RTCSessionDescriptionInit) {
    const entry = this.peers.get(fromUserId);
    if (!entry) return;
    const incomingSession = sdpSessionId(description.sdp);
    if (this.isFromRebuiltRemote(entry, incomingSession)) {
      // Only an answer to an offer we're still waiting on can mean "the remote rebuilt".
      // Anything else is a stray duplicate (a second tab of that person answering too).
      if (entry.pc.signalingState !== 'have-local-offer' || !this.takeRebuildToken(fromUserId)) {
        console.warn('Ignoring answer from another connection of peer:', fromUserId);
        return;
      }
      // A rebuilt remote answered our old connection's offer: rebuild ours as well and
      // offer straight away instead of waiting for the initiator/watchdog rules.
      this.closePeer(fromUserId);
      const fresh = this.createPeer(fromUserId);
      this.offerNowIfIdle(fresh);
      return;
    }
    await this.enqueue(entry, async () => {
      if (entry.pc.signalingState !== 'have-local-offer') return;
      entry.hasNegotiated = true;
      await entry.pc.setRemoteDescription(description);
      this.clearOfferTimer(entry);
      entry.remoteSdpSessionId = incomingSession ?? entry.remoteSdpSessionId;
      this.applyMicSenderPriority(entry);
      await this.flushPendingIce(entry);

      if (entry.needsRenegotiation) {
        await this.sendOfferNow(entry);
      }
    });
  }

  async handleIceCandidate(fromUserId: string, candidate: RTCIceCandidateInit) {
    const entry = this.peers.get(fromUserId);
    if (!entry) return;

    await this.enqueue(entry, async () => {
      if (!entry.pc.remoteDescription) {
        entry.pendingIce.push(candidate);
        return;
      }
      try {
        await entry.pc.addIceCandidate(candidate);
      } catch (err) {
        if (!entry.ignoreOffer) {
          console.warn('ICE add failed:', err);
        }
      }
    });
  }

  private async flushPendingIce(entry: PeerEntry) {
    while (entry.pendingIce.length > 0) {
      const cand = entry.pendingIce.shift();
      if (!cand) continue;
      try {
        await entry.pc.addIceCandidate(cand);
      } catch {
        // Ignore stale candidate
      }
    }
  }

  async startCamera(): Promise<MediaStream> {
    this.stopCamera();
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 640, max: 1280 },
        height: { ideal: 360, max: 720 },
        frameRate: { ideal: 24, max: 30 },
      },
      audio: false,
    });
    const camTrack = stream.getVideoTracks()[0];
    this.localCameraStream = stream;

    if (camTrack) {
      for (const entry of this.peers.values()) {
        await this.enqueue(entry, async () => {
          entry.cameraSender = entry.pc.addTrack(camTrack, stream);
        });
        await this.triggerRenegotiation(entry);
      }
    }
    return stream;
  }

  stopCamera() {
    if (this.localCameraStream) {
      for (const t of this.localCameraStream.getTracks()) {
        t.stop();
      }
      this.localCameraStream = null;
    }

    for (const entry of this.peers.values()) {
      if (!entry.cameraSender) continue;
      this.enqueue(entry, async () => {
        if (entry.cameraSender) {
          try {
            entry.pc.removeTrack(entry.cameraSender);
          } catch {
            // Ignore
          }
          entry.cameraSender = null;
        }
      }).then(() => this.triggerRenegotiation(entry));
    }
  }

  async startScreenShare(
    opts: ScreenShareOptions,
    onEndedByBrowser: () => void,
  ): Promise<MediaStream> {
    this.stopScreenShare();

    const displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        width: { ideal: opts.width, max: opts.width },
        height: { ideal: opts.height, max: opts.height },
        frameRate: { ideal: opts.frameRate, max: opts.frameRate },
      },
      audio: opts.includeAudio
        ? ({
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            // System-audio capture otherwise re-captures this app's own playback (friends'
            // voices, soundboard), so viewers hear every voice twice with a delay / echo.
            // Unsupported engines ignore unknown constraints.
            restrictOwnAudio: true,
          } as MediaTrackConstraints)
        : false,
    });

    const videoTrack = displayStream.getVideoTracks()[0];
    if (videoTrack) {
      if ('contentHint' in videoTrack) {
        videoTrack.contentHint = opts.contentHint;
      }
      videoTrack.onended = () => {
        this.stopScreenShare();
        onEndedByBrowser();
      };
    }

    this.localScreenStream = displayStream;
    this.localScreenOpts = opts;

    for (const entry of this.peers.values()) {
      await this.enqueue(entry, async () => {
        this.attachLocalScreenToPeer(entry, displayStream, opts);
      });
      await this.triggerRenegotiation(entry);
    }

    return displayStream;
  }

  private attachLocalScreenToPeer(
    entry: PeerEntry,
    stream: MediaStream,
    opts: ScreenShareOptions | null,
  ) {
    const videoTrack = stream.getVideoTracks()[0];
    if (videoTrack) {
      const sender = entry.pc.addTrack(videoTrack, stream);
      entry.screenVideoSender = sender;
      if (opts) {
        this.applyVideoSenderParams(sender, opts).catch(() => {});
      }
    }

    const audioTrack = stream.getAudioTracks()[0];
    if (audioTrack) {
      entry.screenAudioSender = entry.pc.addTrack(audioTrack, stream);
    }
  }

  private async applyVideoSenderParams(sender: RTCRtpSender, opts: ScreenShareOptions) {
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) {
      params.encodings = [{}];
    }
    params.encodings[0].maxBitrate = opts.maxBitrateBps;
    params.encodings[0].maxFramerate = opts.frameRate;
    params.degradationPreference =
      opts.contentHint === 'motion' ? 'maintain-framerate' : 'maintain-resolution';
    await sender.setParameters(params);
  }

  stopScreenShare() {
    if (this.localScreenStream) {
      for (const track of this.localScreenStream.getTracks()) {
        track.onended = null;
        track.stop();
      }
      this.localScreenStream = null;
      this.localScreenOpts = null;
    }

    for (const entry of this.peers.values()) {
      const hadSenders = Boolean(entry.screenVideoSender || entry.screenAudioSender);
      if (!hadSenders) continue;
      this.enqueue(entry, async () => {
        if (entry.screenVideoSender) {
          try {
            entry.pc.removeTrack(entry.screenVideoSender);
          } catch {
            // Ignore
          }
          entry.screenVideoSender = null;
        }
        if (entry.screenAudioSender) {
          try {
            entry.pc.removeTrack(entry.screenAudioSender);
          } catch {
            // Ignore
          }
          entry.screenAudioSender = null;
        }
      }).then(() => this.triggerRenegotiation(entry));
    }
  }

  private closePeer(userId: string) {
    const entry = this.peers.get(userId);
    if (!entry) return;
    if (entry.watchdogTimer !== null) {
      window.clearTimeout(entry.watchdogTimer);
      entry.watchdogTimer = null;
    }
    this.clearIceRestartTimer(entry);
    this.clearOfferTimer(entry);
    entry.pc.onnegotiationneeded = null;
    entry.pc.onicecandidate = null;
    entry.pc.oniceconnectionstatechange = null;
    entry.pc.ontrack = null;
    entry.pc.close();
    this.peers.delete(userId);
    this.audioEngine.removePeer(userId);
    this.callbacks.onRemoteScreenStream(userId, null);
    this.callbacks.onRemoteCameraStream(userId, null);
  }

  closeAll() {
    this.stopScreenShare();
    this.stopCamera();
    for (const userId of Array.from(this.peers.keys())) {
      this.closePeer(userId);
    }
    if (this.statsTimer !== null) {
      window.clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
    this.callbacks.onStatsUpdate({});
  }

  /**
   * Collections are serialized: overlapping async runs would interleave the per-peer
   * "previous counter" bookkeeping. A request during a run triggers one more run after.
   */
  private async collectStats() {
    if (this.statsInFlight) {
      this.statsRerunRequested = true;
      return;
    }
    this.statsInFlight = true;
    try {
      do {
        this.statsRerunRequested = false;
        await this.collectStatsOnce();
      } while (this.statsRerunRequested);
    } finally {
      this.statsInFlight = false;
    }
  }

  private async collectStatsOnce() {
    const result: Record<string, PeerStats> = {};
    const now = performance.now();

    for (const [userId, entry] of this.peers.entries()) {
      try {
        const report = await entry.pc.getStats();
        let rttMs: number | null = null;
        let packetsLost = 0;
        let packetsReceived = 0;
        let audioBytes = 0;
        let videoBytes = 0;
        let videoResolution: string | null = null;
        let videoFps: number | null = null;
        let usingRelay = false;
        const candidateTypes = new Map<string, string>();

        report.forEach((stat) => {
          if (stat.type === 'local-candidate' || stat.type === 'remote-candidate') {
            candidateTypes.set(stat.id, String(stat.candidateType || ''));
          }
        });

        // Only the pair ICE actually selected tells us the real path (direct P2P vs TURN)
        const selectedPair = findSelectedCandidatePair(report);
        if (selectedPair) {
          if (typeof selectedPair.currentRoundTripTime === 'number') {
            rttMs = Math.round(selectedPair.currentRoundTripTime * 1000);
          }
          const localType = candidateTypes.get(String(selectedPair.localCandidateId || ''));
          const remoteType = candidateTypes.get(String(selectedPair.remoteCandidateId || ''));
          usingRelay = localType === 'relay' || remoteType === 'relay';
        }

        let jitterMs: number | null = null;
        report.forEach((stat) => {
          if (stat.type === 'inbound-rtp') {
            if (stat.kind === 'audio') {
              audioBytes += Number(stat.bytesReceived || 0);
              packetsLost += Number(stat.packetsLost || 0);
              packetsReceived += Number(stat.packetsReceived || 0);
              if (typeof stat.jitter === 'number') {
                jitterMs = Math.max(jitterMs ?? 0, Math.round(stat.jitter * 1000));
              }
            } else if (stat.kind === 'video') {
              videoBytes += Number(stat.bytesReceived || 0);
              if (stat.frameWidth && stat.frameHeight) {
                videoResolution = `${stat.frameWidth}x${stat.frameHeight}`;
              }
              if (typeof stat.framesPerSecond === 'number') {
                videoFps = Math.round(stat.framesPerSecond);
              }
            }
          }
        });

        // Rates and loss are measured over a window of at least MIN_STATS_WINDOW_MS. Extra
        // collections (ICE state changes, ontrack) can land milliseconds apart, where one
        // lost packet out of three would read as 33 % loss; those reuse the last window.
        const windowMs = now - entry.prevStatsTs;
        if (entry.prevStatsTs === 0 || windowMs >= MIN_STATS_WINDOW_MS) {
          const dtSec = entry.prevStatsTs > 0 ? windowMs / 1000 : 0;
          entry.lastAudioKbps =
            dtSec > 0
              ? Math.max(0, Math.round(((audioBytes - entry.prevAudioBytes) * 8) / 1000 / dtSec))
              : 0;
          entry.lastVideoKbps =
            dtSec > 0
              ? Math.max(0, Math.round(((videoBytes - entry.prevVideoBytes) * 8) / 1000 / dtSec))
              : 0;
          // Loss over this window only: a cumulative figure hides a call that is breaking
          // up right now behind a long clean history (and vice versa).
          const lostNow = Math.max(0, packetsLost - entry.prevPacketsLost);
          const receivedNow = Math.max(0, packetsReceived - entry.prevPacketsReceived);
          const windowPackets = lostNow + receivedNow;
          entry.lastLossPct =
            windowPackets > 0 ? Math.round((lostNow / windowPackets) * 1000) / 10 : null;

          entry.prevAudioBytes = audioBytes;
          entry.prevVideoBytes = videoBytes;
          entry.prevPacketsLost = packetsLost;
          entry.prevPacketsReceived = packetsReceived;
          entry.prevStatsTs = now;
        }
        const audioKbps = entry.lastAudioKbps;
        const videoKbps = entry.lastVideoKbps;
        const packetLossPct = entry.lastLossPct;

        result[userId] = {
          rttMs,
          packetLossPct,
          jitterMs,
          audioKbps,
          videoKbps,
          videoResolution,
          videoFps,
          iceState: entry.pc.iceConnectionState || 'new',
          usingRelay,
          hasAudioTrack: entry.hasAudioTrack,
        };
      } catch {
        // Ignore single peer stat errors
      }
    }

    this.callbacks.onStatsUpdate(result);
  }
}
