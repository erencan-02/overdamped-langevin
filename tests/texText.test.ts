import { describe, expect, it } from 'vitest';
import { texToText } from '../src/export/texText';

describe('texToText (figure titles)', () => {
  it('turns the usual formulas into readable text', () => {
    expect(texToText('x^2 + y^2')).toBe('x² + y²');
    expect(texToText('\\frac{x^2 + y^2}{2}')).toBe('(x² + y²)/2');
    expect(texToText('\\mathbf{1}_{x > 0}')).toBe('𝟏{x > 0}');
    expect(texToText('\\cos(\\pi x)')).toBe('cos(π x)');
    expect(texToText('\\sigma\\sqrt{1 + \\frac{x^2}{4}}')).toBe('σ√(1 + x²/4)');
    expect(texToText('\\frac{(x^2 - 4)^2}{16} + \\frac{y^2}{2}')).toBe('(x² - 4)²/16 + y²/2');
    expect(texToText('1 - (x - 2)^2 - y^2')).toBe('1 - (x - 2)² - y²');
    expect(texToText('x^{-1}')).toBe('x⁻¹');
    expect(texToText('\\Psi')).toBe('Ψ');
  });

  it('keeps what it does not know', () => {
    expect(texToText('x^{a}')).toBe('x^{a}');
    expect(texToText('\\operatorname{erf}(x)')).toBe('\\operatorname{erf}(x)');
  });
});
