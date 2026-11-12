/**
 * Builds the side windows from code: a collapsible card with a header value, and helpers for the
 * usual contents (formula and number inputs, switches, sliders, plots, legends, info lines,
 * buttons). Every window of the app is made with these (see sideWindows.ts and the instruments),
 * so they share one markup, and index.html only holds the frame of the page.
 *
 * Only fixed strings from the code are put into the page: text as text, formulas as LaTeX in
 * `data-tex` (typeset later by KaTeX, with a plain-text fallback until then).
 */

export interface PanelParts {
  section: HTMLElement;
  body: HTMLElement;
  /** The value shown in the header (absent with `value: false`). */
  value: HTMLOutputElement;
  /** Ids for CollapsiblePanel. */
  ids: { section: string; toggle: string; body: string };
}

/** Text, an element, or a sequence of both (e.g. ["Observable 𝔼[f(X", sub("t"), ")]"]). */
export type Content = string | Node | readonly (string | Node)[];

const CHEVRON = '<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Appends content (text stays text) to an element and returns it. */
function put<T extends HTMLElement>(target: T, content: Content): T {
  if (typeof content === 'string' || content instanceof Node) target.append(content);
  else target.append(...content);
  return target;
}

/** Subscript and superscript text. */
export const sub = (text: string): HTMLElement => el('sub', undefined, text);
export const sup = (text: string): HTMLElement => el('sup', undefined, text);
/** A keyboard key. */
export const kbd = (text: string): HTMLElement => el('kbd', undefined, text);
/** A formula typeset by KaTeX once it is loaded; `fallback` is shown until then. */
export function tex(source: string, fallback: Content): HTMLElement {
  const span = put(el('span', 'tex'), fallback);
  span.dataset.tex = source;
  return span;
}

/**
 * A card in a column (default: the side windows on the left, `#left-body`), before the element
 * with id `before` (at the end if it is missing or not in that column). Collapsed unless `open`.
 * Ids follow the window's id: `<id>-toggle`, `<id>-body`, `<id>-value`, unless given.
 */
export function createPanel(opts: {
  id: string;
  title: Content;
  label: string;
  before?: string;
  column?: string;
  /** Id of the header value, or false for none. */
  value?: string | false;
  bodyId?: string;
  /** Class of the body (default "analysis-body"). */
  bodyClass?: string;
  /** Extra classes of the card. */
  cardClass?: string;
  open?: boolean;
}): PanelParts {
  const open = opts.open ?? false;
  const ids = { section: opts.id, toggle: `${opts.id}-toggle`, body: opts.bodyId ?? `${opts.id}-body` };
  const section = el('section', `analysis card${opts.cardClass ? ` ${opts.cardClass}` : ''}${open ? '' : ' collapsed'}`);
  section.id = ids.section;
  section.setAttribute('aria-label', opts.label);
  const head = el('button', 'analysis-head');
  head.id = ids.toggle;
  head.type = 'button';
  head.setAttribute('aria-expanded', String(open));
  head.setAttribute('aria-controls', ids.body);
  head.append(put(el('span', 'analysis-title'), opts.title));
  const value = el('output');
  if (opts.value !== false) {
    value.id = opts.value ?? `${opts.id}-value`;
    head.append(value);
  }
  head.insertAdjacentHTML('beforeend', CHEVRON);
  const body = el('div', opts.bodyClass ?? 'analysis-body');
  body.id = ids.body;
  body.hidden = !open;
  section.append(head, body);
  const column = document.querySelector(opts.column ?? '#left-body');
  if (!column) throw new Error(`Missing ${opts.column ?? '#left-body'}`);
  const before = opts.before ? document.getElementById(opts.before) : null;
  column.insertBefore(section, before && before.parentElement === column ? before : null);
  return { section, body, value, ids };
}

/** A container for a group of fields (e.g. two inputs side by side: "bd-rates"). */
export function group(body: HTMLElement, cls: string, attrs: Record<string, string> = {}): HTMLElement {
  const g = el('div', cls);
  for (const [k, v] of Object.entries(attrs)) g.setAttribute(k, v);
  body.append(g);
  return g;
}

/**
 * A validated text input with its error line (the markup FormulaInput expects): by default a
 * LaTeX formula with a rendered preview and example buttons (`data-tex`).
 */
export function formulaField(
  body: HTMLElement,
  opts: {
    id: string;
    label: Content;
    examples?: readonly (readonly [string, string])[];
    /** Id of the field itself (FormulaInput may look it up). */
    rootId?: string;
    /** Id of the error line (default `<id>-error`). */
    errorId?: string;
    /** Small text after the label (default "LaTeX"; null for none). */
    note?: string | null;
    /** A rendered preview of the formula (default true). */
    preview?: boolean;
    inputMode?: 'text' | 'decimal';
    value?: string;
  },
): HTMLElement {
  const root = el('div', 'field obs-field');
  if (opts.rootId) root.id = opts.rootId;
  const head = el('label', 'field-head');
  head.htmlFor = opts.id;
  head.append(put(el('span'), opts.label));
  const noteText = opts.note === undefined ? 'LaTeX' : opts.note;
  if (noteText) head.append(el('span', 'field-note', noteText));
  const input = el('input');
  input.type = 'text';
  input.id = opts.id;
  input.spellcheck = false;
  input.autocomplete = 'off';
  input.setAttribute('autocapitalize', 'off');
  if (opts.inputMode && opts.inputMode !== 'text') input.inputMode = opts.inputMode;
  if (opts.value !== undefined) input.value = opts.value;
  const errorId = opts.errorId ?? `${opts.id}-error`;
  input.setAttribute('aria-describedby', errorId);
  const error = el('div', 'obs-error');
  error.id = errorId;
  error.setAttribute('role', 'alert');
  error.hidden = true;
  root.append(head, input, error);
  if (opts.preview ?? true) {
    const preview = el('div', 'obs-preview');
    preview.setAttribute('aria-hidden', 'true');
    root.append(preview);
  }
  if (opts.examples?.length) {
    exampleButtons(
      root,
      'Examples',
      opts.examples.map(([label, source]) => ({ label, data: { tex: source } })),
    );
  }
  body.append(root);
  return root;
}

/** A row of small example buttons with data attributes (e.g. `data-tex`). */
export function exampleButtons(
  body: HTMLElement,
  label: string,
  items: readonly { label: string; data: Record<string, string> }[],
): HTMLElement {
  const g = group(body, 'obs-examples', { role: 'group', 'aria-label': label });
  for (const item of items) {
    const b = el('button', undefined, item.label);
    b.type = 'button';
    for (const [k, v] of Object.entries(item.data)) b.dataset[k] = v;
    g.append(b);
  }
  return g;
}

/** An on/off switch with its label. */
export function switchRow(body: HTMLElement, opts: { id: string; label: Content }): HTMLInputElement {
  const row = el('label', 'switch-row');
  const input = el('input');
  input.type = 'checkbox';
  input.id = opts.id;
  const knob = el('span', 'switch');
  knob.setAttribute('aria-hidden', 'true');
  row.append(input, knob, put(el('span'), opts.label));
  body.append(row);
  return input;
}

/** A slider with its label and value (positions 0…1; the code maps them to the setting). */
export function rangeField(
  body: HTMLElement,
  opts: { id: string; label: Content; outputId: string; note?: string },
): HTMLInputElement {
  const row = el('label', 'field');
  const head = el('span', 'field-head');
  const out = el('output');
  out.id = opts.outputId;
  head.append(put(el('span'), opts.label), out);
  const input = el('input');
  input.type = 'range';
  input.id = opts.id;
  input.min = '0';
  input.max = '1';
  input.step = '0.001';
  row.append(head, input);
  if (opts.note) row.append(el('span', 'field-note', opts.note));
  body.append(row);
  return input;
}

/** A heading line: a label and a value on the right. */
export function headLine(body: HTMLElement, opts: { label: Content; outputId?: string; outputText?: string; cls?: string }): HTMLOutputElement {
  const head = el('div', `field-head${opts.cls ? ` ${opts.cls}` : ''}`);
  const out = el('output');
  if (opts.outputId) out.id = opts.outputId;
  if (opts.outputText) out.textContent = opts.outputText;
  head.append(put(el('span'), opts.label), out);
  body.append(head);
  return out;
}

export function caption(body: HTMLElement, text: Content): HTMLElement {
  const c = put(el('div', 'kl-caption'), text);
  body.append(c);
  return c;
}

export function plotCanvas(body: HTMLElement, label: string, id?: string): HTMLCanvasElement {
  const c = el('canvas', 'ts-plot');
  if (id) c.id = id;
  c.setAttribute('aria-label', label);
  body.append(c);
  return c;
}

/**
 * Legend entries by kind: 'line' (solid), 'dash' (dashed, blue), 'band' (shaded), '#rrggbb' (a
 * solid line in that colour) or 'dash:#rrggbb' (a dashed line in that colour).
 */
export function legend(body: HTMLElement, items: readonly (readonly [kind: string, text: Content])[]): HTMLElement {
  const box = el('div', 'kl-legend');
  for (const [kind, text] of items) {
    const item = el('span');
    const colour = /#[0-9a-f]{6}$/i.exec(kind)?.[0];
    const mark = el('i', kind.startsWith('dash') ? 'lg-dash' : kind === 'band' ? 'lg-band' : 'lg-line');
    if (colour) mark.style.borderTopColor = colour;
    item.append(mark);
    put(item, text);
    box.append(item);
  }
  body.append(box);
  return box;
}

export function info(body: HTMLElement, id?: string): HTMLElement {
  const i = el('div', 'kl-info');
  if (id) i.id = id;
  body.append(i);
  return i;
}

export function note(body: HTMLElement, text: Content, id?: string): HTMLElement {
  const n = put(el('div', 'field-note'), text);
  if (id) n.id = id;
  body.append(n);
  return n;
}

/** A row of buttons (one or two per row, like the other windows), with optional ids. */
export function buttons(body: HTMLElement, labels: readonly string[], ids: readonly string[] = []): HTMLButtonElement[] {
  const row = el('div', labels.length === 1 ? 'kl-actions single' : 'kl-actions');
  const out = labels.map((label, k) => {
    const b = el('button', 'ghost-btn', label);
    b.type = 'button';
    if (ids[k]) b.id = ids[k];
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
