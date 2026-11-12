import type { PotentialSampler } from '../sim/potential';
import type { ParticleSystem } from '../sim/particles';
import {
  type AnalysisGrid,
  type Box,
  depositParticles,
  gibbsLogProbabilitiesOf,
  gridBox,
  klDivergence,
  makeGrid,
  smoothAndNormalise,
} from './kde';
import { TimeSeries } from './timeSeries';

/** Real-time interval between two estimates (10 Hz is plenty for a plot, and cheap). */
const INTERVAL_MS = 100;

export interface EquilibriumSample {
  /** KL(ρ̂_h ‖ π) on the box, or NaN if undefined (σ = 0 or no particle in the box). */
  kl: number;
  /** KL(π ∗ K_h ‖ π): the value perfect sampling would reach as N → ∞ (smoothing bias). */
  floor: number;
  inside: number;
  total: number;
  /** Kernel std in analysis cells (below ~0.75 the kernel is not resolved by the grid). */
  kernelCells: number;
  /** Kernel standard deviation h (world units). */
  h: number;
}

/**
 * Tracks the relative entropy between the Gaussian-smoothed empirical measure of the particles
 * and the Gibbs measure, both restricted to an analysis box, as a time series over the
 * simulated time.
 *
 * Work is minimised by caching: the grid depends only on (box, h); the Gibbs log-probabilities
 * only on (grid, Ψ revision, σ); the smoothing floor additionally on h. A new estimate costs one
 * cloud-in-cell deposit, one separable blur and one pass for the KL sum, and is taken at most
 * every 100 ms of real time, and only while the monitor is enabled.
 */
/** The smoothed empirical measure on its grid, for drawing. */
export interface DensityImage {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  nx: number;
  ny: number;
  /** Cell probabilities p_c (row 0 at y0), valid until the next update. */
  values: Float32Array;
  /** Incremented on every new estimate. */
  version: number;
}

export class EquilibriumMonitor {
  /** The KL window is open. */
  enabled = true;
  /** Keep estimating even while the window is closed (recording, density shown). */
  keepRunning = false;
  /**
   * The process is an overdamped Langevin equation, so the Gibbs measure is its invariant
   * measure (see ProcessCapabilities). Otherwise only the smoothed empirical measure is
   * estimated (for the density view) and KL is NaN.
   */
  gibbs = true;
  box: Box | null = null;
  /** KL over simulated time. */
  readonly series = new TimeSeries(['kl'] as const);
  latest: EquilibriumSample | null = null;

  private grid: AnalysisGrid | null = null;
  private gridKey = '';
  private logQ: Float64Array | null = null;
  private piKey = '';
  private floor = NaN;
  private floorKey = '';
  private mass = new Float32Array(0);
  private lastRun = -Infinity;
  private lastInputs = '';
  private densityValid = false;
  private densityVersion = 0;

  constructor(
    private readonly field: PotentialSampler,
    private readonly particles: ParticleSystem,
  ) {}

  /** Whether estimates are being taken. */
  get active(): boolean {
    return this.enabled || this.keepRunning;
  }

  /** The latest smoothed empirical measure, or null if there is none. */
  get density(): DensityImage | null {
    const g = this.grid;
    if (!g || !this.densityValid) return null;
    return {
      x0: g.x0,
      y0: g.y0,
      x1: g.x0 + g.nx * g.cell,
      y1: g.y0 + g.ny * g.cell,
      nx: g.nx,
      ny: g.ny,
      values: this.mass,
      version: this.densityVersion,
    };
  }

  setBox(box: Box): void {
    this.box = { ...box };
    this.reset();
  }

  /** Clears the time series (the next update starts a new one). */
  reset(): void {
    this.series.clear();
    this.latest = null;
    this.lastInputs = '';
  }

  /**
   * The analysis grid for this kernel variance (cached). Other analyses use it to work on
   * exactly the same region as the KL estimate.
   */
  analysisGrid(kernelVariance: number): AnalysisGrid | null {
    return this.box ? this.ensureGrid(Math.sqrt(kernelVariance)) : null;
  }

  /** The exact region the numbers refer to (the box snapped to the analysis grid). */
  get region(): Box | null {
    return this.grid ? gridBox(this.grid) : this.box;
  }

  /**
   * Takes a new estimate if enough real time has passed and something changed. Returns true
   * when a new sample was produced (so the plot needs redrawing).
   */
  update(nowMs: number, sigma: number, kernelVariance: number, intervalMs = INTERVAL_MS): boolean {
    if (!this.active || !this.box) return false;
    if (nowMs - this.lastRun < intervalMs) return false;
    const field = this.field;
    const ps = this.particles;
    const inputs = `${ps.version}|${field.revision}|${field.epoch}|${sigma}|${kernelVariance}|${this.gibbs}`;
    if (inputs === this.lastInputs) return false;
    this.lastRun = nowMs;
    this.lastInputs = inputs;

    const h = Math.sqrt(kernelVariance);
    const grid = this.ensureGrid(h);
    const n = grid.nx * grid.ny;
    const logQ = this.gibbs ? this.ensureGibbs(grid, sigma) : null;

    if (this.mass.length < n) this.mass = new Float32Array(n);
    const mass = this.mass;
    const inside = depositParticles(grid, ps.x, ps.y, ps.count, mass);
    let kl = NaN;
    this.densityValid = inside > 0 && smoothAndNormalise(grid, mass, h);
    this.densityVersion++;
    if (logQ && this.densityValid) kl = klDivergence(mass, logQ, n);
    const floor = logQ ? this.ensureFloor(grid, logQ, h) : NaN;

    this.latest = { kl, floor, inside, total: ps.count, kernelCells: h / grid.cell, h };
    this.series.push(ps.time, { kl });
    return true;
  }

  private ensureGrid(h: number): AnalysisGrid {
    const b = this.box!;
    const key = `${b.x0},${b.y0},${b.x1},${b.y1},${h}`;
    if (key !== this.gridKey || !this.grid) {
      this.grid = makeGrid(b, h);
      this.gridKey = key;
      this.piKey = '';
      this.floorKey = '';
    }
    return this.grid;
  }

  private ensureGibbs(grid: AnalysisGrid, sigma: number): Float64Array | null {
    const key = `${this.gridKey}|${this.field.revision}|${this.field.epoch}|${sigma}`;
    if (key !== this.piKey) {
      this.logQ = gibbsLogProbabilitiesOf(grid, this.field, sigma);
      this.piKey = key;
      this.floorKey = '';
    }
    return this.logQ;
  }

  /** KL(π ∗ K_h ‖ π) on the same grid, i.e. the bias caused by the smoothing alone. */
  private ensureFloor(grid: AnalysisGrid, logQ: Float64Array, h: number): number {
    const key = `${this.piKey}|${h}`;
    if (key !== this.floorKey) {
      const n = grid.nx * grid.ny;
      const q = new Float32Array(n);
      for (let c = 0; c < n; c++) q[c] = Math.exp(logQ[c]);
      this.floor = smoothAndNormalise(grid, q, h) ? klDivergence(q, logQ, n) : NaN;
      this.floorKey = key;
    }
    return this.floor;
  }
}
