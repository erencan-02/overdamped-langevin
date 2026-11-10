import type { CompiledPotential } from '../analysis/latex';
import { PotentialField } from './field';
import type { DriftField } from './schemes';

/** Ψ as the analysis code sees it: values at points, and counters that change when Ψ changes. */
export interface PotentialSampler {
  /** Ψ(x, y) now. */
  sample(x: number, y: number): number;
  /** Ψ at n points into `out` (faster than `sample` for many points). */
  samplePoints(xs: Float64Array, ys: Float64Array, n: number, out: Float64Array): void;
  /** Changes whenever the values of Ψ change (with `epoch`, a cache key). */
  readonly revision: number;
  readonly epoch: number;
}

/** World rectangle. */
interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** The display copy of a formula is sampled with at most this many points along the longer side. */
const RASTER_SAMPLES = 220;
/** It covers the view plus this fraction of its size on each side (the 3D view shows +35 %). */
const RASTER_MARGIN = 0.6;
/** A time-dependent Ψ is redrawn at most this often (real time). */
const RASTER_INTERVAL_MS = 40;

/**
 * The potential of the simulation: either the painted lattice (`PotentialField`, brush, images,
 * camera) or a formula Ψ(t, x, y) typed in LaTeX, with its exact, symbolically derived gradient.
 *
 * With a formula there is no lattice and no cap in the dynamics or the analysis: the integrator
 * gets ∇Ψ at the exact particle positions and times (`drift`), and the analysis samples Ψ
 * exactly. Only the pictures (heat map, contours, 3D relief) use a lattice: `display`, into which
 * the formula is drawn around the current view (and redrawn as time passes when Ψ depends on t).
 * Its colour scale saturates at |Ψ| = cap like the painted field's.
 *
 * The painted lattice is kept while a formula is used, and comes back when the formula is turned off.
 */
export class Potential implements PotentialSampler {
  /** Lattice that shows the formula (display only: no gradients are kept). */
  readonly raster: PotentialField;
  private formula: CompiledPotential | null = null;
  /** Counts formula changes, so cache keys never repeat across formulas. */
  private formulaVersion = 0;
  /** Changes when a formula's values change (time or σ, if it depends on them). */
  private formulaRevision = 0;
  private t = 0;
  private sigma = 0;
  private readonly one = { x: new Float64Array(1), y: new Float64Array(1), v: new Float64Array(1) };
  private rasterKey = '';
  private rasterAt = -Infinity;
  private rasterRegion: Rect | null = null;

  /** The drift −∇Ψ for the integrator: the painted lattice, or the formula's exact gradient. */
  readonly formulaDrift: DriftField;

  constructor(readonly lattice: PotentialField) {
    this.raster = new PotentialField({ cellSize: lattice.h, cap: lattice.cap, gradients: false });
    const g = { x: new Float64Array(1), y: new Float64Array(1), gx: new Float64Array(1), gy: new Float64Array(1) };
    this.formulaDrift = {
      gradient: (x, y, out) => {
        g.x[0] = x;
        g.y[0] = y;
        this.formula?.gradient(g.x, g.y, 1, this.t, this.sigma, g.gx, g.gy);
        out[0] = g.gx[0];
        out[1] = g.gy[0];
      },
      gradientBatch: (xs, ys, n, t, gx, gy) => this.formula?.gradient(xs, ys, n, t, this.sigma, gx, gy),
    };
  }

  /** A formula is in use. */
  get analytic(): boolean {
    return this.formula !== null;
  }

  /** The formula in use (null: the painted lattice). */
  get compiled(): CompiledPotential | null {
    return this.formula;
  }

  get timeDependent(): boolean {
    return this.formula?.timeDependent ?? false;
  }

  /** The drift for the integrator. */
  get drift(): DriftField {
    return this.formula ? this.formulaDrift : this.lattice;
  }

  /** The lattice to draw (heat map, contours, 3D relief). */
  get display(): PotentialField {
    return this.formula ? this.raster : this.lattice;
  }

  /** Uses `formula` from now on (null: back to the painted lattice). */
  setFormula(formula: CompiledPotential | null): void {
    this.formula = formula;
    this.formulaVersion++;
    this.formulaRevision = 0;
    this.rasterKey = '';
    this.rasterRegion = null;
    this.raster.clear();
  }

  /** Current simulated time and σ (call every frame): a formula depending on them changes value. */
  setTime(t: number, sigma: number): void {
    const f = this.formula;
    if (f && ((f.timeDependent && t !== this.t) || (f.usesSigma && sigma !== this.sigma))) this.formulaRevision++;
    this.t = t;
    this.sigma = sigma;
  }

  get revision(): number {
    return this.formula ? this.formulaRevision : this.lattice.revision;
  }

  /** Negative for formulas, so their cache keys never coincide with the lattice's. */
  get epoch(): number {
    return this.formula ? -this.formulaVersion : this.lattice.epoch;
  }

  sample(x: number, y: number): number {
    if (!this.formula) return this.lattice.sample(x, y);
    const o = this.one;
    o.x[0] = x;
    o.y[0] = y;
    this.formula.value(o.x, o.y, 1, this.t, this.sigma, o.v);
    return o.v[0];
  }

  samplePoints(xs: Float64Array, ys: Float64Array, n: number, out: Float64Array): void {
    if (this.formula) {
      this.formula.value(xs, ys, n, this.t, this.sigma, out);
      return;
    }
    for (let i = 0; i < n; i++) out[i] = this.lattice.sample(xs[i], ys[i]);
  }

  /**
   * Draws the formula into the display lattice around `view` when needed: after a change of
   * formula, when the view leaves the drawn area or zooms, and (at most every
   * RASTER_INTERVAL_MS) when a time-dependent Ψ has moved on.
   */
  updateDisplay(view: Rect, nowMs: number): void {
    const f = this.formula;
    if (!f) return;
    const r = this.rasterRegion;
    const w = view.x1 - view.x0;
    const h = view.y1 - view.y0;
    const covered =
      r !== null &&
      view.x0 >= r.x0 &&
      view.x1 <= r.x1 &&
      view.y0 >= r.y0 &&
      view.y1 <= r.y1 &&
      // Re-sample when zoomed in a lot (finer detail) or out (more area).
      (r.x1 - r.x0) / w < 4 &&
      (r.x1 - r.x0) / w > 1.5;
    const key = `${this.formulaVersion}|${this.formulaRevision}`;
    if (covered && key === this.rasterKey) return;
    if (covered && nowMs - this.rasterAt < RASTER_INTERVAL_MS) return; // only time moved on: throttle
    const region = covered
      ? r!
      : { x0: view.x0 - RASTER_MARGIN * w, y0: view.y0 - RASTER_MARGIN * h, x1: view.x1 + RASTER_MARGIN * w, y1: view.y1 + RASTER_MARGIN * h };
    if (!covered) this.raster.clear(); // drop what was drawn elsewhere
    this.rasterRegion = region;
    this.rasterKey = key;
    this.rasterAt = nowMs;
    // Sample on a grid with spacing ≥ the lattice's, then let the lattice interpolate.
    const long = Math.max(region.x1 - region.x0, region.y1 - region.y0);
    const cell = Math.max(long / (RASTER_SAMPLES - 1), this.raster.h);
    const W = Math.max(2, Math.ceil((region.x1 - region.x0) / cell) + 1);
    const H = Math.max(2, Math.ceil((region.y1 - region.y0) / cell) + 1);
    const n = W * H;
    const xs = new Float64Array(n);
    const ys = new Float64Array(n);
    for (let j = 0; j < H; j++) {
      // Row 0 is the top (writeGrid's convention).
      const y = region.y1 - j * cell;
      for (let i = 0; i < W; i++) {
        xs[j * W + i] = region.x0 + i * cell;
        ys[j * W + i] = y;
      }
    }
    const values = new Float64Array(n);
    f.value(xs, ys, n, this.t, this.sigma, values);
    const grid = new Float32Array(n);
    for (let k = 0; k < n; k++) grid[k] = Number.isFinite(values[k]) ? values[k] : 0;
    this.raster.writeGrid(grid, W, H, region.x0, region.y1, cell);
  }
}
