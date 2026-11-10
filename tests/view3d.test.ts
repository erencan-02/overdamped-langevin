import { describe, expect, it } from 'vitest';
import { easeInOutCubic, lerpPose } from '../src/view3d/viewSwitch';
import type { CameraPose } from '../src/view3d/types';

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
