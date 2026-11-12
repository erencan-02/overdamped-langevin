import type { Rng } from './rng';

/**
 * Independent replicas of the linear birth–death process: every individual gives birth at rate
 * λ and dies at rate μ, independently. With position-independent rates, this is exactly the law
 * of the particle count N(t) of the simulation (see birthDeath.ts), so the replicas show the
 * spread of N(t) across runs next to the one run on screen.
 *
 * The replicas are advanced with the exact transition law (Kendall, 1948): over a time Δ, each
 * individual independently leaves 0 descendants with probability α, and otherwise 1 + G
 * descendants, where G is geometric with P(G = k) = (1 − β) β^k, and
 *
 *     α = μ(E − 1) / (λE − μ),   β = λ(E − 1) / (λE − μ),   E = e^{(λ−μ)Δ}
 *
 * (α = β = λΔ / (1 + λΔ) for λ = μ). Exact for any Δ, so no time step is involved. Like the
 * simulation, a replica never exceeds `cap` individuals (births beyond it are lost).
 */
export class BranchingReplicas {
  readonly counts: Float64Array;
  private sorted: Float64Array;

  constructor(
    private readonly rng: Rng,
    readonly replicas = 200,
  ) {
    this.counts = new Float64Array(replicas);
    this.sorted = new Float64Array(replicas);
  }

  /** All replicas start with n individuals. */
  start(n: number): void {
    this.counts.fill(n);
  }

  /** Advances every replica by time Δ ≥ 0 with birth rate λ and death rate μ. */
  advance(delta: number, lambda: number, mu: number, cap = Infinity): void {
    if (!(delta > 0) || (lambda === 0 && mu === 0)) return;
    const { alpha, beta } = transition(delta, lambda, mu);
    const logBeta = beta > 0 ? Math.log(beta) : -Infinity;
    const rng = this.rng;
    for (let r = 0; r < this.counts.length; r++) {
      const n = this.counts[r];
      let next = 0;
      for (let i = 0; i < n && next < cap; i++) {
        if (rng.float() < alpha) continue;
        next += 1;
        if (beta > 0) {
          // Geometric number of extra descendants: ⌊ln U / ln β⌋, U uniform in (0, 1].
          next += Math.floor(Math.log(1 - rng.float()) / logBeta);
        }
      }
      this.counts[r] = Math.min(next, cap);
    }
  }

  /** Mean, standard deviation and the q-quantiles (q in [0, 1]) over the replicas. */
  stats(qLow = 0.05, qHigh = 0.95): { mean: number; sd: number; lo: number; hi: number } {
    const c = this.counts;
    const n = c.length;
    let mean = 0;
    for (let i = 0; i < n; i++) mean += c[i];
    mean /= n;
    let v = 0;
    for (let i = 0; i < n; i++) v += (c[i] - mean) ** 2;
    this.sorted.set(c);
    this.sorted.sort();
    const q = (p: number) => this.sorted[Math.min(n - 1, Math.max(0, Math.round(p * (n - 1))))];
    return { mean, sd: Math.sqrt(v / Math.max(1, n - 1)), lo: q(qLow), hi: q(qHigh) };
  }
}

/** α = P(no descendants after Δ) and β of the geometric part, for one individual. */
export function transition(delta: number, lambda: number, mu: number): { alpha: number; beta: number } {
  if (Math.abs(lambda - mu) < 1e-12 * Math.max(lambda, mu, 1)) {
    const a = (lambda * delta) / (1 + lambda * delta);
    return { alpha: a, beta: a };
  }
  const E = Math.exp((lambda - mu) * delta);
  const d = lambda * E - mu;
  return { alpha: (mu * (E - 1)) / d, beta: (lambda * (E - 1)) / d };
}

/** Exact mean and variance of N(t) for the linear birth–death process started from n₀. */
export function populationMoments(n0: number, t: number, lambda: number, mu: number): { mean: number; variance: number } {
  const r = lambda - mu;
  if (Math.abs(r) < 1e-12 * Math.max(lambda, mu, 1)) return { mean: n0, variance: 2 * n0 * lambda * t };
  const E = Math.exp(r * t);
  return { mean: n0 * E, variance: (n0 * (lambda + mu) * E * (E - 1)) / r };
}
