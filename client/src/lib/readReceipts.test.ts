import { describe, expect, it } from 'vitest';
import type { ReadReceipt } from '../types/protocol';
import { getReadersForMessage, mapLatestReadMessageByReader } from './readReceipts';

const RECEIPTS: ReadReceipt[] = [
  {
    user_id: 'me',
    display_name: 'Ben',
    avatar_color: '#5865F2',
    last_read_at: '2026-11-27T10:05:00.000Z',
    last_read_msg_id: 'm3',
    updated_at: 1000,
  },
  {
    user_id: 'ali',
    display_name: 'Ali',
    avatar_color: '#3BA55D',
    last_read_at: '2026-11-27T10:02:00.000Z',
    last_read_msg_id: 'm2',
    updated_at: 1001,
  },
  {
    user_id: 'ayse',
    display_name: 'Ayşe',
    avatar_color: '#EB459E',
    last_read_at: '2026-11-27T10:05:00.000Z',
    last_read_msg_id: 'm3',
    updated_at: 1002,
  },
];

const MESSAGES = [
  { id: 'm1', user_id: 'me', created_at: '2026-11-27T10:00:00.000Z' },
  { id: 'm2', user_id: 'me', created_at: '2026-11-27T10:02:00.000Z' },
  { id: 'm3', user_id: 'me', created_at: '2026-11-27T10:05:00.000Z' },
];

describe('readReceipts helpers', () => {
  it('returns other readers who reached or passed a message timestamp', () => {
    expect(getReadersForMessage(MESSAGES[0], RECEIPTS, 'me').map((r) => r.user_id)).toEqual([
      'ali',
      'ayse',
    ]);
    expect(getReadersForMessage(MESSAGES[1], RECEIPTS, 'me').map((r) => r.user_id)).toEqual([
      'ali',
      'ayse',
    ]);
    expect(getReadersForMessage(MESSAGES[2], RECEIPTS, 'me').map((r) => r.user_id)).toEqual([
      'ayse',
    ]);
  });

  it('maps each reader to only the latest message they saw', () => {
    const map = mapLatestReadMessageByReader(MESSAGES, RECEIPTS, 'me');
    expect(map.get('m1')).toBeUndefined();
    expect(map.get('m2')?.map((r) => r.user_id)).toEqual(['ali']);
    expect(map.get('m3')?.map((r) => r.user_id)).toEqual(['ayse']);
  });
});
