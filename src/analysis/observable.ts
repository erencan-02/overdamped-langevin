import type { PotentialSampler } from '../sim/potential';
import type { ParticleSystem } from '../sim/particles';
import type { EquilibriumMonitor } from './equilibrium';
import { type AnalysisGrid, gibbsLogProbabilitiesOf, gridBox } from './kde';
import type { CompiledObservable, EvalContext } from './latex';
import { TimeSeries } from './timeSeries';

/** Real-time interval between two estimates. */
const INTERVAL_MS = 100;
/** The exact integral uses a refinement of the KL grid with at least this many cells per side. */
const EXACT_CELLS = 256;
/**
 * While Ψ keeps changing (painting, live camera), the exact value is recomputed at most this
 * often, or less often if one computation is slow: the gap is at least EXACT_COST_FACTOR times
 * its cost, so it takes at most ~1/EXACT_COST_FACTOR of the time and the brush stays smooth.
 */
const EXACT_MIN_GAP_MS = 250;
const EXACT_COST_FACTOR = 4;
/** Two-sided 95 % normal quantile. */
const Z95 = 1.959963984540054;

export interface ObservableSample {
  /** Sample mean of f over the particles in the box (NaN if none). */
  mean: number;
  /** Half width of the 95 % confidence interval of the mean (NaN with fewer than 2 particles). */
  ci: number;
  /** ∫ f dπ_B, the Gibbs expectation on the box (NaN if undefined). */
  exact: number;
  /**
   * `exact` belongs to an earlier Ψ: Ψ is changing faster than the exact value is recomputed.
   * It catches up at most EXACT_MIN_GAP_MS (or a few computation times) after Ψ settles.
   */
  exactStale: boolean;
  /** Particles in the box at which f is defined, and all particles. */
  inside: number;
  total: number;
  /** Particles in the box at which f is not a finite number (left out of the mean). */
  undefinedAt: number;
}

/**
 * Weak-convergence monitor: for a test function f, tracks the empirical expectation
 * E[f(X_t) | X_t ∈ B] ≈ (1/n) Σ f(X_i) over the particles in the analysis box B, with a 95 %
 * confidence interval from the central limit theorem (the particles are independent), against
 * the exact Gibbs expectation ∫_B f dπ_B. The bias |E f(X_t) − ∫ f dπ| as t → ∞ is the
 * quantity that the weak order of a scheme describes (it is O(Δt^p) for a scheme of weak order p).
 *
 * B is exactly the KL region, so both analyses describe the same conditional measures. The
 * exact value is a midpoint sum over a refinement of the KL grid with the same Gibbs cell
 * probabilities, cached until f, Ψ, σ or the box change. While Ψ is being painted it is
 * recomputed at a limited rate (see EXACT_MIN_GAP_MS) and flagged as stale in between.
 */
export class ObservableMonitor {
  /** The observables window is open. */
  enabled = false;
  /** Keep estimating while the window is closed (recording). */
  keepRunning = false;
  readonly series = new TimeSeries(['mean', 'lo', 'hi', 'exact'] as const);
  latest: ObservableSample | null = null;

  private fn: CompiledObservable | null = null;
  /** Scratch columns: positions of the particles inside the box. */
  private xs = new Float64Array(0);
  private ys = new Float64Array(0);
  private fnVersion = 0;
  private lastRun = -Infinity;
  private lastInputs = '';
  private boxKey = '';
  private exact = NaN;
  /** Inputs of `exact` other than the Ψ revision; a change here always recomputes at once. */
  private exactKey = '';
  /** Ψ revision of `exact`. */
  private exactRevision = -1;
  private exactAt = -Infinity;
  private exactCostMs = 0;
  private exactStale = false;
  private readonly ctx: EvalContext;
  private sigma = 0;

  constructor(
    private readonly field: PotentialSampler,
    private readonly particles: ParticleSystem,
    private readonly equilibrium: EquilibriumMonitor,
  ) {
    this.ctx = {
      sigma: 0,
      psi: (x, y) => this.field.sample(x, y),
    };
  }

  /** σ of the latest estimate is (practically) zero, where π has no density. */
  get sigmaIsZero(): boolean {
    return !(this.sigma > 1e-6);
  }

  get active(): boolean {
    return (this.enabled || this.keepRunning) && this.fn !== null;
  }

  /** Sets the test function (null: none); the time series starts over. */
  setFunction(fn: CompiledObservable | null): void {
    this.fn = fn;
    this.fnVersion++;
    this.exactKey = '';
    this.exactStale = false;
    this.reset();
  }

  reset(): void {
    this.series.clear();
    this.latest = null;
    this.lastInputs = '';
  }

  /** Takes a new estimate if due and something changed; true if there is a new sample. */
  update(nowMs: number, sigma: number, kernelVariance: number, intervalMs = INTERVAL_MS): boolean {
    const f = this.fn;
    if (!this.active || !f) return false;
    if (nowMs - this.lastRun < intervalMs) return false;
    const grid = this.equilibrium.analysisGrid(kernelVariance);
    if (!grid) return false;
    const field = this.field;
    const ps = this.particles;
    const gridKey = `${grid.x0},${grid.y0},${grid.cell},${grid.nx},${grid.ny}`;
    const inputs = `${ps.version}|${field.revision}|${field.epoch}|${sigma}|${gridKey}|${this.fnVersion}`;
    // A stale exact value is retried even when nothing else changed.
    if (inputs === this.lastInputs && !this.exactStale) return false;
    // A different box (not just a re-snapped grid after changing h) starts a new curve.
    const b = this.equilibrium.box!;
    const boxKey = `${b.x0},${b.y0},${b.x1},${b.y1}`;
    if (boxKey !== this.boxKey) {
      this.series.clear();
      this.boxKey = boxKey;
    }
    this.lastRun = nowMs;
    this.lastInputs = inputs;
    this.ctx.sigma = sigma;
    this.sigma = sigma;

    // f at the particles in B, evaluated in one batch.
    const box = gridBox(grid);
    if (this.xs.length < ps.count) {
      this.xs = new Float64Array(ps.x.length);
      this.ys = new Float64Array(this.xs.length);
    }
    let inBox = 0;
    for (let p = 0; p < ps.count; p++) {
      const x = ps.x[p];
      const y = ps.y[p];
      if (!(x >= box.x0 && x < box.x1 && y >= box.y0 && y < box.y1)) continue;
      this.xs[inBox] = x;
      this.ys[inBox] = y;
      inBox++;
    }
    const values = f.evaluate(this.xs, this.ys, inBox, this.ctx);

    // Mean and variance (Welford: stable for large means).
    let n = 0;
    let undefinedAt = 0;
    let mean = 0;
    let m2 = 0;
    for (let k = 0; k < inBox; k++) {
      const v = values[k];
      if (!Number.isFinite(v)) {
        undefinedAt++;
        continue;
      }
      n++;
      const d = v - mean;
      mean += d / n;
      m2 += d * (v - mean);
    }
    const m = n > 0 ? mean : NaN;
    const ci = n > 1 ? (Z95 * Math.sqrt(m2 / (n - 1))) / Math.sqrt(n) : NaN;
    const exact = this.ensureExact(grid, gridKey, f, nowMs);

    this.latest = { mean: m, ci, exact, exactStale: this.exactStale, inside: n, total: ps.count, undefinedAt };
    this.series.push(ps.time, { mean: m, lo: m - ci, hi: m + ci, exact });
    return true;
  }

  /**
   * The exact value for the current inputs. A new f, σ, box, kernel grid or a replaced Ψ
   * (epoch) is computed at once; a Ψ that is being edited (revision) at a limited rate.
   */
  private ensureExact(grid: AnalysisGrid, gridKey: string, f: CompiledObservable, nowMs: number): number {
    const key = `${gridKey}|${this.field.epoch}|${this.sigma}|${this.fnVersion}`;
    const revision = this.field.revision;
    if (key === this.exactKey && revision === this.exactRevision) {
      this.exactStale = false;
      return this.exact;
    }
    const gap = Math.max(EXACT_MIN_GAP_MS, EXACT_COST_FACTOR * this.exactCostMs);
    if (key === this.exactKey && nowMs - this.exactAt < gap) {
      this.exactStale = true; // only Ψ was edited, and recently: keep the previous value for now
      return this.exact;
    }
    const t0 = performance.now();
    this.exact = exactExpectation(grid, f, this.field, this.ctx);
    this.exactCostMs = performance.now() - t0;
    this.exactKey = key;
    this.exactRevision = revision;
    this.exactAt = nowMs;
    this.exactStale = false;
    return this.exact;
  }
}

/**
 * ∫_B f dπ_B for the box covered by `grid`, as a midpoint sum over a refinement of the grid
 * (each cell split into m × m, m chosen so the longer side has ≥ EXACT_CELLS cells). The region
 * is exactly the same. NaN if σ = 0 (π has no density) or f is not finite where π has mass.
 */
export function exactExpectation(
  grid: AnalysisGrid,
  f: CompiledObservable,
  field: Pick<PotentialSampler, 'samplePoints'>,
  ctx: EvalContext,
): number {
  const m = Math.max(1, Math.ceil(EXACT_CELLS / Math.max(grid.nx, grid.ny)));
  const fine: AnalysisGrid = { x0: grid.x0, y0: grid.y0, cell: grid.cell / m, nx: grid.nx * m, ny: grid.ny * m };
  const n = fine.nx * fine.ny;
  const psiAt = new Float64Array(n); // Ψ at the cells: sampled once, for π and for f
  const logQ = gibbsLogProbabilitiesOf(fine, field, ctx.sigma, psiAt);
  if (!logQ) return NaN;
  // f at the cells that carry mass, in one batch.
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  const psi = new Float64Array(n);
  const q = new Float64Array(n);
  let used = 0;
  for (let j = 0; j < fine.ny; j++) {
    const y = fine.y0 + (j + 0.5) * fine.cell;
    for (let i = 0; i < fine.nx; i++) {
      const qc = Math.exp(logQ[j * fine.nx + i]);
      if (qc === 0) continue;
      xs[used] = fine.x0 + (i + 0.5) * fine.cell;
      ys[used] = y;
      psi[used] = psiAt[j * fine.nx + i];
      q[used] = qc;
      used++;
    }
  }
  const values = f.evaluate(xs, ys, used, ctx, psi);
  // Kahan summation: up to ~10^5 terms of very different sizes.
  let sum = 0;
  let comp = 0;
  for (let k = 0; k < used; k++) {
    const v = values[k];
    if (!Number.isFinite(v)) return NaN;
    const term = q[k] * v - comp;
    const t = sum + term;
    comp = t - sum - term;
    sum = t;
  }
  return sum;
}
