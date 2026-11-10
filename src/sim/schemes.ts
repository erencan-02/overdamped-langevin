import type { Rng } from './rng';

/**
 * Numerical schemes for the overdamped Langevin SDE with additive noise
 *
 *     dX_t = −∇Ψ(t, X_t) dt + σ dW_t ,   X_t ∈ ℝ².
 *
 * A scheme advances a whole ensemble by one step. It only needs the drift (through
 * `DriftField.gradient`) and a source of Gaussian increments, so schemes are independent of
 * how Ψ is stored and can be tested against analytic potentials.
 */

/** Anything that can evaluate ∇Ψ (the painted field, a formula, or an analytic test potential). */
export interface DriftField {
  /** Writes ∇Ψ(x, y) into out[0], out[1] (at the current time). */
  gradient(x: number, y: number, out: Float64Array): void;
  /**
   * Optional batch form, for drifts that are cheaper to evaluate for many points at once (and
   * may depend on time): ∇Ψ(t, xs[i], ys[i]) for i < n into gx[i], gy[i]. When present, the
   * schemes use it; the random numbers are drawn in the same order either way.
   */
  gradientBatch?(
    xs: Float64Array,
    ys: Float64Array,
    n: number,
    t: number,
    gx: Float64Array,
    gy: Float64Array,
  ): void;
}

/** Reusable per-particle work arrays of a scheme (grown on demand). */
class Scratch {
  private arrays: Float64Array[] = [];
  constructor(private readonly count: number) {}
  get(n: number): Float64Array[] {
    if (!this.arrays.length || this.arrays[0].length < n) {
      this.arrays = Array.from({ length: this.count }, () => new Float64Array(Math.max(n, 64)));
    }
    return this.arrays;
  }
}

/** Positions of an ensemble of particles (structure of arrays). */
export interface Ensemble {
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly count: number;
}

export type SchemeId = 'heun' | 'euler-maruyama';

export interface Scheme {
  readonly id: SchemeId;
  /** Full name for the UI. */
  readonly name: string;
  /** Drift (∇Ψ) evaluations per particle and step, i.e. the relative cost of a step. */
  readonly driftEvals: number;
  /** One-line summary for the UI. */
  readonly summary: string;
  /** Advances every particle of the ensemble by one step of size dt, starting at time t. */
  step(ensemble: Ensemble, field: DriftField, dt: number, sigma: number, rng: Rng, t?: number): void;
}

/**
 * Euler–Maruyama:
 *
 *     Xₙ₊₁ = Xₙ − ∇Ψ(Xₙ) Δt + σ ΔW ,   ΔW ~ N(0, Δt·I)
 *
 * One drift evaluation per step. For additive noise it has strong order 1 and weak order 1;
 * its deterministic part is the explicit Euler method (first order).
 */
class EulerMaruyama implements Scheme {
  readonly id = 'euler-maruyama' as const;
  readonly name = 'Euler–Maruyama';
  readonly driftEvals = 1;
  readonly summary = '1 force evaluation per step · first order in the drift';
  private readonly g = new Float64Array(2);
  private readonly scratch = new Scratch(2);

  step(e: Ensemble, field: DriftField, dt: number, sigma: number, rng: Rng, t = 0): void {
    const { x, y } = e;
    const g = this.g;
    const noise = sigma * Math.sqrt(dt);
    if (field.gradientBatch) {
      const n = e.count;
      const [gx, gy] = this.scratch.get(n);
      field.gradientBatch(x, y, n, t, gx, gy);
      for (let i = 0; i < n; i++) {
        let nx = x[i] - gx[i] * dt;
        let ny = y[i] - gy[i] * dt;
        if (noise > 0) {
          nx += noise * rng.normal();
          ny += noise * rng.normal();
        }
        store(x, y, i, nx, ny);
      }
      return;
    }
    for (let i = 0, n = e.count; i < n; i++) {
      const xi = x[i];
      const yi = y[i];
      field.gradient(xi, yi, g);
      let nx = xi - g[0] * dt;
      let ny = yi - g[1] * dt;
      if (noise > 0) {
        nx += noise * rng.normal();
        ny += noise * rng.normal();
      }
      store(x, y, i, nx, ny);
    }
  }
}

/**
 * Stochastic Heun (predictor–corrector), with the same increment ΔW in both stages:
 *
 *     X̃    = Xₙ − ∇Ψ(Xₙ) Δt + σ ΔW
 *     Xₙ₊₁ = Xₙ − ½[∇Ψ(Xₙ) + ∇Ψ(X̃)] Δt + σ ΔW
 *
 * Two drift evaluations per step. For additive noise it has strong order 1 like
 * Euler–Maruyama, but its deterministic part is the second-order Heun method, so it is much
 * more accurate when the drift dominates the noise, and it is reported to have weak order 2
 * for additive noise (Greiner, Strittmatter & Honerkamp, 1988).
 */
class Heun implements Scheme {
  readonly id = 'heun' as const;
  readonly name = 'Stochastic Heun';
  readonly driftEvals = 2;
  readonly summary = '2 force evaluations per step · second order in the drift';
  private readonly g0 = new Float64Array(2);
  private readonly g1 = new Float64Array(2);
  private readonly scratch = new Scratch(8);

  step(e: Ensemble, field: DriftField, dt: number, sigma: number, rng: Rng, t = 0): void {
    const { x, y } = e;
    const { g0, g1 } = this;
    const noise = sigma * Math.sqrt(dt);
    const halfDt = 0.5 * dt;
    if (field.gradientBatch) {
      // Same formulas as below, one stage at a time for all particles: predictor at time t,
      // corrector with the drift at the predicted points at time t + dt.
      const n = e.count;
      const [ax, ay, bx, by, px, py, wx, wy] = this.scratch.get(n);
      field.gradientBatch(x, y, n, t, ax, ay);
      for (let i = 0; i < n; i++) {
        wx[i] = 0;
        wy[i] = 0;
        if (noise > 0) {
          wx[i] = noise * rng.normal();
          wy[i] = noise * rng.normal();
        }
        px[i] = x[i] - ax[i] * dt + wx[i];
        py[i] = y[i] - ay[i] * dt + wy[i];
      }
      field.gradientBatch(px, py, n, t + dt, bx, by);
      for (let i = 0; i < n; i++) {
        store(x, y, i, x[i] - (ax[i] + bx[i]) * halfDt + wx[i], y[i] - (ay[i] + by[i]) * halfDt + wy[i]);
      }
      return;
    }
    for (let i = 0, n = e.count; i < n; i++) {
      const xi = x[i];
      const yi = y[i];
      let wx = 0;
      let wy = 0;
      if (noise > 0) {
        wx = noise * rng.normal();
        wy = noise * rng.normal();
      }
      field.gradient(xi, yi, g0);
      const px = xi - g0[0] * dt + wx;
      const py = yi - g0[1] * dt + wy;
      field.gradient(px, py, g1);
      store(x, y, i, xi - (g0[0] + g1[0]) * halfDt + wx, yi - (g0[1] + g1[1]) * halfDt + wy);
    }
  }
}

/** Writes a new position, ignoring non-finite values (cannot happen for finite Ψ). */
function store(x: Float64Array, y: Float64Array, i: number, nx: number, ny: number): void {
  if (Number.isFinite(nx) && Number.isFinite(ny)) {
    x[i] = nx;
    y[i] = ny;
  }
}

export const SCHEMES: Readonly<Record<SchemeId, Scheme>> = {
  heun: new Heun(),
  'euler-maruyama': new EulerMaruyama(),
};

export const DEFAULT_SCHEME: SchemeId = 'heun';
