import { AudioEngine } from '../src/lib/audioEngine';
import { WebRtcMeshManager } from '../src/lib/webrtcMesh';
import type { AudioSettings, PeerStats } from '../src/types/protocol';

/**
 * Two of these pages (e.g. ?me=alice and ?me=bob, same ?room) call each other with the
 * app's real audio + WebRTC code. Signaling goes over a BroadcastChannel, which keeps the
 * in-order delivery Firebase gives us, and lets tests drop messages to inject faults.
 */

type Signal =
  | { kind: 'offer'; from: string; to: string; sdp: RTCSessionDescriptionInit; screen: string | null; camera: string | null }
  | { kind: 'answer'; from: string; to: string; sdp: RTCSessionDescriptionInit }
  | { kind: 'ice'; from: string; to: string; candidate: RTCIceCandidateInit };

const params = new URLSearchParams(window.location.search);
const me = params.get('me') ?? 'alice';
const room = params.get('room') ?? 'default';
const bus = new BroadcastChannel(`sv-e2e-${room}`);

const settings: AudioSettings = {
  inputDeviceId: 'default',
  outputDeviceId: 'default',
  opusBitrateKbps: 96,
  stereo: false,
  echoCancellation: true,
  noiseSuppression: true,
  noiseSuppressionMode: 'standard',
  autoGainControl: true,
  inputSensitivity: 'auto',
  gateThresholdDb: -50,
  pttEnabled: false,
  pttKey: 'Backquote',
  soundsEnabled: false,
  desktopNotifications: false,
};

let latestStats: Record<string, PeerStats> = {};
const drop = { answer: 0, offer: 0 };
const sent = { offer: 0, answer: 0, ice: 0 };

function post(signal: Signal) {
  if (signal.kind !== 'ice' && drop[signal.kind] > 0) {
    drop[signal.kind] -= 1;
    return;
  }
  sent[signal.kind] += 1;
  bus.postMessage(signal);
}

let peakMicLevel = 0;

const audio = new AudioEngine({
  onSpeakingChange: () => {},
  onMicLevel: (level) => {
    peakMicLevel = Math.max(peakMicLevel, level);
  },
  onAutoplayBlocked: () => {},
});

const mesh = new WebRtcMeshManager(audio, settings, {
  sendOffer: (to, sdp, screen, camera) => post({ kind: 'offer', from: me, to, sdp, screen, camera }),
  sendAnswer: (to, sdp) => post({ kind: 'answer', from: me, to, sdp }),
  sendIceCandidate: (to, candidate) => post({ kind: 'ice', from: me, to, candidate }),
  onRemoteScreenStream: () => {},
  onRemoteCameraStream: () => {},
  onStatsUpdate: (stats) => {
    latestStats = stats;
  },
});

bus.onmessage = (event: MessageEvent<Signal>) => {
  const signal = event.data;
  if (signal.to !== me) return;
  if (signal.kind === 'offer') {
    mesh.handleOffer(signal.from, signal.sdp, signal.screen, signal.camera).catch(() => {});
  } else if (signal.kind === 'answer') {
    mesh.handleAnswer(signal.from, signal.sdp).catch(() => {});
  } else {
    mesh.handleIceCandidate(signal.from, signal.candidate).catch(() => {});
  }
};

/** Test-only peek at the mesh's private connections. */
function peerConnection(peerId: string): RTCPeerConnection | null {
  const peers = (mesh as unknown as { peers: Map<string, { pc: RTCPeerConnection; micSender: RTCRtpSender | null }> }).peers;
  return peers.get(peerId)?.pc ?? null;
}

function micSender(peerId: string): RTCRtpSender | null {
  const peers = (mesh as unknown as { peers: Map<string, { micSender: RTCRtpSender | null }> }).peers;
  return peers.get(peerId)?.micSender ?? null;
}

const pcIds = new WeakMap<RTCPeerConnection, number>();
let nextPcId = 1;

const api = {
  me,
  async start(peers: string[]) {
    mesh.configure(me, [], settings);
    await audio.unlockAudio();
    const stream = await audio.acquireMic(settings);
    await mesh.setMicStream(stream);
    mesh.syncPeers(peers);
  },
  /** Stable id for the current RTCPeerConnection object, to detect rebuilds. */
  pcId(peerId: string): number | null {
    const pc = peerConnection(peerId);
    if (!pc) return null;
    if (!pcIds.has(pc)) pcIds.set(pc, nextPcId++);
    return pcIds.get(pc) ?? null;
  },
  iceState(peerId: string): string | null {
    return peerConnection(peerId)?.iceConnectionState ?? null;
  },
  async inboundAudio(peerId: string): Promise<{ bytes: number; energy: number }> {
    const pc = peerConnection(peerId);
    if (!pc) return { bytes: 0, energy: 0 };
    let bytes = 0;
    let energy = 0;
    (await pc.getStats()).forEach((stat) => {
      if (stat.type === 'inbound-rtp' && stat.kind === 'audio') {
        bytes += Number(stat.bytesReceived || 0);
        energy += Number(stat.totalAudioEnergy || 0);
      }
    });
    return { bytes, energy };
  },
  remoteAudioPlaying(): boolean {
    const els = Array.from(document.querySelectorAll<HTMLAudioElement>('#squadvoice-audio-host audio'));
    return els.length > 0 && els.every((el) => !el.paused && el.srcObject !== null);
  },
  micPriority(peerId: string): string | null {
    return micSender(peerId)?.getParameters().encodings?.[0]?.priority ?? null;
  },
  stats: () => latestStats,
  sent: () => ({ ...sent }),
  dropNext(kind: 'offer' | 'answer', count = 1) {
    drop[kind] += count;
  },
  reconnect() {
    mesh.reconnectAllPeers();
  },
  rotateIceServers() {
    mesh.updateIceServers([{ urls: 'stun:127.0.0.1:9' }]);
  },
  /** Same path the app takes when a headset is plugged in mid-call. */
  async swapMic() {
    const stream = await audio.acquireMic(settings, { settleMs: 50 });
    await mesh.setMicStream(stream);
  },
  async startMicTest() {
    peakMicLevel = 0;
    await audio.startMicTest(settings);
  },
  stopMicTest() {
    audio.stopMicTest();
  },
  micTestRunning: () => audio.isMicTestRunning(),
  setSensitivity(mode: 'auto' | 'manual' | 'off', gateThresholdDb = -50) {
    settings.inputSensitivity = mode;
    settings.gateThresholdDb = gateThresholdDb;
    audio.applySensitivity(settings);
  },
  micTrackEnabled: () => audio.getMicTrack()?.enabled ?? null,
  peakMicLevel: () => peakMicLevel,
  leave() {
    mesh.closeAll();
    audio.destroyAll();
  },
};

(window as unknown as { sv: typeof api }).sv = api;
document.title = `harness:${me}:ready`;
