import { initializeApp, getApps, type FirebaseApp } from 'firebase/app';
import { getAuth, type Auth } from 'firebase/auth';
import { getDatabase, type Database } from 'firebase/database';
import type { TurnConfig } from '../types/protocol';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY?.trim() || '',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN?.trim() || '',
  databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL?.trim() || '',
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID?.trim() || '',
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET?.trim() || '',
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID?.trim() || '',
  appId: import.meta.env.VITE_FIREBASE_APP_ID?.trim() || '',
};

export function isFirebaseEnabled(): boolean {
  return Boolean(
    firebaseConfig.apiKey &&
      firebaseConfig.authDomain &&
      firebaseConfig.databaseURL &&
      firebaseConfig.projectId &&
      firebaseConfig.appId,
  );
}

export function dmPairId(uidA: string, uidB: string): string {
  return [uidA, uidB].sort().join('__');
}

export function validateEmail(email: string): string {
  const clean = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) {
    throw new Error('Geçerli bir e-posta adresi girin.');
  }
  return clean;
}

export function usernameToEmail(usernameOrEmail: string): string {
  const trimmed = usernameOrEmail.trim().toLowerCase();
  if (trimmed.includes('@')) {
    return validateEmail(trimmed);
  }
  if (trimmed.length < 2 || trimmed.length > 24 || !/^[a-z0-9_.-]+$/.test(trimmed)) {
    throw new Error('Kullanıcı adı 2-24 karakter olmalı ve sadece harf, rakam, _ . - içermelidir.');
  }
  return `${trimmed}@squadvoice.app`;
}

export function normalizeIceServersField(raw: unknown): RTCIceServer[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw as RTCIceServer[];
  if (typeof raw === 'object') return [raw as RTCIceServer];
  return [];
}

export function buildIceServers(turnConfig?: TurnConfig | null): {
  iceServers: RTCIceServer[];
  turnEnabled: boolean;
} {
  const iceServers: RTCIceServer[] = [
    {
      urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'],
    },
  ];

  let turnEnabled = false;

  const appendTurn = (urlStr: string, username?: string, credential?: string) => {
    const urls = urlStr
      .split(',')
      .map((u) => u.trim())
      .filter(Boolean);
    if (urls.length === 0) return;
    iceServers.push({
      urls,
      username: username?.trim() || undefined,
      credential: credential?.trim() || undefined,
    });
    turnEnabled = true;
  };

  if (turnConfig?.url) {
    appendTurn(turnConfig.url, turnConfig.username, turnConfig.credential);
  } else {
    const envTurnUrl = import.meta.env.VITE_TURN_URL?.trim();
    if (envTurnUrl) {
      appendTurn(
        envTurnUrl,
        import.meta.env.VITE_TURN_USERNAME,
        import.meta.env.VITE_TURN_CREDENTIAL,
      );
    }
  }

  return { iceServers, turnEnabled };
}

export async function resolveIceServers(
  turnConfig?: TurnConfig | null,
  getIdToken?: () => Promise<string | null>,
): Promise<{ iceServers: RTCIceServer[]; turnEnabled: boolean }> {
  const base = buildIceServers(turnConfig);
  const workerUrl =
    turnConfig?.workerUrl?.trim() || import.meta.env.VITE_TURN_WORKER_URL?.trim() || '';

  if (!workerUrl || !getIdToken) {
    return base;
  }

  try {
    const token = await getIdToken();
    if (!token) return base;

    const resp = await fetch(workerUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });
    if (!resp.ok) return base;

    const data = (await resp.json()) as { iceServers?: unknown };
    const extra = normalizeIceServersField(data?.iceServers);
    if (extra.length === 0) return base;

    return {
      iceServers: [...base.iceServers, ...extra],
      turnEnabled: true,
    };
  } catch {
    return base;
  }
}

export function getStaticIceServers(): { iceServers: RTCIceServer[]; turnEnabled: boolean } {
  return buildIceServers(null);
}

export function getFirebaseServices(): {
  app: FirebaseApp;
  auth: Auth;
  rtdb: Database;
} {
  if (!isFirebaseEnabled()) {
    throw new Error('Firebase ortam değişkenleri ayarlanmamış.');
  }
  const app = getApps().length > 0 ? getApps()[0] : initializeApp(firebaseConfig);
  return {
    app,
    auth: getAuth(app),
    rtdb: getDatabase(app),
  };
}
