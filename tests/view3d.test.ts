import { describe, expect, it } from 'vitest';
import { COLORMAP, hexToRgb } from '../src/config';
import { psiColor, srgbToLinear } from '../src/render/colormap';
import { easeInOutCubic, lerpPose } from '../src/view3d/viewSwitch';
import type { CameraPose } from '../src/view3d/types';

describe('colour map on the CPU (3D surface)', () => {
  const at = (v: number) => {
    const out = [0, 0, 0];
    psiColor(v, 5, out);
    return out;
  };

  it('matches the stops of the shader ramp exactly', () => {
    expect(at(0)).toEqual([1, 1, 1]);
    COLORMAP.stops.forEach((stop, i) => {
      if (stop === 0) return;
      const hot = hexToRgb(COLORMAP.hot[i]);
      const cold = hexToRgb(COLORMAP.cold[i]);
      at(stop * 5).forEach((c, k) => expect(c).toBeCloseTo(hot[k], 12));
      at(-stop * 5).forEach((c, k) => expect(c).toBeCloseTo(cold[k], 12));
    });
    expect(at(99)).toEqual(at(5)); // saturates at ±cap
  });

  it('interpolates linearly between stops', () => {
    const [a, b] = [COLORMAP.stops[1], COLORMAP.stops[2]];
    const c0 = hexToRgb(COLORMAP.hot[1]);
    const c1 = hexToRgb(COLORMAP.hot[2]);
    at(((a + b) / 2) * 5).forEach((c, k) => expect(c).toBeCloseTo((c0[k] + c1[k]) / 2, 12));
  });

  it('converts sRGB to linear with the standard curve', () => {
    expect(srgbToLinear(0)).toBe(0);
    expect(srgbToLinear(1)).toBeCloseTo(1, 12);
    expect(srgbToLinear(0.5)).toBeCloseTo(0.214041, 5);
  });
});

describe('2D ↔ 3D transition maths', () => {
  it('eases from 0 to 1 symmetrically', () => {
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(1)).toBe(1);
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5, 12);
    expect(easeInOutCubic(0.25) + easeInOutCubic(0.75)).toBeCloseTo(1, 12);
  });

  it('interpolates camera poses: ends exactly, angles the short way round', () => {
    const a: CameraPose = { target: [0, 0, 0], distance: 10, polar: 0, azimuth: -Math.PI / 2 };
    const b: CameraPose = { target: [2, 4, 0], distance: 40, polar: 1, azimuth: Math.PI };
    expect(lerpPose(a, b, 0)).toEqual(a);
    const end = lerpPose(a, b, 1);
    expect(end.target).toEqual(b.target);
    expect(end.distance).toBeCloseTo(40, 12);
    expect(end.polar).toBeCloseTo(1, 12);
    // From −90° to 180°: the short way is −90° → −180°, not through 0°.
    expect(Math.cos(end.azimuth)).toBeCloseTo(-1, 12);
    expect(lerpPose(a, b, 0.5).azimuth).toBeCloseTo((-3 * Math.PI) / 4, 12);
    expect(lerpPose(a, b, 0.5).distance).toBeCloseTo(20, 12); // geometric: zoom feels even
  });
});
