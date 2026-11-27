export type UserStatus = 'online' | 'idle' | 'dnd' | 'invisible';

export interface PublicUser {
  id: string;
  username: string;
  display_name: string;
  avatar_color: string;
  avatar_url?: string | null;
  status?: UserStatus;
  custom_status?: string | null;
  role: 'admin' | 'member' | string;
  slot?: string;
  email?: string;
  created_at: string;
}

export interface Channel {
  id: string;
  name: string;
  kind: 'text' | 'voice';
  position: number;
  created_at: string;
}

export interface MessageReplyRef {
  id: string;
  display_name: string;
  content: string;
}

export interface Message {
  id: string;
  channel_id: string;
  user_id: string;
  username: string;
  display_name: string;
  avatar_color: string;
  avatar_url?: string | null;
  content: string;
  attachment_url: string | null;
  attachment_name: string | null;
  edited_at?: string | null;
  pinned?: boolean;
  reply_to?: MessageReplyRef | null;
  reactions?: Record<string, Record<string, boolean>>;
  created_at: string;
}

export interface VoiceMemberState {
  user_id: string;
  username: string;
  display_name: string;
  avatar_color: string;
  avatar_url?: string | null;
  channel_id: string;
  muted: boolean;
  deafened: boolean;
  force_muted?: boolean;
  kicked_by_admin?: boolean;
  /** Which tab/device of the account holds this voice entry (Firebase mode). */
  session_id?: string;
  screen_sharing: boolean;
  screen_stream_id: string | null;
  camera_on?: boolean;
  camera_stream_id?: string | null;
  speaking: boolean;
}

export type SoundboardId =
  | 'airhorn'
  | 'drumroll'
  | 'applause'
  | 'gg'
  | 'fail'
  | 'quack'
  | 'alarm'
  | 'levelup';

export interface SoundboardEvent {
  id: string;
  sound: SoundboardId;
  user_id: string;
  display_name: string;
  ts: number;
}

export interface TurnConfig {
  workerUrl?: string;
  url?: string;
  username?: string;
  credential?: string;
}

export interface RtcConfigResponse {
  iceServers: RTCIceServer[];
  turnEnabled: boolean;
}

export type InputSensitivityMode = 'auto' | 'manual' | 'off';

export type NoiseSuppressionMode = 'off' | 'standard' | 'rnnoise' | 'gtcrn';

export interface NoiseSuppressionStatus {
  activeMode: NoiseSuppressionMode;
  loading: boolean;
  fallbackMessage: string | null;
}

export interface AudioSettings {
  inputDeviceId: string;
  outputDeviceId: string;
  opusBitrateKbps: 64 | 96 | 128;
  stereo: boolean;
  echoCancellation: boolean;
  noiseSuppression: boolean;
  noiseSuppressionMode: NoiseSuppressionMode;
  autoGainControl: boolean;
  /**
   * Input sensitivity (noise gate): 'auto' follows the room's noise, 'manual' uses
   * gateThresholdDb, 'off' always sends. Sound below the threshold is not transmitted.
   */
  inputSensitivity: InputSensitivityMode;
  /** Manual gate threshold in dBFS (-80..-10). */
  gateThresholdDb: number;
  pttEnabled: boolean;
  pttKey: string;
  soundsEnabled: boolean;
  desktopNotifications: boolean;
}

export interface ScreenShareOptions {
  width: number;
  height: number;
  frameRate: number;
  maxBitrateBps: number;
  contentHint: 'motion' | 'detail';
  includeAudio: boolean;
}

export interface PeerStats {
  rttMs: number | null;
  /** Incoming audio packet loss over the last stats interval (not since call start). */
  packetLossPct: number | null;
  /** Incoming audio jitter as reported by the receiver. */
  jitterMs: number | null;
  audioKbps: number;
  videoKbps: number;
  videoResolution: string | null;
  videoFps: number | null;
  iceState: RTCIceConnectionState | 'new';
  usingRelay: boolean;
  hasAudioTrack: boolean;
}

export type WsClientEvent =
  | { type: 'ping'; ts: number }
  | {
      type: 'send_message';
      channel_id: string;
      content: string;
      attachment_url?: string | null;
      attachment_name?: string | null;
    }
  | { type: 'join_voice'; channel_id: string }
  | { type: 'leave_voice' }
  | {
      type: 'voice_state_update';
      muted: boolean;
      deafened: boolean;
      screen_sharing: boolean;
      screen_stream_id: string | null;
    }
  | { type: 'speaking'; speaking: boolean }
  | {
      type: 'rtc_offer';
      target_user_id: string;
      sdp: RTCSessionDescriptionInit;
      screen_stream_id?: string | null;
      camera_stream_id?: string | null;
    }
  | {
      type: 'rtc_answer';
      target_user_id: string;
      sdp: RTCSessionDescriptionInit;
    }
  | {
      type: 'rtc_ice_candidate';
      target_user_id: string;
      candidate: RTCIceCandidateInit;
    };

export type WsServerEvent =
  | { type: 'pong'; ts: number }
  | {
      type: 'ready';
      self_user: PublicUser;
      online_users: PublicUser[];
      voice_members: VoiceMemberState[];
    }
  | { type: 'presence_update'; online_users: PublicUser[] }
  | { type: 'voice_members_update'; voice_members: VoiceMemberState[] }
  | { type: 'user_speaking'; user_id: string; speaking: boolean }
  | { type: 'message_created'; message: Message }
  | { type: 'channel_created'; channel: Channel }
  | { type: 'channel_deleted'; channel_id: string }
  | {
      type: 'rtc_offer';
      from_user_id: string;
      sdp: RTCSessionDescriptionInit;
      screen_stream_id?: string | null;
      camera_stream_id?: string | null;
    }
  | { type: 'rtc_answer'; from_user_id: string; sdp: RTCSessionDescriptionInit }
  | {
      type: 'rtc_ice_candidate';
      from_user_id: string;
      candidate: RTCIceCandidateInit;
    }
  | { type: 'error'; message: string };
