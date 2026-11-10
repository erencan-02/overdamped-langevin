import { beforeAll, describe, expect, it } from 'vitest';
import { type EvalContext, loadTexParser, type TexParser } from '../src/analysis/latex';

const ctx: EvalContext = { sigma: 0.7, psi: (x, y) => x * x + 2 * y };
let parser: TexParser;

beforeAll(async () => {
  parser = await loadTexParser();
});

/** f at (x, y), through the batch evaluator. */
function f(tex: string, x = 0.3, y = -1.2): number {
  const r = parser.parse(tex);
  if (!r.ok) throw new Error(`${tex}: ${r.message}`);
  return r.fn.evaluate(Float64Array.of(x), Float64Array.of(y), 1, ctx)[0];
}

function error(tex: string): string {
  const r = parser.parse(tex);
  if (r.ok) throw new Error(`${tex} should not parse`);
  return r.message;
}

describe('LaTeX test functions (Compute Engine)', () => {
  const x = 0.3;
  const y = -1.2;

  it('evaluates arithmetic with the usual precedence', () => {
    expect(f('x^2 + y^2')).toBeCloseTo(x * x + y * y, 12);
    expect(f('2x - 3y')).toBeCloseTo(2 * x - 3 * y, 12);
    expect(f('x \\cdot y')).toBeCloseTo(x * y, 12);
    expect(f('x \\times y / 2')).toBeCloseTo((x * y) / 2, 12);
    expect(f('-x^2')).toBeCloseTo(-(x * x), 12);
    expect(f('2^{3^2}')).toBe(512);
    expect(f('x^{-1}')).toBeCloseTo(1 / x, 12);
    expect(f('x y')).toBeCloseTo(x * y, 12);
    expect(f('2(x+1)')).toBeCloseTo(2 * (x + 1), 12);
    expect(f('(x+1)(y-1)')).toBeCloseTo((x + 1) * (y - 1), 12);
    expect(f('x\\,y')).toBeCloseTo(x * y, 12);
  });

  it('understands fractions, roots and functions', () => {
    expect(f('\\frac{x}{y}')).toBeCloseTo(x / y, 12);
    expect(f('\\frac12')).toBe(0.5);
    expect(f('\\dfrac{1}{1+x^2}')).toBeCloseTo(1 / (1 + x * x), 12);
    expect(f('\\sqrt{x^2+y^2}')).toBeCloseTo(Math.hypot(x, y), 12);
    expect(f('\\sqrt[3]{8}')).toBeCloseTo(2, 12);
    expect(f('\\sin 2x')).toBeCloseTo(Math.sin(2 * x), 12);
    expect(f('\\sin^2 x + \\cos^2 x')).toBeCloseTo(1, 12);
    expect(f('\\exp(-x^2)')).toBeCloseTo(Math.exp(-x * x), 12);
    expect(f('e^{x}')).toBeCloseTo(Math.exp(x), 12);
    expect(f('\\mathrm{e}^{-y}')).toBeCloseTo(Math.exp(-y), 12);
    expect(f('\\log_2 8')).toBeCloseTo(3, 12);
    expect(f('\\ln(2)')).toBeCloseTo(Math.LN2, 12);
    expect(f('\\max(x, y, 0.1)')).toBe(x);
    expect(f('\\min(x, y)')).toBe(y);
    expect(f('\\operatorname{sgn}(y)')).toBe(-1);
    expect(f('\\cos(\\pi x)')).toBeCloseTo(Math.cos(Math.PI * x), 12);
  });

  it('handles delimiters and absolute values', () => {
    expect(f('|y|')).toBeCloseTo(-y, 12);
    expect(f('|x| + |y|')).toBeCloseTo(Math.abs(x) + Math.abs(y), 12);
    expect(f('\\left| x - 1 \\right|')).toBeCloseTo(1 - x, 12);
    expect(f('\\left( x + 1 \\right)^2')).toBeCloseTo((x + 1) ** 2, 12);
    expect(f('\\lvert y \\rvert')).toBeCloseTo(-y, 12);
    expect(f('\\lfloor 2.7 \\rfloor')).toBe(2);
  });

  it('supports indicators, polar coordinates and the model quantities', () => {
    expect(f('\\mathbf{1}_{x>0}')).toBe(1);
    expect(f('\\mathbf{1}_{y>0}')).toBe(0);
    expect(f('\\mathbb{1}_{\\{x \\le 1\\}}')).toBe(1);
    expect(f('\\mathbf{1}_{x \\le 1 \\land y > -2}')).toBe(1);
    expect(f('\\mathbf{1}_{-1 < y < 0}')).toBe(0);
    expect(f('\\mathbf{1}_{0 < x < 1}')).toBe(1);
    expect(f('[x > 0]')).toBe(1); // Iverson bracket
    expect(f('r')).toBeCloseTo(Math.hypot(x, y), 12);
    expect(f('\\theta')).toBeCloseTo(Math.atan2(y, x), 12);
    expect(f('\\sigma')).toBe(0.7);
    expect(f('\\Psi')).toBeCloseTo(x * x + 2 * y, 12);
    expect(f('\\Psi(x, y)^2')).toBeCloseTo((x * x + 2 * y) ** 2, 12);
    expect(f('\\frac{1}{2}\\sigma^2 + \\Psi')).toBeCloseTo(0.245 + x * x + 2 * y, 12);
    const r = parser.parse('\\Psi + \\sigma');
    expect(r.ok && r.usesPsi && r.usesSigma).toBe(true);
  });

  it('accepts a definition prefix and evaluates many points at once', () => {
    expect(f('f(x, y) = x + y')).toBeCloseTo(x + y, 12);
    expect(f('f = x')).toBe(x);
    const r = parser.parse('x^2 - y');
    if (!r.ok) throw new Error(r.message);
    const xs = Float64Array.from({ length: 1000 }, (_, i) => i / 100);
    const ys = Float64Array.from({ length: 1000 }, (_, i) => -i / 50);
    const out = r.fn.evaluate(xs, ys, 1000, ctx);
    expect(out.length).toBe(1000);
    for (let i = 0; i < 1000; i += 97) expect(out[i]).toBeCloseTo(xs[i] ** 2 - ys[i], 12);
    expect(f('\\pi')).toBe(Math.PI); // a constant: one value for every point
  });

  it('reports non-scalar outputs and other mistakes', () => {
    expect(error('(x, y)')).toMatch(/must be a scalar/);
    expect(error('x, y')).toMatch(/must be a scalar/);
    expect(error('[x + 1]^2')).toMatch(/must be a scalar/);
    expect(error('\\mathbf{x}')).toMatch(/must be a scalar/);
    expect(error('\\begin{pmatrix} x \\\\ y \\end{pmatrix}')).toMatch(/must be a scalar/);
    expect(error('x > 0')).toMatch(/must be a scalar/);
    expect(error('')).toMatch(/Enter a function/);
    expect(error('z + 1')).toMatch(/Unknown variable "z"/);
    expect(error('\\foo x')).toMatch(/Unknown command \\foo/);
    expect(error('(x + 1')).toMatch(/closing bracket/);
    expect(error('x + 1)')).toMatch(/Unmatched "\)"/);
    expect(error('\\frac{1}')).toMatch(/denominator/);
    expect(error('x^')).toMatch(/exponent/);
    expect(error('x +')).toMatch(/needs something/);
    expect(error('x = y')).toMatch(/not an equation/);
    expect(error('\\sin')).toMatch(/needs an argument/);
    expect(error('x # 2')).toMatch(/Unexpected character "#"/);
    expect(error('\\Psi(y, x)')).toMatch(/only be evaluated at \(x, y\)/);
    expect(error('a'.repeat(501))).toMatch(/too long/);
  });
});
