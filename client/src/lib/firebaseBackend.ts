import {
  createUserWithEmailAndPassword,
  deleteUser,
  EmailAuthProvider,
  onAuthStateChanged,
  reauthenticateWithCredential,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut,
  updatePassword,
  type User as FirebaseAuthUser,
} from 'firebase/auth';
import {
  get,
  goOnline,
  limitToLast,
  onChildAdded,
  onDisconnect,
  onValue,
  orderByChild,
  push,
  query,
  ref,
  remove,
  set,
  update,
  type Unsubscribe,
} from 'firebase/database';
import type {
  Channel,
  CustomSoundItem,
  Message,
  MessageReplyRef,
  PublicUser,
  ReadReceipt,
  RoomSummary,
  SoundboardEvent,
  SoundboardId,
  TurnConfig,
  UserStatus,
  VoiceMemberState,
} from '../types/protocol';
import { getFirebaseServices, usernameToEmail, validateEmail } from './firebase';
import { extractInviteCode, generateInviteCode } from './invite';
import { sanitizeRtcPayload } from './sdp';

const AVATAR_COLORS = [
  '#5865F2',
  '#3BA55D',
  '#FAA61A',
  '#EB459E',
  '#ED4245',
  '#00AFF4',
  '#9B59B6',
];

export const MAX_ROOM_MEMBERS = 10;
const SLOTS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'] as const;
export const DEFAULT_ROOM_ID = 'default';

let activeRoomId: string = DEFAULT_ROOM_ID;

function roomPath(subpath: string, roomId = activeRoomId): string {
  return roomId === DEFAULT_ROOM_ID ? subpath : `rooms/${roomId}/${subpath}`;
}

function membersPath(roomId = activeRoomId): string {
  return roomId === DEFAULT_ROOM_ID ? 'users' : `rooms/${roomId}/members`;
}

function serverNamePath(roomId = activeRoomId): string {
  return roomId === DEFAULT_ROOM_ID ? 'config/serverName' : `rooms/${roomId}/meta/name`;
}

function inviteCodePath(roomId = activeRoomId): string {
  return roomId === DEFAULT_ROOM_ID ? 'config/inviteCode' : `rooms/${roomId}/meta/invite_code`;
}

function turnConfigPath(roomId = activeRoomId): string {
  return roomId === DEFAULT_ROOM_ID ? 'config/turn' : `rooms/${roomId}/turn`;
}

/**
 * voice/{uid} and signals/{uid} are keyed per account, but one account can have several
 * sessions open (desktop app, phone, a browser tab). Only the session that actually joined
 * voice may clean up the voice entry or consume WebRTC signals; otherwise closing any other
 * session of the same account dropped the live call, and an idle tab could steal offers.
 */
let voiceOwnerUid: string | null = null;
let voiceOwnerRoomId: string = DEFAULT_ROOM_ID;
/** Identifies this tab/app instance among the account's sessions. */
const SESSION_ID =
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
/** Last full voice entry this session wrote or saw for itself; used to restore it. */
let voiceEntryCache: VoiceMemberState | null = null;
/**
 * True while the Firebase socket is down: the server runs our onDisconnect and deletes
 * the voice entry, so when we're back we re-create it instead of leaving the room.
 * Without this every Wi-Fi blip or phone screen-lock kicked the user out of voice.
 */
let voiceRestorePending = false;
/** Hook into the active realtime session so mobile resume can immediately re-verify voice presence. */
let activeVoiceHealHook: ((userId: string) => void) | null = null;

function isVoiceMember(m: Partial<VoiceMemberState> | null | undefined): m is VoiceMemberState {
  return (
    typeof m?.user_id === 'string' &&
    typeof m.channel_id === 'string' &&
    typeof m.username === 'string'
  );
}

/** Minimum gap between presence self-heals, so a rejected write can't loop. */
const PRESENCE_HEAL_INTERVAL_MS = 5000;

function pickAvatarColor(seed: string): string {
  let sum = 0;
  for (let i = 0; i < seed.length; i += 1) {
    sum += seed.charCodeAt(i);
  }
  return AVATAR_COLORS[sum % AVATAR_COLORS.length];
}

function mapAuthError(err: unknown): Error {
  const code = (err as { code?: string })?.code || '';
  if (code === 'auth/email-already-in-use') {
    return new Error('Bu e-posta veya kullanıcı adı zaten kayıtlı.');
  }
  if (
    code === 'auth/invalid-credential' ||
    code === 'auth/user-not-found' ||
    code === 'auth/wrong-password'
  ) {
    return new Error('E-posta/kullanıcı adı veya şifre hatalı.');
  }
  if (code === 'auth/invalid-email') {
    return new Error('Geçersiz e-posta adresi.');
  }
  if (code === 'auth/weak-password') {
    return new Error('Şifre en az 6 karakter olmalıdır.');
  }
  if (code === 'auth/too-many-requests') {
    return new Error('Çok fazla deneme yapıldı. Lütfen biraz sonra tekrar deneyin.');
  }
  if (code === 'auth/requires-recent-login') {
    return new Error('Güvenlik için çıkış yapıp tekrar giriş yapmalısın.');
  }
  if (err instanceof Error) return err;
  return new Error('Firebase kimlik doğrulama hatası.');
}

interface StoredUserRecord extends PublicUser {
  slot?: string;
  invite_code?: string;
}

interface RoomMetaRecord {
  id: string;
  name: string;
  icon_color: string;
  owner_id: string;
  invite_code: string;
  created_at: string;
}

export type RtcSignalPayload =
  | {
      kind: 'offer';
      from_user_id: string;
      sdp: RTCSessionDescriptionInit;
      screen_stream_id?: string | null;
      camera_stream_id?: string | null;
      /** Sending tab/device (added by sendRtcSignal); absent from older app versions. */
      session_id?: string;
    }
  | {
      kind: 'answer';
      from_user_id: string;
      sdp: RTCSessionDescriptionInit;
      session_id?: string;
    }
  | {
      kind: 'ice';
      from_user_id: string;
      candidate: RTCIceCandidateInit;
      session_id?: string;
    };

export interface RealtimeCallbacks {
  onUsers: (users: PublicUser[]) => void;
  onOnlineUsers: (users: PublicUser[]) => void;
  onChannels: (channels: Channel[]) => void;
  onVoiceMembers: (members: VoiceMemberState[]) => void;
  onServerName: (name: string) => void;
  onTurnConfig: (turn: TurnConfig | null) => void;
  onKicked: () => void;
  onRtcSignal: (signal: RtcSignalPayload) => void;
  onConnectionStatus: (status: 'connecting' | 'connected' | 'disconnected') => void;
  /** We were in voice, went offline, and could not (or must not) rejoin on reconnect. */
  onVoiceRestoreFailed?: (reason: 'kicked' | 'failed') => void;
  /** Custom soundboard clips uploaded to the active room. */
  onCustomSounds?: (sounds: CustomSoundItem[]) => void;
}

export const firebaseBackend = {
  setActiveRoom(roomId: string): void {
    activeRoomId = roomId || DEFAULT_ROOM_ID;
  },

  getActiveRoomId(): string {
    return activeRoomId;
  },

  observeAuth(callback: (user: PublicUser | null) => void): () => void {
    const { auth, rtdb } = getFirebaseServices();
    return onAuthStateChanged(auth, async (fbUser: FirebaseAuthUser | null) => {
      if (!fbUser) {
        callback(null);
        return;
      }
      try {
        const snap = await get(ref(rtdb, `users/${fbUser.uid}`));
        if (!snap.exists()) {
          callback(null);
          return;
        }
        callback(snap.val() as PublicUser);
      } catch {
        callback(null);
      }
    });
  },

  async register(
    username: string,
    displayName: string,
    emailInput: string,
    password: string,
    inviteCode = '',
  ): Promise<PublicUser> {
    const { auth, rtdb } = getFirebaseServices();
    const cleanUsername = username.trim();
    if (cleanUsername.length < 2 || cleanUsername.length > 24) {
      throw new Error('Kullanıcı adı 2 ile 24 karakter arasında olmalıdır.');
    }

    const email = emailInput.trim()
      ? validateEmail(emailInput)
      : usernameToEmail(cleanUsername);
    const extractedInvite = extractInviteCode(inviteCode) ?? '';

    let fbUser: FirebaseAuthUser;
    try {
      const cred = await createUserWithEmailAndPassword(auth, email, password);
      fbUser = cred.user;
    } catch (err) {
      throw mapAuthError(err);
    }

    let claimedDefaultSlot: string | null = null;
    try {
      const slotsSnap = await get(ref(rtdb, 'slots'));
      const slotsData = (slotsSnap.val() as Record<string, string> | null) || {};
      const isFirstEverUser = Object.keys(slotsData).length === 0;
      const now = new Date().toISOString();

      let role: 'admin' | 'member' = 'member';
      let slotValue = '';

      if (isFirstEverUser) {
        await set(ref(rtdb, 'slots/1'), fbUser.uid);
        claimedDefaultSlot = '1';
        slotValue = '1';
        role = 'admin';
        const initialCode = extractedInvite || generateInviteCode();
        await set(ref(rtdb, 'config/inviteCode'), initialCode);
        await set(ref(rtdb, `invites/${initialCode}`), {
          roomId: DEFAULT_ROOM_ID,
          created_by: fbUser.uid,
        });
      }

      const userRecord: StoredUserRecord = {
        id: fbUser.uid,
        username: cleanUsername.includes('@')
          ? cleanUsername.split('@')[0]
          : cleanUsername,
        display_name: (displayName.trim() || cleanUsername).slice(0, 32),
        avatar_color: pickAvatarColor(cleanUsername),
        status: 'online',
        role,
        slot: slotValue,
        email,
        ...(extractedInvite ? { invite_code: extractedInvite } : {}),
        created_at: now,
      };

      await set(ref(rtdb, `users/${fbUser.uid}`), userRecord);

      if (isFirstEverUser) {
        await seedDefaultChannelsIfEmpty(now, DEFAULT_ROOM_ID);
        await set(ref(rtdb, `userRooms/${fbUser.uid}/${DEFAULT_ROOM_ID}`), {
          id: DEFAULT_ROOM_ID,
          name: 'SquadVoice',
          icon_color: '#5865F2',
          role: 'admin',
          joined_at: now,
        } satisfies RoomSummary);
      }

      const { invite_code: _ic, ...publicUser } = userRecord;
      return publicUser;
    } catch (err) {
      if (claimedDefaultSlot) {
        await remove(ref(rtdb, `slots/${claimedDefaultSlot}`)).catch(() => {});
      }
      await deleteUser(fbUser).catch(() => {});
      throw mapAuthError(err);
    }
  },

  async login(usernameOrEmail: string, password: string): Promise<PublicUser> {
    const { auth, rtdb } = getFirebaseServices();
    const email = usernameToEmail(usernameOrEmail);
    try {
      const cred = await signInWithEmailAndPassword(auth, email, password);
      const snap = await get(ref(rtdb, `users/${cred.user.uid}`));
      if (!snap.exists()) {
        throw new Error('Kullanıcı profili bulunamadı.');
      }
      return snap.val() as PublicUser;
    } catch (err) {
      throw mapAuthError(err);
    }
  },

  async ensureUserRooms(user: PublicUser): Promise<RoomSummary[]> {
    const { rtdb } = getFirebaseServices();
    const roomsSnap = await get(ref(rtdb, `userRooms/${user.id}`));
    const existing = (roomsSnap.val() as Record<string, RoomSummary> | null) || {};

    // Legacy backward compatibility: if user holds a slot in the root server, register it in userRooms
    const slotsSnap = await get(ref(rtdb, 'slots')).catch(() => null);
    const slotsData = (slotsSnap?.val() as Record<string, string> | null) || {};
    const holdsLegacySlot = Object.values(slotsData).includes(user.id);

    if (holdsLegacySlot && !existing[DEFAULT_ROOM_ID]) {
      const nameSnap = await get(ref(rtdb, 'config/serverName')).catch(() => null);
      const legacyName = nameSnap?.exists() ? String(nameSnap.val()) : 'SquadVoice';
      const summary: RoomSummary = {
        id: DEFAULT_ROOM_ID,
        name: legacyName,
        icon_color: '#5865F2',
        role: user.role === 'admin' ? 'admin' : 'member',
        joined_at: user.created_at || new Date().toISOString(),
      };
      await set(ref(rtdb, `userRooms/${user.id}/${DEFAULT_ROOM_ID}`), summary).catch(() => {});
      existing[DEFAULT_ROOM_ID] = summary;
    }

    // Ensure legacy default room invite code is indexed under invites/{code} for link joins
    if (holdsLegacySlot && user.role === 'admin') {
      const codeSnap = await get(ref(rtdb, 'config/inviteCode')).catch(() => null);
      if (codeSnap?.exists()) {
        const code = String(codeSnap.val()).trim();
        if (code) {
          await set(ref(rtdb, `invites/${code}`), {
            roomId: DEFAULT_ROOM_ID,
            created_by: user.id,
          }).catch(() => {});
        }
      }
    }

    return Object.values(existing).sort((a, b) => a.joined_at.localeCompare(b.joined_at));
  },

  subscribeUserRooms(userId: string, onRooms: (rooms: RoomSummary[]) => void): () => void {
    const { rtdb } = getFirebaseServices();
    return onValue(ref(rtdb, `userRooms/${userId}`), (snap) => {
      const raw = (snap.val() as Record<string, RoomSummary> | null) || {};
      const list = Object.values(raw)
        .filter((r) => Boolean(r?.id && r?.name))
        .sort((a, b) => a.joined_at.localeCompare(b.joined_at));
      onRooms(list);
    });
  },

  async createRoom(user: PublicUser, nameInput: string, iconColor?: string): Promise<RoomSummary> {
    const { rtdb } = getFirebaseServices();
    const cleanName = nameInput.trim().slice(0, 32);
    if (!cleanName) {
      throw new Error('Oda / sunucu adı boş olamaz.');
    }

    const roomRef = push(ref(rtdb, 'rooms'));
    const roomId = roomRef.key || crypto.randomUUID();
    const now = new Date().toISOString();
    const color = iconColor || pickAvatarColor(cleanName);
    const inviteCode = generateInviteCode();

    const meta: RoomMetaRecord = {
      id: roomId,
      name: cleanName,
      icon_color: color,
      owner_id: user.id,
      invite_code: inviteCode,
      created_at: now,
    };

    await set(ref(rtdb, `rooms/${roomId}/meta`), meta);
    await set(ref(rtdb, `rooms/${roomId}/slots/1`), user.id);

    const memberRecord: StoredUserRecord = {
      id: user.id,
      username: user.username,
      display_name: user.display_name,
      avatar_color: user.avatar_color,
      avatar_url: user.avatar_url ?? null,
      status: user.status ?? 'online',
      custom_status: user.custom_status ?? null,
      email: user.email,
      role: 'admin',
      slot: '1',
      created_at: now,
    };
    await set(ref(rtdb, `rooms/${roomId}/members/${user.id}`), sanitizeRtcPayload(memberRecord));
    await set(ref(rtdb, `invites/${inviteCode}`), {
      roomId,
      created_by: user.id,
    });

    await seedDefaultChannelsIfEmpty(now, roomId);

    const summary: RoomSummary = {
      id: roomId,
      name: cleanName,
      icon_color: color,
      role: 'admin',
      invite_code: inviteCode,
      joined_at: now,
    };
    await set(ref(rtdb, `userRooms/${user.id}/${roomId}`), summary);
    return summary;
  },

  async joinRoomByInvite(user: PublicUser, rawInvite: string): Promise<RoomSummary> {
    const { rtdb } = getFirebaseServices();
    const code = extractInviteCode(rawInvite);
    if (!code) {
      throw new Error('Geçersiz davet linki veya kodu.');
    }

    const inviteSnap = await get(ref(rtdb, `invites/${code}`));
    if (!inviteSnap.exists()) {
      throw new Error('Davet linki geçersiz veya süresi dolmuş.');
    }
    const inviteData = inviteSnap.val() as { roomId?: string } | null;
    const roomId = inviteData?.roomId;
    if (!roomId) {
      throw new Error('Davet linki geçersiz.');
    }

    const now = new Date().toISOString();

    if (roomId === DEFAULT_ROOM_ID) {
      const slotsSnap = await get(ref(rtdb, 'slots'));
      const slotsData = (slotsSnap.val() as Record<string, string> | null) || {};
      const existingSlot = Object.entries(slotsData).find(([, uid]) => uid === user.id)?.[0];

      let slot = existingSlot;
      if (!slot) {
        const freeSlot = SLOTS.find((s) => !slotsData[s]);
        if (!freeSlot) {
          throw new Error(`Bu oda maksimum kullanıcı sayısına ulaştı (${MAX_ROOM_MEMBERS}/${MAX_ROOM_MEMBERS}).`);
        }
        await set(ref(rtdb, `slots/${freeSlot}`), user.id);
        slot = freeSlot;
        await update(ref(rtdb, `users/${user.id}`), { slot }).catch(() => {});
      }

      const nameSnap = await get(ref(rtdb, 'config/serverName')).catch(() => null);
      const roomName = nameSnap?.exists() ? String(nameSnap.val()) : 'SquadVoice';
      const summary: RoomSummary = {
        id: DEFAULT_ROOM_ID,
        name: roomName,
        icon_color: '#5865F2',
        role: user.role === 'admin' ? 'admin' : 'member',
        joined_at: now,
      };
      await set(ref(rtdb, `userRooms/${user.id}/${DEFAULT_ROOM_ID}`), summary);
      return summary;
    }

    // Custom room join
    const slotsSnap = await get(ref(rtdb, `rooms/${roomId}/slots`));
    const slotsData = (slotsSnap.val() as Record<string, string> | null) || {};
    const existingSlot = Object.entries(slotsData).find(([, uid]) => uid === user.id)?.[0];
    let claimedSlot: string | null = null;

    try {
      let slot = existingSlot;
      if (!slot) {
        const freeSlot = SLOTS.find((s) => !slotsData[s]);
        if (!freeSlot) {
          throw new Error(`Bu oda maksimum kullanıcı sayısına ulaştı (${MAX_ROOM_MEMBERS}/${MAX_ROOM_MEMBERS}).`);
        }
        await set(ref(rtdb, `rooms/${roomId}/slots/${freeSlot}`), user.id);
        claimedSlot = freeSlot;
        slot = freeSlot;

        const memberRecord: StoredUserRecord = {
          id: user.id,
          username: user.username,
          display_name: user.display_name,
          avatar_color: user.avatar_color,
          avatar_url: user.avatar_url ?? null,
          status: user.status ?? 'online',
          custom_status: user.custom_status ?? null,
          email: user.email,
          role: 'member',
          slot,
          invite_code: code,
          created_at: now,
        };
        await set(ref(rtdb, `rooms/${roomId}/members/${user.id}`), sanitizeRtcPayload(memberRecord));
      }

      const metaSnap = await get(ref(rtdb, `rooms/${roomId}/meta`));
      const meta = metaSnap.val() as RoomMetaRecord | null;
      const existingMemberSnap = await get(ref(rtdb, `rooms/${roomId}/members/${user.id}`)).catch(
        () => null,
      );
      const memberRole =
        (existingMemberSnap?.val() as { role?: string } | null)?.role === 'admin'
          ? 'admin'
          : 'member';

      const summary: RoomSummary = {
        id: roomId,
        name: meta?.name || 'Yeni Oda',
        icon_color: meta?.icon_color || '#5865F2',
        role: memberRole,
        joined_at: now,
      };
      await set(ref(rtdb, `userRooms/${user.id}/${roomId}`), summary);
      return summary;
    } catch (err) {
      if (claimedSlot) {
        await remove(ref(rtdb, `rooms/${roomId}/slots/${claimedSlot}`)).catch(() => {});
      }
      const msg = err instanceof Error ? err.message : '';
      if (msg.toLowerCase().includes('permission')) {
        throw new Error('Davet kodu geçersiz veya yenilenmiş.');
      }
      throw err;
    }
  },

  async leaveRoom(user: PublicUser, roomId: string): Promise<void> {
    const { rtdb } = getFirebaseServices();
    if (roomId === DEFAULT_ROOM_ID) {
      const slotsSnap = await get(ref(rtdb, 'slots')).catch(() => null);
      const slotsData = (slotsSnap?.val() as Record<string, string> | null) || {};
      for (const [slotKey, uid] of Object.entries(slotsData)) {
        if (uid === user.id) {
          await remove(ref(rtdb, `slots/${slotKey}`)).catch(() => {});
        }
      }
      await remove(ref(rtdb, `voice/${user.id}`)).catch(() => {});
      await remove(ref(rtdb, `presence/${user.id}`)).catch(() => {});
      await update(ref(rtdb, `users/${user.id}`), { slot: null }).catch(() => {});
      await remove(ref(rtdb, `userRooms/${user.id}/${DEFAULT_ROOM_ID}`)).catch(() => {});
      return;
    }

    const slotsSnap = await get(ref(rtdb, `rooms/${roomId}/slots`)).catch(() => null);
    const slotsData = (slotsSnap?.val() as Record<string, string> | null) || {};
    for (const [slotKey, uid] of Object.entries(slotsData)) {
      if (uid === user.id) {
        await remove(ref(rtdb, `rooms/${roomId}/slots/${slotKey}`)).catch(() => {});
      }
    }
    await remove(ref(rtdb, `rooms/${roomId}/voice/${user.id}`)).catch(() => {});
    await remove(ref(rtdb, `rooms/${roomId}/presence/${user.id}`)).catch(() => {});
    await remove(ref(rtdb, `rooms/${roomId}/members/${user.id}`)).catch(() => {});
    await remove(ref(rtdb, `userRooms/${user.id}/${roomId}`)).catch(() => {});
  },

  async resetPassword(emailInput: string): Promise<void> {
    const { auth } = getFirebaseServices();
    const email = validateEmail(emailInput);
    try {
      await sendPasswordResetEmail(auth, email);
    } catch (err) {
      throw mapAuthError(err);
    }
  },

  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    const { auth } = getFirebaseServices();
    const currentUser = auth.currentUser;
    if (!currentUser || !currentUser.email) {
      throw new Error('Oturum bulunamadı.');
    }
    if (newPassword.length < 6) {
      throw new Error('Yeni şifre en az 6 karakter olmalıdır.');
    }
    try {
      const cred = EmailAuthProvider.credential(currentUser.email, currentPassword);
      await reauthenticateWithCredential(currentUser, cred);
      await updatePassword(currentUser, newPassword);
    } catch (err) {
      throw mapAuthError(err);
    }
  },

  async logout(): Promise<void> {
    const { auth } = getFirebaseServices();
    await signOut(auth);
  },

  async getIdToken(): Promise<string | null> {
    const { auth } = getFirebaseServices();
    if (!auth.currentUser) return null;
    try {
      return await auth.currentUser.getIdToken();
    } catch {
      return null;
    }
  },

  async updateOwnProfile(
    userId: string,
    patch: {
      display_name?: string;
      avatar_color?: string;
      avatar_url?: string | null;
      status?: UserStatus;
      custom_status?: string | null;
    },
    inVoice: boolean,
  ): Promise<void> {
    const { rtdb } = getFirebaseServices();
    const cleanPatch: Record<string, unknown> = {};
    if (patch.display_name !== undefined) {
      const cleanName = patch.display_name.trim().slice(0, 32);
      if (!cleanName) throw new Error('Görünen isim boş olamaz.');
      cleanPatch.display_name = cleanName;
    }
    if (patch.avatar_color !== undefined) cleanPatch.avatar_color = patch.avatar_color;
    if (patch.avatar_url !== undefined) cleanPatch.avatar_url = patch.avatar_url || null;
    if (patch.status !== undefined) cleanPatch.status = patch.status;
    if (patch.custom_status !== undefined) {
      const cleanCustom = patch.custom_status ? patch.custom_status.trim().slice(0, 60) : null;
      cleanPatch.custom_status = cleanCustom || null;
    }

    await update(ref(rtdb, `users/${userId}`), cleanPatch);
    if (activeRoomId !== DEFAULT_ROOM_ID) {
      await update(ref(rtdb, `rooms/${activeRoomId}/members/${userId}`), cleanPatch).catch(
        () => {},
      );
    }
    await update(ref(rtdb, roomPath(`presence/${userId}`)), cleanPatch).catch(() => {});

    if (inVoice && voiceOwnerUid === userId) {
      const voicePatch: Partial<VoiceMemberState> = {};
      if (cleanPatch.display_name !== undefined) {
        voicePatch.display_name = cleanPatch.display_name as string;
      }
      if (cleanPatch.avatar_color !== undefined) {
        voicePatch.avatar_color = cleanPatch.avatar_color as string;
      }
      if (cleanPatch.avatar_url !== undefined) {
        voicePatch.avatar_url = cleanPatch.avatar_url as string | null;
      }
      if (Object.keys(voicePatch).length > 0) {
        if (voiceEntryCache) voiceEntryCache = { ...voiceEntryCache, ...voicePatch };
        if (!voiceRestorePending) {
          await update(ref(rtdb, roomPath(`voice/${userId}`, voiceOwnerRoomId)), voicePatch).catch(
            () => {},
          );
        }
      }
    }
  },

  async getAdminInviteCode(roomId = activeRoomId): Promise<string | null> {
    const { rtdb } = getFirebaseServices();
    try {
      const snap = await get(ref(rtdb, inviteCodePath(roomId)));
      return snap.exists() ? String(snap.val()) : null;
    } catch {
      return null;
    }
  },

  async setInviteCode(code: string, userId?: string, roomId = activeRoomId): Promise<void> {
    const clean = code.trim();
    if (clean.length < 3 || clean.length > 40) {
      throw new Error('Davet kodu 3-40 karakter arasında olmalıdır.');
    }
    const { auth, rtdb } = getFirebaseServices();
    const actorUid = userId || auth.currentUser?.uid || '';
    const oldSnap = await get(ref(rtdb, inviteCodePath(roomId))).catch(() => null);
    const oldCode = oldSnap?.exists() ? String(oldSnap.val()).trim() : null;

    await set(ref(rtdb, inviteCodePath(roomId)), clean);
    if (actorUid) {
      await set(ref(rtdb, `invites/${clean}`), {
        roomId,
        created_by: actorUid,
      }).catch(() => {});
    }
    if (oldCode && oldCode !== clean) {
      await remove(ref(rtdb, `invites/${oldCode}`)).catch(() => {});
    }
  },

  async setServerName(name: string, userId?: string, roomId = activeRoomId): Promise<void> {
    const clean = name.trim();
    if (clean.length < 1 || clean.length > 32) {
      throw new Error('Sunucu adı 1-32 karakter arasında olmalıdır.');
    }
    const { auth, rtdb } = getFirebaseServices();
    await set(ref(rtdb, serverNamePath(roomId)), clean);
    const actorUid = userId || auth.currentUser?.uid;
    if (actorUid) {
      await update(ref(rtdb, `userRooms/${actorUid}/${roomId}`), { name: clean }).catch(() => {});
    }
  },

  async setTurnConfig(turn: TurnConfig | null, roomId = activeRoomId): Promise<void> {
    const { rtdb } = getFirebaseServices();
    const turnRef = ref(rtdb, turnConfigPath(roomId));
    const workerUrl = turn?.workerUrl?.trim() || '';
    const url = turn?.url?.trim() || '';
    if (!turn || (!workerUrl && !url)) {
      await remove(turnRef);
      return;
    }
    const payload: TurnConfig = {};
    if (workerUrl) payload.workerUrl = workerUrl;
    if (url) {
      payload.url = url;
      payload.username = (turn.username || '').trim();
      payload.credential = (turn.credential || '').trim();
    }
    await set(turnRef, payload);
  },

  async setUserRole(
    targetUid: string,
    role: 'admin' | 'member',
    roomId = activeRoomId,
  ): Promise<void> {
    const { rtdb } = getFirebaseServices();
    await update(ref(rtdb, `${membersPath(roomId)}/${targetUid}`), { role });
    await update(ref(rtdb, `userRooms/${targetUid}/${roomId}`), { role }).catch(() => {});
  },

  async kickMember(targetUser: PublicUser, roomId = activeRoomId): Promise<void> {
    const { rtdb } = getFirebaseServices();
    const slotsSnap = await get(ref(rtdb, roomPath('slots', roomId)));
    const slotsData = (slotsSnap.val() as Record<string, string> | null) || {};
    for (const [slotKey, uid] of Object.entries(slotsData)) {
      if (uid === targetUser.id) {
        await remove(ref(rtdb, roomPath(`slots/${slotKey}`, roomId)));
      }
    }
    await remove(ref(rtdb, roomPath(`voice/${targetUser.id}`, roomId))).catch(() => {});
    await remove(ref(rtdb, roomPath(`presence/${targetUser.id}`, roomId))).catch(() => {});
    if (roomId === DEFAULT_ROOM_ID) {
      // Keep the user's global profile intact so they can still use their other rooms
      await update(ref(rtdb, `users/${targetUser.id}`), { slot: null, role: 'member' });
    } else {
      await remove(ref(rtdb, `${membersPath(roomId)}/${targetUser.id}`));
    }
    await remove(ref(rtdb, `userRooms/${targetUser.id}/${roomId}`)).catch(() => {});
  },

  async adminForceMute(targetUid: string, forceMuted: boolean): Promise<void> {
    const { rtdb } = getFirebaseServices();
    await update(ref(rtdb, roomPath(`voice/${targetUid}`)), {
      force_muted: forceMuted,
      muted: forceMuted,
      speaking: false,
    });
  },

  async adminDisconnectVoice(targetUid: string): Promise<void> {
    const { rtdb } = getFirebaseServices();
    await set(ref(rtdb, roomPath(`voice_kicks/${targetUid}`)), Date.now()).catch(() => {});
    await update(ref(rtdb, roomPath(`voice/${targetUid}`)), { kicked_by_admin: true });
    window.setTimeout(() => {
      remove(ref(rtdb, roomPath(`voice/${targetUid}`))).catch(() => {});
    }, 1200);
  },

  async adminMoveVoice(targetUid: string, targetChannelId: string): Promise<void> {
    const { rtdb } = getFirebaseServices();
    await update(ref(rtdb, roomPath(`voice/${targetUid}`)), { channel_id: targetChannelId });
  },

  async renameChannel(channelId: string, newName: string): Promise<void> {
    const clean = newName.trim().slice(0, 32);
    if (!clean) throw new Error('Kanal adı boş olamaz.');
    const { rtdb } = getFirebaseServices();
    await update(ref(rtdb, roomPath(`channels/${channelId}`)), { name: clean });
  },

  async editMessage(channelId: string, messageId: string, content: string): Promise<void> {
    const { rtdb } = getFirebaseServices();
    await update(ref(rtdb, roomPath(`messages/${channelId}/${messageId}`)), {
      content: content.trim(),
      edited_at: new Date().toISOString(),
    });
  },

  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    const { rtdb } = getFirebaseServices();
    await remove(ref(rtdb, roomPath(`messages/${channelId}/${messageId}`)));
  },

  async clearChannelMessages(channelId: string): Promise<void> {
    const { rtdb } = getFirebaseServices();
    await remove(ref(rtdb, roomPath(`messages/${channelId}`)));
  },

  async toggleReaction(
    channelId: string,
    messageId: string,
    emoji: string,
    userId: string,
    active: boolean,
  ): Promise<void> {
    const { rtdb } = getFirebaseServices();
    const rRef = ref(rtdb, roomPath(`messages/${channelId}/${messageId}/reactions/${emoji}/${userId}`));
    if (active) {
      await set(rRef, true);
    } else {
      await remove(rRef);
    }
  },

  async togglePinMessage(channelId: string, messageId: string, pinned: boolean): Promise<void> {
    const { rtdb } = getFirebaseServices();
    const pRef = ref(rtdb, roomPath(`messages/${channelId}/${messageId}/pinned`));
    if (pinned) {
      await set(pRef, true);
    } else {
      await remove(pRef);
    }
  },

  async markChannelRead(
    channelId: string,
    user: PublicUser,
    lastMessage: Pick<Message, 'id' | 'created_at'>,
  ): Promise<void> {
    const { rtdb } = getFirebaseServices();
    const receipt: ReadReceipt = {
      user_id: user.id,
      display_name: user.display_name,
      avatar_color: user.avatar_color,
      avatar_url: user.avatar_url ?? null,
      last_read_at: lastMessage.created_at,
      last_read_msg_id: lastMessage.id,
      updated_at: Date.now(),
    };
    await set(
      ref(rtdb, roomPath(`readReceipts/${channelId}/${user.id}`)),
      sanitizeRtcPayload(receipt),
    ).catch(() => {});
  },

  subscribeChannelReadReceipts(
    channelId: string,
    onReceipts: (receipts: ReadReceipt[]) => void,
  ): () => void {
    const { rtdb } = getFirebaseServices();
    return onValue(ref(rtdb, roomPath(`readReceipts/${channelId}`)), (snap) => {
      const raw = (snap.val() as Record<string, ReadReceipt> | null) || {};
      const list = Object.values(raw).filter((r) => Boolean(r?.user_id && r?.last_read_at));
      onReceipts(list);
    });
  },

  async markDmRead(
    pairId: string,
    user: PublicUser,
    lastMessage: Pick<Message, 'id' | 'created_at'>,
  ): Promise<void> {
    const { rtdb } = getFirebaseServices();
    const receipt: ReadReceipt = {
      user_id: user.id,
      display_name: user.display_name,
      avatar_color: user.avatar_color,
      avatar_url: user.avatar_url ?? null,
      last_read_at: lastMessage.created_at,
      last_read_msg_id: lastMessage.id,
      updated_at: Date.now(),
    };
    await set(
      ref(rtdb, `dmReadReceipts/${pairId}/${user.id}`),
      sanitizeRtcPayload(receipt),
    ).catch(() => {});
  },

  subscribeDmReadReceipts(
    pairId: string,
    onReceipts: (receipts: ReadReceipt[]) => void,
  ): () => void {
    const { rtdb } = getFirebaseServices();
    return onValue(ref(rtdb, `dmReadReceipts/${pairId}`), (snap) => {
      const raw = (snap.val() as Record<string, ReadReceipt> | null) || {};
      const list = Object.values(raw).filter((r) => Boolean(r?.user_id && r?.last_read_at));
      onReceipts(list);
    });
  },

  async setTyping(
    scopeKey: string,
    userId: string,
    displayName: string,
    isTyping: boolean,
  ): Promise<void> {
    const { rtdb } = getFirebaseServices();
    const tRef = ref(rtdb, roomPath(`typing/${scopeKey}/${userId}`));
    if (isTyping) {
      onDisconnect(tRef).remove().catch(() => {});
      await set(tRef, { user_id: userId, display_name: displayName, ts: Date.now() }).catch(
        () => {},
      );
    } else {
      await remove(tRef).catch(() => {});
    }
  },

  subscribeTyping(
    scopeKey: string,
    onTyping: (users: Array<{ user_id: string; display_name: string }>) => void,
  ): () => void {
    const { rtdb } = getFirebaseServices();
    return onValue(ref(rtdb, roomPath(`typing/${scopeKey}`)), (snap) => {
      const raw =
        (snap.val() as Record<string, { user_id: string; display_name: string; ts: number }> | null) ||
        {};
      const cutoff = Date.now() - 8000;
      const list = Object.values(raw)
        .filter((u) => u && u.ts > cutoff)
        .map((u) => ({ user_id: u.user_id, display_name: u.display_name }));
      onTyping(list);
    });
  },

  async triggerSoundboard(
    channelId: string,
    user: PublicUser,
    sound: SoundboardId,
    meta?: { label?: string; emoji?: string; audio_url?: string | null },
  ): Promise<void> {
    const { rtdb } = getFirebaseServices();
    const event: SoundboardEvent = {
      id: crypto.randomUUID(),
      sound,
      ...(meta?.label ? { label: meta.label } : {}),
      ...(meta?.emoji ? { emoji: meta.emoji } : {}),
      ...(meta?.audio_url ? { audio_url: meta.audio_url } : {}),
      user_id: user.id,
      display_name: user.display_name,
      ts: Date.now(),
    };
    await set(ref(rtdb, roomPath(`soundboard/${channelId}`)), sanitizeRtcPayload(event));
  },

  subscribeSoundboard(
    channelId: string,
    onSound: (ev: SoundboardEvent) => void,
  ): () => void {
    const { rtdb } = getFirebaseServices();
    return onValue(ref(rtdb, roomPath(`soundboard/${channelId}`)), (snap) => {
      const ev = snap.val() as SoundboardEvent | null;
      if (ev && Date.now() - ev.ts < 5000) {
        onSound(ev);
      }
    });
  },

  async addCustomSound(
    user: PublicUser,
    input: { label: string; emoji: string; audio_url: string },
  ): Promise<CustomSoundItem> {
    const { rtdb } = getFirebaseServices();
    const label = input.label.trim().slice(0, 32);
    const emoji = (input.emoji.trim() || '🔊').slice(0, 8);
    if (!label) throw new Error('Ses adı boş olamaz.');
    if (!input.audio_url || input.audio_url.length > 260000) {
      throw new Error('Ses dosyası çok büyük (en fazla ~180 KB, kısa 2-5 sn klip seç).');
    }
    const itemRef = push(ref(rtdb, roomPath('customSounds')));
    const id = itemRef.key || crypto.randomUUID();
    const item: CustomSoundItem = {
      id,
      label,
      emoji,
      audio_url: input.audio_url,
      created_by: user.id,
      created_by_name: user.display_name,
      created_at: new Date().toISOString(),
    };
    await set(itemRef, sanitizeRtcPayload(item));
    return item;
  },

  async deleteCustomSound(soundId: string): Promise<void> {
    const { rtdb } = getFirebaseServices();
    await remove(ref(rtdb, roomPath(`customSounds/${soundId}`)));
  },

  subscribeDmMessages(
    pairId: string,
    onMessages: (messages: Message[]) => void,
    limit = 80,
  ): () => void {
    const { rtdb } = getFirebaseServices();
    const q = query(
      ref(rtdb, `dms/${pairId}`),
      orderByChild('created_at'),
      limitToLast(limit),
    );
    return onValue(q, (snap) => {
      const raw = (snap.val() as Record<string, Message> | null) || {};
      const list = Object.values(raw).sort((a, b) =>
        a.created_at.localeCompare(b.created_at),
      );
      onMessages(list);
    });
  },

  async sendDmMessage(
    pairId: string,
    user: PublicUser,
    content: string,
    attachment?: { url: string; name: string } | null,
    replyTo?: MessageReplyRef | null,
  ): Promise<void> {
    const { rtdb } = getFirebaseServices();
    const msgRef = push(ref(rtdb, `dms/${pairId}`));
    const id = msgRef.key || crypto.randomUUID();
    const msg: Message = {
      id,
      channel_id: pairId,
      user_id: user.id,
      username: user.username,
      display_name: user.display_name,
      avatar_color: user.avatar_color,
      avatar_url: user.avatar_url ?? null,
      content,
      attachment_url: attachment?.url ?? null,
      attachment_name: attachment?.name ?? null,
      reply_to: replyTo ?? null,
      created_at: new Date().toISOString(),
    };
    await set(msgRef, sanitizeRtcPayload(msg));
  },

  async editDmMessage(pairId: string, messageId: string, content: string): Promise<void> {
    const { rtdb } = getFirebaseServices();
    await update(ref(rtdb, `dms/${pairId}/${messageId}`), {
      content: content.trim(),
      edited_at: new Date().toISOString(),
    });
  },

  async deleteDmMessage(pairId: string, messageId: string): Promise<void> {
    const { rtdb } = getFirebaseServices();
    await remove(ref(rtdb, `dms/${pairId}/${messageId}`));
  },

  async toggleDmReaction(
    pairId: string,
    messageId: string,
    emoji: string,
    userId: string,
    active: boolean,
  ): Promise<void> {
    const { rtdb } = getFirebaseServices();
    const rRef = ref(rtdb, `dms/${pairId}/${messageId}/reactions/${emoji}/${userId}`);
    if (active) {
      await set(rRef, true);
    } else {
      await remove(rRef);
    }
  },

  startRealtimeSession(
    user: PublicUser,
    callbacks: RealtimeCallbacks,
    roomId = activeRoomId,
  ): () => void {
    activeRoomId = roomId || DEFAULT_ROOM_ID;
    const boundRoomId = activeRoomId;
    const { rtdb } = getFirebaseServices();
    const unsubs: Unsubscribe[] = [];

    callbacks.onConnectionStatus('connecting');

    const connectedRef = ref(rtdb, '.info/connected');
    const presenceRef = ref(rtdb, roomPath(`presence/${user.id}`, boundRoomId));
    const voiceRef = ref(rtdb, roomPath(`voice/${user.id}`, boundRoomId));
    const mySignalsRef = ref(rtdb, roomPath(`signals/${user.id}`, boundRoomId));

    let isConnected = false;
    let lastPresenceHealAt = 0;
    let selfPresence: PublicUser = {
      id: user.id,
      username: user.username,
      display_name: user.display_name,
      avatar_color: user.avatar_color,
      avatar_url: user.avatar_url ?? null,
      status: user.status ?? 'online',
      custom_status: user.custom_status ?? null,
      role: user.role,
      created_at: user.created_at,
    };

    const writePresence = () => {
      lastPresenceHealAt = Date.now();
      set(presenceRef, sanitizeRtcPayload(selfPresence)).catch(() => {});
    };

    let selfPresenceMissing = false;
    let presenceHealTimer: ReturnType<typeof setTimeout> | null = null;
    const healPresence = () => {
      if (presenceHealTimer !== null) return;
      const wait = PRESENCE_HEAL_INTERVAL_MS - (Date.now() - lastPresenceHealAt);
      if (wait <= 0) {
        writePresence();
        return;
      }
      presenceHealTimer = setTimeout(() => {
        presenceHealTimer = null;
        if (isConnected && selfPresenceMissing) writePresence();
      }, wait);
    };

    let voiceRestoreInFlight = false;
    let voiceRestoreAttempts = 0;
    let voiceRestoreTimer: ReturnType<typeof setTimeout> | null = null;
    const clearVoiceRestoreTimer = () => {
      if (voiceRestoreTimer !== null) {
        clearTimeout(voiceRestoreTimer);
        voiceRestoreTimer = null;
      }
    };

    const abandonVoice = (reason: 'kicked' | 'failed') => {
      clearVoiceRestoreTimer();
      voiceRestoreAttempts = 0;
      if (voiceOwnerUid !== user.id || voiceOwnerRoomId !== boundRoomId) return;
      firebaseBackend.releaseVoiceOwnership(user.id);
      callbacks.onVoiceRestoreFailed?.(reason);
    };

    const restoreVoiceEntry = async () => {
      if (voiceRestoreInFlight) return;
      const cached = voiceEntryCache;
      if (!cached || voiceOwnerUid !== user.id || voiceOwnerRoomId !== boundRoomId) {
        voiceRestorePending = false;
        clearVoiceRestoreTimer();
        return;
      }
      voiceRestoreInFlight = true;
      clearVoiceRestoreTimer();
      try {
        const [voiceSnap, kickSnap] = await Promise.all([
          get(voiceRef),
          get(ref(rtdb, roomPath(`voice_kicks/${user.id}`, boundRoomId))),
        ]);
        if (voiceOwnerUid !== user.id || voiceOwnerRoomId !== boundRoomId) return;

        if (kickSnap.exists()) {
          remove(kickSnap.ref).catch(() => {});
          remove(voiceRef).catch(() => {});
          abandonVoice('kicked');
          return;
        }

        const current = voiceSnap.val() as Partial<VoiceMemberState> | null;
        if (isVoiceMember(current) && current.session_id && current.session_id !== SESSION_ID) {
          firebaseBackend.releaseVoiceOwnership(user.id);
          return;
        }
        if (isVoiceMember(current) && (!current.session_id || current.session_id === SESSION_ID)) {
          voiceEntryCache = current;
          voiceRestorePending = false;
          voiceRestoreAttempts = 0;
          return;
        }

        await set(
          voiceRef,
          sanitizeRtcPayload({ ...cached, speaking: false, kicked_by_admin: false }),
        );
        onDisconnect(voiceRef).remove().catch(() => {});
        onDisconnect(mySignalsRef).remove().catch(() => {});
        if (voiceOwnerUid === user.id && voiceOwnerRoomId === boundRoomId) {
          voiceRestorePending = false;
          voiceRestoreAttempts = 0;
        }
      } catch (err) {
        if (voiceOwnerUid !== user.id || voiceOwnerRoomId !== boundRoomId) return;
        const msg = err instanceof Error ? err.message : String(err ?? '');
        const isPermanentDenied = /permission_denied|permission denied/i.test(msg);
        if (isPermanentDenied || voiceRestoreAttempts >= 5) {
          remove(voiceRef).catch(() => {});
          abandonVoice('failed');
          return;
        }
        // Transient network error while waking up from mobile screen-lock: retry with backoff
        voiceRestoreAttempts += 1;
        const retryDelayMs = Math.min(10_000, 1500 * voiceRestoreAttempts);
        voiceRestoreTimer = setTimeout(() => {
          voiceRestoreTimer = null;
          if (voiceOwnerUid === user.id && voiceOwnerRoomId === boundRoomId && voiceRestorePending) {
            void restoreVoiceEntry();
          }
        }, retryDelayMs);
      } finally {
        voiceRestoreInFlight = false;
      }
    };

    activeVoiceHealHook = (uid: string) => {
      if (uid !== user.id || voiceOwnerUid !== user.id || voiceOwnerRoomId !== boundRoomId) return;
      voiceRestoreAttempts = 0;
      if (voiceRestorePending || !isConnected) {
        voiceRestorePending = true;
        void restoreVoiceEntry();
      }
    };

    unsubs.push(
      onValue(connectedRef, (snap) => {
        const connected = Boolean(snap.val());
        if (connected) {
          isConnected = true;
          voiceRestoreAttempts = 0;
          callbacks.onConnectionStatus('connected');
          onDisconnect(presenceRef).remove().catch(() => {});
          writePresence();
          if (voiceOwnerUid === user.id && voiceOwnerRoomId === boundRoomId) {
            onDisconnect(voiceRef).remove().catch(() => {});
            onDisconnect(mySignalsRef).remove().catch(() => {});
            if (voiceRestorePending) void restoreVoiceEntry();
          }
        } else {
          const wasConnected = isConnected;
          isConnected = false;
          if (wasConnected && voiceOwnerUid === user.id && voiceOwnerRoomId === boundRoomId) {
            voiceRestorePending = true;
          }
          callbacks.onConnectionStatus('connecting');
        }
      }),
    );

    unsubs.push(
      onValue(ref(rtdb, membersPath(boundRoomId)), (snap) => {
        const raw = (snap.val() as Record<string, PublicUser> | null) || {};
        const values = Object.values(raw);
        const list = (
          boundRoomId === DEFAULT_ROOM_ID
            ? values.filter((u) => Boolean(u.slot) || u.role === 'admin')
            : values
        ).sort((a, b) => a.created_at.localeCompare(b.created_at));
        const mine = raw[user.id];
        if (
          !mine ||
          (boundRoomId === DEFAULT_ROOM_ID && !mine.slot && mine.role !== 'admin')
        ) {
          callbacks.onKicked();
          return;
        }
        callbacks.onUsers(list);
      }),
    );

    unsubs.push(
      onValue(ref(rtdb, roomPath('presence', boundRoomId)), (snap) => {
        const raw = (snap.val() as Record<string, PublicUser> | null) || {};
        const mine = raw[user.id];
        selfPresenceMissing = !mine;
        if (mine) {
          selfPresence = { ...selfPresence, ...mine };
        } else if (isConnected) {
          healPresence();
        }
        const list = Object.values(raw)
          .filter((u) => typeof u?.username === 'string')
          .sort((a, b) => a.username.localeCompare(b.username));
        callbacks.onOnlineUsers(list);
      }),
    );

    unsubs.push(
      onValue(ref(rtdb, roomPath('channels', boundRoomId)), (snap) => {
        const raw = (snap.val() as Record<string, Channel> | null) || {};
        const list = Object.values(raw).sort((a, b) => a.position - b.position);
        callbacks.onChannels(list);
      }),
    );

    unsubs.push(
      onValue(ref(rtdb, roomPath('voice', boundRoomId)), (snap) => {
        const raw = (snap.val() as Record<string, Partial<VoiceMemberState>> | null) || {};
        const mine = raw[user.id];
        if (voiceOwnerUid === user.id && voiceOwnerRoomId === boundRoomId) {
          if (isVoiceMember(mine) && !voiceRestorePending) {
            voiceEntryCache = mine;
          } else if (!mine && voiceEntryCache) {
            // Our voice entry disappeared (e.g. mobile screen-lock socket timeout triggered
            // server onDisconnect before .info/connected flipped). Self-heal instead of
            // ejecting the user from the voice room; restoreVoiceEntry still honors admin kicks
            // and multi-device takeovers.
            voiceRestorePending = true;
            if (isConnected) {
              void restoreVoiceEntry();
            }
          }
        }
        const list = Object.values(raw)
          .filter(isVoiceMember)
          .sort((a, b) => a.username.localeCompare(b.username));
        callbacks.onVoiceMembers(list);
      }),
    );

    unsubs.push(
      onValue(ref(rtdb, serverNamePath(boundRoomId)), (snap) => {
        if (snap.exists()) {
          callbacks.onServerName(String(snap.val()));
        } else {
          callbacks.onServerName('SquadVoice');
        }
      }),
    );

    unsubs.push(
      onValue(ref(rtdb, turnConfigPath(boundRoomId)), (snap) => {
        if (snap.exists()) {
          callbacks.onTurnConfig(snap.val() as TurnConfig);
        } else {
          callbacks.onTurnConfig(null);
        }
      }),
    );

    if (callbacks.onCustomSounds) {
      unsubs.push(
        onValue(ref(rtdb, roomPath('customSounds', boundRoomId)), (snap) => {
          const raw = (snap.val() as Record<string, CustomSoundItem> | null) || {};
          const list = Object.values(raw)
            .filter((s) => Boolean(s?.id && s?.label && s?.audio_url))
            .sort((a, b) => a.created_at.localeCompare(b.created_at));
          callbacks.onCustomSounds?.(list);
        }),
      );
    }

    unsubs.push(
      onChildAdded(mySignalsRef, (snap) => {
        if (voiceOwnerUid !== user.id || voiceOwnerRoomId !== boundRoomId) return;
        const payload = snap.val() as RtcSignalPayload | null;
        if (payload) {
          callbacks.onRtcSignal(payload);
        }
        remove(snap.ref).catch(() => {});
      }),
    );

    return () => {
      for (const unsub of unsubs) {
        unsub();
      }
      if (presenceHealTimer !== null) {
        clearTimeout(presenceHealTimer);
        presenceHealTimer = null;
      }
      clearVoiceRestoreTimer();
      activeVoiceHealHook = null;
      remove(presenceRef).catch(() => {});
      if (voiceOwnerUid === user.id && voiceOwnerRoomId === boundRoomId) {
        voiceOwnerUid = null;
        voiceEntryCache = null;
        voiceRestorePending = false;
        remove(voiceRef).catch(() => {});
        remove(mySignalsRef).catch(() => {});
      }
      callbacks.onConnectionStatus('disconnected');
    };
  },

  subscribeChannelMessages(
    channelId: string,
    onMessages: (messages: Message[]) => void,
    limit = 80,
  ): () => void {
    const { rtdb } = getFirebaseServices();
    const q = query(
      ref(rtdb, roomPath(`messages/${channelId}`)),
      orderByChild('created_at'),
      limitToLast(limit),
    );
    return onValue(q, (snap) => {
      const raw = (snap.val() as Record<string, Message> | null) || {};
      const list = Object.values(raw).sort((a, b) =>
        a.created_at.localeCompare(b.created_at),
      );
      onMessages(list);
    });
  },

  subscribeChannelLatestMessage(
    channelId: string,
    onLatest: (msg: Message | null) => void,
  ): () => void {
    const { rtdb } = getFirebaseServices();
    const q = query(
      ref(rtdb, roomPath(`messages/${channelId}`)),
      orderByChild('created_at'),
      limitToLast(1),
    );
    return onValue(q, (snap) => {
      const raw = (snap.val() as Record<string, Message> | null) || {};
      const list = Object.values(raw);
      onLatest(list[0] || null);
    });
  },

  async sendMessage(
    user: PublicUser,
    channelId: string,
    content: string,
    attachment?: { url: string; name: string } | null,
    replyTo?: MessageReplyRef | null,
  ): Promise<void> {
    const { rtdb } = getFirebaseServices();
    const msgRef = push(ref(rtdb, roomPath(`messages/${channelId}`)));
    const id = msgRef.key || crypto.randomUUID();
    const msg: Message = {
      id,
      channel_id: channelId,
      user_id: user.id,
      username: user.username,
      display_name: user.display_name,
      avatar_color: user.avatar_color,
      avatar_url: user.avatar_url ?? null,
      content,
      attachment_url: attachment?.url ?? null,
      attachment_name: attachment?.name ?? null,
      reply_to: replyTo ?? null,
      created_at: new Date().toISOString(),
    };
    await set(msgRef, sanitizeRtcPayload(msg));
  },

  async createChannel(name: string, kind: 'text' | 'voice', position: number): Promise<Channel> {
    const { rtdb } = getFirebaseServices();
    const chRef = push(ref(rtdb, roomPath('channels')));
    const id = chRef.key || crypto.randomUUID();
    const ch: Channel = {
      id,
      name: name.trim().slice(0, 32),
      kind,
      position,
      created_at: new Date().toISOString(),
    };
    await set(chRef, ch);
    return ch;
  },

  async deleteChannel(channelId: string): Promise<void> {
    const { rtdb } = getFirebaseServices();
    await remove(ref(rtdb, roomPath(`channels/${channelId}`)));
  },

  async joinVoice(
    user: PublicUser,
    channelId: string,
    state: {
      muted: boolean;
      deafened: boolean;
      screen_sharing: boolean;
      screen_stream_id: string | null;
      camera_on?: boolean;
      camera_stream_id?: string | null;
    },
  ): Promise<void> {
    const { rtdb } = getFirebaseServices();
    const boundRoomId = activeRoomId;
    const voiceRef = ref(rtdb, roomPath(`voice/${user.id}`, boundRoomId));
    const signalsRef = ref(rtdb, roomPath(`signals/${user.id}`, boundRoomId));
    await remove(signalsRef).catch(() => {});
    await remove(ref(rtdb, roomPath(`voice_kicks/${user.id}`, boundRoomId))).catch(() => {});
    voiceOwnerUid = user.id;
    voiceOwnerRoomId = boundRoomId;
    voiceRestorePending = false;
    await onDisconnect(voiceRef).remove().catch(() => {});
    await onDisconnect(signalsRef).remove().catch(() => {});
    const member: VoiceMemberState = {
      session_id: SESSION_ID,
      user_id: user.id,
      username: user.username,
      display_name: user.display_name,
      avatar_color: user.avatar_color,
      avatar_url: user.avatar_url ?? null,
      channel_id: channelId,
      muted: state.muted,
      deafened: state.deafened,
      force_muted: false,
      kicked_by_admin: false,
      screen_sharing: state.screen_sharing,
      screen_stream_id: state.screen_stream_id,
      camera_on: Boolean(state.camera_on),
      camera_stream_id: state.camera_stream_id ?? null,
      speaking: false,
    };
    voiceEntryCache = member;
    try {
      await set(voiceRef, sanitizeRtcPayload(member));
    } catch (err) {
      firebaseBackend.releaseVoiceOwnership(user.id);
      throw err;
    }
  },

  async leaveVoice(userId: string): Promise<void> {
    const { rtdb } = getFirebaseServices();
    const roomId = voiceOwnerRoomId;
    firebaseBackend.releaseVoiceOwnership(userId);
    remove(ref(rtdb, roomPath(`voice_kicks/${userId}`, roomId))).catch(() => {});
    await remove(ref(rtdb, roomPath(`voice/${userId}`, roomId)));
  },

  releaseVoiceOwnership(userId: string): void {
    if (voiceOwnerUid !== userId) return;
    const roomId = voiceOwnerRoomId;
    voiceOwnerUid = null;
    voiceEntryCache = null;
    voiceRestorePending = false;
    const { rtdb } = getFirebaseServices();
    onDisconnect(ref(rtdb, roomPath(`voice/${userId}`, roomId))).cancel().catch(() => {});
    onDisconnect(ref(rtdb, roomPath(`signals/${userId}`, roomId))).cancel().catch(() => {});
  },

  async updateVoiceState(
    userId: string,
    patch: Partial<
      Pick<
        VoiceMemberState,
        | 'muted'
        | 'deafened'
        | 'force_muted'
        | 'screen_sharing'
        | 'screen_stream_id'
        | 'camera_on'
        | 'camera_stream_id'
        | 'speaking'
      >
    >,
  ): Promise<void> {
    if (voiceOwnerUid !== userId) return;
    if (voiceEntryCache) voiceEntryCache = { ...voiceEntryCache, ...patch };
    if (voiceRestorePending) return;
    const { rtdb } = getFirebaseServices();
    await update(ref(rtdb, roomPath(`voice/${userId}`, voiceOwnerRoomId)), sanitizeRtcPayload(patch));
  },

  isVoiceRestorePending(userId: string): boolean {
    return voiceRestorePending && voiceOwnerUid === userId;
  },

  /**
   * Nudges Firebase RTDB back online after a mobile screen-lock / app-switch and
   * immediately verifies/heals the active voice entry if needed.
   */
  ensureOnlineAndHealVoice(userId: string): void {
    try {
      const { rtdb } = getFirebaseServices();
      if (typeof goOnline === 'function') {
        goOnline(rtdb);
      }
    } catch {
      // Ignore if Firebase is not initialized
    }
    activeVoiceHealHook?.(userId);
  },

  ownsVoice(userId: string): boolean {
    return voiceOwnerUid === userId;
  },

  sessionId(): string {
    return SESSION_ID;
  },

  async sendRtcSignal(targetUserId: string, payload: RtcSignalPayload): Promise<void> {
    const { rtdb } = getFirebaseServices();
    const sigRef = push(ref(rtdb, roomPath(`signals/${targetUserId}`, voiceOwnerRoomId)));
    try {
      await set(sigRef, sanitizeRtcPayload({ ...payload, session_id: SESSION_ID }));
    } catch (err) {
      console.warn('WebRTC signal send failed:', err);
    }
  },
};

async function seedDefaultChannelsIfEmpty(now: string, roomId = DEFAULT_ROOM_ID): Promise<void> {
  const { rtdb } = getFirebaseServices();
  const chRoot = roomPath('channels', roomId);
  const snap = await get(ref(rtdb, chRoot));
  if (snap.exists()) return;

  const defaults: Array<{ name: string; kind: 'text' | 'voice'; position: number }> = [
    { name: 'genel', kind: 'text', position: 0 },
    { name: 'medya-link', kind: 'text', position: 1 },
    { name: 'Oyun Odası', kind: 'voice', position: 2 },
    { name: 'Sohbet & Yayın', kind: 'voice', position: 3 },
    { name: 'AFK', kind: 'voice', position: 4 },
  ];

  for (const item of defaults) {
    const chRef = push(ref(rtdb, chRoot));
    const id = chRef.key || crypto.randomUUID();
    await set(chRef, {
      id,
      name: item.name,
      kind: item.kind,
      position: item.position,
      created_at: now,
    } satisfies Channel);
  }
}
