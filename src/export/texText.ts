/**
 * A LaTeX formula as readable plain text for figure titles, e.g. "\frac{x^2 + y^2}{2}" →
 * "(x² + y²)/2" and "\mathbf{1}_{x > 0}" → "𝟏{x > 0}". Covers what the formula fields accept
 * in practice; anything it does not know stays as it is.
 */
export function texToText(tex: string): string {
  let s = tex.trim();
  // \frac{a}{b} → (a)/(b), parentheses dropped around single tokens; innermost first.
  for (let k = 0; k < 8 && s.includes('\\frac'); k++) {
    s = s.replace(/\\[dt]?frac\{([^{}]*)\}\{([^{}]*)\}/g, (_, a: string, b: string) => `${wrap(a)}/${wrap(b)}`);
  }
  s = s
    .replace(/\\sqrt\{([^{}]*)\}/g, (_, a: string) => `√${wrap(a)}`)
    .replace(/\\mathbf\{1\}_\{([^{}]*)\}/g, '𝟏{$1}')
    .replace(/\\mathbb\{1\}_\{([^{}]*)\}/g, '𝟏{$1}')
    .replace(/\\(?:left|right|,|;|!|\s)/g, (m) => (m === '\\,' || m === '\\;' ? ' ' : ''))
    .replace(/\\(cdot|times)/g, (_, c: string) => (c === 'cdot' ? '·' : '×'))
    .replace(/\\(le|leq)\b/g, '≤')
    .replace(/\\(ge|geq)\b/g, '≥')
    .replace(/\\(sin|cos|tan|exp|ln|log|max|min|tanh|arctan)\b/g, '$1');
  for (const [name, letter] of Object.entries(GREEK)) s = s.replace(new RegExp(`\\\\${name}\\b`, 'g'), letter);
  // Powers: ^2, ^{12}, ^{-1} → superscript digits where possible.
  s = s.replace(/\^\{([-+0-9]+)\}|\^([0-9])/g, (m, a?: string, b?: string) => {
    const digits = a ?? b ?? '';
    return [...digits].every((c) => c in SUP) ? [...digits].map((c) => SUP[c]).join('') : m;
  });
  return s.replace(/\s+/g, ' ').trim();
}

/** `a` in parentheses unless it is a single term: a name or number, or a group, with a power. */
function wrap(a: string): string {
  const t = a.trim();
  const base = t.replace(/\^(\{[^{}]*\}|\w)$/, '');
  return /^[\w.]+$/.test(base) || isGroup(base) ? t : `(${t})`;
}

/** "( … )" whose first parenthesis closes at its end. */
function isGroup(s: string): boolean {
  if (!s.startsWith('(') || !s.endsWith(')')) return false;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')' && --depth === 0) return i === s.length - 1;
  }
  return false;
}

const SUP: Record<string, string> = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '-': '⁻', '+': '⁺',
};

const GREEK: Record<string, string> = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', theta: 'θ', lambda: 'λ', mu: 'μ', pi: 'π',
  rho: 'ρ', sigma: 'σ', tau: 'τ', phi: 'φ', omega: 'ω', Psi: 'Ψ', Phi: 'Φ', Omega: 'Ω',
};
