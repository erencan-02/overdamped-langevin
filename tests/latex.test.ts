import { describe, expect, it } from 'vitest';
import { parseFunction, type EvalContext } from '../src/analysis/latex';

const ctx: EvalContext = { sigma: 0.7, psi: (x, y) => x * x + 2 * y };

function f(tex: string, x = 0.3, y = -1.2): number {
  const r = parseFunction(tex);
  if (!r.ok) throw new Error(`${tex}: ${r.message}`);
  return r.fn(x, y, ctx);
}

function error(tex: string): string {
  const r = parseFunction(tex);
  if (r.ok) throw new Error(`${tex} should not parse`);
  return r.message;
}

describe('LaTeX function parser', () => {
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
    expect(f('1 - 2 - 3')).toBe(-4);
    expect(f('x y')).toBeCloseTo(x * y, 12);
    expect(f('2(x+1)')).toBeCloseTo(2 * (x + 1), 12);
    expect(f('(x+1)(y-1)')).toBeCloseTo((x + 1) * (y - 1), 12);
    expect(f('x^23')).toBeCloseTo(x * x * 3, 12); // as in LaTeX: x^2 · 3
    expect(f('.5x')).toBeCloseTo(0.5 * x, 12);
  });

  it('understands fractions, roots and functions', () => {
    expect(f('\\frac{x}{y}')).toBeCloseTo(x / y, 12);
    expect(f('\\frac12')).toBe(0.5);
    expect(f('\\dfrac{1}{1+x^2}')).toBeCloseTo(1 / (1 + x * x), 12);
    expect(f('\\sqrt{x^2+y^2}')).toBeCloseTo(Math.hypot(x, y), 12);
    expect(f('\\sqrt[3]{8}')).toBeCloseTo(2, 12);
    expect(f('\\sin x')).toBeCloseTo(Math.sin(x), 12);
    expect(f('\\sin 2x')).toBeCloseTo(Math.sin(2 * x), 12);
    expect(f('\\sin x \\cos y')).toBeCloseTo(Math.sin(x) * Math.cos(y), 12);
    expect(f('\\sin^2 x + \\cos^2 x')).toBeCloseTo(1, 12);
    expect(f('\\exp(-x^2)')).toBeCloseTo(Math.exp(-x * x), 12);
    expect(f('e^{x}')).toBeCloseTo(Math.exp(x), 12);
    expect(f('\\mathrm{e}^{-y}')).toBeCloseTo(Math.exp(-y), 12);
    expect(f('\\log_2 8')).toBeCloseTo(3, 12);
    expect(f('\\ln(2)')).toBeCloseTo(Math.LN2, 12);
    expect(f('\\max(x, y, 0.1)')).toBe(x);
    expect(f('\\min(x, y)')).toBe(y);
    expect(f('\\operatorname{sgn}(y)')).toBe(-1);
    expect(f('\\operatorname{atan2}(y, x)')).toBeCloseTo(Math.atan2(y, x), 12);
    expect(f('\\pi')).toBe(Math.PI);
  });

  it('handles delimiters and absolute values', () => {
    expect(f('|y|')).toBeCloseTo(-y, 12);
    expect(f('|x| + |y|')).toBeCloseTo(Math.abs(x) + Math.abs(y), 12);
    expect(f('\\left| x - 1 \\right|')).toBeCloseTo(1 - x, 12);
    expect(f('\\left( x + 1 \\right)^2')).toBeCloseTo((x + 1) ** 2, 12);
    expect(f('\\lvert y \\rvert')).toBeCloseTo(-y, 12);
    expect(f('\\lfloor 2.7 \\rfloor')).toBe(2);
    expect(f('[x + 1]^2')).toBeCloseTo((x + 1) ** 2, 12);
    expect(f('x\\,y')).toBeCloseTo(x * y, 12);
  });

  it('supports indicators, polar coordinates and the model quantities', () => {
    expect(f('\\mathbf{1}_{x>0}')).toBe(1);
    expect(f('\\mathbf{1}_{y>0}')).toBe(0);
    expect(f('\\mathbb{1}_{\\{x \\le 1 \\land y > -2\\}}')).toBe(1);
    expect(f('\\mathbf{1}_{-1 < y < 0}')).toBe(0);
    expect(f('\\mathbf{1}_{0 < x < 1}')).toBe(1);
    expect(f('r')).toBeCloseTo(Math.hypot(x, y), 12);
    expect(f('\\theta')).toBeCloseTo(Math.atan2(y, x), 12);
    expect(f('\\sigma')).toBe(0.7);
    expect(f('\\Psi')).toBeCloseTo(x * x + 2 * y, 12);
    expect(f('\\Psi(x, y)^2')).toBeCloseTo((x * x + 2 * y) ** 2, 12);
    const r = parseFunction('\\Psi + \\sigma');
    expect(r.ok && r.usesPsi && r.usesSigma).toBe(true);
  });

  it('accepts a definition prefix', () => {
    expect(f('f(x, y) = x + y')).toBeCloseTo(x + y, 12);
    expect(f('f = x')).toBe(x);
  });

  it('reports non-scalar outputs and other mistakes', () => {
    expect(error('(x, y)')).toMatch(/must be a scalar/);
    expect(error('x, y')).toMatch(/must be a scalar/);
    expect(error('\\mathbf{x}')).toMatch(/must be a scalar/);
    expect(error('\\begin{pmatrix} x \\end{pmatrix}')).toMatch(/must be a scalar/);
    expect(error('x > 0')).toMatch(/must be a scalar/);
    expect(error('')).toMatch(/Enter a function/);
    expect(error('z + 1')).toMatch(/Unknown variable "z"/);
    expect(error('\\foo x')).toMatch(/Unknown command \\foo/);
    expect(error('(x + 1')).toMatch(/Missing "\)"/);
    expect(error('x + 1)')).toMatch(/Unexpected "\)"/);
    expect(error('\\frac{1}')).toMatch(/denominator/);
    expect(error('x^')).toMatch(/exponent/);
    expect(error('x +')).toMatch(/ends too early/);
    expect(error('x = y')).toMatch(/not an equation/);
    expect(error('\\sin')).toMatch(/needs an argument/);
    expect(error('x # 2')).toMatch(/Unexpected character/);
    expect(error('x^2^3')).toMatch(/Double exponent/);
    expect(error('\\sin(x, y)')).toMatch(/one argument/);
    expect(error('a'.repeat(501))).toMatch(/too long/);
  });
});
