import type { NormalSource, Process } from './process';

/**
 * Numerical schemes for an Itô SDE in ℝ² with diagonal noise (see process.ts),
 *
 *     dX_t = b(t, X_t) dt + diag(s₁, s₂)(t, X_t) dW_t .
 *
 * A scheme advances a whole ensemble by one step. It only sees the process through its batched
 * drift and diffusion, so schemes are independent of how the coefficients are given (painted
 * lattice, formulas, analytic test processes). Random numbers are drawn per particle, x before
 * y, in particle order (none at all for a deterministic process), so a run depends only on the
 * seed, and coupled runs (the same Brownian path at several step sizes) are easy to set up.
 */

export type { DriftField, NormalSource, Process } from './process';

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

export type SchemeId = 'heun' | 'euler-maruyama' | 'milstein';

export interface Scheme {
  readonly id: SchemeId;
  /** Full name for the UI. */
  readonly name: string;
  /** Short name for buttons and plot legends. */
  readonly short: string;
  /** Drift evaluations per particle and step, i.e. the relative cost of a step. */
  readonly driftEvals: number;
  /** One-line summary for the UI. */
  readonly summary: string;
  /** Advances every particle of the ensemble by one step of size dt, starting at time t. */
  step(ensemble: Ensemble, process: Process, dt: number, rng: NormalSource, t?: number): void;
}

/**
 * Euler–Maruyama:
 *
 *     Xₙ₊₁ = Xₙ + b(tₙ, Xₙ) Δt + s(tₙ, Xₙ) ΔW ,   ΔW ~ N(0, Δt·I)
 *
 * One drift evaluation per step. Strong order ½ in general and 1 for additive noise; weak
 * order 1.
 */
class EulerMaruyama implements Scheme {
  readonly id = 'euler-maruyama' as const;
  readonly name = 'Euler–Maruyama';
  readonly short = 'EM';
  readonly driftEvals = 1;
  readonly summary = '1 drift evaluation per step · strong order ½ (1 for additive noise)';
  private readonly scratch = new Scratch(4);

  step(e: Ensemble, p: Process, dt: number, rng: NormalSource, t = 0): void {
    const { x, y } = e;
    const n = e.count;
    const [bx, by, s1, s2] = this.scratch.get(n);
    p.drift(x, y, n, t, bx, by);
    const noisy = !p.deterministic;
    if (noisy) p.diffusion(x, y, n, t, s1, s2, null, null);
    const sq = Math.sqrt(dt);
    for (let i = 0; i < n; i++) {
      let nx = x[i] + bx[i] * dt;
      let ny = y[i] + by[i] * dt;
      if (noisy) {
        nx += s1[i] * sq * rng.normal();
        ny += s2[i] * sq * rng.normal();
      }
      store(x, y, i, nx, ny);
    }
  }
}

/**
 * Stochastic Heun for the drift (predictor–corrector), with the Itô noise term of
 * Euler–Maruyama and the same increment ΔW in both stages:
 *
 *     X̃    = Xₙ + b(tₙ, Xₙ) Δt + s(tₙ, Xₙ) ΔW
 *     Xₙ₊₁ = Xₙ + ½[b(tₙ, Xₙ) + b(tₙ₊₁, X̃)] Δt + s(tₙ, Xₙ) ΔW
 *
 * Two drift evaluations per step. With additive noise it has strong order 1 like
 * Euler–Maruyama, but its deterministic part is the second-order Heun method, so it is much
 * more accurate when the drift dominates the noise (weak order 2 for additive noise; Greiner,
 * Strittmatter & Honerkamp, 1988). The noise is evaluated at the start of the step only, so
 * with multiplicative noise it still converges to the Itô solution (strong order ½).
 */
class Heun implements Scheme {
  readonly id = 'heun' as const;
  readonly name = 'Stochastic Heun';
  readonly short = 'Heun';
  readonly driftEvals = 2;
  readonly summary = '2 drift evaluations per step · second order in the drift';
  private readonly scratch = new Scratch(10);

  step(e: Ensemble, p: Process, dt: number, rng: NormalSource, t = 0): void {
    const { x, y } = e;
    const n = e.count;
    const [ax, ay, bx, by, px, py, wx, wy, s1, s2] = this.scratch.get(n);
    const halfDt = 0.5 * dt;
    // One stage at a time for all particles: predictor at time t, corrector with the drift at
    // the predicted points at time t + dt.
    p.drift(x, y, n, t, ax, ay);
    const noisy = !p.deterministic;
    if (noisy) p.diffusion(x, y, n, t, s1, s2, null, null);
    const sq = Math.sqrt(dt);
    for (let i = 0; i < n; i++) {
      wx[i] = 0;
      wy[i] = 0;
      if (noisy) {
        wx[i] = s1[i] * sq * rng.normal();
        wy[i] = s2[i] * sq * rng.normal();
      }
      px[i] = x[i] + ax[i] * dt + wx[i];
      py[i] = y[i] + ay[i] * dt + wy[i];
    }
    p.drift(px, py, n, t + dt, bx, by);
    for (let i = 0; i < n; i++) {
      store(x, y, i, x[i] + (ax[i] + bx[i]) * halfDt + wx[i], y[i] + (ay[i] + by[i]) * halfDt + wy[i]);
    }
  }
}

/**
 * Milstein for diagonal noise:
 *
 *     Xₙ₊₁ᵏ = Xₙᵏ + bᵏ Δt + sᵏ ΔWᵏ + ½ sᵏ ∂ₖsᵏ ((ΔWᵏ)² − Δt) ,   k = 1, 2,
 *
 * all coefficients at (tₙ, Xₙ). One drift and one diffusion evaluation (with derivatives) per
 * step. Strong order 1 when s₁ depends on x only and s₂ on y only (diagonal noise); otherwise
 * the cross terms (Lévy areas) are missing and it is a scheme of strong order ½. For additive
 * noise it is Euler–Maruyama.
 */
class Milstein implements Scheme {
  readonly id = 'milstein' as const;
  readonly name = 'Milstein';
  readonly short = 'Milstein';
  readonly driftEvals = 1;
  readonly summary = '1 drift evaluation per step · strong order 1 for diagonal noise';
  private readonly scratch = new Scratch(6);

  step(e: Ensemble, p: Process, dt: number, rng: NormalSource, t = 0): void {
    const { x, y } = e;
    const n = e.count;
    const [bx, by, s1, s2, d1, d2] = this.scratch.get(n);
    p.drift(x, y, n, t, bx, by);
    const noisy = !p.deterministic;
    if (noisy) p.diffusion(x, y, n, t, s1, s2, d1, d2);
    const sq = Math.sqrt(dt);
    for (let i = 0; i < n; i++) {
      let nx = x[i] + bx[i] * dt;
      let ny = y[i] + by[i] * dt;
      if (noisy) {
        const w1 = sq * rng.normal();
        const w2 = sq * rng.normal();
        nx += s1[i] * w1 + 0.5 * s1[i] * d1[i] * (w1 * w1 - dt);
        ny += s2[i] * w2 + 0.5 * s2[i] * d2[i] * (w2 * w2 - dt);
      }
      store(x, y, i, nx, ny);
    }
  }
}

/** Writes a new position, ignoring non-finite values (a coefficient undefined somewhere). */
function store(x: Float64Array, y: Float64Array, i: number, nx: number, ny: number): void {
  if (Number.isFinite(nx) && Number.isFinite(ny)) {
    x[i] = nx;
    y[i] = ny;
  }
}

export const SCHEMES: Readonly<Record<SchemeId, Scheme>> = {
  heun: new Heun(),
  'euler-maruyama': new EulerMaruyama(),
  milstein: new Milstein(),
};

/** The schemes in the order the UI lists them. */
export const SCHEME_ORDER: readonly SchemeId[] = ['heun', 'euler-maruyama', 'milstein'];

export const DEFAULT_SCHEME: SchemeId = 'heun';
