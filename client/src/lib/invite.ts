/** Query parameter carrying the invite code in a shared link: https://site/?davet=CODE */
export const INVITE_PARAM = 'davet';

const MAX_CODE_LENGTH = 64;

/** Returns the invite code from a link's query string, or null if absent/garbage. */
export function readInviteCode(search: string): string | null {
  const raw = new URLSearchParams(search).get(INVITE_PARAM);
  const code = raw?.trim() ?? '';
  if (!code || code.length > MAX_CODE_LENGTH || /\s/.test(code)) return null;
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
