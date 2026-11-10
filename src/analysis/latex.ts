/**
 * Parser for scalar functions f(x, y) written in LaTeX, compiled into a fast JavaScript closure.
 * User input is never evaluated as code: it is tokenised, parsed into a syntax tree by a
 * recursive-descent parser, and the tree is turned into nested closures.
 *
 * Supported (standard LaTeX math notation):
 *  - numbers, the variables x, y, r = √(x²+y²), \theta = atan2(y, x)
 *  - constants \pi, e (or \mathrm{e}), \sigma (current diffusivity), \Psi (potential at (x, y))
 *  - + − · × * /, implicit multiplication (2x, x y, 2\sin x), powers x^2, x^{-1}, e^{x}
 *  - \frac{a}{b} (also \dfrac, \tfrac, \frac12), \sqrt{a}, \sqrt[n]{a}
 *  - ( ) [ ] { } \{ \}, \left( … \right), |a|, \lvert a \rvert, \lfloor a \rfloor, \lceil a \rceil
 *  - \sin \cos \tan \cot \sec \csc \sinh \cosh \tanh \arcsin \arccos \arctan \exp \log \ln,
 *    \log_{b}, \sin^2 x, \max(a, b, …), \min(…), \operatorname{sgn|sign|abs|floor|ceil|atan2}
 *  - indicators \mathbf{1}_{x>0}, \mathbb{1}_{\{x \le 1 \land y > 0\}}, chained a < x < b
 *  - an optional prefix "f(x, y) =" or "f ="
 */

export interface CompiledFunction {
  /** Evaluates f at (x, y). */
  (x: number, y: number, ctx: EvalContext): number;
}

export interface EvalContext {
  sigma: number;
  psi(x: number, y: number): number;
}

export type ParseResult =
  | { ok: true; fn: CompiledFunction; usesPsi: boolean; usesSigma: boolean }
  | { ok: false; message: string };

/** A parse error with a message meant for the user. */
export class TexError extends Error {}

// ------------------------------------------------------------------ tokens

type Token =
  | { k: 'num'; v: string; p: number }
  | { k: 'cmd'; v: string; p: number }
  | { k: 'id'; v: string; p: number }
  | { k: 'sym'; v: string; p: number }
  | { k: 'end'; v: ''; p: number };

const SPACING = new Set(['\\,', '\\;', '\\:', '\\!', '\\ ', '\\quad', '\\qquad', '\\displaystyle']);

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '\\') {
      const m = /^\\([a-zA-Z]+|.)/.exec(src.slice(i));
      if (!m) throw new TexError('A backslash must be followed by a command name.');
      const cmd = m[0];
      i += cmd.length;
      if (SPACING.has(cmd)) continue;
      if (cmd === '\\{' || cmd === '\\}') out.push({ k: 'sym', v: cmd, p: i - cmd.length });
      else out.push({ k: 'cmd', v: cmd, p: i - cmd.length });
      continue;
    }
    const num = /^(\d+\.?\d*|\.\d+)/.exec(src.slice(i));
    if (num) {
      out.push({ k: 'num', v: num[0], p: i });
      i += num[0].length;
      continue;
    }
    if (/[a-zA-Z]/.test(c)) {
      out.push({ k: 'id', v: c, p: i });
      i++;
      continue;
    }
    if ('+-*/^_()[]{}|,<>=!\''.includes(c)) {
      out.push({ k: 'sym', v: c, p: i });
      i++;
      continue;
    }
    if (c === '·' || c === '×') {
      out.push({ k: 'cmd', v: '\\cdot', p: i });
      i++;
      continue;
    }
    if (c === '≤' || c === '≥') {
      out.push({ k: 'cmd', v: c === '≤' ? '\\le' : '\\ge', p: i });
      i++;
      continue;
    }
    throw new TexError(`Unexpected character "${c}".`);
  }
  out.push({ k: 'end', v: '', p: src.length });
  return out;
}

// ------------------------------------------------------------------ syntax tree

type Node =
  | { t: 'num'; v: number }
  | { t: 'var'; v: 'x' | 'y' | 'r' | 'theta' }
  | { t: 'const'; v: 'sigma' | 'psi' }
  | { t: 'neg'; a: Node }
  | { t: 'bin'; op: '+' | '-' | '*' | '/' | '^'; a: Node; b: Node }
  | { t: 'call'; f: string; args: Node[] }
  | { t: 'cmp'; op: '<' | '>' | '<=' | '>='; a: Node; b: Node }
  | { t: 'logic'; op: 'and' | 'or'; a: Node; b: Node }
  | { t: 'ind'; cond: Node };

const UNARY_FUNCS: Record<string, (v: number) => number> = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  cot: (v) => 1 / Math.tan(v),
  sec: (v) => 1 / Math.cos(v),
  csc: (v) => 1 / Math.sin(v),
  sinh: Math.sinh,
  cosh: Math.cosh,
  tanh: Math.tanh,
  arcsin: Math.asin,
  arccos: Math.acos,
  arctan: Math.atan,
  exp: Math.exp,
  ln: Math.log,
  log: Math.log,
  sgn: Math.sign,
  sign: Math.sign,
  abs: Math.abs,
  floor: Math.floor,
  ceil: Math.ceil,
  sqrt: Math.sqrt,
};
/** Commands that are functions (\sin, \max, …). */
const FUNC_COMMANDS = new Set([
  ...['sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'sinh', 'cosh', 'tanh', 'arcsin', 'arccos', 'arctan'],
  ...['exp', 'ln', 'log', 'max', 'min'],
].map((n) => `\\${n}`));
const OPERATOR_NAMES = new Set(['sgn', 'sign', 'abs', 'floor', 'ceil', 'atan2', 'max', 'min', ...Object.keys(UNARY_FUNCS)]);
const CMP: Record<string, '<' | '>' | '<=' | '>='> = {
  '<': '<',
  '>': '>',
  '\\lt': '<',
  '\\gt': '>',
  '\\le': '<=',
  '\\leq': '<=',
  '\\leqslant': '<=',
  '\\ge': '>=',
  '\\geq': '>=',
  '\\geqslant': '>=',
};
const SCALAR_HINT = 'Output must be a scalar';

class Parser {
  private i = 0;
  /** Depth of |…| being parsed: a "|" then closes instead of opening. */
  private absDepth = 0;
  usesPsi = false;
  usesSigma = false;

  constructor(private readonly tok: Token[]) {}

  private get cur(): Token {
    return this.tok[this.i];
  }

  private peek(o = 1): Token {
    return this.tok[Math.min(this.i + o, this.tok.length - 1)];
  }

  private atEnd(): boolean {
    return this.cur.k === 'end';
  }

  private isSym(v: string, t = this.cur): boolean {
    return t.k === 'sym' && t.v === v;
  }

  private isCmd(v: string, t = this.cur): boolean {
    return t.k === 'cmd' && t.v === v;
  }

  private expectSym(v: string, what: string): void {
    if (!this.isSym(v)) throw new TexError(`Missing "${v}" ${what}.`);
    this.i++;
  }

  // ---------------------------------------------------------------- entry

  parse(): Node {
    this.skipDefinition();
    if (this.atEnd()) throw new TexError('Enter a function of x and y, e.g. x^2 + y^2.');
    const node = this.parseCondition();
    if (node.t === 'cmp' || node.t === 'logic') {
      throw new TexError(`${SCALAR_HINT}, not a true/false condition. For an indicator write \\mathbf{1}_{…}.`);
    }
    if (this.isSym(',')) throw new TexError(`${SCALAR_HINT}: a comma makes it a tuple of values.`);
    if (this.isSym('=')) throw new TexError('Write only the expression for f, not an equation.');
    if (!this.atEnd()) throw new TexError(`Unexpected "${this.cur.v}".`);
    return node;
  }

  /** Skips an optional "f(x,y) =" or "f =" prefix. */
  private skipDefinition(): void {
    const t = this.tok;
    const eq = t.findIndex((x) => x.k === 'sym' && x.v === '=');
    if (eq < 0) return;
    const head = t.slice(0, eq).map((x) => (x.k === 'end' ? '' : x.v)).join('');
    if (head === 'f' || head === 'f(x,y)') this.i = eq + 1;
    else throw new TexError('Write only the expression for f, not an equation.');
  }

  // ---------------------------------------------------------------- conditions

  /** expr (cmp expr)* with \land / \lor; chained comparisons a < x < b mean a < x ∧ x < b. */
  private parseCondition(): Node {
    let left = this.parseComparison();
    for (;;) {
      if (this.isCmd('\\land') || this.isCmd('\\wedge')) {
        this.i++;
        left = { t: 'logic', op: 'and', a: left, b: this.parseComparison() };
      } else if (this.isCmd('\\lor') || this.isCmd('\\vee')) {
        this.i++;
        left = { t: 'logic', op: 'or', a: left, b: this.parseComparison() };
      } else {
        return left;
      }
    }
  }

  private parseComparison(): Node {
    const first = this.parseSum();
    let prev = first;
    let result: Node | null = null;
    for (;;) {
      const op = CMP[this.cur.v];
      if (!op || (this.cur.k !== 'sym' && this.cur.k !== 'cmd')) break;
      this.i++;
      const next = this.parseSum();
      const cmp: Node = { t: 'cmp', op, a: prev, b: next };
      result = result ? { t: 'logic', op: 'and', a: result, b: cmp } : cmp;
      prev = next;
    }
    return result ?? first;
  }

  // ---------------------------------------------------------------- arithmetic

  private parseSum(): Node {
    let left = this.parseProduct();
    while (this.isSym('+') || this.isSym('-')) {
      const op = this.cur.v as '+' | '-';
      this.i++;
      left = { t: 'bin', op, a: left, b: this.parseProduct() };
    }
    return left;
  }

  private parseProduct(): Node {
    let left = this.parseUnary();
    for (;;) {
      if (this.isCmd('\\cdot') || this.isCmd('\\times') || this.isSym('*')) {
        this.i++;
        left = { t: 'bin', op: '*', a: left, b: this.parseUnary() };
      } else if (this.isSym('/') || this.isCmd('\\div')) {
        this.i++;
        left = { t: 'bin', op: '/', a: left, b: this.parseUnary() };
      } else if (this.startsPrimary(this.cur)) {
        left = { t: 'bin', op: '*', a: left, b: this.parsePower() }; // implicit multiplication
      } else {
        return left;
      }
    }
  }

  private parseUnary(): Node {
    if (this.isSym('-')) {
      this.i++;
      return { t: 'neg', a: this.parseUnary() };
    }
    if (this.isSym('+')) {
      this.i++;
      return this.parseUnary();
    }
    return this.parsePower();
  }

  private parsePower(): Node {
    const base = this.parsePrimary();
    if (!this.isSym('^')) return base;
    this.i++;
    const exp = this.parseScript('exponent');
    if (this.isSym('^')) throw new TexError('Double exponent: use braces, e.g. x^{y^2}.');
    return { t: 'bin', op: '^', a: base, b: exp };
  }

  /** A superscript/subscript or \frac argument: {group} or a single token (x^23 = x²·3). */
  private parseScript(what: string): Node {
    if (this.isSym('{')) return this.parseGroup('{', '}');
    const t = this.cur;
    if (t.k === 'num') {
      // Only the first digit belongs to the script, as in LaTeX.
      if (t.v.length > 1) {
        this.tok[this.i] = { k: 'num', v: t.v.slice(1), p: t.p + 1 };
        return { t: 'num', v: Number(t.v[0]) };
      }
      this.i++;
      return { t: 'num', v: Number(t.v) };
    }
    if (t.k === 'id' || t.k === 'cmd') return this.parsePrimary();
    if (this.isSym('-')) throw new TexError(`Use braces for a negative ${what}, e.g. x^{-1}.`);
    throw new TexError(`Missing ${what}.`);
  }

  private parseGroup(open: string, close: string): Node {
    this.expectSym(open, '');
    const prevAbs = this.absDepth;
    this.absDepth = 0;
    const node = this.parseSum();
    this.absDepth = prevAbs;
    if (this.isSym(',')) throw new TexError(`${SCALAR_HINT}: a comma makes it a tuple of values.`);
    this.expectSym(close, `to close "${open}"`);
    return node;
  }

  /** "(a, b, …)" etc.: comma-separated expressions until `close`. */
  private parseList(close: string): Node[] {
    const prevAbs = this.absDepth;
    this.absDepth = 0;
    const items = [this.parseSum()];
    while (this.isSym(',')) {
      this.i++;
      items.push(this.parseSum());
    }
    this.absDepth = prevAbs;
    if (close.startsWith('\\right')) {
      if (!this.isCmd('\\right')) throw new TexError('Missing \\right to close \\left.');
      this.i++;
      this.i++; // the closing delimiter after \right
    } else {
      this.expectSym(close, 'to close the bracket');
    }
    return items;
  }

  private startsPrimary(t: Token): boolean {
    if (t.k === 'num' || t.k === 'id') return true;
    if (t.k === 'sym') return ['(', '[', '{', '\\{'].includes(t.v) || (t.v === '|' && this.absDepth === 0);
    if (t.k === 'cmd') {
      return !['\\cdot', '\\times', '\\div', '\\right', '\\rvert', '\\rfloor', '\\rceil', '\\land', '\\wedge', '\\lor', '\\vee'].includes(t.v) && !(t.v in CMP);
    }
    return false;
  }

  // ---------------------------------------------------------------- primaries

  private parsePrimary(): Node {
    const t = this.cur;
    switch (t.k) {
      case 'num':
        this.i++;
        return { t: 'num', v: Number(t.v) };
      case 'id':
        this.i++;
        return this.identifier(t.v);
      case 'sym':
        return this.parseBracket(t.v);
      case 'cmd':
        return this.parseCommand(t.v);
      default:
        throw new TexError('The expression ends too early.');
    }
  }

  private identifier(name: string): Node {
    if (name === 'x' || name === 'y' || name === 'r') return { t: 'var', v: name };
    if (name === 'e') return { t: 'num', v: Math.E };
    throw new TexError(`Unknown variable "${name}": f may depend on x, y (and r, \\theta).`);
  }

  private parseBracket(v: string): Node {
    if (v === '(' || v === '[' || v === '\\{') {
      this.i++;
      const items = this.parseList(v === '(' ? ')' : v === '[' ? ']' : '\\}');
      if (items.length > 1) throw new TexError(`${SCALAR_HINT}: (a, b) is a tuple, not a number.`);
      return items[0];
    }
    if (v === '{') return this.parseGroup('{', '}');
    if (v === '|') {
      this.i++;
      this.absDepth++;
      const inner = this.parseSum();
      this.absDepth--;
      this.expectSym('|', 'to close |…|');
      return { t: 'call', f: 'abs', args: [inner] };
    }
    if (v === ')' || v === ']' || v === '}') throw new TexError(`Unmatched "${v}".`);
    if (v === '^' || v === '_') throw new TexError(`"${v}" needs something before it.`);
    if (v === '=') throw new TexError('Write only the expression for f, not an equation.');
    if (v === ',') throw new TexError(`${SCALAR_HINT}: a comma makes it a tuple of values.`);
    if (v === '!') throw new TexError('Factorials are not supported.');
    throw new TexError(`Unexpected "${v}".`);
  }

  private parseCommand(cmd: string): Node {
    // Constants
    if (cmd === '\\pi') return this.advance({ t: 'num', v: Math.PI });
    if (cmd === '\\sigma') {
      this.usesSigma = true;
      return this.advance({ t: 'const', v: 'sigma' });
    }
    if (cmd === '\\theta' || cmd === '\\vartheta') return this.advance({ t: 'var', v: 'theta' });
    if (cmd === '\\Psi') {
      this.usesPsi = true;
      this.i++;
      this.skipArgumentsXY();
      return { t: 'const', v: 'psi' };
    }
    if (cmd === '\\infty') throw new TexError('\\infty is not a number.');
    if (cmd === '\\mathrm' || cmd === '\\text' || cmd === '\\textrm' || cmd === '\\mathit') {
      this.i++;
      const name = this.readBracedName();
      if (name === 'e') return { t: 'num', v: Math.E };
      if (name === 'x' || name === 'y' || name === 'r') return { t: 'var', v: name };
      throw new TexError(`Unknown name "${name}".`);
    }
    // Structures
    if (cmd === '\\frac' || cmd === '\\dfrac' || cmd === '\\tfrac') {
      this.i++;
      const a = this.parseScript('numerator');
      const b = this.parseScript('denominator');
      return { t: 'bin', op: '/', a, b };
    }
    if (cmd === '\\sqrt') {
      this.i++;
      let index: Node | null = null;
      if (this.isSym('[')) {
        this.i++;
        index = this.parseSum();
        this.expectSym(']', 'to close the root index');
      }
      const arg = this.parseScript('argument of \\sqrt');
      return index
        ? { t: 'bin', op: '^', a: arg, b: { t: 'bin', op: '/', a: { t: 'num', v: 1 }, b: index } }
        : { t: 'call', f: 'sqrt', args: [arg] };
    }
    if (cmd === '\\left') return this.parseLeftRight();
    if (cmd === '\\lvert' || cmd === '\\lfloor' || cmd === '\\lceil') {
      this.i++;
      const inner = this.parseSum();
      const close = cmd === '\\lvert' ? '\\rvert' : cmd === '\\lfloor' ? '\\rfloor' : '\\rceil';
      if (!this.isCmd(close)) throw new TexError(`Missing ${close}.`);
      this.i++;
      return { t: 'call', f: cmd === '\\lvert' ? 'abs' : cmd === '\\lfloor' ? 'floor' : 'ceil', args: [inner] };
    }
    if (cmd === '\\mathbf' || cmd === '\\mathbb' || cmd === '\\mathds' || cmd === '\\mathbbm' || cmd === '\\boldsymbol') {
      return this.parseIndicatorOrBold(cmd);
    }
    if (cmd === '\\operatorname') {
      this.i++;
      const name = this.readBracedName();
      if (!OPERATOR_NAMES.has(name)) throw new TexError(`Unknown function \\operatorname{${name}}.`);
      return this.parseFunction(name);
    }
    if (FUNC_COMMANDS.has(cmd)) {
      this.i++;
      return this.parseFunction(cmd.slice(1));
    }
    if (cmd === '\\begin' || cmd === '\\vec' || cmd === '\\binom' || cmd === '\\pmatrix') {
      throw new TexError(`${SCALAR_HINT}: vectors and matrices are not supported.`);
    }
    if (cmd === '\\cdot' || cmd === '\\times' || cmd === '\\div') throw new TexError(`"${cmd}" needs something before it.`);
    if (cmd in CMP) throw new TexError(`"${cmd}" needs something before it.`);
    if (cmd === '\\right') throw new TexError('\\right without a matching \\left.');
    throw new TexError(`Unknown command ${cmd}.`);
  }

  private advance(n: Node): Node {
    this.i++;
    return n;
  }

  /** Skips "(x, y)" after \Psi (any other argument is an error). */
  private skipArgumentsXY(): void {
    if (!this.isSym('(')) return;
    const want = ['(', 'x', ',', 'y', ')'];
    for (let k = 0; k < want.length; k++) {
      if (this.peek(k).v !== want[k]) throw new TexError('\\Psi can only be evaluated at (x, y).');
    }
    this.i += want.length;
  }

  private readBracedName(): string {
    if (this.isSym('{')) {
      this.i++;
      let name = '';
      while (!this.isSym('}')) {
        if (this.cur.k === 'end') throw new TexError('Missing "}".');
        name += this.cur.v;
        this.i++;
      }
      this.i++;
      return name;
    }
    const t = this.cur;
    this.i++;
    return t.v;
  }

  private parseLeftRight(): Node {
    this.i++; // \left
    const d = this.cur;
    this.i++;
    const open = d.v;
    if (open === '|' || open === '\\lvert') {
      const inner = this.parseSum();
      if (!this.isCmd('\\right')) throw new TexError('Missing \\right to close \\left.');
      this.i += 2;
      return { t: 'call', f: 'abs', args: [inner] };
    }
    if (!['(', '[', '\\{', '.'].includes(open)) throw new TexError(`Unsupported delimiter after \\left: "${open}".`);
    const items = this.parseList('\\right');
    if (items.length > 1) throw new TexError(`${SCALAR_HINT}: (a, b) is a tuple, not a number.`);
    return items[0];
  }

  /** \mathbf{1}_{cond}, \mathbb{1}\{cond\}, …; \mathbf{x} (a vector) is rejected. */
  private parseIndicatorOrBold(cmd: string): Node {
    this.i++;
    const name = this.readBracedName();
    if (name !== '1') {
      throw new TexError(`${SCALAR_HINT}: ${cmd}{${name}} looks like a vector. Write x and y separately.`);
    }
    let cond: Node;
    if (this.isSym('_')) {
      this.i++;
      if (this.isSym('{')) {
        this.i++;
        const braced = this.isSym('\\{');
        if (braced) this.i++;
        cond = this.parseCondition();
        if (braced) this.expectSym('\\}', 'to close the condition');
        this.expectSym('}', 'to close the indicator subscript');
      } else {
        throw new TexError('Put the indicator condition in braces, e.g. \\mathbf{1}_{x>0}.');
      }
    } else if (this.isSym('\\{') || this.isSym('(')) {
      const close = this.isSym('\\{') ? '\\}' : ')';
      this.i++;
      cond = this.parseCondition();
      this.expectSym(close, 'to close the condition');
    } else {
      return { t: 'num', v: 1 };
    }
    if (cond.t !== 'cmp' && cond.t !== 'logic') throw new TexError('An indicator needs a condition such as x > 0.');
    return { t: 'ind', cond };
  }

  /** Function call: \sin x, \sin(x), \sin^2 x, \log_2 x, \max(a, b). */
  private parseFunction(name: string): Node {
    let power: Node | null = null;
    let base: Node | null = null;
    if (this.isSym('^')) {
      this.i++;
      power = this.parseScript('exponent');
    }
    if (this.isSym('_')) {
      if (name !== 'log') throw new TexError(`\\${name} does not take a subscript.`);
      this.i++;
      base = this.parseScript('logarithm base');
    }
    let args: Node[];
    if (this.isSym('(') || this.isCmd('\\left')) {
      if (this.isCmd('\\left')) {
        this.i++;
        if (!this.isSym('(')) throw new TexError(`Use \\left( … \\right) for the arguments of \\${name}.`);
        this.i++;
        args = this.parseList('\\right');
      } else {
        this.i++;
        args = this.parseList(')');
      }
    } else if (this.isSym('{')) {
      args = [this.parseGroup('{', '}')];
    } else {
      // \sin 2x = sin(2x): implicit product up to the next operator or function.
      if (!this.startsPrimary(this.cur)) throw new TexError(`\\${name} needs an argument.`);
      let arg = this.parsePower();
      while (this.startsPrimary(this.cur) && !(this.cur.k === 'cmd' && FUNC_COMMANDS.has(this.cur.v))) {
        arg = { t: 'bin', op: '*', a: arg, b: this.parsePower() };
      }
      args = [arg];
    }
    const multi = name === 'max' || name === 'min';
    if (name === 'atan2' && args.length !== 2) throw new TexError('atan2 takes two arguments: atan2(y, x).');
    if (!multi && name !== 'atan2' && args.length !== 1) {
      throw new TexError(`\\${name} takes one argument; ${SCALAR_HINT.toLowerCase()}.`);
    }
    let node: Node = { t: 'call', f: name, args };
    if (base) node = { t: 'bin', op: '/', a: node, b: { t: 'call', f: 'ln', args: [base] } };
    if (power) node = { t: 'bin', op: '^', a: node, b: power };
    return node;
  }
}

// ------------------------------------------------------------------ compilation

function compile(n: Node): CompiledFunction {
  switch (n.t) {
    case 'num': {
      const v = n.v;
      return () => v;
    }
    case 'var':
      if (n.v === 'x') return (x) => x;
      if (n.v === 'y') return (_x, y) => y;
      if (n.v === 'r') return (x, y) => Math.hypot(x, y);
      return (x, y) => Math.atan2(y, x);
    case 'const':
      return n.v === 'sigma' ? (_x, _y, c) => c.sigma : (x, y, c) => c.psi(x, y);
    case 'neg': {
      const a = compile(n.a);
      return (x, y, c) => -a(x, y, c);
    }
    case 'bin': {
      const a = compile(n.a);
      const b = compile(n.b);
      switch (n.op) {
        case '+':
          return (x, y, c) => a(x, y, c) + b(x, y, c);
        case '-':
          return (x, y, c) => a(x, y, c) - b(x, y, c);
        case '*':
          return (x, y, c) => a(x, y, c) * b(x, y, c);
        case '/':
          return (x, y, c) => a(x, y, c) / b(x, y, c);
        default:
          return (x, y, c) => a(x, y, c) ** b(x, y, c);
      }
    }
    case 'call': {
      const args = n.args.map(compile);
      if (n.f === 'max') return (x, y, c) => Math.max(...args.map((g) => g(x, y, c)));
      if (n.f === 'min') return (x, y, c) => Math.min(...args.map((g) => g(x, y, c)));
      if (n.f === 'atan2') return (x, y, c) => Math.atan2(args[0](x, y, c), args[1](x, y, c));
      const f = UNARY_FUNCS[n.f];
      const a = args[0];
      return (x, y, c) => f(a(x, y, c));
    }
    case 'cmp': {
      const a = compile(n.a);
      const b = compile(n.b);
      switch (n.op) {
        case '<':
          return (x, y, c) => (a(x, y, c) < b(x, y, c) ? 1 : 0);
        case '>':
          return (x, y, c) => (a(x, y, c) > b(x, y, c) ? 1 : 0);
        case '<=':
          return (x, y, c) => (a(x, y, c) <= b(x, y, c) ? 1 : 0);
        default:
          return (x, y, c) => (a(x, y, c) >= b(x, y, c) ? 1 : 0);
      }
    }
    case 'logic': {
      const a = compile(n.a);
      const b = compile(n.b);
      return n.op === 'and'
        ? (x, y, c) => (a(x, y, c) && b(x, y, c) ? 1 : 0)
        : (x, y, c) => (a(x, y, c) || b(x, y, c) ? 1 : 0);
    }
    case 'ind':
      return compile(n.cond);
  }
}

/** Parses and compiles a LaTeX function of x and y. Never throws. */
export function parseFunction(tex: string): ParseResult {
  if (tex.length > 500) return { ok: false, message: 'The expression is too long (max. 500 characters).' };
  try {
    const parser = new Parser(tokenize(tex));
    const fn = compile(parser.parse());
    return { ok: true, fn, usesPsi: parser.usesPsi, usesSigma: parser.usesSigma };
  } catch (err) {
    if (err instanceof TexError) return { ok: false, message: err.message };
    throw err;
  }
}
