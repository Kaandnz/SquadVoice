import { describe, expect, it } from 'vitest';
import type { Message } from '../types/protocol';
import {
  chatScopeKey,
  FIREBASE_MAX_WINDOW,
  mayHaveMore,
  mergeOlderMessages,
  nextWindowSize,
} from './chatHistory';

function msg(id: string, minute: number): Message {
  return {
    id,
    channel_id: 'c',
    user_id: 'u',
    username: 'u',
    display_name: 'U',
    avatar_color: '#000',
    content: id,
    created_at: `2026-11-26T10:${String(minute).padStart(2, '0')}:00.000Z`,
  } as Message;
}

describe('chat history paging', () => {
  it('prepends an older page in order without duplicates', () => {
    const existing = [msg('c', 30), msg('d', 40)];
    const older = [msg('a', 10), msg('b', 20), msg('c', 30)];
    expect(mergeOlderMessages(existing, older).map((m) => m.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('grows the live window by a page up to the cap', () => {
    expect(nextWindowSize(80)).toBe(160);
    expect(nextWindowSize(FIREBASE_MAX_WINDOW - 10)).toBe(FIREBASE_MAX_WINDOW);
    expect(nextWindowSize(FIREBASE_MAX_WINDOW)).toBeNull();
  });

  it('only expects more history after a full page', () => {
    expect(mayHaveMore(80, 80)).toBe(true);
    expect(mayHaveMore(42, 80)).toBe(false);
  });

  it('keys channels and DMs separately', () => {
    expect(chatScopeKey({ kind: 'channel', id: 'genel' })).toBe('genel');
    expect(chatScopeKey({ kind: 'dm', peerId: 'genel' })).toBe('dm:genel');
  });
});
