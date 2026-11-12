import { describe, expect, it } from 'vitest';
import { PotentialField } from '../src/sim/field';
import { MAX_PARTICLES, ParticleSystem } from '../src/sim/particles';
import { Rng } from '../src/sim/rng';
import { type DriftField, SCHEMES, type SchemeId } from '../src/sim/schemes';
import { langevin } from '../src/sim/process';

/** Analytic harmonic potential Ψ = k/2·|x|², so ∇Ψ = k·x exactly (no grid error). */
const harmonic = (k: number): DriftField => ({
  gradient(x, y, out) {
    out[0] = k * x;
    out[1] = k * y;
  },
});

function ensemble(n: number, x0 = 0, y0 = 0) {
  const x = new Float64Array(n).fill(x0);
  const y = new Float64Array(n).fill(y0);
  return { x, y, count: n };
}

function variance(v: Float64Array): number {
  let m = 0;
  for (const a of v) m += a;
  m /= v.length;
  let s = 0;
  for (const a of v) s += (a - m) ** 2;
  return s / (v.length - 1);
}

const ids = Object.keys(SCHEMES) as SchemeId[];

describe('numerical schemes', () => {
  it('declare their cost', () => {
    expect(SCHEMES['euler-maruyama'].driftEvals).toBe(1);
    expect(SCHEMES.heun.driftEvals).toBe(2);
  });

  // Deterministic convergence order (σ = 0): halving Δt divides the error at T = 1 by
  // 2 for Euler–Maruyama (explicit Euler) and by 4 for Heun (second order).
  it.each([
    ['euler-maruyama', 2],
    ['heun', 4],
  ] as const)('%s has the expected order in the drift', (id, expectedRatio) => {
    const k = 1.5;
    const field = harmonic(k);
    const rng = new Rng(1);
    const errorAt = (n: number) => {
      const e = ensemble(1, 1, -0.5);
      for (let s = 0; s < n; s++) SCHEMES[id].step(e, langevin(field, 0), 1 / n, rng);
      return Math.abs(e.x[0] - Math.exp(-k));
    };
    const ratio = errorAt(50) / errorAt(100);
    expect(ratio).toBeGreaterThan(expectedRatio * 0.9);
    expect(ratio).toBeLessThan(expectedRatio * 1.1);
  });

  // For an Ornstein–Uhlenbeck process each scheme is a linear recursion
  // Xₙ₊₁ = a·Xₙ + b·Z whose stationary variance b²/(1 − a²) is known exactly. With a coarse
  // step the two schemes give clearly different values, and each must match its own formula.
  it.each(ids)('%s reproduces its exact discrete OU stationary variance', (id) => {
    const k = 2;
    const sigma = 1;
    const dt = 0.1;
    const N = 20_000;
    const kd = k * dt;
    const [a, b2] =
      id === 'heun'
        ? [1 - kd + (kd * kd) / 2, (1 - kd / 2) ** 2 * sigma * sigma * dt]
        : [1 - kd, sigma * sigma * dt];
    const expected = b2 / (1 - a * a);

    const e = ensemble(N);
    const rng = new Rng(11);
    for (let s = 0; s < 150; s++) SCHEMES[id].step(e, langevin(harmonic(k), sigma), dt, rng);
    const v = variance(e.x);
    expect(Math.abs(v / expected - 1)).toBeLessThan(0.04);
  });

  it('Heun is closer to the true OU variance than Euler–Maruyama at a coarse step', () => {
    const k = 2;
    const exact = 1 / (2 * k); // σ = 1
    const vs: Record<string, number> = {};
    for (const id of ids) {
      const e = ensemble(20_000);
      const rng = new Rng(5);
      for (let s = 0; s < 150; s++) SCHEMES[id].step(e, langevin(harmonic(k), 1), 0.1, rng);
      vs[id] = Math.abs(variance(e.x) / exact - 1);
    }
    expect(vs.heun).toBeLessThan(0.04);
    expect(vs['euler-maruyama']).toBeGreaterThan(0.07); // theory: +11 %
  });

  it.each(ids)('%s reproduces free Brownian motion (Var = σ² t)', (id) => {
    const field = new PotentialField({ cellSize: 0.04, cap: 5 });
    const ps = new ParticleSystem(new Rng(9), SCHEMES[id]);
    for (let i = 0; i < MAX_PARTICLES; i++) ps.add(0, 0, 0);
    const sigma = 0.7;
    for (let t = 0; t < 20; t++) ps.advance(langevin(field, sigma), 0.05);
    const v = variance(ps.x.subarray(0, ps.count));
    expect(Math.abs(v / (sigma * sigma * 1) - 1)).toBeLessThan(0.1);
  });

  it('can be switched on a running particle system', () => {
    const k = 1;
    const ps = new ParticleSystem(new Rng(3));
    ps.add(1, 0, 0);
    ps.advance(langevin(harmonic(k), 0), 0.5);
    ps.scheme = SCHEMES['euler-maruyama'];
    ps.advance(langevin(harmonic(k), 0), 0.5);
    expect(ps.x[0]).toBeCloseTo(Math.exp(-1), 2);
    expect(ps.time).toBeCloseTo(1, 12);
  });

  it('spends the work budget in drift evaluations', () => {
    const field = harmonic(1);
    for (const id of ids) {
      const ps = new ParticleSystem(new Rng(1), SCHEMES[id]);
      for (let i = 0; i < 1000; i++) ps.add(0, 0, 0);
      ps.advance(langevin(field, 0.5), 1, 1 / 500, 20_000);
      expect(ps.lastWork).toBeLessThanOrEqual(20_000);
      // Euler–Maruyama affords twice as many sub-steps for the same budget.
      expect(ps.lastSubsteps).toBe(id === 'heun' ? 10 : 20);
    }
  });
});
