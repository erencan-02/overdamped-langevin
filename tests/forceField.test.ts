import { describe, expect, it } from 'vitest';
import { PotentialField } from '../src/sim/field';
import {
  ARROW_FLOATS,
  MIN_SPACING_PX,
  arrowLength,
  arrowOpacity,
  arrowSpacing,
  buildArrows,
} from '../src/view/forceField';

describe('force field arrows', () => {
  it('uses a power-of-two lattice spaced 26–52 px on screen', () => {
    for (const scale of [6, 20, 64, 333, 2500]) {
      const sp = arrowSpacing(scale);
      expect(Number.isInteger(Math.log2(sp))).toBe(true);
      expect(sp * scale).toBeGreaterThanOrEqual(MIN_SPACING_PX);
      expect(sp * scale).toBeLessThan(2 * MIN_SPACING_PX);
    }
  });

  it('maps force magnitude to a monotone, saturating length and opacity', () => {
    const lens = [0, 0.2, 1, 3, 10, 100].map((m) => arrowLength(m, 40));
    for (let i = 1; i < lens.length; i++) expect(lens[i]).toBeGreaterThan(lens[i - 1]);
    expect(lens[0]).toBe(0);
    expect(lens[lens.length - 1]).toBeLessThan(40); // never reaches the neighbour
    expect(arrowOpacity(0)).toBe(0);
    expect(arrowOpacity(1)).toBe(1);
  });

  it('draws nothing where the potential is flat', () => {
    const field = new PotentialField({ cellSize: 0.04, cap: 5 });
    const { count } = buildArrows(field, { x0: -5, y0: -5, x1: 5, y1: 5 }, 64, new Float32Array(0));
    expect(count).toBe(0);
  });

  it('points downhill: away from a hill, into a valley', () => {
    for (const sign of [1, -1]) {
      const field = new PotentialField({ cellSize: 0.04, cap: 5 });
      field.applyBrush(0, 0, 3 * sign, 0.8);
      const { data, count } = buildArrows(
        field,
        { x0: -3, y0: -3, x1: 3, y1: 3 },
        64,
        new Float32Array(0),
      );
      expect(count).toBeGreaterThan(50);
      let checked = 0;
      for (let k = 0; k < count; k++) {
        const o = k * ARROW_FLOATS;
        const [x, y, ux, uy, len, alpha] = data.subarray(o, o + ARROW_FLOATS);
        const r = Math.hypot(x, y);
        if (r < 0.3 || r > 2) continue;
        // Radial component of the unit direction: +1 away from a hill, −1 into a valley.
        expect(((ux * x + uy * y) / r) * sign).toBeGreaterThan(0.99);
        expect(Math.hypot(ux, uy)).toBeCloseTo(1, 5);
        expect(len).toBeGreaterThan(0);
        expect(alpha).toBeGreaterThan(0);
        checked++;
      }
      expect(checked).toBeGreaterThan(20);
    }
  });

  it('keeps arrows fixed in the world while panning', () => {
    const field = new PotentialField({ cellSize: 0.04, cap: 5 });
    field.applyBrush(0, 0, 3, 1);
    const a = buildArrows(field, { x0: -2, y0: -2, x1: 2, y1: 2 }, 64, new Float32Array(0));
    const b = buildArrows(field, { x0: -1.7, y0: -2.2, x1: 2.3, y1: 1.8 }, 64, new Float32Array(0));
    const pts = (r: { data: Float32Array; count: number }) => {
      const s = new Set<string>();
      for (let k = 0; k < r.count; k++) s.add(`${r.data[k * ARROW_FLOATS]},${r.data[k * ARROW_FLOATS + 1]}`);
      return s;
    };
    const pa = pts(a);
    const pb = pts(b);
    let shared = 0;
    for (const p of pa) if (pb.has(p)) shared++;
    // Overlapping views share the same lattice nodes (no swimming arrows).
    expect(shared).toBeGreaterThan(0.6 * Math.min(pa.size, pb.size));
  });
});
