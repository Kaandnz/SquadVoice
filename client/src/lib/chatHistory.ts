import type { Message } from '../types/protocol';

export type ChatScope = { kind: 'channel'; id: string } | { kind: 'dm'; peerId: string };

/** Messages fetched per "load older" step in Firebase mode (live window grows by this). */
export const FIREBASE_PAGE_SIZE = 80;
/** Upper bound for the live Firebase window, to keep one listener's payload sane. */
export const FIREBASE_MAX_WINDOW = 2000;
/** Page size for the self-hosted server (it caps at 100). */
export const SERVER_PAGE_SIZE = 50;

/** Key used to remember per-conversation "more history exists" flags. */
export function chatScopeKey(scope: ChatScope): string {
  return scope.kind === 'channel' ? scope.id : `dm:${scope.peerId}`;
}

/** Next live window size, or null when we're already at the cap. */
export function nextWindowSize(current: number): number | null {
  if (current >= FIREBASE_MAX_WINDOW) return null;
  return Math.min(current + FIREBASE_PAGE_SIZE, FIREBASE_MAX_WINDOW);
}

/** A full page came back, so older messages may still exist. */
export function mayHaveMore(received: number, requested: number): boolean {
  return received >= requested;
}

/** Prepends an older page, dropping duplicates and keeping chronological order. */
export function mergeOlderMessages(existing: Message[], older: Message[]): Message[] {
  const seen = new Set(existing.map((m) => m.id));
  return [...older.filter((m) => !seen.has(m.id)), ...existing].sort((a, b) =>
    a.created_at.localeCompare(b.created_at),
  );
}
