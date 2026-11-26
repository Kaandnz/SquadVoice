import { describe, expect, it } from 'vitest';
import type { VoiceMemberState } from '../types/protocol';
import { classifyOwnVoiceEntry, findCallOnOtherDevice } from './voiceSession';

function entry(patch: Partial<VoiceMemberState> = {}): VoiceMemberState {
  const base: VoiceMemberState = {
    user_id: 'me',
    username: 'kagan',
    display_name: 'Kağan',
    avatar_color: '#000',
    channel_id: 'ch-1',
    muted: false,
    deafened: false,
    screen_sharing: false,
    screen_stream_id: null,
    speaking: false,
    session_id: 'tab-a',
  };
  return { ...base, ...patch } as VoiceMemberState;
}

describe('classifyOwnVoiceEntry', () => {
  it('keeps the call while our own session holds the entry', () => {
    expect(
      classifyOwnVoiceEntry({ myEntry: entry(), mySessionId: 'tab-a', restorePending: false }),
    ).toBe('present');
  });

  it('accepts entries from app versions without a session id', () => {
    expect(
      classifyOwnVoiceEntry({
        myEntry: entry({ session_id: undefined }),
        mySessionId: 'tab-a',
        restorePending: false,
      }),
    ).toBe('present');
  });

  it('waits for the restore instead of leaving when we were offline', () => {
    expect(
      classifyOwnVoiceEntry({ myEntry: undefined, mySessionId: 'tab-a', restorePending: true }),
    ).toBe('restoring');
    expect(
      classifyOwnVoiceEntry({ myEntry: undefined, mySessionId: 'tab-a', restorePending: false }),
    ).toBe('gone');
  });

  it('detects an admin kick before anything else', () => {
    expect(
      classifyOwnVoiceEntry({
        myEntry: entry({ kicked_by_admin: true, session_id: 'tab-b' }),
        mySessionId: 'tab-a',
        restorePending: false,
      }),
    ).toBe('kicked');
  });

  it('detects that another device took the call over', () => {
    expect(
      classifyOwnVoiceEntry({
        myEntry: entry({ session_id: 'phone' }),
        mySessionId: 'tab-a',
        restorePending: false,
      }),
    ).toBe('taken-over');
  });
});

describe('findCallOnOtherDevice', () => {
  const others = [entry({ user_id: 'friend', session_id: 'x' })];

  it('finds our call on another device when this one is idle', () => {
    const mine = entry({ session_id: 'phone' });
    expect(
      findCallOnOtherDevice({
        voiceMembers: [...others, mine],
        userId: 'me',
        mySessionId: 'tab-a',
        inVoiceLocally: false,
      }),
    ).toBe(mine);
  });

  it('offers nothing while this device is in voice or nobody else is', () => {
    expect(
      findCallOnOtherDevice({
        voiceMembers: [...others, entry({ session_id: 'phone' })],
        userId: 'me',
        mySessionId: 'tab-a',
        inVoiceLocally: true,
      }),
    ).toBeNull();
    expect(
      findCallOnOtherDevice({
        voiceMembers: others,
        userId: 'me',
        mySessionId: 'tab-a',
        inVoiceLocally: false,
      }),
    ).toBeNull();
  });
});
