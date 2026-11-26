import { describe, expect, it } from 'vitest';
import {
  clampPan,
  clampZoom,
  MAX_ZOOM,
  MIN_ZOOM,
  touchDistance,
  zoomStep,
} from './streamZoom';

describe('streamZoom helpers', () => {
  it('clamps zoom within [MIN_ZOOM, MAX_ZOOM] and handles invalid inputs', () => {
    expect(clampZoom(0.4)).toBe(MIN_ZOOM);
    expect(clampZoom(6)).toBe(MAX_ZOOM);
    expect(clampZoom(2.346)).toBe(2.35);
    expect(clampZoom(Number.NaN)).toBe(MIN_ZOOM);
  });

  it('steps zoom incrementally without leaving bounds', () => {
    expect(zoomStep(1, 0.5)).toBe(1.5);
    expect(zoomStep(1, -0.5)).toBe(1);
    expect(zoomStep(3.8, 0.5)).toBe(4);
  });

  it('clamps pan offsets proportionally to zoom and viewport size', () => {
    expect(clampPan({ x: 120, y: -80 }, 1, 400, 300)).toEqual({ x: 0, y: 0 });
    expect(clampPan({ x: 50, y: 50 }, 2, 0, 300)).toEqual({ x: 0, y: 0 });
    expect(clampPan({ x: 350, y: -260 }, 2, 400, 300)).toEqual({ x: 200, y: -150 });
    expect(clampPan({ x: -120, y: 90 }, 2.5, 400, 300)).toEqual({ x: -120, y: 90 });
  });

  it('computes Euclidean distance between two touch points', () => {
    expect(touchDistance({ clientX: 0, clientY: 0 }, { clientX: 30, clientY: 40 })).toBe(50);
  });
});
