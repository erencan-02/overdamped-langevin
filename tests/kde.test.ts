import { describe, expect, it } from 'vitest';
import {
  depositParticles,
  gibbsLogProbabilities,
  gridBox,
  klDivergence,
  makeGrid,
  smoothAndNormalise,
} from '../src/analysis/kde';
import { Rng } from '../src/sim/rng';

const box = { x0: -4, y0: -3, x1: 4, y1: 3 };

describe('analysis grid', () => {
  it('resolves the kernel with ~1.5 cells per std, within 64–256 cells', () => {
    const g = makeGrid(box, 0.12);
    expect(g.cell).toBeCloseTo(0.08, 10); // h / 1.5
    expect(g.nx).toBe(100); // 8 / 0.08
    expect(makeGrid(box, 0.001).nx).toBe(256); // tiny kernel: capped resolution
    expect(makeGrid(box, 50).nx).toBe(64); // huge kernel: minimum resolution
    const b = gridBox(g);
    expect(b.x1).toBeCloseTo(4, 10);
  });
});

describe('Gibbs probabilities', () => {
  it('are normalised and follow exp(−2ΔΨ/σ²)', () => {
    const g = makeGrid(box, 0.3);
    const psi = (x: number) => 0.5 * x;
    const sigma = 0.8;
    const lq = gibbsLogProbabilities(g, psi, sigma)!;
    let s = 0;
    for (const v of lq) s += Math.exp(v);
    expect(s).toBeCloseTo(1, 10);
    // Neighbouring columns differ by ΔΨ = 0.5·cell.
    expect(lq[1] - lq[0]).toBeCloseTo((-2 * 0.5 * g.cell) / (sigma * sigma), 10);
  });

  it('survive tiny σ without overflow and refuse σ = 0', () => {
    const g = makeGrid(box, 0.3);
    const lq = gibbsLogProbabilities(g, (x, y) => x * x + y * y, 0.01)!;
    expect(lq.every(Number.isFinite)).toBe(true);
    expect(gibbsLogProbabilities(g, () => 0, 0)).toBeNull();
  });
});

describe('cloud-in-cell deposit', () => {
  it('conserves the mass of particles inside the box and ignores the rest', () => {
    const g = makeGrid(box, 0.3);
    const out = new Float32Array(g.nx * g.ny);
    const xs = [0, 3.99, -3.99, 1.234, 10];
    const ys = [0, 2.99, -2.99, -0.777, 0];
    const inside = depositParticles(g, xs, ys, xs.length, out);
    expect(inside).toBe(4);
    let s = 0;
    for (const v of out) s += v;
    expect(s).toBeCloseTo(4, 5);
  });

  it('puts a particle at a cell centre entirely into that cell', () => {
    const g = makeGrid(box, 0.3);
    const out = new Float32Array(g.nx * g.ny);
    const x = g.x0 + 5.5 * g.cell;
    const y = g.y0 + 7.5 * g.cell;
    depositParticles(g, [x], [y], 1, out);
    expect(out[7 * g.nx + 5]).toBeCloseTo(1, 6);
  });
});

describe('KL(ρ̂_h ‖ π)', () => {
  it('is zero for identical distributions and positive otherwise', () => {
    const g = makeGrid(box, 0.3);
    const lq = gibbsLogProbabilities(g, () => 0, 1)!;
    const n = g.nx * g.ny;
    const p = new Float32Array(n).fill(1 / n);
    expect(klDivergence(p, lq, n)).toBeLessThan(1e-6);
    p.fill(0);
    p[0] = 1;
    // All mass in one of n equally likely cells: KL = log n.
    expect(klDivergence(p, lq, n)).toBeCloseTo(Math.log(n), 5);
  });

  it('is small for exact Gibbs samples and large for a far-from-equilibrium cloud', () => {
    // Harmonic potential: π restricted to the box is close to a Gaussian with variance σ²/(2k).
    const k = 1;
    const sigma = 1;
    const h = 0.3;
    const g = makeGrid(box, h);
    const lq = gibbsLogProbabilities(g, (x, y) => 0.5 * k * (x * x + y * y), sigma)!;
    const n = g.nx * g.ny;
    const rng = new Rng(7);
    const N = 20000;
    const sd = sigma / Math.sqrt(2 * k);
    const xs = new Float64Array(N);
    const ys = new Float64Array(N);
    for (let p = 0; p < N; p++) {
      xs[p] = sd * rng.normal();
      ys[p] = sd * rng.normal();
    }
    const mass = new Float32Array(n);
    depositParticles(g, xs, ys, N, mass);
    expect(smoothAndNormalise(g, mass, h)).toBe(true);
    const klEq = klDivergence(mass, lq, n);

    // The smoothing floor KL(π ∗ K_h ‖ π): what perfect sampling converges to as N → ∞.
    const qh = new Float32Array(n);
    for (let c = 0; c < n; c++) qh[c] = Math.exp(lq[c]);
    smoothAndNormalise(g, qh, h);
    const floor = klDivergence(qh, lq, n);
    expect(floor).toBeGreaterThan(0);
    expect(klEq).toBeGreaterThan(floor * 0.5);
    expect(klEq).toBeLessThan(floor + 0.05); // only a small finite-N excess

    // The same particles shifted into a corner: far from equilibrium.
    for (let p = 0; p < N; p++) xs[p] += 2.5;
    depositParticles(g, xs, ys, N, mass);
    smoothAndNormalise(g, mass, h);
    expect(klDivergence(mass, lq, n)).toBeGreaterThan(1);
  });
});
