import type { VoiceMemberState } from '../types/protocol';

/**
 * What our own voice/{uid} entry means for this tab/device while it thinks it is in voice.
 * - present:     all good, keep going
 * - kicked:      an admin disconnected us; leave with a notice
 * - restoring:   our socket dropped and the server removed it; we will re-create it
 * - gone:        removed for another reason; leave with a notice
 * - taken-over:  another device of the same account joined and now holds the entry;
 *                leave quietly without touching the entry
 */
export type OwnVoiceEntryStatus = 'present' | 'kicked' | 'restoring' | 'gone' | 'taken-over';

export function classifyOwnVoiceEntry(input: {
  myEntry: VoiceMemberState | undefined;
  mySessionId: string;
  restorePending: boolean;
}): OwnVoiceEntryStatus {
  const { myEntry, mySessionId, restorePending } = input;
  if (!myEntry) return restorePending ? 'restoring' : 'gone';
  if (myEntry.kicked_by_admin) return 'kicked';
  // Entries written by older app versions have no session_id; treat them as ours.
  if (myEntry.session_id && myEntry.session_id !== mySessionId) return 'taken-over';
  return 'present';
}

/**
 * A WebRTC signal should only be acted on if it comes from the tab/device that holds the
 * sender's voice entry. Another open tab of that person (typically an old version that
 * wasn't refreshed) would otherwise answer too, and two different connections answering
 * for one person made calls flip between "El sıkışıyor…" and "Bağlanıyor…".
 * Unknown on either side (older app versions, entry not seen yet) → accept.
 */
export function isSignalFromVoiceSession(
  senderVoiceEntry: Pick<VoiceMemberState, 'session_id'> | undefined,
  signalSessionId: string | undefined,
): boolean {
  const owner = senderVoiceEntry?.session_id;
  if (!owner) return true;
  return signalSessionId === owner;
}

/**
 * The account is in a voice room on some other device/tab while this one is not,
 * so we can offer to move the call here.
 */
export function findCallOnOtherDevice(input: {
  voiceMembers: VoiceMemberState[];
  userId: string;
  mySessionId: string;
  inVoiceLocally: boolean;
}): VoiceMemberState | null {
  if (input.inVoiceLocally) return null;
  const mine = input.voiceMembers.find((m) => m.user_id === input.userId);
  if (!mine || mine.session_id === input.mySessionId) return null;
  return mine;
}
