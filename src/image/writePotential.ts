import type { PotentialField } from '../sim/field';
import type { PotentialGrid } from '../sim/imagePotential';

/** Where a potential grid lies in the world. */
export interface GridPlacement {
  /** World x of the first (unpadded) image column. */
  x0: number;
  /** World y of the first (unpadded) image row; rows run downwards (−y). */
  yTop: number;
  /** World distance between neighbouring samples (≥ the field's lattice spacing). */
  cell: number;
}

/** World rectangle covered by a grid, including its padding. */
export function gridBounds(grid: PotentialGrid, at: GridPlacement) {
  const { width: W, height: H, pad } = grid;
  return {
    x0: at.x0 - pad * at.cell,
    x1: at.x0 + (W - 1 - pad) * at.cell,
    y0: at.yTop - (H - 1 - pad) * at.cell,
    y1: at.yTop + pad * at.cell,
  };
}

/**
 * Overwrites Ψ with the grid, bilinearly interpolated onto the field's lattice. Nodes outside
 * the grid's rectangle are left untouched, so the same placement can be rewritten every video
 * frame without clearing the rest of the plane.
 */
export function writePotential(field: PotentialField, grid: PotentialGrid, at: GridPlacement): void {
  const { width: W, height: H, pad, values } = grid;
  const inv = 1 / at.cell;
  const ox = at.x0 - pad * at.cell;
  const oy = at.yTop + pad * at.cell;
  const sample = (x: number, y: number): number => {
    const u = (x - ox) * inv;
    const v = (oy - y) * inv;
    let i = Math.floor(u);
    let j = Math.floor(v);
    if (i < 0 || j < 0 || i >= W || j >= H) return 0;
    // The last row/column interpolates with itself.
    if (i === W - 1) i = W - 2;
    if (j === H - 1) j = H - 2;
    const fx = Math.min(1, u - i);
    const fy = Math.min(1, v - j);
    const k = j * W + i;
    const a = values[k] + (values[k + 1] - values[k]) * fx;
    const b = values[k + W] + (values[k + W + 1] - values[k + W]) * fx;
    return a + (b - a) * fy;
  };
  const b = gridBounds(grid, at);
  field.setFunction(b.x0, b.y0, b.x1, b.y1, sample);
}
