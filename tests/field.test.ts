import { describe, expect, it } from 'vitest';
import { CHUNK, PotentialField } from '../src/sim/field';

const H = 0.04;

function gaussian(A: number, s: number, x0: number, y0: number) {
  const psi = (x: number, y: number) =>
    A * Math.exp(-((x - x0) ** 2 + (y - y0) ** 2) / (2 * s * s));
  const grad = (x: number, y: number): [number, number] => {
    const p = psi(x, y);
    return [(-(x - x0) / (s * s)) * p, (-(y - y0) / (s * s)) * p];
  };
  return { psi, grad };
}

describe('PotentialField', () => {
  it('is zero everywhere before painting', () => {
    const f = new PotentialField({ cellSize: H, cap: 5 });
    const g = new Float64Array(2);
    f.gradient(1.234, -5.6, g);
    expect(f.sample(1.234, -5.6)).toBe(0);
    expect(g[0]).toBe(0);
    expect(g[1]).toBe(0);
  });

  it('stores a Gaussian brush stamp and its gradient accurately', () => {
    const f = new PotentialField({ cellSize: H, cap: 100 });
    const A = 2;
    const s = 0.5;
    // Centre the stamp on a chunk corner so that the test also covers the
    // cross-chunk interpolation path (chunk size in world units = CHUNK * H).
    const x0 = CHUNK * H;
    const y0 = -CHUNK * H;
    f.applyBrush(x0, y0, A, s);
    const ref = gaussian(A, s, x0, y0);
    const g = new Float64Array(2);
    let maxErrPsi = 0;
    let maxErrGrad = 0;
    for (let k = 0; k < 400; k++) {
      const x = x0 + (Math.random() - 0.5) * 3 * s;
      const y = y0 + (Math.random() - 0.5) * 3 * s;
      maxErrPsi = Math.max(maxErrPsi, Math.abs(f.sample(x, y) - ref.psi(x, y)));
      f.gradient(x, y, g);
      const [gx, gy] = ref.grad(x, y);
      maxErrGrad = Math.max(maxErrGrad, Math.abs(g[0] - gx), Math.abs(g[1] - gy));
    }
    // Peak |∇Ψ| is A/s·e^{-1/2} ≈ 2.4; discretisation error must be < 1 %.
    expect(maxErrPsi).toBeLessThan(0.01 * A);
    expect(maxErrGrad).toBeLessThan(0.024);
  });

  it('clamps the potential to ±cap', () => {
    const f = new PotentialField({ cellSize: H, cap: 5 });
    for (let k = 0; k < 20; k++) f.applyBrush(0, 0, 3, 0.4);
    expect(f.sample(0, 0)).toBeCloseTo(5, 6);
    for (let k = 0; k < 60; k++) f.applyBrush(3, 3, -3, 0.4);
    expect(f.sample(3, 3)).toBeCloseTo(-5, 6);
    // On the plateau the force vanishes.
    const g = new Float64Array(2);
    f.gradient(0.01, 0.02, g);
    expect(Math.hypot(g[0], g[1])).toBeLessThan(1e-9);
  });

  it('keeps gradients consistent across chunk borders in all quadrants', () => {
    const f = new PotentialField({ cellSize: H, cap: 100 });
    const c = CHUNK * H;
    const centres: [number, number][] = [
      [0, 0],
      [-c, 0],
      [0, -c],
      [-2 * c, 2 * c],
    ];
    for (const [x0, y0] of centres) f.applyBrush(x0, y0, 1, 0.3);
    const g = new Float64Array(2);
    for (const [x0, y0] of centres) {
      const ref = gaussian(1, 0.3, x0, y0);
      for (const [dx, dy] of [
        [0.1, 0.1],
        [-0.1, 0.05],
        [0.07, -0.13],
        [-0.2, -0.2],
      ]) {
        f.gradient(x0 + dx, y0 + dy, g);
        const [gx, gy] = ref.grad(x0 + dx, y0 + dy);
        expect(Math.abs(g[0] - gx)).toBeLessThan(0.03);
        expect(Math.abs(g[1] - gy)).toBeLessThan(0.03);
      }
    }
  });

  it('marks touched chunks and their lower-left neighbours dirty', () => {
    const f = new PotentialField({ cellSize: H, cap: 5 });
    f.applyBrush(0, 0, 1, 0.3);
    // Stamp around the origin touches chunks (-1..0, -1..0) at least.
    expect(f.chunks.size).toBeGreaterThanOrEqual(4);
    expect(f.dirty.size).toBe(f.chunks.size);
    f.clear();
    expect(f.chunks.size).toBe(0);
    expect(f.dirty.size).toBe(0);
    expect(f.epoch).toBe(1);
  });
});
