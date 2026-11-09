import { gaussianBlur } from '../sim/imagePotential';

/**
 * Kernel density estimate of the particle cloud and its relative entropy with respect to the
 * Gibbs measure, both restricted to a rectangular analysis box B and renormalised there.
 *
 * The Gibbs density π ∝ exp(−2Ψ/σ²) is not normalisable on ℝ² (Ψ = 0 wherever nothing is
 * painted), so every quantity is a conditional one: π_B = π·1_B / π(B), and likewise for the
 * smoothed empirical measure ρ̂_h = (1/N) Σ δ_{X_i} ∗ N(0, h² I).
 *
 * Everything lives on a regular grid over B. The empirical measure is deposited with
 * cloud-in-cell (bilinear) weights and convolved with the Gaussian kernel by a separable blur,
 * so one estimate costs O(N + cells · taps) instead of O(N · cells). Integrals are midpoint
 * sums over the cells; densities are kept as cell probabilities.
 */

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Analysis grid: cell (i, j) has its centre at (x0 + (i + ½)·cell, y0 + (j + ½)·cell). */
export interface AnalysisGrid {
  x0: number;
  y0: number;
  cell: number;
  nx: number;
  ny: number;
}

/** The kernel is resolved by at least this many cells per standard deviation (when possible). */
const CELLS_PER_SIGMA = 1.5;
/** Bounds on the grid's longer side, in cells. */
const MAX_CELLS = 256;
const MIN_CELLS = 64;

/**
 * Grid over `box` for kernel standard deviation `h`. The cell is h/1.5 (so the kernel is
 * resolved), but the longer side always has between 64 and 256 cells, which bounds the cost.
 */
export function makeGrid(box: Box, h: number): AnalysisGrid {
  const w = box.x1 - box.x0;
  const hgt = box.y1 - box.y0;
  const long = Math.max(w, hgt);
  const cell = Math.min(long / MIN_CELLS, Math.max(long / MAX_CELLS, h / CELLS_PER_SIGMA));
  // The grid covers [x0, x0 + nx·cell] × [y0, y0 + ny·cell], i.e. the box up to half a cell;
  // use gridBox() for the exact region that all quantities refer to.
  const nx = Math.max(1, Math.round(w / cell));
  const ny = Math.max(1, Math.round(hgt / cell));
  return { x0: box.x0, y0: box.y0, cell, nx, ny };
}

/** The exact rectangle covered by the grid. */
export function gridBox(g: AnalysisGrid): Box {
  return { x0: g.x0, y0: g.y0, x1: g.x0 + g.nx * g.cell, y1: g.y0 + g.ny * g.cell };
}

/**
 * Log cell probabilities of the Gibbs measure on the grid: log q_c with Σ q_c = 1, where
 * q_c ∝ exp(−2Ψ(c)/σ²) (Ψ sampled at the cell centre). Uses log-sum-exp, so very small σ does
 * not overflow. Returns null if σ is (practically) zero, where π has no density.
 */
export function gibbsLogProbabilities(
  grid: AnalysisGrid,
  psiAt: (x: number, y: number) => number,
  sigma: number,
): Float64Array | null {
  if (!(sigma > 1e-6)) return null;
  const { nx, ny, x0, y0, cell } = grid;
  const k = -2 / (sigma * sigma);
  const a = new Float64Array(nx * ny);
  let max = -Infinity;
  for (let j = 0; j < ny; j++) {
    const y = y0 + (j + 0.5) * cell;
    for (let i = 0; i < nx; i++) {
      const v = k * psiAt(x0 + (i + 0.5) * cell, y);
      a[j * nx + i] = v;
      if (v > max) max = v;
    }
  }
  let z = 0;
  for (let c = 0; c < a.length; c++) z += Math.exp(a[c] - max);
  const shift = max + Math.log(z);
  for (let c = 0; c < a.length; c++) a[c] -= shift;
  return a;
}

/**
 * Deposits the particles inside the grid with cloud-in-cell weights into `out` (cleared first)
 * and returns the number of particles that lie inside the box.
 */
export function depositParticles(
  grid: AnalysisGrid,
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  count: number,
  out: Float32Array,
): number {
  const { nx, ny, x0, y0, cell } = grid;
  out.fill(0, 0, nx * ny);
  const inv = 1 / cell;
  const x1 = x0 + nx * cell;
  const y1 = y0 + ny * cell;
  let inside = 0;
  for (let p = 0; p < count; p++) {
    const x = xs[p];
    const y = ys[p];
    if (!(x >= x0 && x < x1 && y >= y0 && y < y1)) continue;
    inside++;
    // Position relative to cell centres; weights split between the 4 nearest centres.
    const u = (x - x0) * inv - 0.5;
    const v = (y - y0) * inv - 0.5;
    let i = Math.floor(u);
    let j = Math.floor(v);
    let fx = u - i;
    let fy = v - j;
    // Particles in the outer half-cell go entirely to the border cell (mass stays in the box).
    if (i < 0) {
      i = 0;
      fx = 0;
    } else if (i >= nx - 1) {
      i = nx - 1;
      fx = 0;
    }
    if (j < 0) {
      j = 0;
      fy = 0;
    } else if (j >= ny - 1) {
      j = ny - 1;
      fy = 0;
    }
    const k = j * nx + i;
    const w00 = (1 - fx) * (1 - fy);
    out[k] += w00;
    if (fx > 0) out[k + 1] += fx * (1 - fy);
    if (fy > 0) {
      out[k + nx] += (1 - fx) * fy;
      if (fx > 0) out[k + nx + 1] += fx * fy;
    }
  }
  return inside;
}

/**
 * Convolves cell masses with the Gaussian kernel (std `h`, world units) and normalises them to
 * probabilities on the box. Mass blurred across the border is dropped before normalising, which
 * is exactly the restriction of ρ̂_h to B. Returns false if nothing is left.
 */
export function smoothAndNormalise(grid: AnalysisGrid, mass: Float32Array, h: number): boolean {
  const sigmaCells = h / grid.cell;
  if (sigmaCells > 0.05) gaussianBlur(mass, grid.nx, grid.ny, sigmaCells);
  const n = grid.nx * grid.ny;
  let total = 0;
  for (let c = 0; c < n; c++) total += mass[c];
  if (!(total > 0)) return false;
  const inv = 1 / total;
  for (let c = 0; c < n; c++) mass[c] *= inv;
  return true;
}

/** KL(p ‖ q) = Σ p log(p / q) for cell probabilities p and log-probabilities log q (0·log 0 = 0). */
export function klDivergence(p: Float32Array, logQ: Float64Array, n: number): number {
  let kl = 0;
  for (let c = 0; c < n; c++) {
    const pc = p[c];
    if (pc > 0) kl += pc * (Math.log(pc) - logQ[c]);
  }
  // Exact arithmetic gives KL ≥ 0; rounding can produce a tiny negative number.
  return Math.max(0, kl);
}
