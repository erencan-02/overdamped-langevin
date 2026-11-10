/**
 * Test functions f(x, y) written in LaTeX, parsed and compiled by the Cortex Compute Engine
 * (https://cortexjs.io/compute-engine/), which runs entirely in the browser.
 *
 * The engine turns LaTeX into a MathJSON tree and compiles that tree to JavaScript. This module
 * only adapts it to the app: it checks that the tree is a real-valued function of the allowed
 * symbols, maps a few notations the engine reads differently (indicator functions, Ψ(x, y),
 * an "f(x, y) =" prefix), turns the engine's parse errors into messages for the user, and
 * evaluates f at many points at once with the engine's batch evaluator.
 *
 * Symbols: x, y, r = √(x²+y²), \theta = atan2(y, x), \sigma (diffusivity), \Psi (potential at
 * the point), plus the engine's constants (\pi, e, …).
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

export interface TexParser {
  parse(tex: string): ParseResult;
}

const SCALAR = 'Output must be a scalar';
const ALLOWED = new Set(['x', 'y', 'r', 'theta', 'sigma', 'Psi']);
/** MathJSON heads whose value is a collection, not a number. */
const COLLECTIONS = new Set(['Tuple', 'List', 'Matrix', 'Sequence', 'Pair', 'Set', 'Range', 'Interval']);
/** MathJSON heads whose value is true/false. */
const CONDITIONS = new Set([
  'Less', 'LessEqual', 'Greater', 'GreaterEqual', 'Equal', 'NotEqual', 'And', 'Or', 'Not', 'Element', 'NotElement',
]);
/** The symbols the engine reads \mathbf{1} and \mathbb{1} as. */
const ONE = new Set(['one_bold', 'one_doublestruck']);
/** Sample point used to check that the result is a number. */
const PROBE = { x: 0.37, y: -0.61, r: Math.hypot(0.37, -0.61), theta: Math.atan2(-0.61, 0.37), sigma: 0.6, Psi: 0.4 };

/** An error with a message meant for the user. */
class TexError extends Error {}

let loading: Promise<TexParser> | null = null;

/** Loads the Compute Engine (once) and returns a parser that uses it. */
export function loadTexParser(): Promise<TexParser> {
  loading ??= import('@cortex-js/compute-engine').then(({ ComputeEngine, compile }) => {
    const ce = new ComputeEngine();
    // The inputs are real numbers (the compiler needs their types, e.g. for f = x).
    for (const name of ALLOWED) ce.declare(name, 'real');
    return {
      parse(tex: string): ParseResult {
        try {
          return { ok: true, ...build(ce, compile, tex) };
        } catch (err) {
          if (err instanceof TexError) return { ok: false, message: err.message };
          console.error(err);
          return { ok: false, message: 'This formula cannot be evaluated.' };
        }
      },
    };
  });
  return loading;
}

type Engine = InstanceType<typeof import('@cortex-js/compute-engine').ComputeEngine>;
type Compile = typeof import('@cortex-js/compute-engine').compile;

function build(ce: Engine, compile: Compile, src: string) {
  const tex = src.trim();
  if (tex.length > 500) throw new TexError('The expression is too long (max. 500 characters).');
  if (tex === '') throw new TexError('Enter a function of x and y, e.g. x^2 + y^2.');

  // Ψ is a number here (the potential at the point): Ψ(x, y) means just Ψ, and any other
  // argument is an error rather than a product.
  const source = tex.replace(/\\Psi\s*(?:\\left\s*)?\(\s*x\s*,\s*y\s*(?:\\right\s*)?\)/g, '\\Psi ');
  if (/\\Psi\s*(?:\\left\s*)?\(/.test(source)) throw new TexError('\\Psi can only be evaluated at (x, y).');

  const parsed = ce.parse(source);
  const raw: Json = parsed.json;
  const error = findError(raw, null);
  if (error) throw new TexError(error);

  let json = stripDefinition(raw);
  json = adapt(json);
  checkScalar(json);

  const expr = ce.box(json as Parameters<Engine['box']>[0]);
  if (!expr.isValid) throw new TexError('This formula cannot be evaluated.');
  const unknowns = expr.unknowns.filter((s) => !ALLOWED.has(s));
  if (unknowns.length) {
    const name = unknowns[0];
    throw new TexError(
      /_bold$/.test(name)
        ? `${SCALAR}: bold letters denote vectors. Write x and y separately.`
        : `Unknown variable "${name}": f may depend on x, y (and r, \\theta, \\sigma, \\Psi).`,
    );
  }

  let compiled: ReturnType<Compile>;
  try {
    compiled = compile(expr, { fallback: false });
  } catch (err) {
    const m = /Unknown operator `([^`]+)`/.exec(String((err as Error).message));
    throw new TexError(m ? `Unknown function "${m[1]}".` : 'This formula cannot be evaluated.');
  }
  const run = compiled.run?.bind(compiled);
  const broadcast = compiled.broadcast?.bind(compiled);
  if (!run || !broadcast) throw new TexError('This formula cannot be evaluated.');
  // A function symbol on its own (\sin), a list or a condition does not give a number.
  const probe = run({ ...PROBE });
  if (typeof probe !== 'number') {
    throw new TexError(
      typeof probe === 'function'
        ? 'A function needs an argument, e.g. \\sin(x).'
        : typeof probe === 'boolean'
          ? `${SCALAR}, not a true/false condition. For an indicator write \\mathbf{1}_{…}.`
          : `${SCALAR}.`,
    );
  }

  const used = new Set(expr.unknowns);
  const usesPsi = used.has('Psi');
  const usesSigma = used.has('sigma');
  const usesR = used.has('r');
  const usesTheta = used.has('theta');
  const constant = !used.has('x') && !used.has('y') && !usesR && !usesTheta && !usesPsi;

  const fn: CompiledObservable = {
    evaluate(xs, ys, n, ctx, psiValues) {
      if (n === 0) return new Float64Array(0);
      if (constant) {
        return new Float64Array(n).fill(Number(run({ sigma: ctx.sigma })));
      }
      const x = xs.length === n ? xs : xs.subarray(0, n);
      const y = ys.length === n ? ys : ys.subarray(0, n);
      const inputs: Record<string, Float64Array | number> = { x, y };
      if (usesSigma) inputs.sigma = ctx.sigma;
      if (usesR) inputs.r = column(n, (i) => Math.hypot(x[i], y[i]));
      if (usesTheta) inputs.theta = column(n, (i) => Math.atan2(y[i], x[i]));
      if (usesPsi) {
        inputs.Psi = psiValues && psiValues.length >= n ? psiValues.subarray(0, n) : column(n, (i) => ctx.psi(x[i], y[i]));
      }
      return broadcast(inputs);
    },
  };
  return { fn, usesPsi, usesSigma };
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
function stripDefinition(j: Json): Json {
  if (!isArr(j) || j[0] !== 'Equal') return j;
  const lhs = JSON.stringify(j[1]);
  if (j.length === 3 && (lhs === '"f"' || lhs === '["f","x","y"]')) return j[2];
  throw new TexError('Write only the expression for f, not an equation.');
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
