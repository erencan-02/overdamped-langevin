/**
 * Equidistant spawn grid inside a rectangle.
 *
 * Points are spaced exactly `spacing` apart in x and y, and the block of points is centred in the
 * rectangle, so the margins on opposite sides are equal. A rectangle smaller than the spacing in
 * some direction still gets one row/column through its centre.
 */

export interface SpawnGrid {
  /** Columns and rows. */
  nx: number;
  ny: number;
  /** Total number of grid points (nx · ny). */
  count: number;
  /** World position of the first point and the step between points. */
  x0: number;
  y0: number;
  spacing: number;
}

export function spawnGrid(ax: number, ay: number, bx: number, by: number, spacing: number): SpawnGrid {
  const minX = Math.min(ax, bx);
  const minY = Math.min(ay, by);
  const w = Math.abs(bx - ax);
  const h = Math.abs(by - ay);
  // Tiny tolerance so that a rectangle of exactly k·spacing really gets k + 1 points.
  const nx = Math.floor(w / spacing + 1e-9) + 1;
  const ny = Math.floor(h / spacing + 1e-9) + 1;
  return {
    nx,
    ny,
    count: nx * ny,
    x0: minX + (w - (nx - 1) * spacing) / 2,
    y0: minY + (h - (ny - 1) * spacing) / 2,
    spacing,
  };
}

/** Calls `fn` for the first `limit` points of the grid, row by row from the bottom left. */
export function forEachGridPoint(
  g: SpawnGrid,
  limit: number,
  fn: (x: number, y: number) => void,
): number {
  const n = Math.min(limit, g.count);
  for (let k = 0; k < n; k++) {
    const i = k % g.nx;
    const j = Math.floor(k / g.nx);
    fn(g.x0 + i * g.spacing, g.y0 + j * g.spacing);
  }
  return n;
}
