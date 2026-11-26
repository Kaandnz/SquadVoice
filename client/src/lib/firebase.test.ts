import { describe, expect, it, vi } from 'vitest';
import {
  buildIceServers,
  dmPairId,
  getStaticIceServers,
  normalizeIceServersField,
  resolveIceServers,
  usernameToEmail,
} from './firebase';

describe('dmPairId', () => {
  it('produces identical pair IDs regardless of user order', () => {
    expect(dmPairId('uid-b', 'uid-a')).toBe('uid-a__uid-b');
    expect(dmPairId('uid-a', 'uid-b')).toBe('uid-a__uid-b');
  });
});

describe('usernameToEmail', () => {
  it('converts plain usernames to synthetic domain email', () => {
    expect(usernameToEmail('Kagan_01')).toBe('kagan_01@squadvoice.app');
  });

  it('passes through existing email addresses', () => {
    expect(usernameToEmail('user@example.com')).toBe('user@example.com');
  });

  it('rejects invalid or too short usernames', () => {
    expect(() => usernameToEmail('a')).toThrow();
    expect(() => usernameToEmail('bad user!')).toThrow();
  });
});

describe('getStaticIceServers & buildIceServers', () => {
  it('always includes Google and Cloudflare STUN servers', () => {
    const cfg = getStaticIceServers();
    expect(cfg.iceServers.length).toBeGreaterThanOrEqual(1);
    const urls = cfg.iceServers[0].urls;
    expect(urls).toContain('stun:stun.l.google.com:19302');
    expect(urls).toContain('stun:stun.cloudflare.com:3478');
  });

  it('parses comma-separated TURN URLs from admin config', () => {
    const cfg = buildIceServers({
      url: 'turn:global.relay.metered.ca:80, turns:global.relay.metered.ca:443',
      username: 'alice',
      credential: 'secret',
    });
    expect(cfg.turnEnabled).toBe(true);
    expect(cfg.iceServers).toHaveLength(2);
    expect(cfg.iceServers[1].urls).toEqual([
      'turn:global.relay.metered.ca:80',
      'turns:global.relay.metered.ca:443',
    ]);
    expect(cfg.iceServers[1].username).toBe('alice');
  });
});

describe('normalizeIceServersField & resolveIceServers', () => {
  it('normalizes both single object and array responses', () => {
    expect(normalizeIceServersField({ urls: 'turn:a:3478' })).toHaveLength(1);
    expect(normalizeIceServersField([{ urls: 'turn:a:3478' }, { urls: 'turns:b:443' }])).toHaveLength(2);
  });

  it('fetches ephemeral Cloudflare TURN servers from worker and falls back on error', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        iceServers: [{ urls: ['turn:turn.cloudflare.com:3478'], username: 'u', credential: 'p' }],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const resolved = await resolveIceServers(
      { workerUrl: 'https://squadvoice-turn.example.workers.dev/turn' },
      async () => 'fake-id-token',
    );
    expect(resolved.turnEnabled).toBe(true);
    expect(resolved.iceServers).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));
    const fallback = await resolveIceServers(
      { workerUrl: 'https://squadvoice-turn.example.workers.dev/turn' },
      async () => 'fake-id-token',
    );
    expect(fallback.turnEnabled).toBe(false);
    expect(fallback.iceServers).toHaveLength(1);
    vi.unstubAllGlobals();
  });
});
