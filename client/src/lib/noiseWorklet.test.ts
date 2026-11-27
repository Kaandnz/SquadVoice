import { describe, expect, it } from 'vitest';
import { buildDeepFilterWorkletSource } from './noiseWorklet';

describe('buildDeepFilterWorkletSource', () => {
  it('polyfills TextDecoder and crypto.getRandomValues for AudioWorkletGlobalScope', () => {
    const fakeScope: Record<string, unknown> = {};
    const wrapped = buildDeepFilterWorkletSource(`
      const dec = new globalThis.TextDecoder('utf-8');
      globalThis.__decoded = dec.decode(new Uint8Array([79, 75, 33]));
      const buf = new Uint8Array(8);
      globalThis.crypto.getRandomValues(buf);
      globalThis.__randLen = buf.length;
    `);

    const runner = new Function('globalThis', wrapped);
    runner(fakeScope);

    expect(fakeScope.__decoded).toBe('OK!');
    expect(fakeScope.__randLen).toBe(8);
  });
});
