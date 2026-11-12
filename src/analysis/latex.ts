/**
 * Formulas written in LaTeX, parsed and compiled by the Cortex Compute Engine
 * (https://cortexjs.io/compute-engine/), which runs entirely in the browser:
 *
 *  - test functions f(x, y) of the observables window (`parse`), and
 *  - potentials Ψ(t, x, y) with their exact gradient, derived symbolically (`parsePotential`).
 *
 * The engine turns LaTeX into a MathJSON tree and compiles that tree to JavaScript. This module
 * adapts it to the app: it checks that the tree is a real-valued function of the allowed
 * symbols, maps a few notations the engine reads differently (indicator functions, Ψ(x, y),
 * "f(x, y) =" or "Ψ(t, x, y) =" prefixes), turns the engine's parse errors into messages for the
 * user, and evaluates formulas at many points at once with the engine's batch evaluator.
 *
 * Every compiled formula is simplified first and then checked against the engine's own
 * arbitrary-precision evaluation at a few sample points, so a compiler mistake can never give
 * silently wrong numbers (version 0.185 compiles −(√(x²+y²))² as −x² + y², for example).
 *
 * The engine (~0.75 MB minified) is loaded on demand with `loadTexParser()`.
 */

type Json = unknown;

export interface EvalContext {
  sigma: number;
  psi(x: number, y: number): number;
}

/** A compiled test function. */
export interface CompiledObservable {
  /** f(xs[i], ys[i]) for i < n; `psi` may hold Ψ at the points already (else it is sampled). */
  evaluate(xs: Float64Array, ys: Float64Array, n: number, ctx: EvalContext, psi?: Float64Array): Float64Array;
}

export type ParseResult =
  | { ok: true; fn: CompiledObservable; usesPsi: boolean; usesSigma: boolean }
  | { ok: false; message: string };

/** A compiled potential Ψ(t, x, y) and its exact gradient. */
export interface CompiledPotential {
  /** Ψ depends on the time t (then also its gradient). */
  readonly timeDependent: boolean;
  /** Ψ depends on σ. */
  readonly usesSigma: boolean;
  /** The symbols it depends on (of x, y, r, theta, t, sigma). */
  readonly variables: ReadonlySet<string>;
  /**
   * Ψ as GLSL ES 3.0 (an expression in x, y, r, theta, t, sigma, plus helper functions), so the
   * pictures can evaluate it on the GPU; null if the formula has no GLSL form. Not trusted by
   * itself: the renderer checks it against `value` before using it.
   */
  readonly glsl: { code: string; preamble: string } | null;
  /** Ψ(t, xs[i], ys[i]) for i < n, into `out`. */
  value(xs: Float64Array, ys: Float64Array, n: number, t: number, sigma: number, out: Float64Array): void;
  /** ∂Ψ/∂x and ∂Ψ/∂y at (t, xs[i], ys[i]) for i < n, into gx and gy. */
  gradient(
    xs: Float64Array,
    ys: Float64Array,
    n: number,
    t: number,
    sigma: number,
    gx: Float64Array,
    gy: Float64Array,
  ): void;
}

export type PotentialParseResult = { ok: true; potential: CompiledPotential } | { ok: false; message: string };

export interface TexParser {
  /** A test function f(x, y) (observables). */
  parse(tex: string): ParseResult;
  /** A potential Ψ(t, x, y), differentiated symbolically. */
  parsePotential(tex: string): PotentialParseResult;
  /**
   * A coefficient of the SDE, a function of (t, x, y) and σ with its exact gradient, named
   * "u_1", "u_2" (extra drift) or "s_1", "s_2" (noise) in the input and in messages.
   */
  parseCoefficient(tex: string, name: 'u_1' | 'u_2' | 's_1' | 's_2'): PotentialParseResult;
}

const SCALAR = 'Output must be a scalar';
/** Symbols of test functions. */
const OBSERVABLE_SYMBOLS = new Set(['x', 'y', 'r', 'theta', 'sigma', 'Psi']);
/** Symbols of potentials. */
const POTENTIAL_SYMBOLS = new Set(['x', 'y', 'r', 'theta', 'sigma', 't']);
/** Inputs given per point (columns); the others are the same for all points (scalars). */
const COLUMNS = new Set(['x', 'y', 'r', 'theta', 'Psi']);
/** MathJSON heads whose value is a collection, not a number. */
const COLLECTIONS = new Set(['Tuple', 'List', 'Matrix', 'Sequence', 'Pair', 'Set', 'Range', 'Interval']);
/** MathJSON heads whose value is true/false. */
const CONDITIONS = new Set([
  'Less', 'LessEqual', 'Greater', 'GreaterEqual', 'Equal', 'NotEqual', 'And', 'Or', 'Not', 'Element', 'NotElement',
]);
/** Heads left in a derivative the engine could not work out. */
const UNRESOLVED_DERIVATIVE = new Set(['D', 'Derivative', 'Apply', 'ND']);
/** The symbols the engine reads \mathbf{1} and \mathbb{1} as. */
const ONE = new Set(['one_bold', 'one_doublestruck']);

/** Points at which every compiled formula is checked (away from the axes and the origin). */
const CHECK_POINTS: readonly [number, number][] = [
  [0.37, -0.61],
  [1.3, 0.8],
  [-0.9, 1.7],
  [-1.6, -0.45],
  [2.2, 0.15],
  [0.05, -1.25],
];

/** An error with a message meant for the user. */
class TexError extends Error {}

let loading: Promise<TexParser> | null = null;

type Engine = InstanceType<typeof import('@cortex-js/compute-engine').ComputeEngine>;
type Compile = typeof import('@cortex-js/compute-engine').compile;
type Boxed = ReturnType<Engine['box']>;

/** Loads the Compute Engine (once) and returns a parser that uses it. */
export function loadTexParser(): Promise<TexParser> {
  loading ??= import('@cortex-js/compute-engine').then(({ ComputeEngine, compile }) => {
    const ce = new ComputeEngine();
    // The inputs are real numbers (the compiler needs their types, e.g. for f = x).
    for (const name of new Set([...OBSERVABLE_SYMBOLS, ...POTENTIAL_SYMBOLS])) ce.declare(name, 'real');
    const guard = <T>(build: () => T): T | { ok: false; message: string } => {
      try {
        return build();
      } catch (err) {
        if (err instanceof TexError) return { ok: false, message: err.message };
        console.error(err);
        return { ok: false, message: 'This formula cannot be evaluated.' };
      }
    };
    return {
      parse: (tex: string) => guard(() => buildObservable(ce, compile, tex)),
      parsePotential: (tex: string) => guard(() => buildPotential(ce, compile, tex)),
      parseCoefficient: (tex: string, name: string) => guard(() => buildPotential(ce, compile, tex, coefficientSpec(name))),
    };
  });
  return loading;
}

// ------------------------------------------------------------------ test functions

function buildObservable(ce: Engine, compile: Compile, src: string): ParseResult {
  // Ψ is a number here (the potential at the point): Ψ(x, y) means just Ψ, and any other
  // argument is an error rather than a product.
  let tex = src.trim();
  tex = tex.replace(/\\Psi\s*(?:\\left\s*)?\(\s*x\s*,\s*y\s*(?:\\right\s*)?\)/g, '\\Psi ');
  if (/\\Psi\s*(?:\\left\s*)?\(/.test(tex)) throw new TexError('\\Psi can only be evaluated at (x, y).');
  const expr = readFormula(ce, tex, {
    allowed: OBSERVABLE_SYMBOLS,
    definitions: ['"f"', '["f","x","y"]'],
    name: 'f',
    hint: 'f may depend on x, y (and r, \\theta, \\sigma, \\Psi)',
    empty: 'Enter a function of x and y, e.g. x^2 + y^2.',
  });
  const f = compileChecked(compile, expr);
  const fn: CompiledObservable = {
    evaluate(xs, ys, n, ctx, psiValues) {
      const out = new Float64Array(n);
      if (n === 0) return out;
      const x = xs.subarray(0, n);
      const y = ys.subarray(0, n);
      const inputs: Record<string, Float64Array | number> = { x, y, sigma: ctx.sigma };
      if (f.uses.has('r')) inputs.r = column(n, (i) => Math.hypot(x[i], y[i]));
      if (f.uses.has('theta')) inputs.theta = column(n, (i) => Math.atan2(y[i], x[i]));
      if (f.uses.has('Psi')) {
        inputs.Psi = psiValues && psiValues.length >= n ? psiValues.subarray(0, n) : column(n, (i) => ctx.psi(x[i], y[i]));
      }
      f.evaluate(inputs, n, out);
      return out;
    },
  };
  return { ok: true, fn, usesPsi: f.uses.has('Psi'), usesSigma: f.uses.has('sigma') };
}

// ------------------------------------------------------------------ potentials

/** How a function of (t, x, y) is named in the input and in messages. */
interface FunctionSpec {
  /** LaTeX of its name, e.g. "\\Psi" or "s_1". */
  name: string;
  /** Matches the name itself in the input (an optional "name(t, x, y) =" prefix is removed). */
  pattern: string;
  /** Message for an empty input. */
  empty: string;
}

const PSI_SPEC: FunctionSpec = {
  name: '\\Psi',
  pattern: '\\\\Psi',
  empty: 'Enter a potential, e.g. \\frac{x^2 + y^2}{2}.',
};

/** A coefficient of the SDE: u_1, u_2 (extra drift) or s_1, s_2 (noise), given by its name. */
function coefficientSpec(name: string): FunctionSpec {
  const m = /^([a-z])_([12])$/.exec(name);
  if (!m) throw new Error(`Unsupported coefficient name ${name}`);
  return {
    name,
    pattern: `${m[1]}_\\{?${m[2]}\\}?`,
    empty: `Enter ${name}(t, x, y), e.g. ${m[1] === 's' ? '\\sigma' : '-y'}.`,
  };
}

function buildPotential(ce: Engine, compile: Compile, src: string, spec: FunctionSpec = PSI_SPEC): PotentialParseResult {
  // An optional "name(t, x, y) =", "name(x, y) =" or "name =" in front.
  const tex = src
    .trim()
    .replace(new RegExp(`^${spec.pattern}\\s*(?:\\\\left\\s*)?\\(\\s*(?:t\\s*,\\s*)?x\\s*,\\s*y\\s*(?:\\\\right\\s*)?\\)\\s*=`), '')
    .replace(new RegExp(`^${spec.pattern}\\s*=`), '');
  if (/\\Psi/.test(tex)) {
    throw new TexError(spec === PSI_SPEC ? '\\Psi cannot appear in its own formula.' : `${spec.name} cannot depend on \\Psi.`);
  }
  const expr = readFormula(ce, tex, {
    allowed: POTENTIAL_SYMBOLS,
    definitions: [],
    name: spec.name,
    hint: `${spec.name} may depend on x, y, t (and r, \\theta, \\sigma)`,
    empty: spec.empty,
  });
  const psi = compileChecked(compile, expr);

  // Exact gradient. r = √(x² + y²) and θ = atan2(y, x) are treated as variables of their own and
  // combined by the chain rule: ∂Ψ/∂x = Ψ_x + Ψ_r·x/r − Ψ_θ·y/r², ∂Ψ/∂y = Ψ_y + Ψ_r·y/r + Ψ_θ·x/r².
  // (Substituting r = √(x² + y²) instead would hit the compiler issue mentioned above.)
  const spatial = ['x', 'y', 'r', 'theta'].filter((v) => psi.uses.has(v));
  const d: Record<string, CheckedFormula> = {};
  for (const v of spatial) {
    const dv = ce.box(['D', expr.json, v] as Parameters<Engine['box']>[0]).evaluate();
    if (!dv.isValid || hasHead(dv.json, UNRESOLVED_DERIVATIVE)) {
      throw new TexError(`${spec.name} must be differentiable: the gradient of this formula could not be derived.`);
    }
    d[v] = compileChecked(compile, dv);
  }

  const columns = (xs: Float64Array, ys: Float64Array, n: number, t: number, sigma: number) => {
    const x = xs.subarray(0, n);
    const y = ys.subarray(0, n);
    const inputs: Record<string, Float64Array | number> = { x, y, t, sigma };
    if (psi.uses.has('r')) inputs.r = column(n, (i) => Math.hypot(x[i], y[i]));
    if (psi.uses.has('theta')) inputs.theta = column(n, (i) => Math.atan2(y[i], x[i]));
    return inputs;
  };
  const tmp = { a: new Float64Array(0) };
  const scratch = (n: number) => (tmp.a.length >= n ? tmp.a : (tmp.a = new Float64Array(n)));

  let glsl: CompiledPotential['glsl'] = null;
  try {
    const g = compile(expr.simplify(), { to: 'glsl', fallback: false });
    if (g.success && typeof g.code === 'string') {
      glsl = { code: g.code, preamble: typeof g.preamble === 'string' ? g.preamble : '' };
    }
  } catch {
    glsl = null; // drawn from the CPU instead
  }

  const potential: CompiledPotential = {
    glsl,
    variables: new Set([...psi.uses].filter((v) => POTENTIAL_SYMBOLS.has(v))),
    timeDependent: psi.uses.has('t'),
    usesSigma: psi.uses.has('sigma'),
    value(xs, ys, n, t, sigma, out) {
      if (n > 0) psi.evaluate(columns(xs, ys, n, t, sigma), n, out);
    },
    gradient(xs, ys, n, t, sigma, gx, gy) {
      if (n === 0) return;
      const inputs = columns(xs, ys, n, t, sigma);
      if (d.x) d.x.evaluate(inputs, n, gx);
      else gx.fill(0, 0, n);
      if (d.y) d.y.evaluate(inputs, n, gy);
      else gy.fill(0, 0, n);
      const r = inputs.r as Float64Array | undefined;
      if (d.r && r) {
        const dr = scratch(n);
        d.r.evaluate(inputs, n, dr);
        for (let i = 0; i < n; i++) {
          if (r[i] > 0) {
            gx[i] += (dr[i] * xs[i]) / r[i];
            gy[i] += (dr[i] * ys[i]) / r[i];
          }
        }
      }
      if (d.theta) {
        const rr = r ?? column(n, (i) => Math.hypot(xs[i], ys[i]));
        const dth = scratch(n);
        d.theta.evaluate(inputs, n, dth);
        for (let i = 0; i < n; i++) {
          const r2 = rr[i] * rr[i];
          if (r2 > 0) {
            gx[i] -= (dth[i] * ys[i]) / r2;
            gy[i] += (dth[i] * xs[i]) / r2;
          }
        }
      }
    },
  };
  checkGradient(potential, spec.name);
  return { ok: true, potential };
}

/**
 * Compares the assembled gradient with central differences of Ψ at the check points, which
 * catches a wrong derivative as well as a wrong chain rule.
 */
function checkGradient(p: CompiledPotential, name: string): void {
  const n = CHECK_POINTS.length;
  const xs = Float64Array.from(CHECK_POINTS, (q) => q[0]);
  const ys = Float64Array.from(CHECK_POINTS, (q) => q[1]);
  const gx = new Float64Array(n);
  const gy = new Float64Array(n);
  const t = 0.37;
  const sigma = 0.6;
  p.gradient(xs, ys, n, t, sigma, gx, gy);
  const h = 1e-5;
  const shifted = (dx: number, dy: number) => {
    const out = new Float64Array(n);
    p.value(
      xs.map((v) => v + dx),
      ys.map((v) => v + dy),
      n,
      t,
      sigma,
      out,
    );
    return out;
  };
  const xp = shifted(h, 0);
  const xm = shifted(-h, 0);
  const yp = shifted(0, h);
  const ym = shifted(0, -h);
  for (let i = 0; i < n; i++) {
    const fdx = (xp[i] - xm[i]) / (2 * h);
    const fdy = (yp[i] - ym[i]) / (2 * h);
    if (!Number.isFinite(fdx) || !Number.isFinite(fdy)) continue; // undefined there (e.g. √x at x < 0)
    const scale = 1 + Math.abs(fdx) + Math.abs(fdy);
    if (!(Math.abs(gx[i] - fdx) <= 1e-4 * scale && Math.abs(gy[i] - fdy) <= 1e-4 * scale)) {
      throw new TexError(`${name} must be differentiable: its derived gradient does not match the formula.`);
    }
  }
}

// ------------------------------------------------------------------ shared: read and compile

interface FormulaSpec {
  allowed: Set<string>;
  /** MathJSON (stringified) of left-hand sides that may precede "=" (e.g. f(x, y)). */
  definitions: string[];
  name: string;
  hint: string;
  empty: string;
}

/** Parses LaTeX into a valid, scalar expression of the allowed symbols (or throws a TexError). */
function readFormula(ce: Engine, src: string, spec: FormulaSpec): Boxed {
  const tex = src.trim();
  if (tex.length > 500) throw new TexError('The expression is too long (max. 500 characters).');
  if (tex === '') throw new TexError(spec.empty);

  const raw: Json = ce.parse(tex).json;
  const error = findError(raw, null);
  if (error) throw new TexError(error);

  let json = stripDefinition(raw, spec);
  json = adapt(json);
  checkScalar(json);

  const expr = ce.box(json as Parameters<Engine['box']>[0]);
  if (!expr.isValid) throw new TexError('This formula cannot be evaluated.');
  const unknowns = expr.unknowns.filter((s) => !spec.allowed.has(s));
  if (unknowns.length) {
    const name = unknowns[0];
    throw new TexError(
      /_bold$/.test(name)
        ? `${SCALAR}: bold letters denote vectors. Write x and y separately.`
        : `Unknown variable "${name}": ${spec.hint}.`,
    );
  }
  return expr;
}

interface CheckedFormula {
  /** Free symbols of the formula. */
  uses: Set<string>;
  /** The formula at n points into `out`; columns hold one value per point, scalars one in all. */
  evaluate(inputs: Record<string, Float64Array | number>, n: number, out: Float64Array): void;
}

/**
 * Simplifies and compiles `expr`, checks that it gives numbers, and that the compiled code
 * agrees with the engine's own numeric evaluation of the original expression at CHECK_POINTS.
 */
function compileChecked(compile: Compile, expr: Boxed): CheckedFormula {
  const uses = new Set(expr.unknowns);
  let compiled: ReturnType<Compile>;
  try {
    compiled = compile(expr.simplify(), { fallback: false });
  } catch (err) {
    const m = /Unknown operator `([^`]+)`/.exec(String((err as Error).message));
    throw new TexError(m ? `Unknown function "${m[1]}".` : 'This formula cannot be evaluated.');
  }
  const run = compiled.run?.bind(compiled);
  const broadcast = compiled.broadcast?.bind(compiled);
  if (!run || !broadcast) throw new TexError('This formula cannot be evaluated.');

  CHECK_POINTS.forEach(([x, y], k) => {
    const at: Record<string, number> = {
      x,
      y,
      r: Math.hypot(x, y),
      theta: Math.atan2(y, x),
      sigma: 0.6,
      t: 0.37 + 0.11 * k,
      Psi: 0.4 - 0.13 * k,
    };
    const got = run({ ...at });
    // A function symbol on its own (\sin), a list or a condition does not give a number.
    if (typeof got !== 'number') {
      throw new TexError(
        typeof got === 'function'
          ? 'A function needs an argument, e.g. \\sin(x).'
          : typeof got === 'boolean'
            ? `${SCALAR}, not a true/false condition. For an indicator write \\mathbf{1}_{…}.`
            : `${SCALAR}.`,
      );
    }
    const values: Record<string, number> = {};
    for (const s of uses) if (s in at) values[s] = at[s];
    const want = numericValue(expr.subs(values).N());
    const bothUndefined = !Number.isFinite(got) && !Number.isFinite(want);
    if (!bothUndefined && !(Math.abs(got - want) <= 1e-9 * Math.max(1, Math.abs(want)))) {
      throw new TexError(
        'The formula engine evaluates this expression inconsistently. Please write it differently ' +
          '(e.g. expand powers of square roots).',
      );
    }
  });

  const columns = [...uses].filter((s) => COLUMNS.has(s));
  return {
    uses,
    evaluate(inputs, n, out) {
      if (columns.length === 0) {
        // Same value everywhere (e.g. a derivative that is constant).
        const scalars: Record<string, number> = {};
        for (const s of uses) scalars[s] = inputs[s] as number;
        out.fill(Number(run(scalars)), 0, n);
        return;
      }
      const used: Record<string, Float64Array | number> = {};
      for (const s of uses) used[s] = inputs[s];
      out.set(broadcast(used).subarray(0, n));
    },
  };
}

/** A real number from an engine value; NaN for complex or non-numeric results. */
function numericValue(v: { re: number; im: number }): number {
  const re = Number(v.re);
  const im = Number(v.im);
  return Number.isFinite(im) && im !== 0 ? Number.NaN : re;
}

function column(n: number, value: (i: number) => number): Float64Array {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = value(i);
  return out;
}

// ------------------------------------------------------------------ MathJSON helpers

const isArr = (j: Json): j is Json[] => Array.isArray(j);
/** MathJSON strings are quoted: "'text'". */
const unquote = (s: unknown) => (typeof s === 'string' ? s.replace(/^'(.*)'$/s, '$1') : '');

function hasHead(j: Json, heads: Set<string>): boolean {
  if (!isArr(j)) return false;
  if (typeof j[0] === 'string' && heads.has(j[0])) return true;
  return j.some((e, k) => k > 0 && hasHead(e, heads)) || (isArr(j[0]) && hasHead(j[0], heads));
}

/** The first parse error in the tree, as a message for the user. */
function findError(j: Json, parent: string | null): string | null {
  if (!isArr(j)) return null;
  if (j[0] === 'Error') {
    const codeNode = j[1];
    const code = isArr(codeNode) ? unquote(codeNode[1]) : unquote(codeNode);
    const detail = isArr(codeNode) ? unquote(codeNode[2]) : '';
    const at = isArr(j[2]) && j[2][0] === 'LatexString' ? unquote(j[2][1]) : detail;
    switch (code) {
      case 'unexpected-command':
        return `Unknown command ${at}.`;
      case 'unexpected-delimiter':
        return at === '(' || at === '[' || at === '\\{' || at === '\\left'
          ? `Missing closing bracket for "${at}".`
          : `Unmatched "${at}".`;
      case 'expected-closing-delimiter':
        return 'Missing closing bracket.';
      case 'missing':
        return parent === 'Power'
          ? 'Missing exponent.'
          : parent === 'Divide'
            ? 'Missing denominator.'
            : 'Something is missing (an operand or an argument).';
      case 'unexpected-operator':
        return `"${at}" needs something on both sides.`;
      case 'unexpected-token':
        return `Unexpected character "${at || detail}".`;
      default:
        return at ? `Could not read the formula near "${at}".` : 'Could not read the formula.';
    }
  }
  const head = typeof j[0] === 'string' ? j[0] : null;
  for (let k = 1; k < j.length; k++) {
    const e = findError(j[k], head);
    if (e) return e;
  }
  return null;
}

/** "f(x, y) = …" or "f = …" → "…"; any other equation is an error. */
function stripDefinition(j: Json, spec: FormulaSpec): Json {
  if (!isArr(j) || j[0] !== 'Equal') return j;
  if (j.length === 3 && spec.definitions.includes(JSON.stringify(j[1]))) return j[2];
  throw new TexError(`Write only the expression for ${spec.name}, not an equation.`);
}

/** Rewrites the notations the engine reads differently from the app. */
function adapt(j: Json): Json {
  if (!isArr(j)) return j;
  const head = j[0];
  // \mathbf{1}_{cond}, \mathbb{1}_{\{cond\}}: indicator → Boole (1 if true, else 0).
  if (head === 'Subscript' && ONE.has(j[1] as string)) return ['Boole', condition(adapt(j[2]))];
  // \mathbf{1}\{cond\} is read as If(cond, one).
  if (head === 'If' && j.length === 3 && ONE.has(j[2] as string)) return ['Boole', condition(adapt(j[1]))];
  return j.map((e, k) => (k === 0 ? e : adapt(e)));
}

/** The condition of an indicator ({cond} is read as If(cond, 1)). */
function condition(j: Json): Json {
  const c = isArr(j) && j[0] === 'If' && j.length === 3 && j[2] === 1 ? j[1] : j;
  if (!(isArr(c) && CONDITIONS.has(c[0] as string))) {
    throw new TexError('An indicator needs a condition such as x > 0.');
  }
  return c;
}

/** Rejects vectors, lists and conditions with a clear message. */
function checkScalar(j: Json): void {
  if (isArr(j) && CONDITIONS.has(j[0] as string)) {
    throw new TexError(`${SCALAR}, not a true/false condition. For an indicator write \\mathbf{1}_{…}.`);
  }
  const walk = (n: Json): void => {
    if (!isArr(n)) return;
    const h = n[0];
    if (h === 'Boole') return; // its argument is a condition by design
    if (COLLECTIONS.has(h as string)) {
      throw new TexError(
        h === 'List'
          ? `${SCALAR}: square brackets make a list. Use ( ) for grouping.`
          : h === 'Matrix'
            ? `${SCALAR}: vectors and matrices are not supported.`
            : `${SCALAR}: (a, b) is a tuple, not a number.`,
      );
    }
    if (h === 'OverVector' || h === 'Vector') throw new TexError(`${SCALAR}: vectors are not supported.`);
    for (let k = 1; k < n.length; k++) walk(n[k]);
  };
  walk(j);
}
