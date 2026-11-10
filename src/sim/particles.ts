import { Rng } from './rng';
import { DEFAULT_SCHEME, type DriftField, SCHEMES, type Scheme } from './schemes';

export const MAX_PARTICLES = 2000;
/** Number of stored trail points per particle. */
export const TRAIL_LEN = 40;
/** Simulated time between two stored trail points. */
export const TRAIL_DT = 1 / 50;
/** Largest internal time step of the integrator. */
export const DEFAULT_DT_MAX = 1 / 500;
/**
 * Largest step the integrator will ever take. If the work budget cannot afford steps this
 * small, the simulation runs slower than requested rather than becoming inaccurate.
 */
export const DT_LIMIT = 1 / 100;
/** Upper bound on sub-steps per frame so a frame can never stall the UI. */
const MAX_SUBSTEPS = 160;
/**
 * Upper bound on drift evaluations per `advance` call. With very many particles at high speed
 * the step size grows beyond dtMax (up to DT_LIMIT) instead of stalling the frame. Both schemes
 * stay stable for Δt·max|∇²Ψ| < 2, which holds by a wide margin for the brush sizes the UI allows.
 */
export const DEFAULT_WORK_BUDGET = 80_000;

/**
 * Ensemble of independent particles following the overdamped Langevin SDE
 *
 *     dX_t = −∇Ψ(X_t) dt + σ dW_t ,   X_t ∈ ℝ²
 *
 * The particle system owns the state (positions, colours, trails) and the time stepping
 * (sub-steps, work budget, trail recording); the numerical scheme that performs a single step
 * is pluggable (see `schemes.ts`) and can be switched at any time.
 */
export class ParticleSystem {
  readonly x = new Float64Array(MAX_PARTICLES);
  readonly y = new Float64Array(MAX_PARTICLES);
  /** Palette index of each particle. */
  readonly color = new Uint8Array(MAX_PARTICLES);
  /**
   * Stable identity of each particle. Indices change when particles are removed (the last one
   * moves into the gap), ids never do, so recordings can follow every particle through a run.
   */
  readonly id = new Uint32Array(MAX_PARTICLES);
  /** Id that the next added particle receives. */
  nextId = 0;
  /** Ring buffers of past positions, TRAIL_LEN (x, y) slots per particle. */
  readonly trail = new Float32Array(MAX_PARTICLES * TRAIL_LEN * 2);
  /** Number of valid trail slots per particle. */
  readonly trailCount = new Uint16Array(MAX_PARTICLES);
  /** Slot that holds the most recent trail point (shared by all particles). */
  trailHead = 0;
  /** Number of trail recordings so far (each one writes slot `trailHead` of every particle). */
  trailWrites = 0;
  /**
   * Incremented when existing trail rows change other than by a recording (removal, reset),
   * telling the renderer to re-upload the whole ring buffer.
   */
  trailLayout = 0;

  count = 0;
  /** Simulated time. */
  time = 0;
  /** Incremented whenever positions or membership change (lets the renderer skip uploads). */
  version = 0;

  /** Numerical scheme used by `step` and `advance`. */
  scheme: Scheme;

  private trailClock = 0;

  constructor(
    readonly rng: Rng = new Rng(),
    scheme: Scheme = SCHEMES[DEFAULT_SCHEME],
  ) {
    this.scheme = scheme;
  }

  get full(): boolean {
    return this.count >= MAX_PARTICLES;
  }

  add(x: number, y: number, color: number): boolean {
    if (this.count >= MAX_PARTICLES) return false;
    const i = this.count++;
    this.x[i] = x;
    this.y[i] = y;
    this.color[i] = color;
    this.id[i] = this.nextId++;
    this.trailCount[i] = 0;
    this.version++;
    return true;
  }

  /** Removes particle i in O(TRAIL_LEN) by moving the last particle into its place. */
  removeAt(i: number): void {
    if (i < 0 || i >= this.count) return;
    const last = --this.count;
    if (i !== last) {
      this.x[i] = this.x[last];
      this.y[i] = this.y[last];
      this.color[i] = this.color[last];
      this.id[i] = this.id[last];
      this.trailCount[i] = this.trailCount[last];
      const n = TRAIL_LEN * 2;
      this.trail.copyWithin(i * n, last * n, last * n + n);
      this.trailLayout++;
    }
    this.version++;
  }

  /** Index of the particle closest to (x, y) within maxDist, or −1. */
  nearest(x: number, y: number, maxDist: number): number {
    let best = -1;
    let bestD2 = maxDist * maxDist;
    for (let i = 0; i < this.count; i++) {
      const dx = this.x[i] - x;
      const dy = this.y[i] - y;
      const d2 = dx * dx + dy * dy;
      if (d2 <= bestD2) {
        bestD2 = d2;
        best = i;
      }
    }
    return best;
  }

  clear(): void {
    this.count = 0;
    this.version++;
  }

  clearTrails(): void {
    this.trailCount.fill(0);
    this.trailLayout++;
    this.version++;
  }

  /**
   * Advances the ensemble by simulated time T using sub-steps no longer than dtMax, doing at
   * most `workBudget` drift evaluations. Returns the simulated time actually advanced (less
   * than T only if the budget would force steps above DT_LIMIT).
   */
  advance(
    field: DriftField,
    T: number,
    sigma: number,
    dtMax = DEFAULT_DT_MAX,
    workBudget = DEFAULT_WORK_BUDGET,
  ): number {
    if (!(T > 0)) return 0;
    const costPerStep = Math.max(1, this.count) * this.scheme.driftEvals;
    const affordable = Math.floor(workBudget / costPerStep);
    const n = Math.max(1, Math.min(MAX_SUBSTEPS, affordable, Math.ceil(T / dtMax)));
    if (T / n > DT_LIMIT) T = n * DT_LIMIT;
    const dt = T / n;
    for (let s = 0; s < n; s++) {
      this.step(field, dt, sigma);
      this.trailClock += dt;
      if (this.trailClock >= TRAIL_DT) {
        this.trailClock -= TRAIL_DT;
        if (this.trailClock >= TRAIL_DT) this.trailClock = 0;
        this.recordTrail();
      }
    }
    this.time += T;
    this.lastSubsteps = n;
    return T;
  }

  /** Number of sub-steps taken by the last `advance` call. */
  lastSubsteps = 0;

  /** Drift evaluations performed by the last `advance` call (for adaptive work budgets). */
  get lastWork(): number {
    return this.lastSubsteps * this.count * this.scheme.driftEvals;
  }

  /** One step of size dt for every particle, using the current scheme. */
  step(field: DriftField, dt: number, sigma: number): void {
    this.scheme.step(this, field, dt, sigma, this.rng);
    this.version++;
  }

  private recordTrail(): void {
    const head = (this.trailHead + 1) % TRAIL_LEN;
    this.trailHead = head;
    this.trailWrites++;
    const { x, y, trail, trailCount } = this;
    for (let i = 0, n = this.count; i < n; i++) {
      const k = (i * TRAIL_LEN + head) * 2;
      trail[k] = x[i];
      trail[k + 1] = y[i];
      if (trailCount[i] < TRAIL_LEN) trailCount[i]++;
    }
  }
}
