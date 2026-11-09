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
  const b = gridBounds(grid, at);
  field.writeGrid(grid.values, grid.width, grid.height, b.x0, b.y1, at.cell);
}
