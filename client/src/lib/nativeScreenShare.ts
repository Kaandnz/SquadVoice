import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type { ScreenShareOptions } from '../types/protocol';

interface ScreenShareFrameEvent {
  data: string;
  width: number;
  height: number;
}

interface ScreenShareStartedEvent {
  width: number;
  height: number;
}

interface ScreenShareNativePlugin {
  start(options: { maxDimension: number; fps: number; quality: number }): Promise<{ started: boolean }>;
  stop(): Promise<void>;
  addListener(
    eventName: 'started',
    listenerFunc: (ev: ScreenShareStartedEvent) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'frame',
    listenerFunc: (ev: ScreenShareFrameEvent) => void,
  ): Promise<PluginListenerHandle>;
  addListener(eventName: 'stopped', listenerFunc: () => void): Promise<PluginListenerHandle>;
}

const ScreenShare = registerPlugin<ScreenShareNativePlugin>('ScreenShare');

export function isNativeAndroidScreenShareSupported(): boolean {
  try {
    return (
      typeof window !== 'undefined' &&
      Capacitor.isNativePlatform() &&
      Capacitor.getPlatform() === 'android'
    );
  } catch {
    return false;
  }
}

export function resolveAndroidCaptureParams(opts: ScreenShareOptions): {
  maxDimension: number;
  fps: number;
  quality: number;
} {
  const maxDimension = opts.width >= 1920 ? 1280 : 960;
  const fps = Math.max(10, Math.min(opts.frameRate || 18, 20));
  const quality = opts.contentHint === 'detail' ? 78 : 66;
  return { maxDimension, fps, quality };
}

interface ActiveNativeCapture {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  stream: MediaStream;
  handles: PluginListenerHandle[];
  disposed: boolean;
  decoding: boolean;
  pendingFrame: ScreenShareFrameEvent | null;
  onStopped: () => void;
}

let activeCapture: ActiveNativeCapture | null = null;

function base64ToBlob(base64: string, mime = 'image/jpeg'): Blob {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) {
    bytes[i] = bin.charCodeAt(i);
  }
  return new Blob([bytes], { type: mime });
}

async function decodeAndDrawFrame(
  session: ActiveNativeCapture,
  frame: ScreenShareFrameEvent,
): Promise<void> {
  if (session.disposed) return;

  const w = Math.max(2, frame.width || session.canvas.width);
  const h = Math.max(2, frame.height || session.canvas.height);

  if (typeof createImageBitmap === 'function') {
    const blob = base64ToBlob(frame.data, 'image/jpeg');
    const bitmap = await createImageBitmap(blob);
    try {
      if (session.disposed) return;
      if (session.canvas.width !== w || session.canvas.height !== h) {
        session.canvas.width = w;
        session.canvas.height = h;
      }
      session.ctx.drawImage(bitmap, 0, 0, w, h);
    } finally {
      bitmap.close();
    }
    return;
  }

  // Fallback for engines without createImageBitmap
  await new Promise<void>((resolve) => {
    const img = new Image();
    img.onload = () => {
      if (!session.disposed) {
        if (session.canvas.width !== w || session.canvas.height !== h) {
          session.canvas.width = w;
          session.canvas.height = h;
        }
        session.ctx.drawImage(img, 0, 0, w, h);
      }
      resolve();
    };
    img.onerror = () => resolve();
    img.src = `data:image/jpeg;base64,${frame.data}`;
  });
}

function enqueueFrame(session: ActiveNativeCapture, frame: ScreenShareFrameEvent): void {
  if (session.disposed) return;
  if (session.decoding) {
    // Drop older unread frames so latency never accumulates
    session.pendingFrame = frame;
    return;
  }
  session.decoding = true;
  void decodeAndDrawFrame(session, frame)
    .catch(() => {})
    .finally(() => {
      session.decoding = false;
      const next = session.pendingFrame;
      session.pendingFrame = null;
      if (next && !session.disposed) {
        enqueueFrame(session, next);
      }
    });
}

function cleanupSession(session: ActiveNativeCapture | null, callNativeStop: boolean): void {
  if (!session || session.disposed) return;
  session.disposed = true;
  session.pendingFrame = null;
  if (activeCapture === session) {
    activeCapture = null;
  }
  for (const h of session.handles) {
    h.remove().catch(() => {});
  }
  session.handles = [];
  for (const track of session.stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // Ignore already stopped track
    }
  }
  if (callNativeStop) {
    ScreenShare.stop().catch(() => {});
  }
}

export function stopNativeAndroidScreenShare(): void {
  if (!activeCapture) {
    if (isNativeAndroidScreenShareSupported()) {
      ScreenShare.stop().catch(() => {});
    }
    return;
  }
  cleanupSession(activeCapture, true);
}

export async function startNativeAndroidScreenShare(
  opts: ScreenShareOptions,
  onStoppedBySystem: () => void,
): Promise<MediaStream> {
  if (!isNativeAndroidScreenShareSupported()) {
    throw new Error('Yerel Android ekran paylaşımı bu cihazda kullanılamıyor.');
  }

  stopNativeAndroidScreenShare();

  const { maxDimension, fps, quality } = resolveAndroidCaptureParams(opts);

  const canvas = document.createElement('canvas');
  canvas.width = 720;
  canvas.height = 1280;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) {
    throw new Error('Ekran yayını için grafik bağlamı oluşturulamadı.');
  }
  // Draw an initial dark frame so WebRTC has a live video frame immediately
  ctx.fillStyle = '#111214';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const stream = canvas.captureStream(fps);
  const session: ActiveNativeCapture = {
    canvas,
    ctx,
    stream,
    handles: [],
    disposed: false,
    decoding: false,
    pendingFrame: null,
    onStopped: onStoppedBySystem,
  };
  activeCapture = session;

  try {
    const startedHandle = await ScreenShare.addListener('started', (ev) => {
      if (session.disposed) return;
      if (ev.width > 0 && ev.height > 0) {
        session.canvas.width = ev.width;
        session.canvas.height = ev.height;
        session.ctx.fillStyle = '#111214';
        session.ctx.fillRect(0, 0, ev.width, ev.height);
      }
    });
    const frameHandle = await ScreenShare.addListener('frame', (frame) => {
      enqueueFrame(session, frame);
    });
    const stoppedHandle = await ScreenShare.addListener('stopped', () => {
      if (session.disposed) return;
      const cb = session.onStopped;
      cleanupSession(session, false);
      cb();
    });
    session.handles = [startedHandle, frameHandle, stoppedHandle];

    await ScreenShare.start({ maxDimension, fps, quality });
    return stream;
  } catch (err) {
    cleanupSession(session, true);
    throw err;
  }
}
