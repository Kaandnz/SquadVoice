export type DesktopOs = 'windows' | 'macos' | 'linux' | 'android' | 'ios';

export interface ReleaseAsset {
  name: string;
  url: string;
  size: number;
}

export interface DesktopReleaseInfo {
  version: string;
  releaseUrl: string;
  publishedAt: string | null;
  windowsExe: ReleaseAsset | null;
  windowsMsi: ReleaseAsset | null;
  macosDmg: ReleaseAsset | null;
  macosDmgIntel: ReleaseAsset | null;
  androidApk: ReleaseAsset | null;
  linuxAppImage: ReleaseAsset | null;
}

export type DesktopReleaseResult =
  | { status: 'ready'; release: DesktopReleaseInfo; releasesUrl: string }
  | { status: 'no-release'; releasesUrl: string }
  | { status: 'error'; releasesUrl: string };

interface GitHubReleaseApiAsset {
  name?: string;
  browser_download_url?: string;
  size?: number;
}

interface GitHubReleaseApiPayload {
  tag_name?: string;
  html_url?: string;
  published_at?: string;
  assets?: GitHubReleaseApiAsset[];
}

export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

const DEFAULT_GITHUB_REPO = 'Kaandnz/SquadVoice';

export function getGithubRepo(): string {
  const fromEnv = (import.meta.env.VITE_GITHUB_REPO as string | undefined)?.trim();
  return fromEnv && fromEnv.includes('/') ? fromEnv : DEFAULT_GITHUB_REPO;
}

export function getReleasesPageUrl(repo = getGithubRepo()): string {
  const custom = (import.meta.env.VITE_DOWNLOAD_URL as string | undefined)?.trim();
  if (custom) return custom;
  return `https://github.com/${repo}/releases`;
}

export function getLatestReleaseApiUrl(repo = getGithubRepo()): string {
  return `https://api.github.com/repos/${repo}/releases/latest`;
}

export function detectDesktopOs(
  userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : '',
  platform = typeof navigator !== 'undefined' ? navigator.platform : '',
): DesktopOs {
  const ua = userAgent.toLowerCase();
  const plat = platform.toLowerCase();
  if (/iphone|ipad|ipod/.test(ua)) return 'ios';
  if (/android/.test(ua)) return 'android';
  if (ua.includes('mac') || plat.includes('mac')) return 'macos';
  if (ua.includes('win') || plat.includes('win')) return 'windows';
  if (ua.includes('linux') || plat.includes('linux')) return 'linux';
  return 'windows';
}

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  const kb = bytes / 1024;
  return `${Math.round(kb)} KB`;
}

export function parseDesktopRelease(
  payload: GitHubReleaseApiPayload,
  fallbackReleasesUrl = getReleasesPageUrl(),
): DesktopReleaseInfo {
  const assets: ReleaseAsset[] = (payload.assets ?? [])
    .filter(
      (a): a is Required<Pick<GitHubReleaseApiAsset, 'name' | 'browser_download_url'>> & {
        size?: number;
      } => Boolean(a?.name && a?.browser_download_url),
    )
    .map((a) => ({
      name: a.name,
      url: a.browser_download_url,
      size: typeof a.size === 'number' ? a.size : 0,
    }));

  const lower = (a: ReleaseAsset) => a.name.toLowerCase();

  const windowsExe = assets.find((a) => lower(a).endsWith('.exe')) ?? null;
  const windowsMsi = assets.find((a) => lower(a).endsWith('.msi')) ?? null;

  const dmgs = assets.filter((a) => lower(a).endsWith('.dmg'));
  const universalDmg = dmgs.find((a) => lower(a).includes('universal')) ?? null;
  const armDmg =
    dmgs.find((a) => lower(a).includes('aarch64') || lower(a).includes('arm64')) ?? null;
  const intelDmg =
    dmgs.find((a) => lower(a).includes('x64') || lower(a).includes('x86_64')) ?? null;

  const macosDmg = universalDmg ?? armDmg ?? dmgs[0] ?? null;
  const macosDmgIntel =
    !universalDmg && intelDmg && intelDmg.url !== macosDmg?.url ? intelDmg : null;

  const androidApk = assets.find((a) => lower(a).endsWith('.apk')) ?? null;

  const linuxAppImage =
    assets.find((a) => lower(a).endsWith('.appimage')) ??
    assets.find((a) => lower(a).endsWith('.deb')) ??
    null;

  return {
    version: payload.tag_name || 'v0.1.0',
    releaseUrl: payload.html_url || fallbackReleasesUrl,
    publishedAt: payload.published_at ?? null,
    windowsExe,
    windowsMsi,
    macosDmg,
    macosDmgIntel,
    androidApk,
    linuxAppImage,
  };
}

let cachedResult: { repo: string; result: DesktopReleaseResult } | null = null;

export async function fetchLatestDesktopRelease(
  signal?: AbortSignal,
): Promise<DesktopReleaseResult> {
  const repo = getGithubRepo();
  const releasesUrl = getReleasesPageUrl(repo);

  if (cachedResult && cachedResult.repo === repo && cachedResult.result.status === 'ready') {
    return cachedResult.result;
  }

  try {
    const res = await fetch(getLatestReleaseApiUrl(repo), {
      headers: { Accept: 'application/vnd.github+json' },
      signal,
    });
    if (res.status === 404) {
      return { status: 'no-release', releasesUrl };
    }
    if (!res.ok) {
      return { status: 'error', releasesUrl };
    }
    const data = (await res.json()) as GitHubReleaseApiPayload;
    const release = parseDesktopRelease(data, releasesUrl);
    const result: DesktopReleaseResult = { status: 'ready', release, releasesUrl };
    cachedResult = { repo, result };
    return result;
  } catch (err) {
    if ((err as { name?: string })?.name === 'AbortError') {
      throw err;
    }
    return { status: 'error', releasesUrl };
  }
}

// Capture Chrome/Edge PWA install prompt globally as soon as the app boots.
let deferredInstallPrompt: BeforeInstallPromptEvent | null = null;
const installListeners = new Set<() => void>();

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e as BeforeInstallPromptEvent;
    installListeners.forEach((fn) => fn());
  });
  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    installListeners.forEach((fn) => fn());
  });
}

export function getDeferredPwaPrompt(): BeforeInstallPromptEvent | null {
  return deferredInstallPrompt;
}

export function subscribePwaPrompt(cb: () => void): () => void {
  installListeners.add(cb);
  return () => {
    installListeners.delete(cb);
  };
}

export async function triggerPwaInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  if (!deferredInstallPrompt) return 'unavailable';
  const promptEvent = deferredInstallPrompt;
  deferredInstallPrompt = null;
  installListeners.forEach((fn) => fn());
  await promptEvent.prompt();
  const choice = await promptEvent.userChoice;
  return choice.outcome;
}
