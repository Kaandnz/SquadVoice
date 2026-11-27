import type { AudioSettings, NoiseSuppressionMode } from '../types/protocol';

export type AiNoiseSuppressionMode = 'rnnoise' | 'gtcrn' | 'deepfilternet';

export interface NoiseSuppressionOption {
  id: NoiseSuppressionMode;
  label: string;
  badge?: string;
  description: string;
}

export const NOISE_SUPPRESSION_OPTIONS: ReadonlyArray<NoiseSuppressionOption> = [
  {
    id: 'off',
    label: 'Kapalı',
    description: 'Filtre yok. Müzik, enstrüman veya harici mikser için ham mikrofon sesi.',
  },
  {
    id: 'standard',
    label: 'Standart',
    badge: 'En Hafif',
    description: 'Tarayıcı / sistem motoru (WebRTC NS). Sıfır ekstra yük, mobil & Bluetooth uyumlu.',
  },
  {
    id: 'rnnoise',
    label: 'RNNoise AI',
    badge: 'Hafif AI',
    description: 'Jitsi standardı yapay zeka (~150 KB WASM). Fan ve dip gürültüsünde ultra düşük CPU.',
  },
  {
    id: 'gtcrn',
    label: 'GTCRN AI',
    badge: 'Hızlı AI',
    description: 'Yeni nesil derin öğrenme (~192 KB WASM). Klavye ve arka plan seslerinde çok hafif & güçlü.',
  },
  {
    id: 'deepfilternet',
    label: 'DeepFilterNet 3',
    badge: 'Stüdyo / Krisp',
    description:
      '48 kHz tam bant Rust WASM yapay zeka. En sert klavye, yankı ve ortam seslerinde stüdyo kalitesi (ilk seçimde indirilir).',
  },
];

export function isValidNoiseSuppressionMode(value: unknown): value is NoiseSuppressionMode {
  return (
    value === 'off' ||
    value === 'standard' ||
    value === 'rnnoise' ||
    value === 'gtcrn' ||
    value === 'deepfilternet'
  );
}

export function isAiNoiseSuppressionMode(
  mode: NoiseSuppressionMode,
): mode is AiNoiseSuppressionMode {
  return mode === 'rnnoise' || mode === 'gtcrn' || mode === 'deepfilternet';
}

export function getNoiseSuppressionLabel(mode: NoiseSuppressionMode): string {
  return NOISE_SUPPRESSION_OPTIONS.find((opt) => opt.id === mode)?.label ?? 'Standart';
}

/**
 * Resolves the effective noise suppression mode, transparently migrating
 * older saved AudioSettings that only stored boolean `noiseSuppression`.
 */
export function resolveNoiseSuppressionMode(
  settings: Partial<Pick<AudioSettings, 'noiseSuppression' | 'noiseSuppressionMode'>>,
): NoiseSuppressionMode {
  if (isValidNoiseSuppressionMode(settings.noiseSuppressionMode)) {
    return settings.noiseSuppressionMode;
  }
  if (settings.noiseSuppression === false) {
    return 'off';
  }
  return 'standard';
}

/**
 * Merges an AudioSettings patch while keeping `noiseSuppressionMode` and legacy
 * boolean `noiseSuppression` synchronized.
 */
export function mergeAudioSettings(
  base: AudioSettings,
  patch: Partial<AudioSettings>,
): AudioSettings {
  const merged = { ...base, ...patch };
  let mode: NoiseSuppressionMode;

  if (
    patch.noiseSuppressionMode !== undefined &&
    isValidNoiseSuppressionMode(patch.noiseSuppressionMode)
  ) {
    mode = patch.noiseSuppressionMode;
  } else if (patch.noiseSuppression !== undefined && patch.noiseSuppressionMode === undefined) {
    mode = patch.noiseSuppression ? 'standard' : 'off';
  } else {
    mode = resolveNoiseSuppressionMode(merged);
  }

  return {
    ...merged,
    noiseSuppressionMode: mode,
    noiseSuppression: mode !== 'off',
  };
}

/**
 * Builds native getUserMedia/applyConstraints audio processing flags.
 * Browser noiseSuppression is disabled in AI modes to prevent double-filtering artifacts.
 */
export function buildMicTrackConstraints(
  settings: Pick<
    AudioSettings,
    'echoCancellation' | 'noiseSuppression' | 'noiseSuppressionMode' | 'autoGainControl'
  >,
): MediaTrackConstraints {
  const mode = resolveNoiseSuppressionMode(settings);
  return {
    echoCancellation: settings.echoCancellation,
    noiseSuppression: mode === 'standard',
    autoGainControl: settings.autoGainControl,
  };
}

/**
 * Checks whether an AudioContext sample rate is supported by the given WASM worklet.
 */
export function isSampleRateCompatible(mode: AiNoiseSuppressionMode, sampleRate: number): boolean {
  if (mode === 'rnnoise' || mode === 'deepfilternet') {
    return sampleRate === 48000;
  }
  return sampleRate === 48000 || sampleRate === 16000;
}
