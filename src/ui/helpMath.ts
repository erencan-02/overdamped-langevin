/**
 * Renders the LaTeX in the help dialog with KaTeX. Loaded on demand the first time the dialog
 * opens, so the ~70 kB of KaTeX (plus fonts) never delays starting the app.
 */
import 'katex/dist/katex.min.css';
import katex from 'katex';

export function renderMath(root: ParentNode): void {
  for (const el of root.querySelectorAll<HTMLElement>('[data-tex]')) {
    if (el.dataset.rendered) continue;
    katex.render(el.dataset.tex ?? '', el, {
      displayMode: el.hasAttribute('data-display'),
      throwOnError: false,
      output: 'htmlAndMathml', // MathML keeps it accessible to screen readers
    });
    el.dataset.rendered = '1';
  }
}
