import type { DriftField } from '../sim/schemes';

/**
 * Floats per arrow: world x, world y, unit direction x, y, length (as a fraction of the lattice
 * spacing, so zooming only rescales it in the shader), opacity.
 */
export const ARROW_FLOATS = 6;

/** Arrow lattice spacing on screen is kept within [MIN_SPACING_PX, 2·MIN_SPACING_PX). */
export const MIN_SPACING_PX = 26;
/** Arrows use at most this fraction of the lattice spacing, so neighbours never touch. */
const MAX_LENGTH_FRACTION = 0.82;
/** Force magnitude at which an arrow reaches 63 % of its maximum length. */
const FORCE_REF = 1.5;
/** Forces weaker than this are not drawn at all (flat or unpainted regions stay clean). */
const MIN_FORCE = 1e-3;

/**
 * World-space spacing of the arrow lattice: a power of two, so the lattice stays fixed in the
 * world while panning and only refines/coarsens by factors of 2 while zooming.
 */
export function arrowSpacing(scale: number): number {
  return 2 ** Math.ceil(Math.log2(MIN_SPACING_PX / scale));
}

/**
 * Arrow length in CSS pixels for a force of magnitude m: grows linearly for weak forces and
 * saturates for strong ones, so both gentle slopes and steep walls stay readable.
 */
export function arrowLength(m: number, spacingPx: number): number {
  return MAX_LENGTH_FRACTION * spacingPx * (1 - Math.exp(-m / FORCE_REF));
}

/** Opacity for a force of magnitude m: very weak forces fade out smoothly. */
export function arrowOpacity(m: number): number {
  const t = Math.min(1, Math.max(0, (m - 0.01) / 0.25));
  return t * t * (3 - 2 * t);
}

/**
 * Samples the force −∇Ψ on the arrow lattice covering the visible rectangle and writes one
 * arrow per lattice node into `out` (growing it if needed). Returns the buffer and the number
 * of arrows.
 */
export function buildArrows(
  field: DriftField,
  bounds: { x0: number; y0: number; x1: number; y1: number },
  scale: number,
  out: Float32Array,
  /** Time for drifts that depend on it (batched drifts only). */
  t = 0,
): { data: Float32Array; count: number } {
  const sp = arrowSpacing(scale);
  const i0 = Math.floor(bounds.x0 / sp) - 1;
  const i1 = Math.ceil(bounds.x1 / sp) + 1;
  const j0 = Math.floor(bounds.y0 / sp) - 1;
  const j1 = Math.ceil(bounds.y1 / sp) + 1;
  const needed = (i1 - i0 + 1) * (j1 - j0 + 1) * ARROW_FLOATS;
  let data = out;
  if (data.length < needed) data = new Float32Array(Math.ceil(needed * 1.5));

  // A batched drift (a formula) is evaluated for all arrows in one call.
  const nx = i1 - i0 + 1;
  const ny = j1 - j0 + 1;
  let gxs: Float64Array | null = null;
  let gys: Float64Array | null = null;
  if (field.gradientBatch) {
    const n = nx * ny;
    const xs = new Float64Array(n);
    const ys = new Float64Array(n);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        xs[j * nx + i] = (i0 + i) * sp;
        ys[j * nx + i] = (j0 + j) * sp;
      }
    }
    gxs = new Float64Array(n);
    gys = new Float64Array(n);
    field.gradientBatch(xs, ys, n, t, gxs, gys);
  }

  const g = new Float64Array(2);
  let w = 0;
  for (let j = j0; j <= j1; j++) {
    const wy = j * sp;
    for (let i = i0; i <= i1; i++) {
      const wx = i * sp;
      if (gxs && gys) {
        const k = (j - j0) * nx + (i - i0);
        g[0] = gxs[k];
        g[1] = gys[k];
      } else {
        field.gradient(wx, wy, g);
      }
      const fx = -g[0];
      const fy = -g[1];
      const m = Math.hypot(fx, fy);
      if (!(m > MIN_FORCE)) continue;
      data[w++] = wx;
      data[w++] = wy;
      data[w++] = fx / m;
      data[w++] = fy / m;
      data[w++] = arrowLength(m, 1);
      data[w++] = arrowOpacity(m);
    }
  }
  return { data, count: w / ARROW_FLOATS };
}
