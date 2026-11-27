/** Query parameter carrying the invite code in a shared link: https://site/?davet=CODE */
export const INVITE_PARAM = 'davet';

const MAX_CODE_LENGTH = 64;
const PENDING_INVITE_KEY = 'squadvoice_pending_invite';

/** Returns the invite code from a link's query string, or null if absent/garbage. */
export function readInviteCode(search: string): string | null {
  const raw = new URLSearchParams(search).get(INVITE_PARAM);
  const code = raw?.trim() ?? '';
  if (!code || code.length > MAX_CODE_LENGTH || /\s/.test(code)) return null;
  return code;
}

/**
 * Extracts a clean invite code from either a full invite URL (https://.../?davet=CODE)
 * or a raw code string (SQUAD-XXXX).
 */
export function extractInviteCode(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (trimmed.includes('://') || trimmed.includes(`${INVITE_PARAM}=`)) {
    try {
      const normalized = trimmed.includes('://') ? trimmed : `https://example.local/?${trimmed.replace(/^\?/, '')}`;
      const url = new URL(normalized);
      return readInviteCode(url.search);
    } catch {
      return null;
    }
  }
  if (trimmed.length > MAX_CODE_LENGTH || /\s/.test(trimmed)) return null;
  return trimmed;
}

/** Generates a CSPRNG invite code (8 unambiguous alphanumeric chars). */
export function generateInviteCode(prefix = 'SQUAD'): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let code = `${prefix}-`;
  for (const b of bytes) {
    code += chars[b % chars.length];
  }
  return code;
}

/** Saves an invite code from a clicked link across login / sign-up. */
export function savePendingInvite(code: string | null): void {
  try {
    if (code) {
      sessionStorage.setItem(PENDING_INVITE_KEY, code);
    } else {
      sessionStorage.removeItem(PENDING_INVITE_KEY);
    }
  } catch {
    // Ignore storage restriction
  }
}

export function peekPendingInvite(): string | null {
  try {
    return sessionStorage.getItem(PENDING_INVITE_KEY);
  } catch {
    return null;
  }
}

export function consumePendingInvite(): string | null {
  const code = peekPendingInvite();
  savePendingInvite(null);
  return code;
}

/** The same URL without the invite parameter (so it doesn't linger in history/bookmarks). */
export function stripInviteParam(href: string): string {
  const url = new URL(href);
  url.searchParams.delete(INVITE_PARAM);
  return url.pathname + (url.search === '?' ? '' : url.search) + url.hash;
}

/**
 * Where friends should open the app. In the browser that's this page's origin; the
 * desktop (Tauri) build isn't served over http(s), so fall back to Firebase Hosting.
 */
export function publicAppOrigin(
  location: Pick<Location, 'protocol' | 'origin'>,
  firebaseAuthDomain: string | undefined,
): string | null {
  if (location.protocol === 'http:' || location.protocol === 'https:') {
    return location.origin;
  }
  const domain = firebaseAuthDomain?.trim();
  return domain ? `https://${domain}` : null;
}

export function buildInviteLink(origin: string, code: string): string {
  return `${origin.replace(/\/+$/, '')}/?${INVITE_PARAM}=${encodeURIComponent(code.trim())}`;
}

/** Invite link for this deployment, or null when there's no public address to share. */
export function currentInviteLink(code: string | null | undefined): string | null {
  if (!code?.trim() || typeof window === 'undefined') return null;
  const origin = publicAppOrigin(
    window.location,
    import.meta.env.VITE_FIREBASE_AUTH_DOMAIN as string | undefined,
  );
  return origin ? buildInviteLink(origin, code) : null;
}
