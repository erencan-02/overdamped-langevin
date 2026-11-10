import { beforeAll, describe, expect, it } from 'vitest';
import { type CompiledPotential, loadTexParser, type TexParser } from '../src/analysis/latex';

let parser: TexParser;
beforeAll(async () => {
  parser = await loadTexParser();
});

function potential(tex: string): CompiledPotential {
  const r = parser.parsePotential(tex);
  if (!r.ok) throw new Error(`${tex}: ${r.message}`);
  return r.potential;
}

function error(tex: string): string {
  const r = parser.parsePotential(tex);
  if (r.ok) throw new Error(`${tex} should not parse`);
  return r.message;
}

const X = Float64Array.of(0.7, -1.3, 2.1, 0.05);
const Y = Float64Array.of(-0.4, 0.9, 1.5, -2.2);
const n = X.length;

function evalAt(p: CompiledPotential, t = 0.3, sigma = 0.6) {
  const v = new Float64Array(n);
  const gx = new Float64Array(n);
  const gy = new Float64Array(n);
  p.value(X, Y, n, t, sigma, v);
  p.gradient(X, Y, n, t, sigma, gx, gy);
  return { v, gx, gy };
}

describe('potential formulas: values and exact gradients', () => {
  it('differentiates polynomials, products and compositions exactly', () => {
    const cases: [string, (x: number, y: number) => number, (x: number, y: number) => [number, number]][] = [
      ['\\frac{x^2 + y^2}{2}', (x, y) => (x * x + y * y) / 2, (x, y) => [x, y]],
      ['\\frac{(x^2 - 4)^2}{16} + \\frac{y^2}{2}', (x, y) => (x * x - 4) ** 2 / 16 + y * y / 2, (x, y) => [(x * (x * x - 4)) / 4, y]],
      ['\\sin(x)\\cos(y)', (x, y) => Math.sin(x) * Math.cos(y), (x, y) => [Math.cos(x) * Math.cos(y), -Math.sin(x) * Math.sin(y)]],
      ['x^3 - 3xy^2', (x, y) => x ** 3 - 3 * x * y * y, (x, y) => [3 * x * x - 3 * y * y, -6 * x * y]],
      ['\\ln(1 + x^2 + y^2)', (x, y) => Math.log(1 + x * x + y * y), (x, y) => [(2 * x) / (1 + x * x + y * y), (2 * y) / (1 + x * x + y * y)]],
    ];
    for (const [tex, f, g] of cases) {
      const { v, gx, gy } = evalAt(potential(tex));
      for (let i = 0; i < n; i++) {
        expect(v[i]).toBeCloseTo(f(X[i], Y[i]), 12);
        const [ex, ey] = g(X[i], Y[i]);
        expect(gx[i]).toBeCloseTo(ex, 11);
        expect(gy[i]).toBeCloseTo(ey, 11);
      }
    }
  });

  it('handles r and θ by the chain rule', () => {
    // Ψ = (r² − 4)²/8: ∇Ψ = (r² − 4)/2 · (x, y).  Ψ = θ: ∇Ψ = (−y, x)/r².  Ψ = e^{−r²}.
    const ring = evalAt(potential('\\frac{(r^2 - 4)^2}{8}'));
    const angle = evalAt(potential('\\theta'));
    const bump = evalAt(potential('e^{-r^2}'));
    for (let i = 0; i < n; i++) {
      const x = X[i];
      const y = Y[i];
      const r2 = x * x + y * y;
      expect(ring.gx[i]).toBeCloseTo(((r2 - 4) / 2) * x, 11);
      expect(ring.gy[i]).toBeCloseTo(((r2 - 4) / 2) * y, 11);
      expect(angle.gx[i]).toBeCloseTo(-y / r2, 11);
      expect(angle.gy[i]).toBeCloseTo(x / r2, 11);
      expect(bump.v[i]).toBeCloseTo(Math.exp(-r2), 12);
      expect(bump.gx[i]).toBeCloseTo(-2 * x * Math.exp(-r2), 11);
    }
  });

  it('depends on time and σ when the formula does', () => {
    const moving = potential('\\frac{(x - 2\\cos t)^2 + (y - 2\\sin t)^2}{2}');
    expect(moving.timeDependent).toBe(true);
    const a = evalAt(moving, 0);
    const b = evalAt(moving, Math.PI / 2);
    expect(a.gx[0]).toBeCloseTo(X[0] - 2, 12);
    expect(b.gy[0]).toBeCloseTo(Y[0] - 2, 12);
    expect(potential('x^2').timeDependent).toBe(false);
    const temp = potential('\\sigma^2 x');
    expect(temp.usesSigma).toBe(true);
    expect(evalAt(temp, 0, 2).gx[0]).toBeCloseTo(4, 12);
  });

  it('accepts a Ψ(t, x, y) = prefix and constant gradients', () => {
    expect(evalAt(potential('\\Psi(t, x, y) = 3x - y')).gx[2]).toBe(3);
    expect(evalAt(potential('\\Psi(x,y) = 3x - y')).gy[2]).toBe(-1);
    expect(evalAt(potential('\\Psi = 2')).gx[1]).toBe(0);
  });

  it('refuses formulas without a usable gradient or with mistakes', () => {
    expect(error('\\max(x, y)')).toMatch(/differentiable/);
    expect(error('\\mathbf{1}_{x > 0}')).toMatch(/differentiable/);
    expect(error('\\Psi + x')).toMatch(/own formula/);
    expect(error('x + z')).toMatch(/Unknown variable "z"/);
    expect(error('(x, y)')).toMatch(/must be a scalar/);
    expect(error('')).toMatch(/Enter a potential/);
  });
});

describe('compiler safety', () => {
  it('evaluates powers of square roots correctly (a compile bug of the engine)', () => {
    const f = parser.parse('-\\left(\\sqrt{x^2+y^2}\\right)^2');
    if (!f.ok) throw new Error(f.message);
    const v = f.fn.evaluate(X, Y, n, { sigma: 0.6, psi: () => 0 });
    for (let i = 0; i < n; i++) expect(v[i]).toBeCloseTo(-(X[i] ** 2 + Y[i] ** 2), 12);
    const p = evalAt(potential('e^{-\\left(\\sqrt{x^2+y^2}\\right)^2}'));
    for (let i = 0; i < n; i++) expect(p.v[i]).toBeCloseTo(Math.exp(-(X[i] ** 2 + Y[i] ** 2)), 12);
  });
});
