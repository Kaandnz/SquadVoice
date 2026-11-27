/// <reference types="vite/client" />
import type {
  GtcrnWorkletNode,
  RnnoiseWorkletNode,
} from '@sapphi-red/web-noise-suppressor';
import gtcrnWasmUrl from '@sapphi-red/web-noise-suppressor/gtcrn.wasm?url';
import gtcrnWorkletUrl from '@sapphi-red/web-noise-suppressor/gtcrnWorklet.js?url';
import rnnoiseWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url';
import rnnoiseSimdWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url';
import rnnoiseWorkletUrl from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url';
import {
  isSampleRateCompatible,
  type AiNoiseSuppressionMode,
} from './noiseSuppression';

export type AiNoiseWorkletNode = RnnoiseWorkletNode | GtcrnWorkletNode;

type SuppressorModule = typeof import('@sapphi-red/web-noise-suppressor');

let suppressorModulePromise: Promise<SuppressorModule> | null = null;
const wasmBinaryCache = new Map<AiNoiseSuppressionMode, Promise<ArrayBuffer>>();
const loadedModulesByContext = new WeakMap<AudioContext, Set<AiNoiseSuppressionMode>>();

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
  mode: AiNoiseSuppressionMode,
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

async function ensureWorkletModule(ctx: AudioContext, mode: AiNoiseSuppressionMode): Promise<void> {
  let loaded = loadedModulesByContext.get(ctx);
  if (!loaded) {
    loaded = new Set<AiNoiseSuppressionMode>();
    loadedModulesByContext.set(ctx, loaded);
  }
  if (loaded.has(mode)) return;

  const url = mode === 'rnnoise' ? rnnoiseWorkletUrl : gtcrnWorkletUrl;
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
