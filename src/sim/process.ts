/**
 * The stochastic process being simulated: an Itô SDE in ℝ² with diagonal noise,
 *
 *     dX_t = b(t, X_t) dt + diag(s₁, s₂)(t, X_t) dW_t ,
 *
 * seen by the numerical schemes only through the `Process` interface: the drift b and the
 * diffusion coefficients s₁, s₂ (with ∂s₁/∂x, ∂s₂/∂y for Milstein), evaluated for many points at
 * once. A process also declares what is known about it (`capabilities`), so analysis tools that
 * need, e.g., the invariant measure in closed form only run where it exists.
 *
 * `Sde` is the process of the app: b = −∇Ψ + u, where Ψ is the potential (painted or a formula)
 * and u an optional non-gradient drift, and s = (σ, σ) or two formulas. With u = 0 and s = σ it
 * is the overdamped Langevin equation, whose invariant measure is the Gibbs measure e^{−2Ψ/σ²}.
 */

/** ∇Ψ for the drift −∇Ψ (the painted lattice, a formula, or an analytic test potential). */
export interface DriftField {
  /** Writes ∇Ψ(x, y) into out[0], out[1] (at the current time). */
  gradient(x: number, y: number, out: Float64Array): void;
  /**
   * Optional batch form, for fields that are cheaper to evaluate for many points at once (and
   * may depend on time): ∇Ψ(t, xs[i], ys[i]) for i < n into gx[i], gy[i].
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

/** Standard normal random numbers (an `Rng`, or prescribed increments for coupled runs). */
export interface NormalSource {
  normal(): number;
}

/** What is known about a process, for the tools that need it. */
export interface ProcessCapabilities {
  /**
   * b = −∇Ψ and s = (σ, σ): an overdamped Langevin equation, whose invariant measure is the Gibbs
   * measure π ∝ e^{−2Ψ/σ²} (for a time-independent Ψ). The equilibrium tools (KL to π, ∫ f dπ)
   * need this.
   */
  readonly gibbs: boolean;
  /** s does not depend on the position (additive noise): Milstein is Euler–Maruyama then. */
  readonly additiveNoise: boolean;
  /**
   * s₁ depends on x only and s₂ on y only (besides t): the noise is diagonal in the sense of
   * Milstein's scheme, which then has strong order 1.
   */
  readonly diagonalNoise: boolean;
}

/** A process the schemes can integrate. */
export interface Process {
  readonly capabilities: ProcessCapabilities;
  /** There is no noise at all: the schemes draw no random numbers. */
  readonly deterministic: boolean;
  /** b(t, xs[i], ys[i]) for i < n into bx, by. */
  drift(xs: Float64Array, ys: Float64Array, n: number, t: number, bx: Float64Array, by: Float64Array): void;
  /**
   * s₁ and s₂ at (t, xs[i], ys[i]) for i < n, and, if d1/d2 are given, ∂s₁/∂x and ∂s₂/∂y
   * (the derivatives Milstein's scheme needs).
   */
  diffusion(
    xs: Float64Array,
    ys: Float64Array,
    n: number,
    t: number,
    s1: Float64Array,
    s2: Float64Array,
    d1: Float64Array | null,
    d2: Float64Array | null,
  ): void;
}

/** A coefficient given by a formula: values and exact gradient at many points (see latex.ts). */
export interface Coefficient {
  readonly variables: ReadonlySet<string>;
  readonly timeDependent: boolean;
  readonly usesSigma: boolean;
  value(xs: Float64Array, ys: Float64Array, n: number, t: number, sigma: number, out: Float64Array): void;
  gradient(
    xs: Float64Array,
    ys: Float64Array,
    n: number,
    t: number,
    sigma: number,
    gx: Float64Array,
    gy: Float64Array,
  ): void;
}

/** Whether a coefficient depends on any coordinate other than `own` ('x' or 'y'). */
function dependsOnOther(c: Coefficient, own: 'x' | 'y'): boolean {
  const other = own === 'x' ? 'y' : 'x';
  return c.variables.has(other) || c.variables.has('r') || c.variables.has('theta');
}

function dependsOnPosition(c: Coefficient): boolean {
  return ['x', 'y', 'r', 'theta'].some((v) => c.variables.has(v));
}

/**
 * dX = (−∇Ψ + u)(t, X) dt + diag(s₁, s₂)(t, X) dW. Its parts can be changed at any time; the
 * capabilities follow.
 */
export class Sde implements Process {
  /** ∇Ψ (the drift is −∇Ψ); null: Ψ = 0. */
  potential: DriftField | null = null;
  /** Extra (e.g. non-gradient) drift u = (u₁, u₂); null: u = 0. */
  extraDrift: readonly [Coefficient, Coefficient] | null = null;
  /** Noise coefficients (s₁, s₂); null: s₁ = s₂ = σ. */
  noise: readonly [Coefficient, Coefficient] | null = null;
  /** σ: the noise level when `noise` is null, and a parameter the formulas may use. */
  sigma = 0;

  private readonly g = new Float64Array(2);
  private tmp = new Float64Array(64);

  get capabilities(): ProcessCapabilities {
    const noise = this.noise;
    return {
      gibbs: this.extraDrift === null && noise === null,
      additiveNoise: noise === null || (!dependsOnPosition(noise[0]) && !dependsOnPosition(noise[1])),
      diagonalNoise: noise === null || (!dependsOnOther(noise[0], 'x') && !dependsOnOther(noise[1], 'y')),
    };
  }

  get deterministic(): boolean {
    return this.noise === null && this.sigma === 0;
  }

  /** The drift or the noise depends on time (beyond a time-dependent Ψ). */
  get coefficientsDependOnTime(): boolean {
    const parts = [...(this.extraDrift ?? []), ...(this.noise ?? [])];
    return parts.some((c) => c.timeDependent || c.usesSigma);
  }

  drift(xs: Float64Array, ys: Float64Array, n: number, t: number, bx: Float64Array, by: Float64Array): void {
    const field = this.potential;
    if (!field) {
      bx.fill(0, 0, n);
      by.fill(0, 0, n);
    } else if (field.gradientBatch) {
      field.gradientBatch(xs, ys, n, t, bx, by);
      for (let i = 0; i < n; i++) {
        bx[i] = -bx[i];
        by[i] = -by[i];
      }
    } else {
      const g = this.g;
      for (let i = 0; i < n; i++) {
        field.gradient(xs[i], ys[i], g);
        bx[i] = -g[0];
        by[i] = -g[1];
      }
    }
    const u = this.extraDrift;
    if (u) {
      const tmp = this.scratch(n);
      u[0].value(xs, ys, n, t, this.sigma, tmp);
      for (let i = 0; i < n; i++) bx[i] += tmp[i];
      u[1].value(xs, ys, n, t, this.sigma, tmp);
      for (let i = 0; i < n; i++) by[i] += tmp[i];
    }
  }

  diffusion(
    xs: Float64Array,
    ys: Float64Array,
    n: number,
    t: number,
    s1: Float64Array,
    s2: Float64Array,
    d1: Float64Array | null,
    d2: Float64Array | null,
  ): void {
    const s = this.noise;
    if (!s) {
      s1.fill(this.sigma, 0, n);
      s2.fill(this.sigma, 0, n);
      d1?.fill(0, 0, n);
      d2?.fill(0, 0, n);
      return;
    }
    s[0].value(xs, ys, n, t, this.sigma, s1);
    s[1].value(xs, ys, n, t, this.sigma, s2);
    if (d1 || d2) {
      const other = this.scratch(n);
      if (d1) s[0].gradient(xs, ys, n, t, this.sigma, d1, other); // ∂s₁/∂x (∂s₁/∂y is dropped)
      if (d2) s[1].gradient(xs, ys, n, t, this.sigma, other, d2); // ∂s₂/∂y
    }
  }

  private scratch(n: number): Float64Array {
    if (this.tmp.length < n) this.tmp = new Float64Array(Math.max(n, 2 * this.tmp.length));
    return this.tmp;
  }
}

/** The overdamped Langevin equation dX = −∇Ψ(X) dt + σ dW for a given ∇Ψ. */
export function langevin(field: DriftField | null, sigma: number): Sde {
  const p = new Sde();
  p.potential = field;
  p.sigma = sigma;
  return p;
}
