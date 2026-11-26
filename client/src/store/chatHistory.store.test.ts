// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message, PublicUser } from '../types/protocol';

const mocks = vi.hoisted(() => ({
  channelSubs: [] as Array<{ id: string; limit: number; cb: (msgs: Message[]) => void }>,
  listMessages: vi.fn(),
}));

vi.mock('../lib/firebaseBackend', () => ({
  firebaseBackend: {
    subscribeChannelMessages: (id: string, cb: (msgs: Message[]) => void, limit = 80) => {
      mocks.channelSubs.push({ id, limit, cb });
      return () => {};
    },
    subscribeDmMessages: () => () => {},
    subscribeTyping: () => () => {},
    setTyping: vi.fn(),
  },
}));

vi.mock('../lib/api', () => ({
  api: { listMessages: mocks.listMessages },
}));

const { useAppStore } = await import('./useAppStore');

const USER = { id: 'me', username: 'kagan', display_name: 'Kağan' } as PublicUser;

function messages(count: number, startMinute = 0): Message[] {
  return Array.from({ length: count }, (_, i) => {
    const t = new Date(Date.UTC(2026, 10, 26, 10, startMinute + i)).toISOString();
    return { id: `m${startMinute + i}`, content: 'x', created_at: t } as Message;
  });
}

beforeEach(() => {
  mocks.channelSubs.length = 0;
  mocks.listMessages.mockReset();
  useAppStore.setState({
    user: USER,
    channels: [{ id: 'c1', name: 'genel', kind: 'text', position: 0, created_at: '' }],
    messagesByChannel: {},
    chatHistoryMore: {},
    loadingOlderMessages: false,
    activeDmUserId: null,
  });
});

describe('loading older messages', () => {
  it('widens the live Firebase window and stops when a short page comes back', async () => {
    useAppStore.setState({ firebaseMode: true });
    await useAppStore.getState().selectTextChannel('c1');
    expect(mocks.channelSubs.at(-1)?.limit).toBe(80);

    mocks.channelSubs.at(-1)?.cb(messages(80, 100));
    expect(useAppStore.getState().chatHistoryMore.c1).toBe(true);

    await useAppStore.getState().loadOlderMessages();
    expect(mocks.channelSubs.at(-1)?.limit).toBe(160);
    expect(useAppStore.getState().loadingOlderMessages).toBe(true);

    mocks.channelSubs.at(-1)?.cb(messages(120, 60));
    const s = useAppStore.getState();
    expect(s.messagesByChannel.c1).toHaveLength(120);
    expect(s.chatHistoryMore.c1).toBe(false);
    expect(s.loadingOlderMessages).toBe(false);
  });

  it('pages the self-hosted server with a before cursor and merges in order', async () => {
    const current = messages(50, 100);
    useAppStore.setState({
      firebaseMode: false,
      token: 'tok',
      serverUrl: 'http://srv',
      activeTextChannelId: 'c1',
      messagesByChannel: { c1: current },
      chatHistoryMore: { c1: true },
    });
    mocks.listMessages.mockResolvedValue(messages(20, 70));

    await useAppStore.getState().loadOlderMessages();

    expect(mocks.listMessages).toHaveBeenCalledWith('http://srv', 'tok', 'c1', 50, current[0].created_at);
    const s = useAppStore.getState();
    expect(s.messagesByChannel.c1).toHaveLength(70);
    expect(s.messagesByChannel.c1[0].id).toBe('m70');
    expect(s.chatHistoryMore.c1).toBe(false);
  });

  it('does nothing when no more history is known', async () => {
    useAppStore.setState({
      firebaseMode: false,
      token: 'tok',
      activeTextChannelId: 'c1',
      messagesByChannel: { c1: messages(10) },
      chatHistoryMore: { c1: false },
    });
    await useAppStore.getState().loadOlderMessages();
    expect(mocks.listMessages).not.toHaveBeenCalled();
  });
});
