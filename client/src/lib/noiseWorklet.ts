/// <reference types="vite/client" />
import deepFilterWasmUrl from '@lofcz/deepfilternet-web/df_bg.wasm?url';
import deepFilterWorkletUrl from '@lofcz/deepfilternet-web/worklet?url';
import gtcrnWasmUrl from '@sapphi-red/web-noise-suppressor/gtcrn.wasm?url';
import gtcrnWorkletUrl from '@sapphi-red/web-noise-suppressor/gtcrnWorklet.js?url';
import rnnoiseWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url';
import rnnoiseSimdWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url';
import rnnoiseWorkletUrl from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url';
import {
  isSampleRateCompatible,
  type AiNoiseSuppressionMode,
} from './noiseSuppression';

export interface AiNoiseWorkletNode extends AudioWorkletNode {
  destroy(): void;
}

type SuppressorModule = typeof import('@sapphi-red/web-noise-suppressor');

let suppressorModulePromise: Promise<SuppressorModule> | null = null;
const wasmBinaryCache = new Map<'rnnoise' | 'gtcrn', Promise<ArrayBuffer>>();
let deepFilterModulePromise: Promise<WebAssembly.Module> | null = null;
let deepFilterWorkletBlobUrlPromise: Promise<string> | null = null;
const loadedModulesByContext = new WeakMap<AudioContext, Set<AiNoiseSuppressionMode>>();

/**
 * AudioWorkletGlobalScope omits TextDecoder and crypto.getRandomValues in browsers,
 * which causes @lofcz/deepfilternet-web's wasm-bindgen glue to throw before
 * registerProcessor("deepfilternet-processor", ...) executes. Prepending minimal
 * shims inside a Blob module makes DeepFilterNet 3 initialize cleanly everywhere.
 */
const WORKLET_GLOBAL_POLYFILL = `
if (typeof globalThis.TextDecoder === 'undefined') {
  globalThis.TextDecoder = class TextDecoder {
    decode(bytes) {
      if (!bytes || !bytes.length) return '';
      const arr = bytes instanceof Uint8Array
        ? bytes
        : new Uint8Array(bytes.buffer || bytes, bytes.byteOffset || 0, bytes.byteLength || bytes.length);
      let out = '';
      for (let i = 0; i < arr.length; i++) {
        const b = arr[i];
        if (b < 0x80) {
          out += String.fromCharCode(b);
        } else if (b < 0xe0) {
          out += String.fromCharCode(((b & 0x1f) << 6) | (arr[++i] & 0x3f));
        } else if (b < 0xf0) {
          out += String.fromCharCode(((b & 0x0f) << 12) | ((arr[++i] & 0x3f) << 6) | (arr[++i] & 0x3f));
        } else {
          const cp = (((b & 0x07) << 18) | ((arr[++i] & 0x3f) << 12) | ((arr[++i] & 0x3f) << 6) | (arr[++i] & 0x3f)) - 0x10000;
          out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
        }
      }
      return out;
    }
  };
}
if (typeof globalThis.crypto === 'undefined') {
  globalThis.crypto = {
    getRandomValues(arr) {
      for (let i = 0; i < arr.length; i++) arr[i] = (Math.random() * 256) | 0;
      return arr;
    },
  };
}
`;

export function buildDeepFilterWorkletSource(rawWorkletSource: string): string {
  return `${WORKLET_GLOBAL_POLYFILL}\n${rawWorkletSource}`;
}

/** Lightweight feature check for WebAssembly SIMD (required by DeepFilterNet 3). */
function supportsWasmSimd(): boolean {
  if (typeof WebAssembly === 'undefined' || typeof WebAssembly.validate !== 'function') {
    return false;
  }
  try {
    return WebAssembly.validate(
      new Uint8Array([
        0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0,
        253, 15, 253, 98, 11,
      ]),
    );
  } catch {
    return false;
  }
}

function loadSuppressorModule(): Promise<SuppressorModule> {
  if (!suppressorModulePromise) {
    suppressorModulePromise = import('@sapphi-red/web-noise-suppressor').catch((err) => {
      suppressorModulePromise = null;
      throw err;
    });
  }
  return suppressorModulePromise;
}

function loadWasmBinary(
  mod: SuppressorModule,
  mode: 'rnnoise' | 'gtcrn',
): Promise<ArrayBuffer> {
  const cached = wasmBinaryCache.get(mode);
  if (cached) return cached;

  const loader =
    mode === 'rnnoise'
      ? mod.loadRnnoise({ url: rnnoiseWasmUrl, simdUrl: rnnoiseSimdWasmUrl })
      : mod.loadGtcrn({ url: gtcrnWasmUrl });

  const tracked = loader.catch((err) => {
    wasmBinaryCache.delete(mode);
    throw err;
  });
  wasmBinaryCache.set(mode, tracked);
  return tracked;
}

function loadDeepFilterWasmModule(): Promise<WebAssembly.Module> {
  if (!deepFilterModulePromise) {
    deepFilterModulePromise = (async () => {
      if (!supportsWasmSimd()) {
        throw new Error('Bu cihaz WASM SIMD desteklemiyor (GTCRN veya RNNoise kullanabilirsin).');
      }
      const res = await fetch(deepFilterWasmUrl);
      if (!res.ok) {
        throw new Error(`DeepFilterNet 3 modeli indirilemedi (${res.status}).`);
      }
      const bytes = await res.arrayBuffer();
      return WebAssembly.compile(bytes);
    })().catch((err) => {
      deepFilterModulePromise = null;
      throw err;
    });
  }
  return deepFilterModulePromise;
}

function loadDeepFilterWorkletBlobUrl(): Promise<string> {
  if (!deepFilterWorkletBlobUrlPromise) {
    deepFilterWorkletBlobUrlPromise = (async () => {
      const res = await fetch(deepFilterWorkletUrl);
      if (!res.ok) {
        throw new Error(`DeepFilterNet 3 worklet dosyası indirilemedi (${res.status}).`);
      }
      const rawSource = await res.text();
      const patched = buildDeepFilterWorkletSource(rawSource);
      const blob = new Blob([patched], { type: 'application/javascript' });
      return URL.createObjectURL(blob);
    })().catch((err) => {
      deepFilterWorkletBlobUrlPromise = null;
      throw err;
    });
  }
  return deepFilterWorkletBlobUrlPromise;
}

async function ensureWorkletModule(ctx: AudioContext, mode: AiNoiseSuppressionMode): Promise<void> {
  let loaded = loadedModulesByContext.get(ctx);
  if (!loaded) {
    loaded = new Set<AiNoiseSuppressionMode>();
    loadedModulesByContext.set(ctx, loaded);
  }
  if (loaded.has(mode)) return;

  const url =
    mode === 'deepfilternet'
      ? await loadDeepFilterWorkletBlobUrl()
      : mode === 'rnnoise'
        ? rnnoiseWorkletUrl
        : gtcrnWorkletUrl;

  await ctx.audioWorklet.addModule(url);
  loaded.add(mode);
}

export async function createAiNoiseWorkletNode(
  ctx: AudioContext,
  mode: AiNoiseSuppressionMode,
  maxChannels: number,
): Promise<AiNoiseWorkletNode> {
  if (typeof AudioWorkletNode === 'undefined' || !ctx.audioWorklet) {
    throw new Error('Bu tarayıcı AudioWorklet desteklemiyor.');
  }

  if (!isSampleRateCompatible(mode, ctx.sampleRate)) {
    throw new Error(
      `${mode.toUpperCase()} için 48 kHz ses örneklemesi gerekiyor (mevcut: ${ctx.sampleRate} Hz).`,
    );
  }

  if (mode === 'deepfilternet') {
    const [wasmModule] = await Promise.all([
      loadDeepFilterWasmModule(),
      ensureWorkletModule(ctx, 'deepfilternet'),
    ]);

    const node = new AudioWorkletNode(ctx, 'deepfilternet-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      processorOptions: {
        wasmModule,
        attenuationLimit: 100,
      },
    }) as AiNoiseWorkletNode;

    node.destroy = () => {
      try {
        node.port.postMessage({ type: 'setEnabled', value: false });
      } catch {
        // Ignore port errors on closed worklet
      }
    };
    return node;
  }

  const mod = await loadSuppressorModule();
  const [wasmBinary] = await Promise.all([
    loadWasmBinary(mod, mode),
    ensureWorkletModule(ctx, mode),
  ]);

  const channels = Math.max(1, Math.min(2, maxChannels));
  const binaryCopy = wasmBinary.slice(0);

  if (mode === 'rnnoise') {
    return new mod.RnnoiseWorkletNode(ctx, {
      wasmBinary: binaryCopy,
      maxChannels: channels,
    });
  }

  return new mod.GtcrnWorkletNode(ctx, {
    wasmBinary: binaryCopy,
    maxChannels: channels,
  });
}
