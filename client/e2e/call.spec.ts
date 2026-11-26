import { expect, test, type BrowserContext, type Page } from '@playwright/test';

/** Mirrors the `window.sv` API exposed by harness.ts. */
interface HarnessApi {
  start(peers: string[]): Promise<void>;
  pcId(peerId: string): number | null;
  iceState(peerId: string): string | null;
  inboundAudio(peerId: string): Promise<{ bytes: number; energy: number }>;
  remoteAudioPlaying(): boolean;
  micPriority(peerId: string): string | null;
  stats(): Record<
    string,
    { rttMs: number | null; packetLossPct: number | null; jitterMs: number | null; usingRelay: boolean }
  >;
  dropNext(kind: 'offer' | 'answer', count?: number): void;
  reconnect(): void;
  rotateIceServers(): void;
  swapMic(): Promise<void>;
  startMicTest(): Promise<void>;
  stopMicTest(): void;
  micTestRunning(): boolean;
  peakMicLevel(): number;
  setSensitivity(mode: 'auto' | 'manual' | 'off', gateThresholdDb?: number): void;
  micTrackEnabled(): boolean | null;
  leave(): void;
}

declare global {
  interface Window {
    sv: HarnessApi;
  }
}

const CONNECTED = /^(connected|completed)$/;

async function openPeer(context: BrowserContext, me: string, room: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`/e2e/harness.html?me=${me}&room=${encodeURIComponent(room)}`);
  await expect(page).toHaveTitle(`harness:${me}:ready`);
  return page;
}

async function start(page: Page, peers: string[]) {
  await page.evaluate((p) => window.sv.start(p), peers);
}

async function expectConnected(page: Page, peerId: string, timeout = 20_000) {
  await expect
    .poll(() => page.evaluate((id) => window.sv.iceState(id), peerId), { timeout })
    .toMatch(CONNECTED);
}

/** Audio is really arriving: bytes and decoded audio energy both keep growing. */
async function expectAudioFlowing(page: Page, peerId: string) {
  const before = await page.evaluate((id) => window.sv.inboundAudio(id), peerId);
  await expect
    .poll(
      async () => {
        const now = await page.evaluate((id) => window.sv.inboundAudio(id), peerId);
        return now.bytes - before.bytes > 4_000 && now.energy > before.energy;
      },
      { timeout: 20_000, message: `audio from ${peerId} should keep arriving` },
    )
    .toBe(true);
}

async function setupCall(context: BrowserContext, room: string) {
  const alice = await openPeer(context, 'alice', room);
  const bob = await openPeer(context, 'bob', room);
  return { alice, bob };
}

test.describe('microphone test', () => {
  test('plays the mic back with a live level meter outside a call', async ({ context }, info) => {
    const alice = await openPeer(context, 'alice', info.testId);
    await alice.evaluate(() => window.sv.startMicTest());

    expect(await alice.evaluate(() => window.sv.micTestRunning())).toBe(true);
    await expect.poll(() => alice.evaluate(() => window.sv.peakMicLevel())).toBeGreaterThan(0);

    await alice.evaluate(() => window.sv.stopMicTest());
    expect(await alice.evaluate(() => window.sv.micTestRunning())).toBe(false);
  });
});

test.describe('voice call between two peers', () => {
  test('connects and carries audio both ways', async ({ context }, info) => {
    const { alice, bob } = await setupCall(context, info.testId);
    await Promise.all([start(alice, ['bob']), start(bob, ['alice'])]);

    await expectConnected(alice, 'bob');
    await expectConnected(bob, 'alice');
    await expectAudioFlowing(alice, 'bob');
    await expectAudioFlowing(bob, 'alice');

    await expect.poll(() => alice.evaluate(() => window.sv.remoteAudioPlaying())).toBe(true);
    await expect.poll(() => bob.evaluate(() => window.sv.remoteAudioPlaying())).toBe(true);
    // Voice must outrank screen-share video when the uplink is saturated
    await expect.poll(() => alice.evaluate(() => window.sv.micPriority('bob'))).toBe('high');

    // Stats feeding the connection-quality panel: real numbers, direct path on a LAN
    await expect
      .poll(() => bob.evaluate(() => window.sv.stats().alice ?? null))
      .toMatchObject({
        jitterMs: expect.any(Number),
        packetLossPct: expect.any(Number),
        rttMs: expect.any(Number),
        usingRelay: false,
      });
  });

  test('recovers when only one side rebuilds its connection', async ({ context }, info) => {
    const { alice, bob } = await setupCall(context, info.testId);
    await Promise.all([start(alice, ['bob']), start(bob, ['alice'])]);
    await expectConnected(alice, 'bob');
    await expectConnected(bob, 'alice');

    const bobPcBefore = await bob.evaluate(() => window.sv.pcId('alice'));
    // Same as pressing the refresh button on one side only
    await alice.evaluate(() => window.sv.reconnect());

    // Bob must notice Alice's new connection and rebuild his side to match it
    await expect
      .poll(() => bob.evaluate(() => window.sv.pcId('alice')))
      .not.toBe(bobPcBefore);
    await expectConnected(alice, 'bob');
    await expectConnected(bob, 'alice');
    await expectAudioFlowing(alice, 'bob');
    await expectAudioFlowing(bob, 'alice');
  });

  test('recovers when both sides rebuild at the same time', async ({ context }, info) => {
    const { alice, bob } = await setupCall(context, info.testId);
    await Promise.all([start(alice, ['bob']), start(bob, ['alice'])]);
    await expectConnected(alice, 'bob');
    await expectConnected(bob, 'alice');

    await Promise.all([
      alice.evaluate(() => window.sv.reconnect()),
      bob.evaluate(() => window.sv.reconnect()),
    ]);

    await expectConnected(alice, 'bob');
    await expectConnected(bob, 'alice');
    await expectAudioFlowing(alice, 'bob');
    await expectAudioFlowing(bob, 'alice');
  });

  test('keeps the call when ICE servers rotate', async ({ context }, info) => {
    const { alice, bob } = await setupCall(context, info.testId);
    await Promise.all([start(alice, ['bob']), start(bob, ['alice'])]);
    await expectConnected(alice, 'bob');
    await expectConnected(bob, 'alice');

    const pcBefore = await alice.evaluate(() => window.sv.pcId('bob'));
    await alice.evaluate(() => window.sv.rotateIceServers());

    await expectAudioFlowing(bob, 'alice');
    expect(await alice.evaluate(() => window.sv.pcId('bob'))).toBe(pcBefore);
    expect(await alice.evaluate(() => window.sv.iceState('bob'))).toMatch(CONNECTED);
  });

  test('keeps audio flowing when the mic is swapped mid-call', async ({ context }, info) => {
    const { alice, bob } = await setupCall(context, info.testId);
    await Promise.all([start(alice, ['bob']), start(bob, ['alice'])]);
    await expectConnected(alice, 'bob');
    await expectConnected(bob, 'alice');

    const bobPcBefore = await bob.evaluate(() => window.sv.pcId('alice'));
    await alice.evaluate(() => window.sv.swapMic());

    await expectAudioFlowing(bob, 'alice');
    // The new mic is swapped in place; the call is not rebuilt
    expect(await bob.evaluate(() => window.sv.pcId('alice'))).toBe(bobPcBefore);
  });

  test('input sensitivity really gates what is sent, and "Kapalı" sends everything', async ({
    context,
  }, info) => {
    const { alice, bob } = await setupCall(context, info.testId);
    await Promise.all([start(alice, ['bob']), start(bob, ['alice'])]);
    await expectConnected(bob, 'alice');
    await expectAudioFlowing(bob, 'alice'); // auto mode lets the voice through

    // Threshold above anything the mic produces: nothing audible may go out
    await alice.evaluate(() => window.sv.setSensitivity('manual', 0));
    await expect.poll(() => alice.evaluate(() => window.sv.micTrackEnabled())).toBe(false);
    await bob.waitForTimeout(1500); // let audio already in flight drain
    const gatedStart = await bob.evaluate(() => window.sv.inboundAudio('alice'));
    await bob.waitForTimeout(3000);
    const gatedEnd = await bob.evaluate(() => window.sv.inboundAudio('alice'));
    expect(gatedEnd.bytes, 'the connection keeps flowing').toBeGreaterThan(gatedStart.bytes);
    expect(gatedEnd.energy - gatedStart.energy, 'but no sound arrives').toBeLessThan(1e-4);

    // Gate off: sound goes out again
    await alice.evaluate(() => window.sv.setSensitivity('off'));
    await expect.poll(() => alice.evaluate(() => window.sv.micTrackEnabled())).toBe(true);
    await expectAudioFlowing(bob, 'alice');
  });

  test('a stray second session of the same peer does not cause a reconnect storm', async ({
    context,
  }, info) => {
    // Alice has the app open twice (e.g. an old tab that wasn't refreshed). Bob offers
    // ('bob' > 'alice') and BOTH Alice tabs answer from different connections. Bob must
    // settle on one instead of rebuilding in a loop, which users saw as
    // "El sıkışıyor… / Bağlanıyor…" flipping and the screen flickering.
    const alice = await openPeer(context, 'alice', info.testId);
    const aliceStale = await openPeer(context, 'alice', info.testId);
    const bob = await openPeer(context, 'bob', info.testId);
    await Promise.all([start(alice, ['bob']), start(aliceStale, ['bob']), start(bob, ['alice'])]);

    const seen = new Set<number | null>();
    for (let i = 0; i < 16; i += 1) {
      seen.add(await bob.evaluate(() => window.sv.pcId('alice')));
      await bob.waitForTimeout(1000);
    }
    expect(seen.size, `Bob rebuilt his connection ${seen.size - 1} times`).toBeLessThanOrEqual(2);
    await expectConnected(bob, 'alice');
  });

  test('recovers when an answer is lost in signaling', async ({ context }, info) => {
    const { alice, bob } = await setupCall(context, info.testId);
    // 'bob' > 'alice', so Bob offers first; lose Alice's answer to it
    await alice.evaluate(() => window.sv.dropNext('answer'));
    await Promise.all([start(alice, ['bob']), start(bob, ['alice'])]);

    await expectConnected(alice, 'bob', 40_000);
    await expectConnected(bob, 'alice', 40_000);
    await expectAudioFlowing(alice, 'bob');
    await expectAudioFlowing(bob, 'alice');
  });
});
