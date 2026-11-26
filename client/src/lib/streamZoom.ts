export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;
export const DOUBLE_TAP_ZOOM = 2.2;

/** Clamps stream zoom factor to [1, 4] rounded to two decimals. */
export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return MIN_ZOOM;
  const clamped = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
  return Math.round(clamped * 100) / 100;
}

/** Steps the current zoom by delta and clamps within valid bounds. */
export function zoomStep(current: number, delta: number): number {
  return clampZoom(current + delta);
}

/** Clamps stream drag pan offsets to keep zoomed video inside the viewport. */
export function clampPan(
  pan: { x: number; y: number },
  zoom: number,
  width: number,
  height: number,
): { x: number; y: number } {
  if (zoom <= MIN_ZOOM || width <= 0 || height <= 0) {
    return { x: 0, y: 0 };
  }
  const maxX = (width * (zoom - 1)) / 2;
  const maxY = (height * (zoom - 1)) / 2;
  return {
    x: Math.max(-maxX, Math.min(maxX, pan.x)),
    y: Math.max(-maxY, Math.min(maxY, pan.y)),
  };
}

/** Euclidean distance between two touch/pointer coordinates. */
export function touchDistance(
  a: { clientX: number; clientY: number },
  b: { clientX: number; clientY: number },
): number {
  return Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
}
