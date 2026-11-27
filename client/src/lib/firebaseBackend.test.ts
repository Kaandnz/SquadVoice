import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicUser, VoiceMemberState } from '../types/protocol';

type Snap = { val: () => unknown; exists: () => boolean; ref: { path: string } };
type Write = { op: 'set' | 'update' | 'remove'; path: string; value?: unknown };

const db = vi.hoisted(() => ({
  values: new Map<string, (snap: Snap) => void>(),
  children: new Map<string, (snap: Snap) => void>(),
  writes: [] as Write[],
  disconnectOps: [] as Array<{ op: 'remove' | 'cancel'; path: string }>,
  rejectSetFor: null as string | null,
  serverValues: new Map<string, unknown>(),
}));

vi.mock('firebase/database', () => {
  const ref = (_db: unknown, path = '') => ({ path });
  return {
    ref,
    onValue: (r: { path: string }, cb: (snap: Snap) => void) => {
      db.values.set(r.path, cb);
      return () => db.values.delete(r.path);
    },
    onChildAdded: (r: { path: string }, cb: (snap: Snap) => void) => {
      db.children.set(r.path, cb);
      return () => db.children.delete(r.path);
    },
    onDisconnect: (r: { path: string }) => ({
      remove: async () => {
        db.disconnectOps.push({ op: 'remove', path: r.path });
      },
      cancel: async () => {
        db.disconnectOps.push({ op: 'cancel', path: r.path });
      },
    }),
    set: async (r: { path: string }, value: unknown) => {
      db.writes.push({ op: 'set', path: r.path, value });
      if (db.rejectSetFor === r.path) throw new Error('PERMISSION_DENIED');
    },
    update: async (r: { path: string }, value: unknown) => {
      db.writes.push({ op: 'update', path: r.path, value });
    },
    remove: async (r: { path: string }) => {
      db.writes.push({ op: 'remove', path: r.path });
    },
    get: async (r: { path: string }) => {
      const value = db.serverValues.get(r.path) ?? null;
      return { exists: () => value !== null, val: () => value };
    },
    goOnline: vi.fn(),
    push: (r: { path: string }) => ({ path: `${r.path}/pushed`, key: 'pushed' }),
    query: (r: unknown) => r,
    orderByChild: () => ({}),
    limitToLast: () => ({}),
  };
});

vi.mock('firebase/auth', () => ({
  createUserWithEmailAndPassword: vi.fn(),
  deleteUser: vi.fn(),
  EmailAuthProvider: { credential: vi.fn() },
  onAuthStateChanged: vi.fn(),
  reauthenticateWithCredential: vi.fn(),
  sendPasswordResetEmail: vi.fn(),
  signInWithEmailAndPassword: vi.fn(),
  signOut: vi.fn(),
  updatePassword: vi.fn(),
}));

vi.mock('./firebase', () => ({
  getFirebaseServices: () => ({ app: {}, auth: {}, rtdb: {} }),
  usernameToEmail: (v: string) => v,
  validateEmail: (v: string) => v,
}));

const USER: PublicUser = {
  id: 'uid-me',
  username: 'kagan',
  display_name: 'Kağan',
  avatar_color: '#5865F2',
  avatar_url: null,
  status: 'online',
  custom_status: null,
  role: 'member',
  created_at: '2026-01-01T00:00:00.000Z',
};

const VOICE_STATE = {
  muted: false,
  deafened: false,
  screen_sharing: false,
  screen_stream_id: null,
};

function snap(path: string, value: unknown): Snap {
  return { val: () => value, exists: () => value !== null && value !== undefined, ref: { path } };
}

function emit(path: string, value: unknown) {
  const cb = db.values.get(path);
  if (!cb) throw new Error(`no listener on ${path}`);
  cb(snap(path, value));
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function writesTo(path: string, op?: Write['op']) {
  return db.writes.filter((w) => w.path === path && (!op || w.op === op));
}

async function loadBackend() {
  vi.resetModules();
  const mod = await import('./firebaseBackend');
  return mod.firebaseBackend;
}

function callbacks() {
  return {
    onUsers: vi.fn(),
    onOnlineUsers: vi.fn(),
    onChannels: vi.fn(),
    onVoiceMembers: vi.fn(),
    onServerName: vi.fn(),
    onTurnConfig: vi.fn(),
    onKicked: vi.fn(),
    onRtcSignal: vi.fn(),
    onConnectionStatus: vi.fn(),
    onVoiceRestoreFailed: vi.fn(),
  };
}

beforeEach(() => {
  db.values.clear();
  db.children.clear();
  db.writes.length = 0;
  db.disconnectOps.length = 0;
  db.rejectSetFor = null;
  db.serverValues.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('voice entry restore after a connection drop', () => {
  it('re-creates our voice entry with the latest state instead of leaving the room', async () => {
    const backend = await loadBackend();
    backend.startRealtimeSession(USER, callbacks());
    emit('.info/connected', true);
    await backend.joinVoice(USER, 'ch-1', VOICE_STATE);
    await backend.updateVoiceState(USER.id, { muted: true });

    emit('.info/connected', false);
    expect(backend.isVoiceRestorePending(USER.id)).toBe(true);

    // Changes made while offline are kept for the restore, not written as stubs
    const updatesBefore = writesTo('voice/uid-me', 'update').length;
    await backend.updateVoiceState(USER.id, { deafened: true, speaking: true });
    expect(writesTo('voice/uid-me', 'update')).toHaveLength(updatesBefore);

    emit('.info/connected', true);
    await flush();

    const restored = writesTo('voice/uid-me', 'set').at(-1)?.value as VoiceMemberState;
    expect(restored).toMatchObject({
      user_id: USER.id,
      channel_id: 'ch-1',
      muted: true,
      deafened: true,
      speaking: false,
      kicked_by_admin: false,
      session_id: backend.sessionId(),
    });
    expect(backend.isVoiceRestorePending(USER.id)).toBe(false);
    expect(db.disconnectOps).toContainEqual({ op: 'remove', path: 'voice/uid-me' });
  });

  it('restores admin-side changes such as a force mute', async () => {
    const backend = await loadBackend();
    backend.startRealtimeSession(USER, callbacks());
    emit('.info/connected', true);
    await backend.joinVoice(USER, 'ch-1', VOICE_STATE);
    const serverEntry = writesTo('voice/uid-me', 'set').at(-1)?.value as VoiceMemberState;
    emit('voice', { [USER.id]: { ...serverEntry, force_muted: true, muted: true, channel_id: 'ch-2' } });

    emit('.info/connected', false);
    emit('.info/connected', true);
    await flush();

    expect(writesTo('voice/uid-me', 'set').at(-1)?.value).toMatchObject({
      force_muted: true,
      muted: true,
      channel_id: 'ch-2',
    });
  });

  it('does nothing for a session that is not in voice', async () => {
    const backend = await loadBackend();
    backend.startRealtimeSession(USER, callbacks());
    emit('.info/connected', true);
    emit('.info/connected', false);
    emit('.info/connected', true);
    await flush();

    expect(writesTo('voice/uid-me')).toHaveLength(0);
    expect(db.disconnectOps.some((o) => o.path === 'voice/uid-me')).toBe(false);
  });

  it('gives the entry up when the restore is rejected', async () => {
    const backend = await loadBackend();
    backend.startRealtimeSession(USER, callbacks());
    emit('.info/connected', true);
    await backend.joinVoice(USER, 'ch-1', VOICE_STATE);

    emit('.info/connected', false);
    db.rejectSetFor = 'voice/uid-me';
    emit('.info/connected', true);
    await flush();

    expect(backend.ownsVoice(USER.id)).toBe(false);
    expect(backend.isVoiceRestorePending(USER.id)).toBe(false);
  });

  it('does not clobber a call another device took over while we were offline', async () => {
    const backend = await loadBackend();
    backend.startRealtimeSession(USER, callbacks());
    emit('.info/connected', true);
    await backend.joinVoice(USER, 'ch-1', VOICE_STATE);
    const ours = writesTo('voice/uid-me', 'set').at(-1)?.value as VoiceMemberState;
    const setsBefore = writesTo('voice/uid-me', 'set').length;

    emit('.info/connected', false);
    db.serverValues.set('voice/uid-me', { ...ours, session_id: 'phone-session' });
    emit('.info/connected', true);
    await flush();

    expect(writesTo('voice/uid-me', 'set')).toHaveLength(setsBefore);
    expect(backend.ownsVoice(USER.id)).toBe(false);
    expect(db.disconnectOps).toContainEqual({ op: 'cancel', path: 'voice/uid-me' });
  });

  it('keeps the live entry after a short blip instead of overwriting admin changes', async () => {
    const backend = await loadBackend();
    backend.startRealtimeSession(USER, callbacks());
    emit('.info/connected', true);
    await backend.joinVoice(USER, 'ch-1', VOICE_STATE);
    const ours = writesTo('voice/uid-me', 'set').at(-1)?.value as VoiceMemberState;
    const setsBefore = writesTo('voice/uid-me', 'set').length;

    emit('.info/connected', false);
    // Server never dropped us; an admin force-muted us meanwhile
    db.serverValues.set('voice/uid-me', { ...ours, force_muted: true, muted: true });
    emit('.info/connected', true);
    await flush();

    expect(writesTo('voice/uid-me', 'set')).toHaveLength(setsBefore);
    expect(backend.ownsVoice(USER.id)).toBe(true);
    expect(backend.isVoiceRestorePending(USER.id)).toBe(false);
  });

  it('does not bring back a call an admin ended while we were offline', async () => {
    const backend = await loadBackend();
    const cb = callbacks();
    backend.startRealtimeSession(USER, cb);
    emit('.info/connected', true);
    await backend.joinVoice(USER, 'ch-1', VOICE_STATE);
    const setsBefore = writesTo('voice/uid-me', 'set').length;

    emit('.info/connected', false);
    db.serverValues.set('voice_kicks/uid-me', 1764187200000);
    emit('.info/connected', true);
    await flush();

    expect(writesTo('voice/uid-me', 'set')).toHaveLength(setsBefore);
    expect(writesTo('voice_kicks/uid-me', 'remove').length).toBeGreaterThan(0);
    expect(backend.ownsVoice(USER.id)).toBe(false);
    expect(cb.onVoiceRestoreFailed).toHaveBeenCalledWith('kicked');
  });

  it('leaves (and tells the store) when the restore is rejected', async () => {
    const backend = await loadBackend();
    const cb = callbacks();
    backend.startRealtimeSession(USER, cb);
    emit('.info/connected', true);
    await backend.joinVoice(USER, 'ch-1', VOICE_STATE);

    emit('.info/connected', false);
    db.rejectSetFor = 'voice/uid-me';
    emit('.info/connected', true);
    await flush();

    expect(cb.onVoiceRestoreFailed).toHaveBeenCalledWith('failed');
    expect(backend.ownsVoice(USER.id)).toBe(false);
  });

  it('stops restoring after leaving voice', async () => {
    const backend = await loadBackend();
    backend.startRealtimeSession(USER, callbacks());
    emit('.info/connected', true);
    await backend.joinVoice(USER, 'ch-1', VOICE_STATE);
    emit('.info/connected', false);
    await backend.leaveVoice(USER.id);
    const setsBefore = writesTo('voice/uid-me', 'set').length;

    emit('.info/connected', true);
    await flush();

    expect(writesTo('voice/uid-me', 'set')).toHaveLength(setsBefore);
  });

  it('self-heals voice entry if server onDisconnect removes it while still connected', async () => {
    const backend = await loadBackend();
    const cb = callbacks();
    backend.startRealtimeSession(USER, cb);
    emit('.info/connected', true);
    await backend.joinVoice(USER, 'ch-1', VOICE_STATE);
    const setsBefore = writesTo('voice/uid-me', 'set').length;

    // Server removed our entry (e.g., mobile screen-lock socket timeout) before .info/connected flipped
    emit('voice', {});
    expect(backend.isVoiceRestorePending(USER.id)).toBe(true);
    await flush();

    expect(writesTo('voice/uid-me', 'set')).toHaveLength(setsBefore + 1);
    expect(backend.isVoiceRestorePending(USER.id)).toBe(false);
    expect(backend.ownsVoice(USER.id)).toBe(true);
    expect(cb.onVoiceRestoreFailed).not.toHaveBeenCalled();
  });
});

describe('sessions of the same account', () => {
  it('only the voice session consumes WebRTC signals', async () => {
    const backend = await loadBackend();
    const cb = callbacks();
    backend.startRealtimeSession(USER, cb);
    emit('.info/connected', true);
    const signal = { kind: 'ice', from_user_id: 'uid-friend', candidate: { candidate: 'x' } };

    db.children.get('signals/uid-me')?.(snap('signals/uid-me/s1', signal));
    expect(cb.onRtcSignal).not.toHaveBeenCalled();
    expect(writesTo('signals/uid-me/s1', 'remove')).toHaveLength(0);

    await backend.joinVoice(USER, 'ch-1', VOICE_STATE);
    db.children.get('signals/uid-me')?.(snap('signals/uid-me/s2', signal));
    expect(cb.onRtcSignal).toHaveBeenCalledWith(signal);
  });

  it('tags outgoing signals with this session so receivers can ignore other tabs', async () => {
    const backend = await loadBackend();
    await backend.sendRtcSignal('uid-friend', {
      kind: 'ice',
      from_user_id: USER.id,
      candidate: { candidate: 'x' },
    });
    expect(writesTo('signals/uid-friend/pushed', 'set').at(-1)?.value).toMatchObject({
      session_id: backend.sessionId(),
    });
  });

  it('re-writes shared presence that another session removed, at most every 5s', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(new Date('2026-11-26T20:00:00Z'));
    const backend = await loadBackend();
    backend.startRealtimeSession(USER, callbacks());
    emit('.info/connected', true);
    const presenceWrites = () => writesTo('presence/uid-me', 'set').length;
    const afterConnect = presenceWrites();

    vi.setSystemTime(new Date('2026-11-26T20:00:10Z'));
    emit('presence', {});
    expect(presenceWrites()).toBe(afterConnect + 1);

    // Removed again right away: deferred to the end of the interval, not dropped
    emit('presence', {});
    expect(presenceWrites()).toBe(afterConnect + 1);
    vi.advanceTimersByTime(5000);
    expect(presenceWrites()).toBe(afterConnect + 2);
  });

  it('skips a deferred heal when presence came back meanwhile', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(new Date('2026-11-26T20:00:00Z'));
    const backend = await loadBackend();
    backend.startRealtimeSession(USER, callbacks());
    emit('.info/connected', true);
    const afterConnect = writesTo('presence/uid-me', 'set').length;

    emit('presence', {}); // within 5s of the connect write: deferred
    emit('presence', { [USER.id]: USER }); // another session re-wrote it
    vi.advanceTimersByTime(5000);
    expect(writesTo('presence/uid-me', 'set')).toHaveLength(afterConnect);
  });

  it('keeps status changes made after login when re-writing presence', async () => {
    const backend = await loadBackend();
    backend.startRealtimeSession(USER, callbacks());
    emit('.info/connected', true);
    emit('presence', { [USER.id]: { ...USER, status: 'dnd', custom_status: 'Valorant' } });

    emit('.info/connected', false);
    emit('.info/connected', true);

    expect(writesTo('presence/uid-me', 'set').at(-1)?.value).toMatchObject({
      status: 'dnd',
      custom_status: 'Valorant',
    });
  });
});

describe('voice listener', () => {
  it('drops stub entries instead of crashing the member list', async () => {
    const backend = await loadBackend();
    const cb = callbacks();
    backend.startRealtimeSession(USER, cb);
    const valid = {
      user_id: 'uid-a',
      username: 'ahmet',
      display_name: 'Ahmet',
      avatar_color: '#000',
      channel_id: 'ch-1',
      muted: false,
      deafened: false,
      screen_sharing: false,
      screen_stream_id: null,
    };

    expect(() => emit('voice', { 'uid-stub': { speaking: false }, 'uid-a': valid })).not.toThrow();
    expect(cb.onVoiceMembers).toHaveBeenLastCalledWith([valid]);
  });
});
