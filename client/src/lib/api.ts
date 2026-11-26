import type { Channel, Message, PublicUser, RtcConfigResponse } from '../types/protocol';
import { normalizeServerUrl } from './platform';

export interface AuthResponse {
  token: string;
  user: PublicUser;
}

async function request<T>(
  serverUrl: string,
  path: string,
  options: RequestInit = {},
  token?: string | null,
): Promise<T> {
  const base = normalizeServerUrl(serverUrl);
  const headers = new Headers(options.headers || {});
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  if (!(options.body instanceof FormData) && options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const resp = await fetch(`${base}${path}`, {
    ...options,
    headers,
  });

  const text = await resp.text();
  let data: Record<string, unknown> = {};
  if (text) {
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      data = {};
    }
  }

  if (!resp.ok) {
    const errMsg = typeof data.error === 'string' ? data.error : `HTTP ${resp.status}`;
    throw new Error(errMsg);
  }

  return data as unknown as T;
}

export const api = {
  register(
    serverUrl: string,
    payload: { username: string; display_name?: string; password: string; invite_code: string },
  ) {
    return request<AuthResponse>(serverUrl, '/api/auth/register', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  login(serverUrl: string, payload: { username: string; password: string }) {
    return request<AuthResponse>(serverUrl, '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  me(serverUrl: string, token: string) {
    return request<{ user: PublicUser }>(serverUrl, '/api/auth/me', {}, token);
  },

  listUsers(serverUrl: string, token: string) {
    return request<PublicUser[]>(serverUrl, '/api/users', {}, token);
  },

  listChannels(serverUrl: string, token: string) {
    return request<Channel[]>(serverUrl, '/api/channels', {}, token);
  },

  createChannel(serverUrl: string, token: string, name: string, kind: 'text' | 'voice') {
    return request<Channel>(
      serverUrl,
      '/api/channels',
      {
        method: 'POST',
        body: JSON.stringify({ name, kind }),
      },
      token,
    );
  },

  deleteChannel(serverUrl: string, token: string, channelId: string) {
    return request<{ ok: boolean }>(
      serverUrl,
      `/api/channels/${encodeURIComponent(channelId)}`,
      { method: 'DELETE' },
      token,
    );
  },

  listMessages(serverUrl: string, token: string, channelId: string, limit = 50) {
    return request<Message[]>(
      serverUrl,
      `/api/channels/${encodeURIComponent(channelId)}/messages?limit=${limit}`,
      {},
      token,
    );
  },

  uploadImage(serverUrl: string, token: string, file: File) {
    const form = new FormData();
    form.append('file', file, file.name);
    return request<{ url: string; name: string }>(
      serverUrl,
      '/api/uploads',
      {
        method: 'POST',
        body: form,
      },
      token,
    );
  },

  rtcConfig(serverUrl: string, token: string) {
    return request<RtcConfigResponse>(serverUrl, '/api/rtc-config', {}, token);
  },
};
