/**
 * Builds the markup of a side window (as written by hand in index.html for the older ones) from
 * code, so a new instrument needs no HTML: a collapsible card with a header value, and helpers
 * for the usual contents (formula input, plot, legend, info line, buttons). Only fixed strings
 * from the code are put into the page, as text.
 */

export interface PanelParts {
  section: HTMLElement;
  body: HTMLElement;
  /** The value shown in the header. */
  value: HTMLOutputElement;
  /** Ids for CollapsiblePanel. */
  ids: { section: string; toggle: string; body: string };
}

const CHEVRON = '<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/**
 * A collapsed card in a column (default: the side windows on the left, `#left-body`), before
 * the element with id `before` (default: Settings; at the end if it is not in that column).
 */
export function createPanel(opts: { id: string; title: string; label: string; before?: string; column?: string }): PanelParts {
  const ids = { section: opts.id, toggle: `${opts.id}-toggle`, body: `${opts.id}-body` };
  const section = el('section', 'analysis card collapsed');
  section.id = ids.section;
  section.setAttribute('aria-label', opts.label);
  const head = el('button', 'analysis-head');
  head.id = ids.toggle;
  head.type = 'button';
  head.setAttribute('aria-expanded', 'false');
  head.setAttribute('aria-controls', ids.body);
  head.append(el('span', 'analysis-title', opts.title));
  const value = el('output');
  value.id = `${opts.id}-value`;
  head.append(value);
  head.insertAdjacentHTML('beforeend', CHEVRON);
  const body = el('div', 'analysis-body');
  body.id = ids.body;
  body.hidden = true;
  section.append(head, body);
  const column = document.querySelector(opts.column ?? '#left-body');
  if (!column) throw new Error(`Missing ${opts.column ?? '#left-body'}`);
  const before = document.getElementById(opts.before ?? 'settings');
  column.insertBefore(section, before && before.parentElement === column ? before : null);
  return { section, body, value, ids };
}

/** A LaTeX input with error line, preview and examples (the markup FormulaInput expects). */
export function formulaField(
  body: HTMLElement,
  opts: { id: string; label: string; examples?: readonly (readonly [string, string])[] },
): HTMLElement {
  const root = el('div', 'field obs-field');
  const head = el('label', 'field-head');
  head.htmlFor = opts.id;
  head.append(el('span', undefined, opts.label), el('span', 'field-note', 'LaTeX'));
  const input = el('input');
  input.type = 'text';
  input.id = opts.id;
  input.spellcheck = false;
  input.autocomplete = 'off';
  input.setAttribute('autocapitalize', 'off');
  input.setAttribute('aria-describedby', `${opts.id}-error`);
  const error = el('div', 'obs-error');
  error.id = `${opts.id}-error`;
  error.setAttribute('role', 'alert');
  error.hidden = true;
  const preview = el('div', 'obs-preview');
  preview.setAttribute('aria-hidden', 'true');
  root.append(head, input, error, preview);
  if (opts.examples?.length) {
    const group = el('div', 'obs-examples');
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', 'Examples');
    for (const [label, tex] of opts.examples) {
      const b = el('button', undefined, label);
      b.type = 'button';
      b.dataset.tex = tex;
      group.append(b);
    }
    root.append(group);
  }
  body.append(root);
  return root;
}

export function caption(body: HTMLElement, text: string): HTMLElement {
  const c = el('div', 'kl-caption', text);
  body.append(c);
  return c;
}

export function plotCanvas(body: HTMLElement, label: string): HTMLCanvasElement {
  const c = el('canvas', 'ts-plot');
  c.setAttribute('aria-label', label);
  body.append(c);
  return c;
}

/**
 * Legend entries by kind: 'line' (solid), 'dash' (dashed, blue), 'band' (shaded), '#rrggbb' (a
 * solid line in that colour) or 'dash:#rrggbb' (a dashed line in that colour).
 */
export function legend(body: HTMLElement, items: readonly (readonly [kind: string, text: string])[]): HTMLElement {
  const box = el('div', 'kl-legend');
  for (const [kind, text] of items) {
    const item = el('span');
    const colour = /#[0-9a-f]{6}$/i.exec(kind)?.[0];
    const mark = el('i', kind.startsWith('dash') ? 'lg-dash' : kind === 'band' ? 'lg-band' : 'lg-line');
    if (colour) mark.style.borderTopColor = colour;
    item.append(mark, document.createTextNode(text));
    box.append(item);
  }
  body.append(box);
  return box;
}

export function info(body: HTMLElement): HTMLElement {
  const i = el('div', 'kl-info');
  body.append(i);
  return i;
}

export function note(body: HTMLElement, text: string): HTMLElement {
  const n = el('div', 'field-note', text);
  body.append(n);
  return n;
}

/** A row of buttons (one or two per row, like the other windows). */
export function buttons(body: HTMLElement, labels: readonly string[]): HTMLButtonElement[] {
  const row = el('div', labels.length === 1 ? 'kl-actions single' : 'kl-actions');
  const out = labels.map((label) => {
    const b = el('button', 'ghost-btn', label);
    b.type = 'button';
    row.append(b);
    return b;
  });
  body.append(row);
  return out;
}

/** A labelled number input (validated by the caller). */
export function numberField(
  body: HTMLElement,
  opts: { id: string; label: string; value: number; min: number; max: number; step: number },
): HTMLInputElement {
  const row = el('label', 'field inline-number');
  const head = el('span', 'field-head');
  head.append(el('span', undefined, opts.label));
  const input = el('input');
  input.type = 'number';
  input.id = opts.id;
  input.min = String(opts.min);
  input.max = String(opts.max);
  input.step = String(opts.step);
  input.value = String(opts.value);
  row.append(head, input);
  body.append(row);
  return input;
}
