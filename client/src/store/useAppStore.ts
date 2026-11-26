import { create } from 'zustand';
import { api } from '../lib/api';
import { AudioEngine } from '../lib/audioEngine';
import {
  dmPairId,
  getStaticIceServers,
  isFirebaseEnabled,
  resolveIceServers,
} from '../lib/firebase';
import { firebaseBackend } from '../lib/firebaseBackend';
import {
  getDefaultServerUrl,
  registerGlobalPttShortcut,
  saveServerUrl,
} from '../lib/platform';
import { playSoundboard, playUiSound } from '../lib/sounds';
import {
  chatScopeKey,
  FIREBASE_PAGE_SIZE,
  mayHaveMore,
  mergeOlderMessages,
  nextWindowSize,
  SERVER_PAGE_SIZE,
  type ChatScope,
} from '../lib/chatHistory';
import { appendSample, sampleFromStats, type QualitySample } from '../lib/connectionQuality';
import { shouldReacquireMic } from '../lib/micDevices';
import { classifyOwnVoiceEntry, isSignalFromVoiceSession } from '../lib/voiceSession';
import { WebRtcMeshManager } from '../lib/webrtcMesh';
import { SquadWsClient } from '../lib/ws';
import type {
  AudioSettings,
  Channel,
  Message,
  MessageReplyRef,
  PeerStats,
  PublicUser,
  ScreenShareOptions,
  SoundboardEvent,
  SoundboardId,
  TurnConfig,
  UserStatus,
  VoiceMemberState,
  WsServerEvent,
} from '../types/protocol';
import { useMicLevelStore } from './useMicLevelStore';

const TOKEN_KEY = 'squadvoice_token';
const AUDIO_SETTINGS_KEY = 'squadvoice_audio_settings';
const PEER_VOLUMES_KEY = 'squadvoice_peer_volumes';

const DEFAULT_AUDIO_SETTINGS: AudioSettings = {
  inputDeviceId: 'default',
  outputDeviceId: 'default',
  opusBitrateKbps: 96,
  stereo: false,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  inputSensitivity: 'auto',
  gateThresholdDb: -50,
  pttEnabled: false,
  pttKey: 'Backquote',
  soundsEnabled: true,
  desktopNotifications: false,
};

function loadAudioSettings(): AudioSettings {
  try {
    const raw = localStorage.getItem(AUDIO_SETTINGS_KEY);
    if (!raw) return DEFAULT_AUDIO_SETTINGS;
    return { ...DEFAULT_AUDIO_SETTINGS, ...(JSON.parse(raw) as Partial<AudioSettings>) };
  } catch {
    return DEFAULT_AUDIO_SETTINGS;
  }
}

function loadPeerVolumes(): Record<string, number> {
  try {
    const raw = localStorage.getItem(PEER_VOLUMES_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as Record<string, number>;
  } catch {
    return {};
  }
}

export interface AppState {
  firebaseMode: boolean;
  serverName: string;
  serverUrl: string;
  token: string | null;
  user: PublicUser | null;
  adminInviteCode: string | null;
  turnConfig: TurnConfig | null;
  wsStatus: 'connecting' | 'connected' | 'disconnected';
  authLoading: boolean;
  authError: string | null;

  channels: Channel[];
  activeTextChannelId: string | null;
  activeDmUserId: string | null;
  messagesByChannel: Record<string, Message[]>;
  dmMessagesByPeer: Record<string, Message[]>;
  unreadByChannel: Record<string, number>;
  typingUsers: Array<{ user_id: string; display_name: string }>;

  onlineUsers: PublicUser[];
  allUsers: PublicUser[];
  voiceMembers: VoiceMemberState[];
  activeVoiceChannelId: string | null;
  memberListOpen: boolean;

  muted: boolean;
  forceMuted: boolean;
  deafened: boolean;
  speaking: boolean;
  pttActive: boolean;
  needsAudioUnlock: boolean;

  audioSettings: AudioSettings;
  peerVolumes: Record<string, number>;
  peerStats: Record<string, PeerStats>;
  peerQualityHistory: Record<string, QualitySample[]>;
  turnEnabled: boolean;
  iceServers: RTCIceServer[];

  localScreenStream: MediaStream | null;
  remoteScreenStreams: Record<string, MediaStream>;
  focusedStreamUserId: string | null;
  localCameraStream: MediaStream | null;
  remoteCameraStreams: Record<string, MediaStream>;
  lastSoundboard: SoundboardEvent | null;

  toastError: string | null;
  /** Neutral notice (auto-dismissed), e.g. "Mikrofon değişti". */
  toastInfo: string | null;
  micTestActive: boolean;
  /** Per conversation (channel id or "dm:<peer>"): older messages may exist. */
  chatHistoryMore: Record<string, boolean>;
  loadingOlderMessages: boolean;

  // Auth & Profile
  setServerUrl: (url: string) => void;
  bootstrap: () => Promise<void>;
  login: (username: string, password: string, serverUrl?: string) => Promise<void>;
  register: (
    username: string,
    displayName: string,
    email: string,
    password: string,
    inviteCode: string,
    serverUrl?: string,
  ) => Promise<void>;
  resetPassword: (email: string) => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  updateOwnProfile: (patch: {
    display_name?: string;
    avatar_color?: string;
    avatar_url?: string | null;
    status?: UserStatus;
    custom_status?: string | null;
  }) => Promise<void>;
  logout: () => void;

  // Channels, DMs, & Messages
  selectTextChannel: (channelId: string) => Promise<void>;
  openDm: (peerUserId: string) => void;
  toggleMemberList: () => void;
  sendMessage: (
    content: string,
    attachment?: { url: string; name: string } | null,
    replyTo?: MessageReplyRef | null,
  ) => void;
  editMessage: (messageId: string, content: string) => Promise<void>;
  deleteMessage: (channelId: string, messageId: string) => Promise<void>;
  toggleReaction: (messageId: string, emoji: string, active: boolean) => Promise<void>;
  togglePinMessage: (messageId: string, pinned: boolean) => Promise<void>;
  setTyping: (isTyping: boolean) => void;
  createChannel: (name: string, kind: 'text' | 'voice') => Promise<void>;
  renameChannel: (channelId: string, newName: string) => Promise<void>;
  deleteChannel: (channelId: string) => Promise<void>;
  clearChannelMessages: (channelId: string) => Promise<void>;

  // Voice, Camera, Screen, & Soundboard
  joinVoice: (channelId: string) => Promise<void>;
  leaveVoice: () => void;
  reconnectVoicePeers: () => void;
  toggleMute: () => void;
  toggleDeafen: () => void;
  startCamera: () => Promise<void>;
  stopCamera: () => void;
  startScreenShare: (opts: ScreenShareOptions) => Promise<void>;
  stopScreenShare: () => void;
  playRoomSoundboard: (sound: SoundboardId) => Promise<void>;
  setFocusedStreamUser: (userId: string | null) => void;
  setPeerVolume: (userId: string, volume: number) => void;
  updateAudioSettings: (patch: Partial<AudioSettings>) => Promise<void>;
  unlockAudio: () => Promise<void>;

  // Admin Actions
  updateInviteCode: (code: string) => Promise<void>;
  updateServerName: (name: string) => Promise<void>;
  updateTurnConfig: (turn: TurnConfig | null) => Promise<void>;
  setUserRole: (targetUid: string, role: 'admin' | 'member') => Promise<void>;
  kickMember: (targetUser: PublicUser) => Promise<void>;
  adminForceMute: (targetUid: string, forceMuted: boolean) => Promise<void>;
  adminDisconnectVoice: (targetUid: string) => Promise<void>;
  adminMoveVoice: (targetUid: string, targetChannelId: string) => Promise<void>;

  clearToast: () => void;
  startMicTest: () => Promise<void>;
  stopMicTest: () => void;
  loadOlderMessages: () => Promise<void>;
}

let pttCleanup: (() => void) | null = null;
let wsClient: SquadWsClient | null = null;
let audioEngine: AudioEngine | null = null;
let rtcMesh: WebRtcMeshManager | null = null;

let fbAuthUnsub: (() => void) | null = null;
let fbSessionUnsub: (() => void) | null = null;
let fbMessagesUnsub: (() => void) | null = null;
let fbTypingUnsub: (() => void) | null = null;
let fbSoundboardUnsub: (() => void) | null = null;
const fbUnreadUnsubs = new Map<string, () => void>();
const lastSeenMsgIds = new Map<string, string>();
let prevVoicePeerIds = new Set<string>();
let soundboardClearTimer: number | null = null;
let lastRegularTextChannelId: string | null = null;
let selfLeavingVoice = false;

function resolveFallbackTextChannelId(channels: Channel[]): string | null {
  if (
    lastRegularTextChannelId &&
    channels.some((c) => c.id === lastRegularTextChannelId && c.kind === 'text')
  ) {
    return lastRegularTextChannelId;
  }
  return channels.find((c) => c.kind === 'text')?.id || null;
}

function maybePlayUi(kind: Parameters<typeof playUiSound>[0]) {
  const s = useAppStore.getState();
  if (!s.audioSettings.soundsEnabled || s.deafened) return;
  if (s.user?.status === 'dnd') return;
  playUiSound(kind);
}

function maybeNotifyDesktop(title: string, body: string) {
  const s = useAppStore.getState();
  if (!s.audioSettings.desktopNotifications || s.user?.status === 'dnd') return;
  if (typeof document !== 'undefined' && document.visibilityState === 'visible') return;
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    try {
      new Notification(title, { body });
    } catch {
      // Ignore notification errors on mobile
    }
  }
}

function ensureEngines() {
  if (!audioEngine) {
    audioEngine = new AudioEngine({
      onSpeakingChange: (speaking) => {
        const state = useAppStore.getState();
        if (state.muted || state.deafened || state.forceMuted) {
          useAppStore.setState({ speaking: false });
          return;
        }
        useAppStore.setState({ speaking });
        if (state.firebaseMode && state.user && state.activeVoiceChannelId) {
          firebaseBackend.updateVoiceState(state.user.id, { speaking }).catch(() => {});
        } else {
          wsClient?.send({ type: 'speaking', speaking });
        }
      },
      onMicLevel: (level) => {
        useMicLevelStore.getState().setMicLevel(level);
      },
      onAutoplayBlocked: (needsAudioUnlock) => {
        useAppStore.setState({ needsAudioUnlock });
      },
      onGateThreshold: (threshold) => {
        useMicLevelStore.getState().setGateThreshold(threshold);
      },
    });
    audioEngine.applySensitivity(loadAudioSettings());
    const savedVolumes = loadPeerVolumes();
    for (const [uid, vol] of Object.entries(savedVolumes)) {
      audioEngine.setPeerVolume(uid, vol);
    }
    audioEngine.setMicLostHandler(scheduleMicCheck);
    audioEngine.setMicTestStoppedHandler(() => {
      useAppStore.setState({ micTestActive: false });
    });
    navigator.mediaDevices?.addEventListener?.('devicechange', scheduleMicCheck);
  }

  if (!rtcMesh) {
    rtcMesh = new WebRtcMeshManager(audioEngine, loadAudioSettings(), {
      sendOffer: (targetUserId, sdp, screenStreamId, cameraStreamId) => {
        const state = useAppStore.getState();
        if (state.firebaseMode && state.user) {
          firebaseBackend
            .sendRtcSignal(targetUserId, {
              kind: 'offer',
              from_user_id: state.user.id,
              sdp,
              screen_stream_id: screenStreamId,
              camera_stream_id: cameraStreamId,
            })
            .catch(() => {});
        } else {
          wsClient?.send({
            type: 'rtc_offer',
            target_user_id: targetUserId,
            sdp,
            screen_stream_id: screenStreamId,
            camera_stream_id: cameraStreamId,
          });
        }
      },
      sendAnswer: (targetUserId, sdp) => {
        const state = useAppStore.getState();
        if (state.firebaseMode && state.user) {
          firebaseBackend
            .sendRtcSignal(targetUserId, {
              kind: 'answer',
              from_user_id: state.user.id,
              sdp,
            })
            .catch(() => {});
        } else {
          wsClient?.send({
            type: 'rtc_answer',
            target_user_id: targetUserId,
            sdp,
          });
        }
      },
      sendIceCandidate: (targetUserId, candidate) => {
        const state = useAppStore.getState();
        if (state.firebaseMode && state.user) {
          firebaseBackend
            .sendRtcSignal(targetUserId, {
              kind: 'ice',
              from_user_id: state.user.id,
              candidate,
            })
            .catch(() => {});
        } else {
          wsClient?.send({
            type: 'rtc_ice_candidate',
            target_user_id: targetUserId,
            candidate,
          });
        }
      },
      onRemoteScreenStream: (userId, stream) => {
        useAppStore.setState((prev) => {
          const next = { ...prev.remoteScreenStreams };
          if (stream) {
            next[userId] = stream;
          } else {
            delete next[userId];
          }
          const focused =
            prev.focusedStreamUserId === userId && !stream
              ? Object.keys(next)[0] || null
              : prev.focusedStreamUserId || (stream ? userId : null);
          return { remoteScreenStreams: next, focusedStreamUserId: focused };
        });
      },
      onRemoteCameraStream: (userId, stream) => {
        useAppStore.setState((prev) => {
          const next = { ...prev.remoteCameraStreams };
          if (stream) {
            next[userId] = stream;
          } else {
            delete next[userId];
          }
          return { remoteCameraStreams: next };
        });
      },
      onStatsUpdate: (peerStats) => {
        const now = Date.now();
        useAppStore.setState((prev) => {
          // Rolling ~1 minute per peer for the connection-quality sparklines;
          // peers that left drop out because only current stats are carried over.
          const peerQualityHistory: Record<string, QualitySample[]> = {};
          for (const [uid, stats] of Object.entries(peerStats)) {
            peerQualityHistory[uid] = appendSample(
              prev.peerQualityHistory[uid],
              sampleFromStats(stats, now),
            );
          }
          return { peerStats, peerQualityHistory };
        });
      },
    });
  }

  if (!wsClient && !isFirebaseEnabled()) {
    wsClient = new SquadWsClient(handleWsEvent, (wsStatus) => {
      useAppStore.setState({ wsStatus });
    });
  }
}

let toastInfoTimer: number | null = null;

function showInfo(message: string) {
  if (toastInfoTimer !== null) window.clearTimeout(toastInfoTimer);
  useAppStore.setState({ toastInfo: message });
  toastInfoTimer = window.setTimeout(() => {
    toastInfoTimer = null;
    useAppStore.setState({ toastInfo: null });
  }, 5000);
}

let micCheckTimer: number | null = null;
let micRecovering = false;

/** devicechange fires in bursts (each device of a headset); check once it settles. */
function scheduleMicCheck() {
  if (micCheckTimer !== null) window.clearTimeout(micCheckTimer);
  micCheckTimer = window.setTimeout(() => {
    micCheckTimer = null;
    recoverMicIfNeeded().catch(() => {});
  }, 600);
}

/** Re-opens the call's mic when it was unplugged or the system default changed. */
async function recoverMicIfNeeded() {
  const s = useAppStore.getState();
  if (!s.activeVoiceChannelId || !audioEngine || !rtcMesh || micRecovering) return;
  const track = audioEngine.getMicTrack();
  const trackSettings = track?.getSettings?.() ?? {};
  const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
  const needed = shouldReacquireMic({
    track: track
      ? {
          readyState: track.readyState,
          deviceId: trackSettings.deviceId,
          groupId: trackSettings.groupId,
        }
      : null,
    selectedDeviceId: s.audioSettings.inputDeviceId,
    devices,
  });
  if (!needed) return;

  micRecovering = true;
  try {
    const stream = await audioEngine.acquireMic(useAppStore.getState().audioSettings, {
      settleMs: 200,
    });
    if (!useAppStore.getState().activeVoiceChannelId) {
      audioEngine.stopMic(); // left the call meanwhile
      return;
    }
    await rtcMesh.setMicStream(stream);
    syncMicTransmission();
    const label = stream.getAudioTracks()[0]?.label;
    showInfo(label ? `Mikrofon değişti: ${label}` : 'Mikrofon yeniden bağlandı.');
  } catch (err) {
    useAppStore.setState({
      toastError:
        err instanceof Error
          ? `Mikrofon bulunamadı: ${err.message}`
          : 'Mikrofon bulunamadı, bir mikrofon takıp tekrar dene.',
    });
  } finally {
    micRecovering = false;
  }
}

/** Tears down this device's call state and returns to a text channel if needed. */
function leaveVoiceLocally(toast: string | null) {
  const st = useAppStore.getState();
  const prevVoiceId = st.activeVoiceChannelId;
  const shouldReturnToText = !st.activeDmUserId && st.activeTextChannelId === prevVoiceId;
  rtcMesh?.closeAll();
  audioEngine?.destroyAll();
  subscribeFirebaseSoundboard(null);
  prevVoicePeerIds.clear();
  useAppStore.setState({
    activeVoiceChannelId: null,
    forceMuted: false,
    speaking: false,
    localScreenStream: null,
    localCameraStream: null,
    remoteScreenStreams: {},
    remoteCameraStreams: {},
    focusedStreamUserId: null,
    peerStats: {},
    toastError: toast,
  });
  if (shouldReturnToText) {
    const fallbackId = resolveFallbackTextChannelId(useAppStore.getState().channels);
    if (fallbackId) {
      useAppStore.getState().selectTextChannel(fallbackId);
    }
  }
}

function syncMicTransmission() {
  const s = useAppStore.getState();
  const transmit =
    !s.muted &&
    !s.deafened &&
    !s.forceMuted &&
    (!s.audioSettings.pttEnabled || s.pttActive);
  audioEngine?.setMicEnabled(transmit);
}

function setupPttBinding(settings: AudioSettings) {
  if (pttCleanup) {
    pttCleanup();
    pttCleanup = null;
  }
  if (!settings.pttEnabled) {
    useAppStore.setState({ pttActive: false });
    syncMicTransmission();
    return;
  }
  registerGlobalPttShortcut(
    settings.pttKey,
    () => {
      useAppStore.setState({ pttActive: true });
      syncMicTransmission();
    },
    () => {
      useAppStore.setState({ pttActive: false });
      syncMicTransmission();
    },
  ).then((cleanup) => {
    pttCleanup = cleanup;
  });
}

function pruneStoppedRemoteMedia(
  voiceMembers: VoiceMemberState[],
  activeChannelId: string | null,
) {
  const inRoom = voiceMembers.filter((m) => m.channel_id === activeChannelId);
  const sharingIds = new Set(inRoom.filter((m) => m.screen_sharing).map((m) => m.user_id));
  const cameraIds = new Set(inRoom.filter((m) => m.camera_on).map((m) => m.user_id));

  const state = useAppStore.getState();
  for (const uid of Object.keys(state.remoteScreenStreams)) {
    if (!sharingIds.has(uid)) {
      rtcMesh?.clearRemoteScreenStream(uid);
    }
  }
  for (const uid of Object.keys(state.remoteCameraStreams)) {
    if (!cameraIds.has(uid)) {
      rtcMesh?.clearRemoteCameraStream(uid);
    }
  }
}

let currentChatScope: ChatScope | null = null;
let currentChatWindow = FIREBASE_PAGE_SIZE;

function markHistory(key: string, received: number, requested: number) {
  useAppStore.setState((prev) => ({
    chatHistoryMore: { ...prev.chatHistoryMore, [key]: mayHaveMore(received, requested) },
    loadingOlderMessages: false,
  }));
}

function subscribeFirebaseChatScope(scope: ChatScope, windowSize = FIREBASE_PAGE_SIZE) {
  if (fbMessagesUnsub) {
    fbMessagesUnsub();
    fbMessagesUnsub = null;
  }
  if (fbTypingUnsub) {
    fbTypingUnsub();
    fbTypingUnsub = null;
  }

  const myUser = useAppStore.getState().user;
  if (!myUser) return;
  currentChatScope = scope;
  currentChatWindow = windowSize;
  const historyKey = chatScopeKey(scope);

  if (scope.kind === 'channel') {
    fbMessagesUnsub = firebaseBackend.subscribeChannelMessages(scope.id, (msgs) => {
      const latest = msgs[msgs.length - 1];
      if (latest) {
        lastSeenMsgIds.set(scope.id, latest.id);
      }
      useAppStore.setState((prev) => ({
        messagesByChannel: {
          ...prev.messagesByChannel,
          [scope.id]: msgs,
        },
        unreadByChannel: {
          ...prev.unreadByChannel,
          [scope.id]: 0,
        },
      }));
      markHistory(historyKey, msgs.length, windowSize);
    }, windowSize);
    fbTypingUnsub = firebaseBackend.subscribeTyping(scope.id, (users) => {
      useAppStore.setState({
        typingUsers: users.filter((u) => u.user_id !== myUser.id),
      });
    });
  } else {
    const pairId = dmPairId(myUser.id, scope.peerId);
    fbMessagesUnsub = firebaseBackend.subscribeDmMessages(pairId, (msgs) => {
      const prevMsgs = useAppStore.getState().dmMessagesByPeer[scope.peerId] || [];
      const latest = msgs[msgs.length - 1];
      if (latest && latest.user_id !== myUser.id && !prevMsgs.some((m) => m.id === latest.id)) {
        maybePlayUi('message');
        maybeNotifyDesktop(`${latest.display_name} (Özel Mesaj)`, latest.content || 'Görsel gönderdi');
      }
      useAppStore.setState((prev) => ({
        dmMessagesByPeer: {
          ...prev.dmMessagesByPeer,
          [scope.peerId]: msgs,
        },
      }));
      markHistory(historyKey, msgs.length, windowSize);
    }, windowSize);
    fbTypingUnsub = firebaseBackend.subscribeTyping(pairId, (users) => {
      useAppStore.setState({
        typingUsers: users.filter((u) => u.user_id !== myUser.id),
      });
    });
  }
}

function subscribeFirebaseSoundboard(channelId: string | null) {
  if (fbSoundboardUnsub) {
    fbSoundboardUnsub();
    fbSoundboardUnsub = null;
  }
  if (!channelId) return;
  fbSoundboardUnsub = firebaseBackend.subscribeSoundboard(channelId, (ev) => {
    const state = useAppStore.getState();
    if (state.lastSoundboard?.id === ev.id) return;
    if (!state.deafened && state.audioSettings.soundsEnabled && state.user?.status !== 'dnd') {
      playSoundboard(ev.sound);
    }
    useAppStore.setState({ lastSoundboard: ev });
    if (soundboardClearTimer !== null) {
      window.clearTimeout(soundboardClearTimer);
    }
    soundboardClearTimer = window.setTimeout(() => {
      useAppStore.setState({ lastSoundboard: null });
    }, 3200);
  });
}

function syncUnreadWatchers(channels: Channel[]) {
  const trackedIds = new Set(channels.map((c) => c.id));
  for (const [id, unsub] of Array.from(fbUnreadUnsubs.entries())) {
    if (!trackedIds.has(id)) {
      unsub();
      fbUnreadUnsubs.delete(id);
    }
  }
  for (const ch of channels) {
    if (fbUnreadUnsubs.has(ch.id)) continue;
    const unsub = firebaseBackend.subscribeChannelLatestMessage(ch.id, (latest) => {
      if (!latest) return;
      const st = useAppStore.getState();
      const prevSeen = lastSeenMsgIds.get(ch.id);
      if (prevSeen === latest.id) return;

      const isActive = !st.activeDmUserId && st.activeTextChannelId === ch.id;
      if (isActive || latest.user_id === st.user?.id) {
        lastSeenMsgIds.set(ch.id, latest.id);
        return;
      }

      if (prevSeen !== undefined) {
        useAppStore.setState((prev) => ({
          unreadByChannel: {
            ...prev.unreadByChannel,
            [ch.id]: (prev.unreadByChannel[ch.id] || 0) + 1,
          },
        }));
        const mentioned =
          st.user &&
          latest.content.toLowerCase().includes(`@${st.user.username.toLowerCase()}`);
        if (mentioned) {
          maybePlayUi('message');
          const prefix = ch.kind === 'voice' ? `🔊 ${ch.name}` : `#${ch.name}`;
          maybeNotifyDesktop(`${prefix} • ${latest.display_name}`, latest.content);
        }
      }
      lastSeenMsgIds.set(ch.id, latest.id);
    });
    fbUnreadUnsubs.set(ch.id, unsub);
  }
}

function stopFirebaseListeners() {
  if (fbMessagesUnsub) {
    fbMessagesUnsub();
    fbMessagesUnsub = null;
  }
  if (fbTypingUnsub) {
    fbTypingUnsub();
    fbTypingUnsub = null;
  }
  if (fbSoundboardUnsub) {
    fbSoundboardUnsub();
    fbSoundboardUnsub = null;
  }
  if (fbSessionUnsub) {
    fbSessionUnsub();
    fbSessionUnsub = null;
  }
  for (const unsub of fbUnreadUnsubs.values()) {
    unsub();
  }
  fbUnreadUnsubs.clear();
  lastSeenMsgIds.clear();
  prevVoicePeerIds.clear();
  lastRegularTextChannelId = null;
  selfLeavingVoice = false;
  currentChatScope = null;
  currentChatWindow = FIREBASE_PAGE_SIZE;
}

async function initializeFirebaseSession(user: PublicUser) {
  ensureEngines();
  stopFirebaseListeners();

  const { iceServers, turnEnabled } = getStaticIceServers();
  const audioSettings = useAppStore.getState().audioSettings;
  rtcMesh?.configure(user.id, iceServers, audioSettings);

  const adminInviteCode =
    user.role === 'admin' ? await firebaseBackend.getAdminInviteCode() : null;

  useAppStore.setState({
    user,
    token: 'firebase-session',
    adminInviteCode,
    iceServers,
    turnEnabled,
    authError: null,
    authLoading: false,
  });

  fbSessionUnsub = firebaseBackend.startRealtimeSession(user, {
    onUsers: (allUsers) => {
      const updatedSelf = allUsers.find((u) => u.id === user.id);
      if (updatedSelf) {
        const prevSelf = useAppStore.getState().user;
        const roleChanged = prevSelf && updatedSelf.role !== prevSelf.role;
        useAppStore.setState({ user: updatedSelf });
        if (roleChanged) {
          if (updatedSelf.role === 'admin') {
            firebaseBackend.getAdminInviteCode().then((code) => {
              useAppStore.setState({ adminInviteCode: code });
            });
          } else {
            useAppStore.setState({ adminInviteCode: null });
          }
        }
      }
      useAppStore.setState({ allUsers });
    },
    onOnlineUsers: (onlineUsers) => useAppStore.setState({ onlineUsers }),
    onServerName: (serverName) => useAppStore.setState({ serverName }),
    onTurnConfig: (turnConfig) => {
      useAppStore.setState({ turnConfig });
      resolveIceServers(turnConfig, () => firebaseBackend.getIdToken())
        .then((built) => {
          useAppStore.setState({
            iceServers: built.iceServers,
            turnEnabled: built.turnEnabled,
          });
          rtcMesh?.updateIceServers(built.iceServers);
        })
        .catch(() => {});
    },
    onKicked: () => {
      useAppStore.getState().logout();
      useAppStore.setState({
        authError: 'Sunucudan çıkarıldın. Tekrar katılmak için davet kodu gerekir.',
      });
    },
    onChannels: (channels) => {
      const prevState = useAppStore.getState();
      const textExists = Boolean(
        prevState.activeTextChannelId &&
          channels.some((c) => c.id === prevState.activeTextChannelId),
      );

      const leftVoice =
        prevState.activeVoiceChannelId &&
        !channels.some((c) => c.id === prevState.activeVoiceChannelId);

      if (leftVoice) {
        rtcMesh?.closeAll();
        audioEngine?.destroyAll();
        subscribeFirebaseSoundboard(null);
      }

      let nextTextId = textExists
        ? prevState.activeTextChannelId
        : resolveFallbackTextChannelId(channels);
      if (leftVoice && prevState.activeTextChannelId === prevState.activeVoiceChannelId) {
        nextTextId = resolveFallbackTextChannelId(channels);
      }
      const nextTextChannel = channels.find((c) => c.id === nextTextId);
      if (nextTextChannel?.kind === 'text') {
        lastRegularTextChannelId = nextTextChannel.id;
      }

      useAppStore.setState({
        channels,
        activeTextChannelId: nextTextId,
        activeVoiceChannelId: leftVoice ? null : prevState.activeVoiceChannelId,
        localScreenStream: leftVoice ? null : prevState.localScreenStream,
        localCameraStream: leftVoice ? null : prevState.localCameraStream,
      });

      syncUnreadWatchers(channels);

      if (!prevState.activeDmUserId && nextTextId && nextTextId !== prevState.activeTextChannelId) {
        subscribeFirebaseChatScope({ kind: 'channel', id: nextTextId });
      }
    },
    onVoiceMembers: (rawVoiceMembers) => {
      const activeMembers = rawVoiceMembers.filter((m) => !m.kicked_by_admin);
      useAppStore.setState({ voiceMembers: activeMembers });
      for (const m of activeMembers) {
        rtcMesh?.setPeerScreenStreamId(m.user_id, m.screen_stream_id);
        rtcMesh?.setPeerCameraStreamId(m.user_id, m.camera_stream_id ?? null);
      }

      const st = useAppStore.getState();
      if (st.activeVoiceChannelId && st.user) {
        const userId = st.user.id;
        const myEntry = rawVoiceMembers.find((m) => m.user_id === userId);
        const status = classifyOwnVoiceEntry({
          myEntry,
          mySessionId: firebaseBackend.sessionId(),
          restorePending: firebaseBackend.isVoiceRestorePending(userId),
        });

        if (status === 'restoring') {
          // Our socket dropped and the server cleaned up the entry; firebaseBackend
          // re-creates it as soon as we're back online, so stay in the room meanwhile.
          return;
        }
        if (status === 'kicked') {
          leaveVoiceLocally('Yönetici tarafından ses odasından çıkarıldın.');
          firebaseBackend.leaveVoice(userId).catch(() => {});
          return;
        }
        if (status === 'taken-over') {
          // Another device of this account joined: hand the entry over untouched
          firebaseBackend.releaseVoiceOwnership(userId);
          leaveVoiceLocally(null);
          showInfo('Görüşme başka bir cihazına aktarıldı.');
          return;
        }
        if (status === 'gone' || !myEntry) {
          firebaseBackend.releaseVoiceOwnership(userId);
          leaveVoiceLocally(selfLeavingVoice ? null : 'Ses odası bağlantısı kesildi.');
          return;
        }

        const nextForceMuted = Boolean(myEntry.force_muted);
        if (nextForceMuted !== st.forceMuted || (nextForceMuted && !st.muted)) {
          useAppStore.setState({
            forceMuted: nextForceMuted,
            muted: nextForceMuted ? true : st.muted,
            speaking: nextForceMuted ? false : st.speaking,
          });
          syncMicTransmission();
        }

        const effectiveChannelId = myEntry.channel_id;
        if (effectiveChannelId !== st.activeVoiceChannelId) {
          const wasViewingOldVoiceChat =
            !st.activeDmUserId && st.activeTextChannelId === st.activeVoiceChannelId;
          useAppStore.setState({ activeVoiceChannelId: effectiveChannelId });
          subscribeFirebaseSoundboard(effectiveChannelId);
          if (wasViewingOldVoiceChat) {
            useAppStore.getState().selectTextChannel(effectiveChannelId);
          }
        }

        const peersInChannel = activeMembers
          .filter((m) => m.channel_id === effectiveChannelId)
          .map((m) => m.user_id);

        const nextPeerSet = new Set(peersInChannel.filter((id) => id !== st.user!.id));
        if (prevVoicePeerIds.size > 0 || nextPeerSet.size > 0) {
          const joined = Array.from(nextPeerSet).some((id) => !prevVoicePeerIds.has(id));
          const left = Array.from(prevVoicePeerIds).some((id) => !nextPeerSet.has(id));
          if (joined) maybePlayUi('peer_join');
          else if (left) maybePlayUi('peer_leave');
        }
        prevVoicePeerIds = nextPeerSet;

        pruneStoppedRemoteMedia(activeMembers, effectiveChannelId);
        rtcMesh?.syncPeers(peersInChannel);
      }
    },
    onRtcSignal: (signal) => {
      const sender = useAppStore
        .getState()
        .voiceMembers.find((m) => m.user_id === signal.from_user_id);
      if (!isSignalFromVoiceSession(sender, signal.session_id)) {
        // Another tab/device of that person (not the one in voice) is answering too
        return;
      }
      if (signal.kind === 'offer') {
        rtcMesh
          ?.handleOffer(
            signal.from_user_id,
            signal.sdp,
            signal.screen_stream_id,
            signal.camera_stream_id,
          )
          .catch(() => {});
      } else if (signal.kind === 'answer') {
        rtcMesh?.handleAnswer(signal.from_user_id, signal.sdp).catch(() => {});
      } else if (signal.kind === 'ice') {
        rtcMesh?.handleIceCandidate(signal.from_user_id, signal.candidate).catch(() => {});
      }
    },
    onConnectionStatus: (wsStatus) => useAppStore.setState({ wsStatus }),
    onVoiceRestoreFailed: (reason) => {
      if (!useAppStore.getState().activeVoiceChannelId) return;
      leaveVoiceLocally(
        reason === 'kicked'
          ? 'Yönetici tarafından ses odasından çıkarıldın.'
          : 'Bağlantı geri geldi ama ses odasına yeniden katılınamadı.',
      );
    },
  });

  setupPttBinding(audioSettings);
}

function handleWsEvent(event: WsServerEvent) {
  const state = useAppStore.getState();

  switch (event.type) {
    case 'ready': {
      useAppStore.setState({
        user: event.self_user,
        onlineUsers: event.online_users,
        voiceMembers: event.voice_members,
      });
      if (state.activeVoiceChannelId) {
        wsClient?.send({ type: 'join_voice', channel_id: state.activeVoiceChannelId });
      }
      break;
    }
    case 'presence_update': {
      useAppStore.setState({ onlineUsers: event.online_users });
      break;
    }
    case 'voice_members_update': {
      useAppStore.setState({ voiceMembers: event.voice_members });
      for (const m of event.voice_members) {
        rtcMesh?.setPeerScreenStreamId(m.user_id, m.screen_stream_id);
        rtcMesh?.setPeerCameraStreamId(m.user_id, m.camera_stream_id ?? null);
      }
      if (state.activeVoiceChannelId) {
        const peersInChannel = event.voice_members
          .filter((m) => m.channel_id === state.activeVoiceChannelId)
          .map((m) => m.user_id);
        pruneStoppedRemoteMedia(event.voice_members, state.activeVoiceChannelId);
        rtcMesh?.syncPeers(peersInChannel);
      }
      break;
    }
    case 'user_speaking': {
      useAppStore.setState((prev) => ({
        voiceMembers: prev.voiceMembers.map((m) =>
          m.user_id === event.user_id ? { ...m, speaking: event.speaking } : m,
        ),
      }));
      break;
    }
    case 'message_created': {
      const msg = event.message;
      useAppStore.setState((prev) => {
        const list = prev.messagesByChannel[msg.channel_id] || [];
        if (list.some((m) => m.id === msg.id)) return prev;
        return {
          messagesByChannel: {
            ...prev.messagesByChannel,
            [msg.channel_id]: [...list, msg],
          },
        };
      });
      break;
    }
    case 'channel_created': {
      useAppStore.setState((prev) => {
        if (prev.channels.some((c) => c.id === event.channel.id)) return prev;
        return { channels: [...prev.channels, event.channel] };
      });
      break;
    }
    case 'channel_deleted': {
      useAppStore.setState((prev) => {
        const remaining = prev.channels.filter((c) => c.id !== event.channel_id);
        const nextText =
          prev.activeTextChannelId === event.channel_id
            ? remaining.find((c) => c.kind === 'text')?.id || null
            : prev.activeTextChannelId;
        const leftVoice = prev.activeVoiceChannelId === event.channel_id;
        if (leftVoice) {
          rtcMesh?.closeAll();
          audioEngine?.destroyAll();
        }
        return {
          channels: remaining,
          activeTextChannelId: nextText,
          activeVoiceChannelId: leftVoice ? null : prev.activeVoiceChannelId,
          localScreenStream: leftVoice ? null : prev.localScreenStream,
          localCameraStream: leftVoice ? null : prev.localCameraStream,
        };
      });
      break;
    }
    case 'rtc_offer': {
      rtcMesh
        ?.handleOffer(
          event.from_user_id,
          event.sdp,
          event.screen_stream_id,
          event.camera_stream_id,
        )
        .catch(() => {});
      break;
    }
    case 'rtc_answer': {
      rtcMesh?.handleAnswer(event.from_user_id, event.sdp).catch(() => {});
      break;
    }
    case 'rtc_ice_candidate': {
      rtcMesh?.handleIceCandidate(event.from_user_id, event.candidate).catch(() => {});
      break;
    }
    case 'error': {
      useAppStore.setState({ toastError: event.message });
      break;
    }
    case 'pong':
      break;
  }
}

async function initializeAuthenticatedSession(serverUrl: string, token: string, user: PublicUser) {
  ensureEngines();
  localStorage.setItem(TOKEN_KEY, token);

  const [channels, users, rtc] = await Promise.all([
    api.listChannels(serverUrl, token),
    api.listUsers(serverUrl, token),
    api.rtcConfig(serverUrl, token),
  ]);

  const firstText = channels.find((c) => c.kind === 'text')?.id || null;
  const initialMessages: Record<string, Message[]> = {};
  if (firstText) {
    initialMessages[firstText] = await api.listMessages(
      serverUrl,
      token,
      firstText,
      SERVER_PAGE_SIZE,
    );
  }
  const initialHistoryMore: Record<string, boolean> = firstText
    ? { [firstText]: mayHaveMore(initialMessages[firstText].length, SERVER_PAGE_SIZE) }
    : {};

  const audioSettings = useAppStore.getState().audioSettings;
  rtcMesh?.configure(user.id, rtc.iceServers, audioSettings);

  useAppStore.setState({
    serverUrl,
    token,
    user,
    channels,
    allUsers: users,
    activeTextChannelId: firstText,
    messagesByChannel: initialMessages,
    chatHistoryMore: initialHistoryMore,
    iceServers: rtc.iceServers,
    turnEnabled: rtc.turnEnabled,
    authError: null,
    authLoading: false,
  });

  wsClient?.connect(serverUrl, token);
  setupPttBinding(audioSettings);
}

const FIREBASE_ACTIVE = isFirebaseEnabled();

export const useAppStore = create<AppState>((set, get) => ({
  firebaseMode: FIREBASE_ACTIVE,
  serverName: 'SquadVoice',
  serverUrl: getDefaultServerUrl(),
  token: FIREBASE_ACTIVE ? null : localStorage.getItem(TOKEN_KEY),
  user: null,
  adminInviteCode: null,
  turnConfig: null,
  wsStatus: 'disconnected',
  authLoading: FIREBASE_ACTIVE ? true : Boolean(localStorage.getItem(TOKEN_KEY)),
  authError: null,

  channels: [],
  activeTextChannelId: null,
  activeDmUserId: null,
  messagesByChannel: {},
  dmMessagesByPeer: {},
  unreadByChannel: {},
  typingUsers: [],

  onlineUsers: [],
  allUsers: [],
  voiceMembers: [],
  activeVoiceChannelId: null,
  memberListOpen: true,

  muted: false,
  forceMuted: false,
  deafened: false,
  speaking: false,
  pttActive: false,
  needsAudioUnlock: false,

  audioSettings: loadAudioSettings(),
  peerVolumes: loadPeerVolumes(),
  peerStats: {},
  peerQualityHistory: {},
  turnEnabled: false,
  iceServers: [],

  localScreenStream: null,
  remoteScreenStreams: {},
  focusedStreamUserId: null,
  localCameraStream: null,
  remoteCameraStreams: {},
  lastSoundboard: null,

  toastError: null,
  toastInfo: null,
  micTestActive: false,
  chatHistoryMore: {},
  loadingOlderMessages: false,

  setServerUrl: (url) => {
    const saved = saveServerUrl(url);
    set({ serverUrl: saved });
  },

  bootstrap: async () => {
    if (get().firebaseMode) {
      if (fbAuthUnsub) return;
      fbAuthUnsub = firebaseBackend.observeAuth((fbUser) => {
        if (fbUser) {
          if (get().user?.id !== fbUser.id) {
            initializeFirebaseSession(fbUser).catch(() => {
              set({ authLoading: false });
            });
          } else {
            set({ authLoading: false });
          }
        } else {
          stopFirebaseListeners();
          set({
            user: null,
            token: null,
            authLoading: false,
            channels: [],
            onlineUsers: [],
            voiceMembers: [],
            activeVoiceChannelId: null,
          });
        }
      });
      return;
    }

    const token = localStorage.getItem(TOKEN_KEY);
    const serverUrl = get().serverUrl;
    if (!token) {
      set({ authLoading: false });
      return;
    }
    try {
      const { user } = await api.me(serverUrl, token);
      await initializeAuthenticatedSession(serverUrl, token, user);
    } catch {
      localStorage.removeItem(TOKEN_KEY);
      set({ token: null, user: null, authLoading: false });
    }
  },

  login: async (username, password, customServerUrl) => {
    if (get().firebaseMode) {
      set({ authLoading: true, authError: null });
      try {
        const user = await firebaseBackend.login(username, password);
        await initializeFirebaseSession(user);
      } catch (err) {
        set({
          authLoading: false,
          authError: err instanceof Error ? err.message : 'Giriş yapılamadı',
        });
        throw err;
      }
      return;
    }

    const serverUrl = customServerUrl ? saveServerUrl(customServerUrl) : get().serverUrl;
    set({ authLoading: true, authError: null });
    try {
      const res = await api.login(serverUrl, { username, password });
      await initializeAuthenticatedSession(serverUrl, res.token, res.user);
    } catch (err) {
      set({
        authLoading: false,
        authError: err instanceof Error ? err.message : 'Giriş yapılamadı',
      });
      throw err;
    }
  },

  register: async (username, displayName, email, password, inviteCode, customServerUrl) => {
    if (get().firebaseMode) {
      set({ authLoading: true, authError: null });
      try {
        const user = await firebaseBackend.register(
          username,
          displayName,
          email,
          password,
          inviteCode,
        );
        await initializeFirebaseSession(user);
      } catch (err) {
        set({
          authLoading: false,
          authError: err instanceof Error ? err.message : 'Kayıt olunamadı',
        });
        throw err;
      }
      return;
    }

    const serverUrl = customServerUrl ? saveServerUrl(customServerUrl) : get().serverUrl;
    set({ authLoading: true, authError: null });
    try {
      const res = await api.register(serverUrl, {
        username,
        display_name: displayName,
        password,
        invite_code: inviteCode,
      });
      await initializeAuthenticatedSession(serverUrl, res.token, res.user);
    } catch (err) {
      set({
        authLoading: false,
        authError: err instanceof Error ? err.message : 'Kayıt olunamadı',
      });
      throw err;
    }
  },

  resetPassword: async (email) => {
    if (!get().firebaseMode) {
      throw new Error('Şifre sıfırlama e-postası yalnızca Firebase modunda desteklenir.');
    }
    await firebaseBackend.resetPassword(email);
  },

  changePassword: async (currentPassword, newPassword) => {
    if (!get().firebaseMode) {
      throw new Error('Şifre değiştirme bu modda desteklenmiyor.');
    }
    await firebaseBackend.changePassword(currentPassword, newPassword);
  },

  updateOwnProfile: async (patch) => {
    const s = get();
    if (!s.firebaseMode || !s.user) return;
    await firebaseBackend.updateOwnProfile(
      s.user.id,
      patch,
      Boolean(s.activeVoiceChannelId),
    );
    set((prev) => ({
      user: prev.user ? { ...prev.user, ...patch } : null,
    }));
  },

  logout: () => {
    lastRegularTextChannelId = null;
    selfLeavingVoice = false;
    if (pttCleanup) {
      pttCleanup();
      pttCleanup = null;
    }
    rtcMesh?.closeAll();
    audioEngine?.destroyAll();

    if (get().firebaseMode) {
      stopFirebaseListeners();
      firebaseBackend.logout().catch(() => {});
    } else {
      wsClient?.disconnect();
      localStorage.removeItem(TOKEN_KEY);
    }

    set({
      token: null,
      user: null,
      adminInviteCode: null,
      channels: [],
      onlineUsers: [],
      voiceMembers: [],
      activeVoiceChannelId: null,
      activeDmUserId: null,
      typingUsers: [],
      forceMuted: false,
      localScreenStream: null,
      remoteScreenStreams: {},
      localCameraStream: null,
      remoteCameraStreams: {},
      focusedStreamUserId: null,
      peerStats: {},
    });
  },

  selectTextChannel: async (channelId) => {
    const targetChannel = get().channels.find((c) => c.id === channelId);
    if (targetChannel?.kind === 'text') {
      lastRegularTextChannelId = channelId;
    }
    set((prev) => ({
      activeTextChannelId: channelId,
      activeDmUserId: null,
      typingUsers: [],
      unreadByChannel: { ...prev.unreadByChannel, [channelId]: 0 },
    }));
    if (get().firebaseMode) {
      subscribeFirebaseChatScope({ kind: 'channel', id: channelId });
      return;
    }

    const { serverUrl, token, messagesByChannel } = get();
    if (!token || messagesByChannel[channelId]) return;
    try {
      const msgs = await api.listMessages(serverUrl, token, channelId, SERVER_PAGE_SIZE);
      set((prev) => ({
        messagesByChannel: { ...prev.messagesByChannel, [channelId]: msgs },
        chatHistoryMore: {
          ...prev.chatHistoryMore,
          [channelId]: mayHaveMore(msgs.length, SERVER_PAGE_SIZE),
        },
      }));
    } catch (err) {
      set({ toastError: err instanceof Error ? err.message : 'Mesajlar yüklenemedi' });
    }
  },

  openDm: (peerUserId) => {
    set({ activeDmUserId: peerUserId, typingUsers: [] });
    if (get().firebaseMode) {
      subscribeFirebaseChatScope({ kind: 'dm', peerId: peerUserId });
    }
  },

  toggleMemberList: () => set((prev) => ({ memberListOpen: !prev.memberListOpen })),

  sendMessage: (content, attachment, replyTo) => {
    const { activeTextChannelId, activeDmUserId, user, firebaseMode } = get();
    if (!user) return;

    if (firebaseMode) {
      if (activeDmUserId) {
        const pairId = dmPairId(user.id, activeDmUserId);
        firebaseBackend
          .sendDmMessage(pairId, user, content, attachment, replyTo)
          .catch((err) => {
            set({
              toastError: err instanceof Error ? err.message : 'DM gönderilemedi',
            });
          });
        firebaseBackend.setTyping(pairId, user.id, user.display_name, false);
        return;
      }
      if (!activeTextChannelId) return;
      firebaseBackend
        .sendMessage(user, activeTextChannelId, content, attachment, replyTo)
        .catch((err) => {
          set({
            toastError: err instanceof Error ? err.message : 'Mesaj gönderilemedi',
          });
        });
      firebaseBackend.setTyping(activeTextChannelId, user.id, user.display_name, false);
      return;
    }

    if (!activeTextChannelId) return;
    wsClient?.send({
      type: 'send_message',
      channel_id: activeTextChannelId,
      content,
      attachment_url: attachment?.url ?? null,
      attachment_name: attachment?.name ?? null,
    });
  },

  editMessage: async (messageId, content) => {
    const { firebaseMode, activeTextChannelId, activeDmUserId, user } = get();
    if (!firebaseMode || !user) return;
    if (activeDmUserId) {
      await firebaseBackend.editDmMessage(dmPairId(user.id, activeDmUserId), messageId, content);
    } else if (activeTextChannelId) {
      await firebaseBackend.editMessage(activeTextChannelId, messageId, content);
    }
  },

  deleteMessage: async (channelId, messageId) => {
    const { firebaseMode, activeDmUserId, user } = get();
    if (!firebaseMode || !user) return;
    if (activeDmUserId) {
      await firebaseBackend.deleteDmMessage(dmPairId(user.id, activeDmUserId), messageId);
    } else {
      await firebaseBackend.deleteMessage(channelId, messageId);
    }
  },

  toggleReaction: async (messageId, emoji, active) => {
    const { firebaseMode, activeTextChannelId, activeDmUserId, user } = get();
    if (!firebaseMode || !user) return;
    if (activeDmUserId) {
      await firebaseBackend.toggleDmReaction(
        dmPairId(user.id, activeDmUserId),
        messageId,
        emoji,
        user.id,
        active,
      );
    } else if (activeTextChannelId) {
      await firebaseBackend.toggleReaction(
        activeTextChannelId,
        messageId,
        emoji,
        user.id,
        active,
      );
    }
  },

  togglePinMessage: async (messageId, pinned) => {
    const { firebaseMode, activeTextChannelId, activeDmUserId } = get();
    if (!firebaseMode || activeDmUserId || !activeTextChannelId) return;
    await firebaseBackend.togglePinMessage(activeTextChannelId, messageId, pinned);
  },

  setTyping: (isTyping) => {
    const { firebaseMode, activeTextChannelId, activeDmUserId, user } = get();
    if (!firebaseMode || !user) return;
    const scope = activeDmUserId ? dmPairId(user.id, activeDmUserId) : activeTextChannelId;
    if (!scope) return;
    firebaseBackend.setTyping(scope, user.id, user.display_name, isTyping);
  },

  createChannel: async (name, kind) => {
    if (get().firebaseMode) {
      const maxPos = get().channels.reduce((acc, c) => Math.max(acc, c.position), -1);
      await firebaseBackend.createChannel(name, kind, maxPos + 1);
      return;
    }

    const { serverUrl, token } = get();
    if (!token) return;
    const ch = await api.createChannel(serverUrl, token, name, kind);
    set((prev) => ({
      channels: prev.channels.some((c) => c.id === ch.id) ? prev.channels : [...prev.channels, ch],
    }));
  },

  renameChannel: async (channelId, newName) => {
    if (get().firebaseMode) {
      await firebaseBackend.renameChannel(channelId, newName);
    }
  },

  deleteChannel: async (channelId) => {
    if (get().firebaseMode) {
      await firebaseBackend.deleteChannel(channelId);
      return;
    }

    const { serverUrl, token } = get();
    if (!token) return;
    await api.deleteChannel(serverUrl, token, channelId);
  },

  clearChannelMessages: async (channelId) => {
    if (get().firebaseMode) {
      await firebaseBackend.clearChannelMessages(channelId);
    }
  },

  joinVoice: async (channelId) => {
    ensureEngines();
    const state = get();
    if (!state.user) return;
    if (state.activeVoiceChannelId === channelId) {
      await get().selectTextChannel(channelId);
      return;
    }

    selfLeavingVoice = false;

    try {
      await audioEngine!.unlockAudio();
      const micStream = await audioEngine!.acquireMic(state.audioSettings);
      await rtcMesh!.setMicStream(micStream);
    } catch (err) {
      set({
        toastError:
          err instanceof Error
            ? `Mikrofon erişimi alınamadı: ${err.message}`
            : 'Mikrofon erişimi alınamadı',
      });
      return;
    }

    if (state.firebaseMode) {
      const built = await resolveIceServers(state.turnConfig, () =>
        firebaseBackend.getIdToken(),
      );
      set({ iceServers: built.iceServers, turnEnabled: built.turnEnabled });
      rtcMesh?.updateIceServers(built.iceServers);

      await firebaseBackend.joinVoice(state.user, channelId, {
        muted: state.muted,
        deafened: state.deafened,
        screen_sharing: Boolean(state.localScreenStream),
        screen_stream_id: state.localScreenStream?.id ?? null,
        camera_on: Boolean(state.localCameraStream),
        camera_stream_id: state.localCameraStream?.id ?? null,
      });
      prevVoicePeerIds.clear();
      set({ activeVoiceChannelId: channelId, forceMuted: false });
      syncMicTransmission();
      subscribeFirebaseSoundboard(channelId);
    } else {
      set({ activeVoiceChannelId: channelId, forceMuted: false });
      syncMicTransmission();
      wsClient?.send({ type: 'join_voice', channel_id: channelId });
      wsClient?.send({
        type: 'voice_state_update',
        muted: state.muted,
        deafened: state.deafened,
        screen_sharing: Boolean(state.localScreenStream),
        screen_stream_id: state.localScreenStream?.id ?? null,
      });
    }

    await get().selectTextChannel(channelId);
    maybePlayUi('join');

    const peers = get()
      .voiceMembers.filter((m) => m.channel_id === channelId)
      .map((m) => m.user_id);
    rtcMesh?.syncPeers(peers);
  },

  leaveVoice: () => {
    const s = get();
    const prevVoiceId = s.activeVoiceChannelId;
    const shouldReturnToText =
      !s.activeDmUserId && Boolean(prevVoiceId) && s.activeTextChannelId === prevVoiceId;

    selfLeavingVoice = true;
    rtcMesh?.closeAll();
    audioEngine?.destroyAll();
    if (s.firebaseMode) {
      subscribeFirebaseSoundboard(null);
    }
    prevVoicePeerIds.clear();
    maybePlayUi('leave');
    set({
      activeVoiceChannelId: null,
      forceMuted: false,
      speaking: false,
      localScreenStream: null,
      remoteScreenStreams: {},
      localCameraStream: null,
      remoteCameraStreams: {},
      focusedStreamUserId: null,
      peerStats: {},
      toastError: null,
    });

    if (s.firebaseMode && s.user) {
      firebaseBackend
        .leaveVoice(s.user.id)
        .catch(() => {})
        .finally(() => {
          selfLeavingVoice = false;
        });
    } else {
      wsClient?.send({ type: 'leave_voice' });
      selfLeavingVoice = false;
    }

    if (shouldReturnToText) {
      const fallbackId = resolveFallbackTextChannelId(get().channels);
      if (fallbackId) {
        get().selectTextChannel(fallbackId);
      }
    }
  },

  reconnectVoicePeers: () => {
    audioEngine?.unlockAudio().catch(() => {});
    rtcMesh?.reconnectAllPeers();
  },

  toggleMute: () => {
    const cur = get();
    if (cur.forceMuted) {
      set({ toastError: 'Yönetici tarafından susturuldun.' });
      return;
    }
    set((prev) => {
      const nextMuted = !prev.muted;
      return { muted: nextMuted, speaking: nextMuted ? false : prev.speaking };
    });
    const s = get();
    maybePlayUi(s.muted ? 'mute' : 'unmute');
    syncMicTransmission();
    if (s.activeVoiceChannelId && s.user) {
      if (s.firebaseMode) {
        firebaseBackend
          .updateVoiceState(s.user.id, {
            muted: s.muted,
            speaking: s.muted ? false : s.speaking,
          })
          .catch(() => {});
      } else {
        wsClient?.send({
          type: 'voice_state_update',
          muted: s.muted,
          deafened: s.deafened,
          screen_sharing: Boolean(s.localScreenStream),
          screen_stream_id: s.localScreenStream?.id ?? null,
        });
      }
    }
  },

  toggleDeafen: () => {
    set((prev) => {
      const nextDeafened = !prev.deafened;
      return {
        deafened: nextDeafened,
        speaking: nextDeafened ? false : prev.speaking,
      };
    });
    const s = get();
    audioEngine?.setDeafened(s.deafened);
    if (!s.deafened) maybePlayUi('undeafen');
    syncMicTransmission();
    if (s.activeVoiceChannelId && s.user) {
      if (s.firebaseMode) {
        firebaseBackend
          .updateVoiceState(s.user.id, {
            deafened: s.deafened,
            speaking: s.deafened ? false : s.speaking,
          })
          .catch(() => {});
      } else {
        wsClient?.send({
          type: 'voice_state_update',
          muted: s.muted,
          deafened: s.deafened,
          screen_sharing: Boolean(s.localScreenStream),
          screen_stream_id: s.localScreenStream?.id ?? null,
        });
      }
    }
  },

  startCamera: async () => {
    const s = get();
    if (!s.activeVoiceChannelId || !rtcMesh || !s.user) return;
    try {
      const stream = await rtcMesh.startCamera();
      set({ localCameraStream: stream });
      if (s.firebaseMode) {
        await firebaseBackend.updateVoiceState(s.user.id, {
          camera_on: true,
          camera_stream_id: stream.id,
        });
      }
    } catch (err) {
      set({
        toastError:
          err instanceof Error ? `Kamera açılamadı: ${err.message}` : 'Kamera açılamadı',
      });
    }
  },

  stopCamera: () => {
    rtcMesh?.stopCamera();
    const s = get();
    set({ localCameraStream: null });
    if (s.activeVoiceChannelId && s.user && s.firebaseMode) {
      firebaseBackend
        .updateVoiceState(s.user.id, {
          camera_on: false,
          camera_stream_id: null,
        })
        .catch(() => {});
    }
  },

  startScreenShare: async (opts) => {
    const s = get();
    if (!s.activeVoiceChannelId || !rtcMesh || !s.user) return;
    try {
      const stream = await rtcMesh.startScreenShare(opts, () => {
        const cur = get();
        set({
          localScreenStream: null,
          focusedStreamUserId:
            cur.focusedStreamUserId === 'self'
              ? Object.keys(cur.remoteScreenStreams)[0] || null
              : cur.focusedStreamUserId,
        });
        if (cur.firebaseMode && cur.user) {
          firebaseBackend
            .updateVoiceState(cur.user.id, {
              screen_sharing: false,
              screen_stream_id: null,
            })
            .catch(() => {});
        } else {
          wsClient?.send({
            type: 'voice_state_update',
            muted: cur.muted,
            deafened: cur.deafened,
            screen_sharing: false,
            screen_stream_id: null,
          });
        }
      });

      set({
        localScreenStream: stream,
        focusedStreamUserId: 'self',
      });

      if (s.firebaseMode) {
        await firebaseBackend.updateVoiceState(s.user.id, {
          screen_sharing: true,
          screen_stream_id: stream.id,
        });
      } else {
        wsClient?.send({
          type: 'voice_state_update',
          muted: s.muted,
          deafened: s.deafened,
          screen_sharing: true,
          screen_stream_id: stream.id,
        });
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Ekran paylaşımı başlatılamadı';
      if (!message.toLowerCase().includes('cancel') && !message.toLowerCase().includes('denied')) {
        set({ toastError: message });
      }
    }
  },

  stopScreenShare: () => {
    rtcMesh?.stopScreenShare();
    const s = get();
    set({
      localScreenStream: null,
      focusedStreamUserId:
        s.focusedStreamUserId === 'self'
          ? Object.keys(s.remoteScreenStreams)[0] || null
          : s.focusedStreamUserId,
    });
    if (s.activeVoiceChannelId && s.user) {
      if (s.firebaseMode) {
        firebaseBackend
          .updateVoiceState(s.user.id, {
            screen_sharing: false,
            screen_stream_id: null,
          })
          .catch(() => {});
      } else {
        wsClient?.send({
          type: 'voice_state_update',
          muted: s.muted,
          deafened: s.deafened,
          screen_sharing: false,
          screen_stream_id: null,
        });
      }
    }
  },

  playRoomSoundboard: async (sound) => {
    const s = get();
    if (!s.firebaseMode || !s.activeVoiceChannelId || !s.user) return;
    await firebaseBackend.triggerSoundboard(s.activeVoiceChannelId, s.user, sound);
  },

  setFocusedStreamUser: (userId) => set({ focusedStreamUserId: userId }),

  setPeerVolume: (userId, volume) => {
    const clamped = Math.max(0, Math.min(2, volume));
    audioEngine?.setPeerVolume(userId, clamped);
    set((prev) => {
      const next = { ...prev.peerVolumes, [userId]: clamped };
      localStorage.setItem(PEER_VOLUMES_KEY, JSON.stringify(next));
      return { peerVolumes: next };
    });
  },

  updateAudioSettings: async (patch) => {
    const prev = get().audioSettings;
    const next = { ...prev, ...patch };
    localStorage.setItem(AUDIO_SETTINGS_KEY, JSON.stringify(next));
    set({ audioSettings: next });
    rtcMesh?.updateAudioSettings(next);
    audioEngine?.applySensitivity(next);

    if (patch.pttEnabled !== undefined || patch.pttKey !== undefined) {
      setupPttBinding(next);
    }

    if (patch.outputDeviceId !== undefined) {
      await audioEngine?.setOutputDevice(next.outputDeviceId);
    }

    const needsDeviceReacquire =
      get().activeVoiceChannelId !== null &&
      (patch.inputDeviceId !== undefined || patch.stereo !== undefined);

    const needsConstraintUpdate =
      get().activeVoiceChannelId !== null &&
      !needsDeviceReacquire &&
      (patch.echoCancellation !== undefined ||
        patch.noiseSuppression !== undefined ||
        patch.autoGainControl !== undefined);

    try {
      if (needsDeviceReacquire && audioEngine && rtcMesh) {
        const stream = await audioEngine.acquireMic(next, { settleMs: 120 });
        await rtcMesh.setMicStream(stream);
        syncMicTransmission();
      } else if (needsConstraintUpdate && audioEngine && rtcMesh) {
        const { stream, replaced } = await audioEngine.applyAudioConstraints(next);
        if (replaced) {
          await rtcMesh.setMicStream(stream);
        }
        syncMicTransmission();
      }
    } catch (err) {
      set({
        toastError:
          err instanceof Error
            ? `Ses ayarı uygulanamadı: ${err.message}`
            : 'Ses ayarı uygulanamadı.',
      });
    }
  },

  unlockAudio: async () => {
    if (!audioEngine) return;
    await audioEngine.unlockAudio();
  },

  updateInviteCode: async (code) => {
    await firebaseBackend.setInviteCode(code);
    set({ adminInviteCode: code.trim() });
  },

  updateServerName: async (name) => {
    await firebaseBackend.setServerName(name);
  },

  updateTurnConfig: async (turn) => {
    await firebaseBackend.setTurnConfig(turn);
  },

  setUserRole: async (targetUid, role) => {
    await firebaseBackend.setUserRole(targetUid, role);
  },

  kickMember: async (targetUser) => {
    await firebaseBackend.kickMember(targetUser);
  },

  adminForceMute: async (targetUid, forceMuted) => {
    await firebaseBackend.adminForceMute(targetUid, forceMuted);
  },

  adminDisconnectVoice: async (targetUid) => {
    await firebaseBackend.adminDisconnectVoice(targetUid);
  },

  adminMoveVoice: async (targetUid, targetChannelId) => {
    await firebaseBackend.adminMoveVoice(targetUid, targetChannelId);
  },

  clearToast: () => set({ toastError: null, toastInfo: null }),

  startMicTest: async () => {
    ensureEngines();
    try {
      await audioEngine!.startMicTest(get().audioSettings);
      set({ micTestActive: true });
    } catch (err) {
      set({
        micTestActive: false,
        toastError:
          err instanceof Error
            ? `Mikrofon testi başlatılamadı: ${err.message}`
            : 'Mikrofon testi başlatılamadı.',
      });
    }
  },

  stopMicTest: () => {
    audioEngine?.stopMicTest();
    set({ micTestActive: false });
  },

  loadOlderMessages: async () => {
    const s = get();
    if (s.loadingOlderMessages) return;

    if (s.firebaseMode) {
      const scope = currentChatScope;
      if (!scope || !s.chatHistoryMore[chatScopeKey(scope)]) return;
      const next = nextWindowSize(currentChatWindow);
      if (next === null) {
        set((prev) => ({ chatHistoryMore: { ...prev.chatHistoryMore, [chatScopeKey(scope)]: false } }));
        return;
      }
      // Widen the live window; the new snapshot replaces the list and clears the flag
      set({ loadingOlderMessages: true });
      subscribeFirebaseChatScope(scope, next);
      return;
    }

    const channelId = s.activeTextChannelId;
    if (!channelId || !s.token || !s.chatHistoryMore[channelId]) return;
    const oldest = (s.messagesByChannel[channelId] || [])[0];
    if (!oldest) return;
    set({ loadingOlderMessages: true });
    try {
      const older = await api.listMessages(
        s.serverUrl,
        s.token,
        channelId,
        SERVER_PAGE_SIZE,
        oldest.created_at,
      );
      set((prev) => ({
        messagesByChannel: {
          ...prev.messagesByChannel,
          [channelId]: mergeOlderMessages(prev.messagesByChannel[channelId] || [], older),
        },
        chatHistoryMore: {
          ...prev.chatHistoryMore,
          [channelId]: mayHaveMore(older.length, SERVER_PAGE_SIZE),
        },
        loadingOlderMessages: false,
      }));
    } catch (err) {
      set({
        loadingOlderMessages: false,
        toastError: err instanceof Error ? err.message : 'Eski mesajlar yüklenemedi',
      });
    }
  },
}));
