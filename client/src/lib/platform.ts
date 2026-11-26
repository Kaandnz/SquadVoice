const SERVER_URL_STORAGE_KEY = 'squadvoice_server_url';

export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export function isDesktopPlatform(): boolean {
  if (typeof navigator === 'undefined') return true;
  return !/Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

export function getDefaultServerUrl(): string {
  if (typeof window === 'undefined') return 'http://127.0.0.1:3001';
  if (!isTauriRuntime()) {
    return window.location.origin;
  }
  return localStorage.getItem(SERVER_URL_STORAGE_KEY) || 'http://127.0.0.1:3001';
}

export function normalizeServerUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) return getDefaultServerUrl();
  if (!/^https?:\/\//i.test(trimmed)) {
    return `https://${trimmed}`;
  }
  return trimmed;
}

export function saveServerUrl(url: string): string {
  const normalized = normalizeServerUrl(url);
  localStorage.setItem(SERVER_URL_STORAGE_KEY, normalized);
  return normalized;
}

export function toWebSocketUrl(httpBaseUrl: string, token: string): string {
  const normalized = normalizeServerUrl(httpBaseUrl);
  const wsBase = normalized.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
  return `${wsBase}/ws?token=${encodeURIComponent(token)}`;
}

export function resolveAssetUrl(serverUrl: string, pathOrUrl: string): string {
  if (/^(https?:|data:|blob:)/i.test(pathOrUrl)) return pathOrUrl;
  const base = normalizeServerUrl(serverUrl);
  const cleanPath = pathOrUrl.startsWith('/') ? pathOrUrl : `/${pathOrUrl}`;
  return `${base}${cleanPath}`;
}

export function canUseDisplayMedia(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    Boolean(navigator.mediaDevices && typeof navigator.mediaDevices.getDisplayMedia === 'function')
  );
}

function toTauriShortcut(keyCodeOrName: string): string {
  const map: Record<string, string> = {
    Backquote: 'Backquote',
    Space: 'Space',
    CapsLock: 'CapsLock',
    AltLeft: 'Alt',
    AltRight: 'Alt',
    ControlLeft: 'Control',
    ControlRight: 'Control',
    ShiftLeft: 'Shift',
    ShiftRight: 'Shift',
  };
  if (map[keyCodeOrName]) return map[keyCodeOrName];
  if (keyCodeOrName.startsWith('Key')) return keyCodeOrName.slice(3);
  if (keyCodeOrName.startsWith('Digit')) return keyCodeOrName.slice(5);
  return keyCodeOrName;
}

export async function registerGlobalPttShortcut(
  keyCode: string,
  onPressed: () => void,
  onReleased: () => void,
): Promise<() => void> {
  if (isTauriRuntime() && isDesktopPlatform()) {
    try {
      const mod = await import('@tauri-apps/plugin-global-shortcut');
      const shortcut = toTauriShortcut(keyCode);
      try {
        if (await mod.isRegistered(shortcut)) {
          await mod.unregister(shortcut);
        }
      } catch {
        // Ignore cleanup check failure
      }
      await mod.register(shortcut, (event) => {
        if (event.state === 'Pressed') onPressed();
        if (event.state === 'Released') onReleased();
      });
      return () => {
        mod.unregister(shortcut).catch(() => {});
      };
    } catch {
      // Fallback to DOM keyboard listeners below
    }
  }

  const downHandler = (e: KeyboardEvent) => {
    if (e.repeat) return;
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (e.code === keyCode) {
      onPressed();
    }
  };

  const upHandler = (e: KeyboardEvent) => {
    if (e.code === keyCode) {
      onReleased();
    }
  };

  const blurHandler = () => onReleased();

  window.addEventListener('keydown', downHandler);
  window.addEventListener('keyup', upHandler);
  window.addEventListener('blur', blurHandler);

  return () => {
    window.removeEventListener('keydown', downHandler);
    window.removeEventListener('keyup', upHandler);
    window.removeEventListener('blur', blurHandler);
  };
}
