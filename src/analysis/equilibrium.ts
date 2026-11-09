import type { PotentialField } from '../sim/field';
import type { ParticleSystem } from '../sim/particles';
import {
  type AnalysisGrid,
  type Box,
  depositParticles,
  gibbsLogProbabilities,
  gridBox,
  klDivergence,
  makeGrid,
  smoothAndNormalise,
} from './kde';

/** Real-time interval between two estimates (10 Hz is plenty for a plot, and cheap). */
const INTERVAL_MS = 100;
/** History length; when full, every other point is dropped (the whole run stays visible). */
const MAX_POINTS = 1200;

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
export class EquilibriumMonitor {
  enabled = true;
  box: Box | null = null;
  readonly times: number[] = [];
  readonly values: number[] = [];
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

  constructor(
    private readonly field: PotentialField,
    private readonly particles: ParticleSystem,
  ) {}

  setBox(box: Box): void {
    this.box = { ...box };
    this.reset();
  }

  /** Clears the time series (the next update starts a new one). */
  reset(): void {
    this.times.length = 0;
    this.values.length = 0;
    this.latest = null;
    this.lastInputs = '';
  }

  /** The exact region the numbers refer to (the box snapped to the analysis grid). */
  get region(): Box | null {
    return this.grid ? gridBox(this.grid) : this.box;
  }

  /**
   * Takes a new estimate if enough real time has passed and something changed. Returns true
   * when a new sample was produced (so the plot needs redrawing).
   */
  update(nowMs: number, sigma: number, kernelVariance: number): boolean {
    if (!this.enabled || !this.box) return false;
    if (nowMs - this.lastRun < INTERVAL_MS) return false;
    const field = this.field;
    const ps = this.particles;
    const inputs = `${ps.version}|${field.revision}|${field.epoch}|${sigma}|${kernelVariance}`;
    if (inputs === this.lastInputs) return false;
    this.lastRun = nowMs;
    this.lastInputs = inputs;

    const h = Math.sqrt(kernelVariance);
    const grid = this.ensureGrid(h);
    const n = grid.nx * grid.ny;
    const logQ = this.ensureGibbs(grid, sigma);

    if (this.mass.length < n) this.mass = new Float32Array(n);
    const mass = this.mass;
    const inside = depositParticles(grid, ps.x, ps.y, ps.count, mass);
    let kl = NaN;
    if (logQ && inside > 0 && smoothAndNormalise(grid, mass, h)) kl = klDivergence(mass, logQ, n);
    const floor = logQ ? this.ensureFloor(grid, logQ, h) : NaN;

    this.latest = { kl, floor, inside, total: ps.count, kernelCells: h / grid.cell, h };
    this.record(ps.time, kl);
    return true;
  }

  private record(t: number, kl: number): void {
    const n = this.times.length;
    if (n > 0 && t <= this.times[n - 1]) {
      // Paused (or nothing advanced): update the current point instead of adding one.
      this.values[n - 1] = kl;
      return;
    }
    this.times.push(t);
    this.values.push(kl);
    if (this.times.length > MAX_POINTS) {
      let w = 0;
      for (let r = 0; r < this.times.length; r += 2) {
        this.times[w] = this.times[r];
        this.values[w] = this.values[r];
        w++;
      }
      this.times.length = w;
      this.values.length = w;
    }
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
      const field = this.field;
      this.logQ = gibbsLogProbabilities(grid, (x, y) => field.sample(x, y), sigma);
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
