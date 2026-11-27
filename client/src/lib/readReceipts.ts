import type { Message, ReadReceipt } from '../types/protocol';

/**
 * Returns all other users who have read at or past `message.created_at`.
 */
export function getReadersForMessage(
  message: Pick<Message, 'user_id' | 'created_at'>,
  receipts: ReadReceipt[],
  myUserId: string | undefined,
): ReadReceipt[] {
  if (!message.created_at || receipts.length === 0) return [];
  return receipts.filter(
    (r) =>
      r.user_id !== myUserId &&
      r.user_id !== message.user_id &&
      r.last_read_at >= message.created_at,
  );
}

/**
 * Maps each reader to the latest message ID they have read (WhatsApp/Messenger-style
 * "seen up to here" markers), excluding the current user.
 */
export function mapLatestReadMessageByReader(
  messages: Array<Pick<Message, 'id' | 'user_id' | 'created_at'>>,
  receipts: ReadReceipt[],
  myUserId: string | undefined,
): Map<string, ReadReceipt[]> {
  const byMessageId = new Map<string, ReadReceipt[]>();
  if (!messages.length || !receipts.length) return byMessageId;

  for (const receipt of receipts) {
    if (receipt.user_id === myUserId) continue;
    let latestMsgId: string | null = null;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (receipt.last_read_at >= m.created_at) {
        latestMsgId = m.id;
        break;
      }
    }
    if (latestMsgId) {
      const arr = byMessageId.get(latestMsgId) ?? [];
      arr.push(receipt);
      byMessageId.set(latestMsgId, arr);
    }
  }

  return byMessageId;
}
