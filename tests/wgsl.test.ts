import { describe, expect, it } from 'vitest';
import { loadTexParser } from '../src/analysis/latex';
import { toWgsl, WGSL_HELPERS } from '../src/sim/gpu/wgsl';

/**
 * The WGSL the GPU integrator gets for a formula, evaluated here as JavaScript (the generated
 * expressions only use syntax both languages share; WGSL's built-ins are mapped to Math), against
 * the formula and exact gradient the CPU uses. The real GPU is checked in the browser
 * (e2e/particles.spec.ts) and by the app itself before it uses a kernel.
 */

/** JavaScript versions of the WGSL built-ins and of WGSL_HELPERS. */
const BUILTINS: Record<string, (...a: number[]) => number> = {
  sqrt: Math.sqrt,
  exp: Math.exp,
  log: Math.log,
  log2: Math.log2,
  abs: Math.abs,
  sign: Math.sign,
  floor: Math.floor,
  ceil: Math.ceil,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  atan2: Math.atan2,
  sinh: Math.sinh,
  cosh: Math.cosh,
  tanh: Math.tanh,
  asinh: Math.asinh,
  acosh: Math.acosh,
  atanh: Math.atanh,
  max: Math.max,
  min: Math.min,
  pow: Math.pow,
  lg_powr: (b, e) => b ** e,
  lg_root: (a, n) => (a < 0 && Number.isInteger(n) && Math.abs(n % 2) === 1 ? -((-a) ** (1 / n)) : a ** (1 / n)),
  lg_round: (a) => Math.floor(a + 0.5),
  lg_bool: (c) => (c ? 1 : 0),
};

function asJs(wgsl: string): (x: number, y: number, t: number, sigma: number) => number {
  const names = Object.keys(BUILTINS);
  const f = new Function(...names, 'x', 'y', 't', 'sigma', 'const r = Math.hypot(x, y), theta = Math.atan2(y, x);' + `return ${wgsl};`);
  return (x, y, t, sigma) => f(...names.map((n) => BUILTINS[n]), x, y, t, sigma);
}

const FORMULAS = [
  '\\frac{x^2 + y^2}{2}',
  '\\frac{(x^2 - 4)^2}{16} + \\frac{y^2}{2}',
  '\\frac{(r^2 - 4)^2}{16}',
  '-\\cos(2x)\\cos(2y) + \\frac{r^2}{20}',
  '\\frac{(x - 2\\cos t)^2 + (y - 2\\sin t)^2}{2}',
  '\\frac{(x^2 - 4)^2}{16} + \\frac{y^2}{2} + \\frac{x \\sin t}{2}',
  '\\sigma\\sqrt{1 + \\frac{x^2}{4}}',
  '\\sigma x',
  '\\frac{\\sigma}{4}',
  '\\sigma\\left(1 + \\frac{1}{2}\\sin t\\right)',
  '-y\\cos t',
  'x^3 - \\frac{1}{1 + x^2} + e^{-x^2} + \\ln(2 + y^2)',
  '\\theta \\cdot r + \\tanh(x) + \\arctan(y)',
  'x^{-3} + 10^{x/5} + |y| + \\sqrt[3]{x}',
  'x^{\\frac{2}{3}} + y^{\\frac{1}{3}} + (1 + x^2)^{1.5}',
];

const POINTS: [number, number][] = [
  [0.37, -0.61],
  [1.3, 0.8],
  [-0.9, 1.7],
  [-1.6, -0.45],
  [2.2, 0.15],
  [-2.7, -2.1],
];

describe('WGSL of formulas (GPU integrator)', () => {
  it('evaluates like the CPU formula, value and exact gradient', async () => {
    const parser = await loadTexParser();
    for (const tex of FORMULAS) {
      const r = parser.parsePotential(tex);
      expect(r.ok, tex).toBe(true);
      if (!r.ok) continue;
      const p = r.potential;
      expect(p.wgsl, tex).not.toBeNull();
      const w = p.wgsl!;
      const value = asJs(w.value);
      const d = { x: asJs(w.dx), y: asJs(w.dy), r: asJs(w.dr), theta: asJs(w.dtheta) };
      for (const [x, y] of POINTS) {
        const t = 0.83;
        const sigma = 0.6;
        const xs = Float64Array.of(x);
        const ys = Float64Array.of(y);
        const v = new Float64Array(1);
        const gx = new Float64Array(1);
        const gy = new Float64Array(1);
        p.value(xs, ys, 1, t, sigma, v);
        p.gradient(xs, ys, 1, t, sigma, gx, gy);
        const near = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * (1 + Math.abs(b));
        expect(near(value(x, y, t, sigma), v[0]), `${tex} at ${x}, ${y}`).toBe(true);
        // The chain rule for r and θ, as on the GPU (see kernel.ts).
        const rr = Math.hypot(x, y);
        const ex = d.x(x, y, t, sigma) + (d.r(x, y, t, sigma) * x) / rr - (d.theta(x, y, t, sigma) * y) / (rr * rr);
        const ey = d.y(x, y, t, sigma) + (d.r(x, y, t, sigma) * y) / rr + (d.theta(x, y, t, sigma) * x) / (rr * rr);
        expect(near(ex, gx[0]), `∂x ${tex} at ${x}, ${y}`).toBe(true);
        expect(near(ey, gy[0]), `∂y ${tex} at ${x}, ${y}`).toBe(true);
      }
    }
  }, 60_000);

  it('writes valid literals and parenthesises every operation', () => {
    expect(toWgsl(2)).toBe('2.0');
    expect(toWgsl(-1.5)).toBe('(-1.5)');
    expect(toWgsl(1e-7)).toBe('1.0e-7');
    expect(toWgsl(['Rational', 1, 4])).toBe('0.25');
    expect(toWgsl(['Add', 'x', ['Multiply', 2, 'y']])).toBe('(x + (2.0 * y))');
    expect(toWgsl(['Power', 'x', 3])).toBe('(x * x * x)');
    expect(toWgsl(['Power', 'x', -2])).toBe('(1.0 / (x * x))');
    expect(toWgsl(['Power', 'ExponentialE', 'x'])).toBe('exp(x)');
    expect(toWgsl(['Boole', ['Less', 0, 'x', 1]])).toBe('lg_bool(((0.0 < x) && (x < 1.0)))');
  });

  it('refuses what it does not cover (that formula stays on the CPU)', () => {
    expect(toWgsl(['Gamma', 'x'])).toBeNull();
    expect(toWgsl('Psi')).toBeNull();
    expect(toWgsl(['Add', 'x', ['Zeta', 'y']])).toBeNull();
    expect(toWgsl(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('has helpers for every function the expressions call', () => {
    for (const name of ['lg_powr', 'lg_root', 'lg_round', 'lg_bool']) expect(WGSL_HELPERS).toContain(`fn ${name}(`);
  });
});
