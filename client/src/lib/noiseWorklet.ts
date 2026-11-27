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
const loadedModulesByContext = new WeakMap<AudioContext, Set<AiNoiseSuppressionMode>>();

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

async function ensureWorkletModule(ctx: AudioContext, mode: AiNoiseSuppressionMode): Promise<void> {
  let loaded = loadedModulesByContext.get(ctx);
  if (!loaded) {
    loaded = new Set<AiNoiseSuppressionMode>();
    loadedModulesByContext.set(ctx, loaded);
  }
  if (loaded.has(mode)) return;

  const url =
    mode === 'deepfilternet'
      ? deepFilterWorkletUrl
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
