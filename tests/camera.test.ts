import { describe, expect, it } from 'vitest';
import { Camera } from '../src/view/camera';
import { gridSpacing } from '../src/view/gridSpacing';

describe('Camera', () => {
  it('round-trips between screen and world coordinates', () => {
    const c = new Camera();
    c.setViewport(800, 600);
    c.x = 3.5;
    c.y = -2;
    c.scale = 50;
    for (const [sx, sy] of [
      [0, 0],
      [400, 300],
      [799, 17],
    ]) {
      expect(c.toScreenX(c.toWorldX(sx))).toBeCloseTo(sx, 9);
      expect(c.toScreenY(c.toWorldY(sy))).toBeCloseTo(sy, 9);
    }
    // y axis points up on screen
    expect(c.toWorldY(0)).toBeGreaterThan(c.toWorldY(600));
  });

  it('keeps the point under the cursor fixed while zooming', () => {
    const c = new Camera();
    c.setViewport(800, 600);
    const wx = c.toWorldX(123);
    const wy = c.toWorldY(456);
    c.zoomAt(123, 456, 3.7);
    expect(c.toWorldX(123)).toBeCloseTo(wx, 9);
    expect(c.toWorldY(456)).toBeCloseTo(wy, 9);
  });

  it('pans so that content follows the pointer', () => {
    const c = new Camera();
    c.setViewport(800, 600);
    const wx = c.toWorldX(100);
    const wy = c.toWorldY(100);
    c.panBy(40, -25);
    expect(c.toScreenX(wx)).toBeCloseTo(140, 9);
    expect(c.toScreenY(wy)).toBeCloseTo(75, 9);
  });
});

describe('gridSpacing', () => {
  it('chooses 1-2-5 major steps at least ~90 px apart', () => {
    for (const scale of [6, 13, 64, 100, 777, 2500]) {
      const { major, minor } = gridSpacing(scale);
      expect(major * scale).toBeGreaterThanOrEqual(90 - 1e-9);
      expect(major * scale).toBeLessThan(90 * 5 + 1e-9);
      const mant = major / 10 ** Math.floor(Math.log10(major) + 1e-9);
      expect([1, 2, 5].some((m) => Math.abs(mant - m) < 1e-9)).toBe(true);
      expect(Math.abs(major / minor - Math.round(major / minor))).toBeLessThan(1e-9);
    }
  });
});
