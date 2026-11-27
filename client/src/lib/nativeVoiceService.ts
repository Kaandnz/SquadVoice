import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

interface VoiceCallNativePlugin {
  start(options: {
    channelName: string;
    serverName: string;
    muted: boolean;
    deafened?: boolean;
  }): Promise<void>;
  update(options: {
    channelName?: string;
    serverName?: string;
    muted?: boolean;
    deafened?: boolean;
  }): Promise<void>;
  stop(): Promise<void>;
  addListener(
    eventName: 'toggleMute' | 'toggleDeafen' | 'hangup',
    listenerFunc: () => void,
  ): Promise<PluginListenerHandle>;
}

const VoiceCall = registerPlugin<VoiceCallNativePlugin>('VoiceCall');

export function isNativeMobileRuntime(): boolean {
  try {
    return typeof window !== 'undefined' && Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

let listenerHandles: PluginListenerHandle[] = [];

async function clearNativeListeners(): Promise<void> {
  const handles = listenerHandles;
  listenerHandles = [];
  for (const h of handles) {
    try {
      await h.remove();
    } catch {
      // Ignore cleanup errors
    }
  }
}

export async function startNativeVoiceService(options: {
  channelName: string;
  serverName: string;
  muted: boolean;
  deafened?: boolean;
  onToggleMute: () => void;
  onToggleDeafen?: () => void;
  onHangup: () => void;
}): Promise<void> {
  if (!isNativeMobileRuntime()) return;
  await clearNativeListeners();
  try {
    const handles: PluginListenerHandle[] = [];
    handles.push(await VoiceCall.addListener('toggleMute', options.onToggleMute));
    if (options.onToggleDeafen) {
      handles.push(await VoiceCall.addListener('toggleDeafen', options.onToggleDeafen));
    }
    handles.push(await VoiceCall.addListener('hangup', options.onHangup));
    listenerHandles = handles;
  } catch {
    // Ignore listener registration errors
  }
  await VoiceCall.start({
    channelName: options.channelName,
    serverName: options.serverName,
    muted: options.muted,
    deafened: Boolean(options.deafened),
  }).catch(() => {});
}

export function updateNativeVoiceService(options: {
  channelName?: string;
  serverName?: string;
  muted?: boolean;
  deafened?: boolean;
}): void {
  if (!isNativeMobileRuntime()) return;
  VoiceCall.update(options).catch(() => {});
}

export function stopNativeVoiceService(): void {
  if (!isNativeMobileRuntime()) return;
  void clearNativeListeners();
  VoiceCall.stop().catch(() => {});
}
