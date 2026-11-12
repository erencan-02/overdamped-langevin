import { describe, expect, it } from 'vitest';
import { PotentialField } from '../src/sim/field';
import { MAX_PARTICLES, ParticleSystem, TRAIL_DT, TRAIL_LEN } from '../src/sim/particles';
import { Rng } from '../src/sim/rng';
import { langevin } from '../src/sim/process';

function stats(v: Float64Array, n: number) {
  let m = 0;
  for (let i = 0; i < n; i++) m += v[i];
  m /= n;
  let s = 0;
  for (let i = 0; i < n; i++) s += (v[i] - m) ** 2;
  return { mean: m, variance: s / (n - 1) };
}

function harmonicField(k: number) {
  const f = new PotentialField({ cellSize: 0.04, cap: 1000 });
  f.addFunction(-6, -6, 6, 6, (x, y) => 0.5 * k * (x * x + y * y));
  return f;
}

describe('Rng', () => {
  it('produces uniform floats in [0, 1)', () => {
    const rng = new Rng(7);
    let min = 1;
    let max = 0;
    let sum = 0;
    const n = 200_000;
    for (let i = 0; i < n; i++) {
      const u = rng.float();
      min = Math.min(min, u);
      max = Math.max(max, u);
      sum += u;
    }
    expect(min).toBeGreaterThanOrEqual(0);
    expect(max).toBeLessThan(1);
    expect(Math.abs(sum / n - 0.5)).toBeLessThan(0.005);
  });

  it('produces standard normal variates (moments and tails)', () => {
    const rng = new Rng(42);
    const n = 1_000_000;
    let s1 = 0;
    let s2 = 0;
    let s3 = 0;
    let s4 = 0;
    let beyond2 = 0;
    let beyond3 = 0;
    for (let i = 0; i < n; i++) {
      const z = rng.normal();
      s1 += z;
      s2 += z * z;
      s3 += z * z * z;
      s4 += z ** 4;
      if (Math.abs(z) > 2) beyond2++;
      if (Math.abs(z) > 3.442619855899) beyond3++;
    }
    expect(Math.abs(s1 / n)).toBeLessThan(0.005);
    expect(Math.abs(s2 / n - 1)).toBeLessThan(0.006);
    expect(Math.abs(s3 / n)).toBeLessThan(0.015); // skewness 0
    expect(Math.abs(s4 / n - 3)).toBeLessThan(0.04); // kurtosis 3
    // P(|Z| > 2) = 0.0455, P(|Z| > R) = 5.76e-4 (the ziggurat tail region).
    expect(Math.abs(beyond2 / n - 0.0455) / 0.0455).toBeLessThan(0.02);
    expect(Math.abs(beyond3 / n - 5.76e-4) / 5.76e-4).toBeLessThan(0.1);
  });

  it('is reproducible for a given seed', () => {
    const a = new Rng(123);
    const b = new Rng(123);
    for (let i = 0; i < 100; i++) expect(a.normal()).toBe(b.normal());
  });
});

describe('ParticleSystem', () => {
  it('reproduces free Brownian motion: Var[X_t] = σ² t', () => {
    const field = new PotentialField({ cellSize: 0.04, cap: 5 });
    const ps = new ParticleSystem(new Rng(1));
    const N = MAX_PARTICLES;
    for (let i = 0; i < N; i++) ps.add(0, 0, 0);
    const sigma = 0.8;
    const T = 1.5;
    for (let t = 0; t < 30; t++) ps.advance(langevin(field, sigma), T / 30);
    const sx = stats(ps.x, N);
    const sy = stats(ps.y, N);
    const expected = sigma * sigma * T;
    expect(Math.abs(sx.variance / expected - 1)).toBeLessThan(0.1);
    expect(Math.abs(sy.variance / expected - 1)).toBeLessThan(0.1);
    expect(Math.abs(sx.mean)).toBeLessThan(0.1);
    expect(ps.time).toBeCloseTo(T, 10);
  });

  it('follows the deterministic gradient flow exactly when σ = 0', () => {
    const k = 2;
    const field = harmonicField(k);
    const ps = new ParticleSystem(new Rng(2));
    ps.add(1, 0.5, 0);
    for (let t = 0; t < 60; t++) ps.advance(langevin(field, 0), 1 / 60);
    // x(t) = x0 · e^{-k t}
    expect(ps.x[0]).toBeCloseTo(Math.exp(-k), 5);
    expect(ps.y[0]).toBeCloseTo(0.5 * Math.exp(-k), 5);
  });

  it('relaxes to the Gibbs distribution of an Ornstein–Uhlenbeck process', () => {
    const k = 2;
    const sigma = 1;
    const field = harmonicField(k);
    const ps = new ParticleSystem(new Rng(3));
    const N = MAX_PARTICLES;
    for (let i = 0; i < N; i++) ps.add(0, 0, 0);
    for (let t = 0; t < 120; t++) ps.advance(langevin(field, sigma), 1 / 40);
    // Stationary density ∝ exp(−2Ψ/σ²)  ⇒  Var = σ² / (2k) per coordinate.
    const expected = (sigma * sigma) / (2 * k);
    expect(Math.abs(stats(ps.x, N).variance / expected - 1)).toBeLessThan(0.1);
    expect(Math.abs(stats(ps.y, N).variance / expected - 1)).toBeLessThan(0.1);
  });

  it('records trails at the trail interval and caps their length', () => {
    const field = new PotentialField({ cellSize: 0.04, cap: 5 });
    const ps = new ParticleSystem(new Rng(4));
    ps.add(0, 0, 0);
    ps.advance(langevin(field, 0.5), TRAIL_DT * 5.5);
    expect(ps.trailCount[0]).toBe(5);
    ps.advance(langevin(field, 0.5), TRAIL_DT * TRAIL_LEN * 2);
    expect(ps.trailCount[0]).toBe(TRAIL_LEN);
  });

  it('removes particles by swapping with the last one', () => {
    const ps = new ParticleSystem(new Rng(5));
    ps.add(0, 0, 1);
    ps.add(5, 5, 2);
    ps.add(9, 9, 3);
    expect(ps.nearest(5.1, 4.9, 0.5)).toBe(1);
    ps.removeAt(1);
    expect(ps.count).toBe(2);
    expect(ps.x[1]).toBe(9);
    expect(ps.color[1]).toBe(3);
    expect(ps.nearest(5, 5, 0.5)).toBe(-1);
  });
});
