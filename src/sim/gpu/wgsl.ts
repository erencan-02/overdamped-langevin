/**
 * Formulas (MathJSON from the Compute Engine) as WGSL expressions, for the GPU integrator.
 *
 * Covers what the formula fields produce in practice: arithmetic, powers and roots, exp / ln /
 * log, trigonometric and hyperbolic functions and their inverses, abs, sign, floor / ceil /
 * round, max / min and indicators of conditions. The variables are x, y, r, theta, t and sigma.
 * Anything else gives null, and that formula stays on the CPU. The GPU computes in single
 * precision; every compiled kernel is checked against the exact CPU values before it is used
 * (see gpuIntegrator.ts).
 *
 * The expressions may use the helper functions of WGSL_HELPERS.
 */

type Json = unknown;

/** Helper functions the generated expressions may call (put once into every kernel). */
export const WGSL_HELPERS = /* wgsl */ `
// NaN as a run-time value (a constant NaN is not allowed in WGSL); P is the kernel's parameters.
fn lg_nan() -> f32 { return bitcast<f32>(0x7fc00000u | (P.n & 0u)); }
fn lg_powr(b: f32, e: f32) -> f32 {
  // JavaScript's b ** e: negative bases work for whole exponents.
  if (b >= 0.0) { return pow(b, e); }
  if (e == floor(e)) {
    let m = pow(-b, e);
    return select(m, -m, abs(e - 2.0 * floor(e / 2.0)) == 1.0);
  }
  return lg_nan();
}
fn lg_root(a: f32, n: f32) -> f32 {
  // The real n-th root (odd n: also of negative numbers).
  if (a >= 0.0) { return pow(a, 1.0 / n); }
  if (n == floor(n) && abs(n - 2.0 * floor(n / 2.0)) == 1.0) { return -pow(-a, 1.0 / n); }
  return lg_nan();
}
fn lg_round(a: f32) -> f32 { return floor(a + 0.5); } // JavaScript's Math.round
fn lg_bool(c: bool) -> f32 { return select(0.0, 1.0, c); }
`;

const VARIABLES: Record<string, string> = { x: 'x', y: 'y', r: 'r', theta: 'theta', t: 't', sigma: 'sigma' };
const CONSTANTS: Record<string, number> = { Pi: Math.PI, ExponentialE: Math.E };

const UNARY: Record<string, (a: string) => string> = {
  Negate: (a) => `(-${a})`,
  Sqrt: (a) => `sqrt(${a})`,
  Exp: (a) => `exp(${a})`,
  Ln: (a) => `log(${a})`,
  Lb: (a) => `log2(${a})`,
  Lg: (a) => `(log(${a}) / ${lit(Math.LN10)})`,
  Abs: (a) => `abs(${a})`,
  Sign: (a) => `sign(${a})`,
  Floor: (a) => `floor(${a})`,
  Ceil: (a) => `ceil(${a})`,
  Round: (a) => `lg_round(${a})`,
  Square: (a) => `(${a} * ${a})`,
  Sin: (a) => `sin(${a})`,
  Cos: (a) => `cos(${a})`,
  Tan: (a) => `tan(${a})`,
  Sec: (a) => `(1.0 / cos(${a}))`,
  Csc: (a) => `(1.0 / sin(${a}))`,
  Cot: (a) => `(1.0 / tan(${a}))`,
  Arcsin: (a) => `asin(${a})`,
  Arccos: (a) => `acos(${a})`,
  Arctan: (a) => `atan(${a})`,
  Sinh: (a) => `sinh(${a})`,
  Cosh: (a) => `cosh(${a})`,
  Tanh: (a) => `tanh(${a})`,
  Sech: (a) => `(1.0 / cosh(${a}))`,
  Csch: (a) => `(1.0 / sinh(${a}))`,
  Coth: (a) => `(1.0 / tanh(${a}))`,
  Arsinh: (a) => `asinh(${a})`,
  Arcosh: (a) => `acosh(${a})`,
  Artanh: (a) => `atanh(${a})`,
};

const COMPARE: Record<string, string> = {
  Less: '<',
  LessEqual: '<=',
  Greater: '>',
  GreaterEqual: '>=',
  Equal: '==',
  NotEqual: '!=',
};

/** A WGSL f32 literal (always with a decimal point or exponent; negative ones in parentheses). */
function lit(v: number): string {
  if (!Number.isFinite(v)) throw new Unsupported();
  let s = String(v);
  if (!/[.eE]/.test(s)) s += '.0';
  else if (/^-?\d+e/.test(s)) s = s.replace('e', '.0e');
  return v < 0 ? `(${s})` : s;
}

class Unsupported extends Error {}

/** The formula as a WGSL f32 expression, or null if it uses something not covered. */
export function toWgsl(json: Json): string | null {
  try {
    return expr(json);
  } catch (err) {
    if (err instanceof Unsupported) return null;
    throw err;
  }
}

function numberOf(j: Json): number | null {
  if (typeof j === 'number') return j;
  if (j && typeof j === 'object' && !Array.isArray(j) && 'num' in j) {
    const v = Number((j as { num: unknown }).num);
    return Number.isFinite(v) ? v : null;
  }
  if (Array.isArray(j) && j[0] === 'Rational' && typeof j[1] === 'number' && typeof j[2] === 'number') return j[1] / j[2];
  return null;
}

function expr(j: Json): string {
  const n = numberOf(j);
  if (n !== null) return lit(n);
  if (typeof j === 'string') {
    if (j in VARIABLES) return VARIABLES[j];
    if (j in CONSTANTS) return lit(CONSTANTS[j]);
    throw new Unsupported();
  }
  if (j && typeof j === 'object' && !Array.isArray(j) && 'sym' in j) return expr((j as { sym: unknown }).sym);
  if (!Array.isArray(j) || typeof j[0] !== 'string') throw new Unsupported();
  const [head, ...args] = j as [string, ...Json[]];

  if (head === 'Rational' && args.length === 2) return `(${expr(args[0])} / ${expr(args[1])})`;
  if (head === 'Add' && args.length >= 1) return `(${args.map(expr).join(' + ')})`;
  if (head === 'Multiply' && args.length >= 1) return `(${args.map(expr).join(' * ')})`;
  if (head === 'Subtract' && args.length === 2) return `(${expr(args[0])} - ${expr(args[1])})`;
  if (head === 'Divide' && args.length === 2) return `(${expr(args[0])} / ${expr(args[1])})`;
  if (head === 'Power' && args.length === 2) return power(args[0], args[1]);
  if (head === 'Root' && args.length === 2) return `lg_root(${expr(args[0])}, ${expr(args[1])})`;
  if (head === 'Log' && args.length === 1) return `(log(${expr(args[0])}) / ${lit(Math.LN10)})`;
  if (head === 'Log' && args.length === 2) return `(log(${expr(args[0])}) / log(${expr(args[1])}))`;
  if (head === 'Arctan2' && args.length === 2) return `atan2(${expr(args[0])}, ${expr(args[1])})`;
  if ((head === 'Max' || head === 'Min') && args.length >= 1) {
    const f = head === 'Max' ? 'max' : 'min';
    return args.map(expr).reduce((a, b) => `${f}(${a}, ${b})`);
  }
  if (head === 'Boole' && args.length === 1) return `lg_bool(${condition(args[0])})`;
  const unary = UNARY[head];
  if (unary && args.length === 1) return unary(expr(args[0]));
  throw new Unsupported();
}

/** b^e: whole exponents as products (exact, any sign of b), e^x as exp, ½ as sqrt. */
function power(base: Json, exponent: Json): string {
  const e = numberOf(exponent);
  if (base === 'ExponentialE') return `exp(${expr(exponent)})`;
  const b = expr(base);
  if (e !== null && Number.isInteger(e) && Math.abs(e) <= 8) {
    if (e === 0) return '1.0';
    const product = `(${Array(Math.abs(e)).fill(b).join(' * ')})`;
    return e > 0 ? product : `(1.0 / ${product})`;
  }
  if (e === 0.5) return `sqrt(${b})`;
  // p/q with odd q: the real power (∛x)² etc., defined for negative bases too (as on the CPU).
  if (Array.isArray(exponent) && exponent[0] === 'Rational') {
    const [, p, q] = exponent as [string, unknown, unknown];
    if (typeof p === 'number' && typeof q === 'number' && Number.isInteger(p) && Number.isInteger(q) && Math.abs(q % 2) === 1) {
      return `lg_powr(lg_root(${b}, ${lit(q)}), ${lit(p)})`;
    }
  }
  return `lg_powr(${b}, ${expr(exponent)})`;
}

function condition(j: Json): string {
  if (!Array.isArray(j) || typeof j[0] !== 'string') throw new Unsupported();
  const [head, ...args] = j as [string, ...Json[]];
  if (head === 'And' || head === 'Or') {
    if (args.length < 1) throw new Unsupported();
    return `(${args.map(condition).join(head === 'And' ? ' && ' : ' || ')})`;
  }
  if (head === 'Not' && args.length === 1) return `(!${condition(args[0])})`;
  const op = COMPARE[head];
  if (!op || args.length < 2) throw new Unsupported();
  // Chains such as a < b < c mean a < b and b < c.
  const parts: string[] = [];
  for (let k = 0; k + 1 < args.length; k++) parts.push(`(${expr(args[k])} ${op} ${expr(args[k + 1])})`);
  return parts.length === 1 ? parts[0] : `(${parts.join(' && ')})`;
}
