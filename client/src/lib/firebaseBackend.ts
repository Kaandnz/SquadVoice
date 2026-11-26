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
  Message,
  MessageReplyRef,
  PublicUser,
  SoundboardEvent,
  SoundboardId,
  TurnConfig,
  UserStatus,
  VoiceMemberState,
} from '../types/protocol';
import { getFirebaseServices, usernameToEmail, validateEmail } from './firebase';
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

const SLOTS = ['1', '2', '3', '4', '5'] as const;

/**
 * voice/{uid} and signals/{uid} are keyed per account, but one account can have several
 * sessions open (desktop app, phone, a browser tab). Only the session that actually joined
 * voice may clean up the voice entry or consume WebRTC signals; otherwise closing any other
 * session of the same account dropped the live call, and an idle tab could steal offers.
 */
let voiceOwnerUid: string | null = null;

function pickAvatarColor(username: string): string {
  let sum = 0;
  for (let i = 0; i < username.length; i += 1) {
    sum += username.charCodeAt(i);
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
  slot: string;
  invite_code?: string;
}

export type RtcSignalPayload =
  | {
      kind: 'offer';
      from_user_id: string;
      sdp: RTCSessionDescriptionInit;
      screen_stream_id?: string | null;
      camera_stream_id?: string | null;
    }
  | {
      kind: 'answer';
      from_user_id: string;
      sdp: RTCSessionDescriptionInit;
    }
  | {
      kind: 'ice';
      from_user_id: string;
      candidate: RTCIceCandidateInit;
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
}

export const firebaseBackend = {
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
    inviteCode: string,
  ): Promise<PublicUser> {
    const { auth, rtdb } = getFirebaseServices();
    const cleanUsername = username.trim();
    if (cleanUsername.length < 2 || cleanUsername.length > 24) {
      throw new Error('Kullanıcı adı 2 ile 24 karakter arasında olmalıdır.');
    }

    const email = emailInput.trim()
      ? validateEmail(emailInput)
      : usernameToEmail(cleanUsername);
    const cleanInvite = inviteCode.trim();

    if (!cleanInvite) {
      throw new Error('Davet kodu zorunludur.');
    }

    let fbUser: FirebaseAuthUser;
    try {
      const cred = await createUserWithEmailAndPassword(auth, email, password);
      fbUser = cred.user;
    } catch (err) {
      throw mapAuthError(err);
    }

    let claimedSlot: string | null = null;
    try {
      const slotsSnap = await get(ref(rtdb, 'slots'));
      const slotsData = (slotsSnap.val() as Record<string, string> | null) || {};
      const freeSlot = SLOTS.find((s) => !slotsData[s]);

      if (!freeSlot) {
        await deleteUser(fbUser).catch(() => {});
        throw new Error('Sunucu maksimum kullanıcı sayısına ulaştı (5/5).');
      }

      await set(ref(rtdb, `slots/${freeSlot}`), fbUser.uid);
      claimedSlot = freeSlot;

      const isFirstUser = freeSlot === '1' && Object.keys(slotsData).length === 0;
      const role = isFirstUser ? 'admin' : 'member';

      if (isFirstUser) {
        await set(ref(rtdb, 'config/inviteCode'), cleanInvite);
      }

      const now = new Date().toISOString();
      const userRecord: StoredUserRecord = {
        id: fbUser.uid,
        username: cleanUsername.includes('@')
          ? cleanUsername.split('@')[0]
          : cleanUsername,
        display_name: (displayName.trim() || cleanUsername).slice(0, 32),
        avatar_color: pickAvatarColor(cleanUsername),
        status: 'online',
        role,
        slot: freeSlot,
        email,
        invite_code: cleanInvite,
        created_at: now,
      };

      await set(ref(rtdb, `users/${fbUser.uid}`), userRecord);

      if (isFirstUser) {
        await seedDefaultChannelsIfEmpty(now);
      }

      const { invite_code: _ic, ...publicUser } = userRecord;
      return publicUser;
    } catch (err) {
      if (claimedSlot) {
        await remove(ref(rtdb, `slots/${claimedSlot}`)).catch(() => {});
      }
      await deleteUser(fbUser).catch(() => {});
      const msg = err instanceof Error ? err.message : '';
      if (msg.toLowerCase().includes('permission')) {
        throw new Error('Geçersiz davet kodu.');
      }
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
        throw new Error('Kullanıcı profili bulunamadı veya sunucudan çıkarılmış.');
      }
      return snap.val() as PublicUser;
    } catch (err) {
      throw mapAuthError(err);
    }
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
    await update(ref(rtdb, `presence/${userId}`), cleanPatch).catch(() => {});

    if (inVoice) {
      const voicePatch: Record<string, unknown> = {};
      if (cleanPatch.display_name !== undefined) voicePatch.display_name = cleanPatch.display_name;
      if (cleanPatch.avatar_color !== undefined) voicePatch.avatar_color = cleanPatch.avatar_color;
      if (cleanPatch.avatar_url !== undefined) voicePatch.avatar_url = cleanPatch.avatar_url;
      if (Object.keys(voicePatch).length > 0) {
        await update(ref(rtdb, `voice/${userId}`), voicePatch).catch(() => {});
      }
    }
  },

  async getAdminInviteCode(): Promise<string | null> {
    const { rtdb } = getFirebaseServices();
    try {
      const snap = await get(ref(rtdb, 'config/inviteCode'));
      return snap.exists() ? String(snap.val()) : null;
    } catch {
      return null;
    }
  },

  async setInviteCode(code: string): Promise<void> {
    const clean = code.trim();
    if (clean.length < 3 || clean.length > 40) {
      throw new Error('Davet kodu 3-40 karakter arasında olmalıdır.');
    }
    const { rtdb } = getFirebaseServices();
    await set(ref(rtdb, 'config/inviteCode'), clean);
  },

  async setServerName(name: string): Promise<void> {
    const clean = name.trim();
    if (clean.length < 1 || clean.length > 32) {
      throw new Error('Sunucu adı 1-32 karakter arasında olmalıdır.');
    }
    const { rtdb } = getFirebaseServices();
    await set(ref(rtdb, 'config/serverName'), clean);
  },

  async setTurnConfig(turn: TurnConfig | null): Promise<void> {
    const { rtdb } = getFirebaseServices();
    const turnRef = ref(rtdb, 'config/turn');
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

  async setUserRole(targetUid: string, role: 'admin' | 'member'): Promise<void> {
    const { rtdb } = getFirebaseServices();
    await update(ref(rtdb, `users/${targetUid}`), { role });
  },

  async kickMember(targetUser: PublicUser): Promise<void> {
    const { rtdb } = getFirebaseServices();
    const slotsSnap = await get(ref(rtdb, 'slots'));
    const slotsData = (slotsSnap.val() as Record<string, string> | null) || {};
    for (const [slotKey, uid] of Object.entries(slotsData)) {
      if (uid === targetUser.id) {
        await remove(ref(rtdb, `slots/${slotKey}`));
      }
    }
    await remove(ref(rtdb, `voice/${targetUser.id}`)).catch(() => {});
    await remove(ref(rtdb, `presence/${targetUser.id}`)).catch(() => {});
    await remove(ref(rtdb, `users/${targetUser.id}`));
  },

  async adminForceMute(targetUid: string, forceMuted: boolean): Promise<void> {
    const { rtdb } = getFirebaseServices();
    await update(ref(rtdb, `voice/${targetUid}`), {
      force_muted: forceMuted,
      muted: forceMuted,
      speaking: false,
    });
  },

  async adminDisconnectVoice(targetUid: string): Promise<void> {
    const { rtdb } = getFirebaseServices();
    await update(ref(rtdb, `voice/${targetUid}`), { kicked_by_admin: true });
    window.setTimeout(() => {
      remove(ref(rtdb, `voice/${targetUid}`)).catch(() => {});
    }, 1200);
  },

  async adminMoveVoice(targetUid: string, targetChannelId: string): Promise<void> {
    const { rtdb } = getFirebaseServices();
    await update(ref(rtdb, `voice/${targetUid}`), { channel_id: targetChannelId });
  },

  async renameChannel(channelId: string, newName: string): Promise<void> {
    const clean = newName.trim().slice(0, 32);
    if (!clean) throw new Error('Kanal adı boş olamaz.');
    const { rtdb } = getFirebaseServices();
    await update(ref(rtdb, `channels/${channelId}`), { name: clean });
  },

  async editMessage(channelId: string, messageId: string, content: string): Promise<void> {
    const { rtdb } = getFirebaseServices();
    await update(ref(rtdb, `messages/${channelId}/${messageId}`), {
      content: content.trim(),
      edited_at: new Date().toISOString(),
    });
  },

  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    const { rtdb } = getFirebaseServices();
    await remove(ref(rtdb, `messages/${channelId}/${messageId}`));
  },

  async clearChannelMessages(channelId: string): Promise<void> {
    const { rtdb } = getFirebaseServices();
    await remove(ref(rtdb, `messages/${channelId}`));
  },

  async toggleReaction(
    channelId: string,
    messageId: string,
    emoji: string,
    userId: string,
    active: boolean,
  ): Promise<void> {
    const { rtdb } = getFirebaseServices();
    const rRef = ref(rtdb, `messages/${channelId}/${messageId}/reactions/${emoji}/${userId}`);
    if (active) {
      await set(rRef, true);
    } else {
      await remove(rRef);
    }
  },

  async togglePinMessage(channelId: string, messageId: string, pinned: boolean): Promise<void> {
    const { rtdb } = getFirebaseServices();
    const pRef = ref(rtdb, `messages/${channelId}/${messageId}/pinned`);
    if (pinned) {
      await set(pRef, true);
    } else {
      await remove(pRef);
    }
  },

  async setTyping(
    scopeKey: string,
    userId: string,
    displayName: string,
    isTyping: boolean,
  ): Promise<void> {
    const { rtdb } = getFirebaseServices();
    const tRef = ref(rtdb, `typing/${scopeKey}/${userId}`);
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
    return onValue(ref(rtdb, `typing/${scopeKey}`), (snap) => {
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
  ): Promise<void> {
    const { rtdb } = getFirebaseServices();
    const event: SoundboardEvent = {
      id: crypto.randomUUID(),
      sound,
      user_id: user.id,
      display_name: user.display_name,
      ts: Date.now(),
    };
    await set(ref(rtdb, `soundboard/${channelId}`), event);
  },

  subscribeSoundboard(
    channelId: string,
    onSound: (ev: SoundboardEvent) => void,
  ): () => void {
    const { rtdb } = getFirebaseServices();
    return onValue(ref(rtdb, `soundboard/${channelId}`), (snap) => {
      const ev = snap.val() as SoundboardEvent | null;
      if (ev && Date.now() - ev.ts < 5000) {
        onSound(ev);
      }
    });
  },

  subscribeDmMessages(pairId: string, onMessages: (messages: Message[]) => void): () => void {
    const { rtdb } = getFirebaseServices();
    const q = query(
      ref(rtdb, `dms/${pairId}`),
      orderByChild('created_at'),
      limitToLast(80),
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

  startRealtimeSession(user: PublicUser, callbacks: RealtimeCallbacks): () => void {
    const { rtdb } = getFirebaseServices();
    const unsubs: Unsubscribe[] = [];

    callbacks.onConnectionStatus('connecting');

    const connectedRef = ref(rtdb, '.info/connected');
    const presenceRef = ref(rtdb, `presence/${user.id}`);
    const voiceRef = ref(rtdb, `voice/${user.id}`);
    const mySignalsRef = ref(rtdb, `signals/${user.id}`);

    unsubs.push(
      onValue(connectedRef, (snap) => {
        const connected = Boolean(snap.val());
        if (connected) {
          callbacks.onConnectionStatus('connected');
          onDisconnect(presenceRef).remove().catch(() => {});
          if (voiceOwnerUid === user.id) {
            onDisconnect(voiceRef).remove().catch(() => {});
            onDisconnect(mySignalsRef).remove().catch(() => {});
          }
          set(
            presenceRef,
            sanitizeRtcPayload({
              id: user.id,
              username: user.username,
              display_name: user.display_name,
              avatar_color: user.avatar_color,
              avatar_url: user.avatar_url ?? null,
              status: user.status ?? 'online',
              custom_status: user.custom_status ?? null,
              role: user.role,
              created_at: user.created_at,
            }),
          ).catch(() => {});
        } else {
          callbacks.onConnectionStatus('connecting');
        }
      }),
    );

    unsubs.push(
      onValue(ref(rtdb, 'users'), (snap) => {
        const raw = (snap.val() as Record<string, PublicUser> | null) || {};
        const list = Object.values(raw).sort((a, b) =>
          a.created_at.localeCompare(b.created_at),
        );
        if (!raw[user.id]) {
          callbacks.onKicked();
          return;
        }
        callbacks.onUsers(list);
      }),
    );

    unsubs.push(
      onValue(ref(rtdb, 'presence'), (snap) => {
        const raw = (snap.val() as Record<string, PublicUser> | null) || {};
        const list = Object.values(raw).sort((a, b) =>
          a.username.localeCompare(b.username),
        );
        callbacks.onOnlineUsers(list);
      }),
    );

    unsubs.push(
      onValue(ref(rtdb, 'channels'), (snap) => {
        const raw = (snap.val() as Record<string, Channel> | null) || {};
        const list = Object.values(raw).sort((a, b) => a.position - b.position);
        callbacks.onChannels(list);
      }),
    );

    unsubs.push(
      onValue(ref(rtdb, 'voice'), (snap) => {
        const raw = (snap.val() as Record<string, VoiceMemberState> | null) || {};
        const list = Object.values(raw).sort((a, b) =>
          a.username.localeCompare(b.username),
        );
        callbacks.onVoiceMembers(list);
      }),
    );

    unsubs.push(
      onValue(ref(rtdb, 'config/serverName'), (snap) => {
        if (snap.exists()) {
          callbacks.onServerName(String(snap.val()));
        } else {
          callbacks.onServerName('SquadVoice');
        }
      }),
    );

    unsubs.push(
      onValue(ref(rtdb, 'config/turn'), (snap) => {
        if (snap.exists()) {
          callbacks.onTurnConfig(snap.val() as TurnConfig);
        } else {
          callbacks.onTurnConfig(null);
        }
      }),
    );

    unsubs.push(
      onChildAdded(mySignalsRef, (snap) => {
        // Signals belong to whichever session of this account is in voice
        if (voiceOwnerUid !== user.id) return;
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
      remove(presenceRef).catch(() => {});
      if (voiceOwnerUid === user.id) {
        voiceOwnerUid = null;
        remove(voiceRef).catch(() => {});
        remove(mySignalsRef).catch(() => {});
      }
      callbacks.onConnectionStatus('disconnected');
    };
  },

  subscribeChannelMessages(
    channelId: string,
    onMessages: (messages: Message[]) => void,
  ): () => void {
    const { rtdb } = getFirebaseServices();
    const q = query(
      ref(rtdb, `messages/${channelId}`),
      orderByChild('created_at'),
      limitToLast(80),
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
      ref(rtdb, `messages/${channelId}`),
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
    const msgRef = push(ref(rtdb, `messages/${channelId}`));
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
    const chRef = push(ref(rtdb, 'channels'));
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
    await remove(ref(rtdb, `channels/${channelId}`));
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
    const voiceRef = ref(rtdb, `voice/${user.id}`);
    const signalsRef = ref(rtdb, `signals/${user.id}`);
    await remove(signalsRef).catch(() => {});
    // Claim the entry before writing it so offers that arrive right after are not dropped
    voiceOwnerUid = user.id;
    await onDisconnect(voiceRef).remove().catch(() => {});
    await onDisconnect(signalsRef).remove().catch(() => {});
    const member: VoiceMemberState = {
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
    try {
      await set(voiceRef, sanitizeRtcPayload(member));
    } catch (err) {
      firebaseBackend.releaseVoiceOwnership(user.id);
      throw err;
    }
  },

  async leaveVoice(userId: string): Promise<void> {
    const { rtdb } = getFirebaseServices();
    firebaseBackend.releaseVoiceOwnership(userId);
    await remove(ref(rtdb, `voice/${userId}`));
  },

  /** Stops this session from owning voice/{uid} without touching the entry itself. */
  releaseVoiceOwnership(userId: string): void {
    if (voiceOwnerUid !== userId) return;
    voiceOwnerUid = null;
    const { rtdb } = getFirebaseServices();
    onDisconnect(ref(rtdb, `voice/${userId}`)).cancel().catch(() => {});
    onDisconnect(ref(rtdb, `signals/${userId}`)).cancel().catch(() => {});
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
    const { rtdb } = getFirebaseServices();
    await update(ref(rtdb, `voice/${userId}`), sanitizeRtcPayload(patch));
  },

  async sendRtcSignal(targetUserId: string, payload: RtcSignalPayload): Promise<void> {
    const { rtdb } = getFirebaseServices();
    const sigRef = push(ref(rtdb, `signals/${targetUserId}`));
    try {
      await set(sigRef, sanitizeRtcPayload(payload));
    } catch (err) {
      console.warn('WebRTC signal send failed:', err);
    }
  },
};

async function seedDefaultChannelsIfEmpty(now: string): Promise<void> {
  const { rtdb } = getFirebaseServices();
  const snap = await get(ref(rtdb, 'channels'));
  if (snap.exists()) return;

  const defaults: Array<{ name: string; kind: 'text' | 'voice'; position: number }> = [
    { name: 'genel', kind: 'text', position: 0 },
    { name: 'medya-link', kind: 'text', position: 1 },
    { name: 'Oyun Odası', kind: 'voice', position: 2 },
    { name: 'Sohbet & Yayın', kind: 'voice', position: 3 },
    { name: 'AFK', kind: 'voice', position: 4 },
  ];

  for (const item of defaults) {
    const chRef = push(ref(rtdb, 'channels'));
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
