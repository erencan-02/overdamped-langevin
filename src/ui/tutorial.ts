/**
 * A guided tour: one element of the page after the other is highlighted, the rest is covered by
 * a transparent grey layer, and a box next to the element explains it.
 *
 * The engine knows nothing about the app: it gets a list of steps, each naming its element and
 * text, and optionally preparing the page for itself (e.g. revealing a hidden window) with a
 * function that undoes it. Adding a step is adding an entry to that list (see tutorialSteps.ts).
 *
 * Controls: a click anywhere (or →, Enter, Space) goes to the next step, ← to the previous one,
 * Escape or the × at the top right ends the tour. While it runs it takes all clicks and keys, so
 * nothing in the app is changed by accident. The highlight follows its element every frame
 * (windows open, the page is resized, …).
 */

export interface TutorialStep {
  /** The element to highlight; a step whose element is missing or not displayed is left out. */
  target(): HTMLElement | null;
  title: string;
  text: string;
  /**
   * Prepares the page for this step (e.g. shows a window that is hidden now). Returns a function
   * that undoes it, called when the step is left.
   */
  prepare?(): (() => void) | void;
}

/** Room around the highlighted element, and between it and the text box (px). */
const PAD = 6;
const GAP = 12;
/** Distance kept from the window edges (px). */
const EDGE = 12;

export class Tutorial {
  private root: HTMLElement | null = null;
  private spot: HTMLElement | null = null;
  private box: HTMLElement | null = null;
  private title: HTMLElement | null = null;
  private text: HTMLElement | null = null;
  private counter: HTMLElement | null = null;
  private close: HTMLElement | null = null;
  private steps: readonly TutorialStep[] = [];
  private index = -1;
  private undo: (() => void) | null = null;
  private frame = 0;
  private returnFocus: HTMLElement | null = null;
  private readonly onKey = (e: KeyboardEvent) => this.key(e);

  constructor(
    private readonly allSteps: readonly TutorialStep[],
    private readonly hooks: {
      /** Called before the tour starts (e.g. to close menus and stop a stroke in progress). */
      starting?(): void;
      /** Called after the tour ended. */
      ended?(): void;
    } = {},
  ) {}

  get active(): boolean {
    return this.root !== null;
  }

  start(): void {
    if (this.active) return;
    this.hooks.starting?.();
    // Only the steps that can be shown now (their element exists and is displayed once prepared).
    this.steps = this.allSteps.filter((s) => {
      const undo = s.prepare?.();
      const ok = visible(s.target());
      if (undo) undo();
      return ok;
    });
    if (this.steps.length === 0) return;
    this.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.build();
    window.addEventListener('keydown', this.onKey, true);
    this.show(0);
    this.track();
  }

  /** Next step, or the end after the last one. */
  next(): void {
    if (this.index + 1 < this.steps.length) this.show(this.index + 1);
    else this.end();
  }

  previous(): void {
    if (this.index > 0) this.show(this.index - 1);
  }

  end(): void {
    if (!this.root) return;
    this.leaveStep();
    cancelAnimationFrame(this.frame);
    window.removeEventListener('keydown', this.onKey, true);
    this.root.remove();
    this.root = this.spot = this.box = this.title = this.text = this.counter = this.close = null;
    this.index = -1;
    this.returnFocus?.focus({ preventScroll: true });
    this.hooks.ended?.();
  }

  private build(): void {
    const root = el('div', 'tour');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Tutorial');
    root.tabIndex = -1; // focused, so Enter and Space go to the next step (Tab reaches the × button)
    const spot = el('div', 'tour-spot');
    const box = el('div', 'tour-box');
    box.setAttribute('aria-live', 'polite');
    const title = el('div', 'tour-title');
    const text = el('div', 'tour-text');
    const foot = el('div', 'tour-foot');
    const counter = el('span', 'tour-count');
    foot.append(counter, el('span', 'tour-hint', 'Click anywhere to continue · Esc to exit'));
    box.append(title, text, foot);
    const close = el('button', 'tour-close');
    close.type = 'button';
    close.setAttribute('aria-label', 'Exit the tutorial');
    close.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>';
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      this.end();
    });
    root.addEventListener('click', () => this.next());
    root.append(spot, box, close);
    document.body.append(root);
    this.root = root;
    this.spot = spot;
    this.box = box;
    this.title = title;
    this.text = text;
    this.counter = counter;
    this.close = close;
    root.focus({ preventScroll: true });
  }

  private show(i: number): void {
    this.leaveStep();
    this.index = i;
    const step = this.steps[i];
    this.undo = step.prepare?.() ?? null;
    this.title!.textContent = step.title;
    this.text!.textContent = step.text;
    this.counter!.textContent = `${i + 1} / ${this.steps.length}`;
    this.place();
  }

  private leaveStep(): void {
    this.undo?.();
    this.undo = null;
  }

  /** Keeps the highlight and the box on the element while the tour runs. */
  private track(): void {
    this.frame = requestAnimationFrame(() => {
      if (!this.root) return;
      this.place();
      this.track();
    });
  }

  private place(): void {
    const step = this.steps[this.index];
    const target = step?.target();
    if (!this.spot || !this.box || !target) return;
    const r = target.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // The highlight: the element plus a little room, kept inside the window.
    const hx0 = Math.max(2, r.left - PAD);
    const hy0 = Math.max(2, r.top - PAD);
    const hx1 = Math.min(vw - 2, r.right + PAD);
    const hy1 = Math.min(vh - 2, r.bottom + PAD);
    setBox(this.spot, hx0, hy0, hx1 - hx0, hy1 - hy0);

    // The text box: below, above, right or left of the highlight, wherever it fits best.
    const bw = Math.min(320, vw - 2 * EDGE);
    this.box.style.width = `${bw}px`;
    const bh = this.box.offsetHeight;
    const room = {
      below: vh - hy1 - GAP - EDGE,
      above: hy0 - GAP - EDGE,
      right: vw - hx1 - GAP - EDGE,
      left: hx0 - GAP - EDGE,
    };
    const fits = {
      below: room.below >= bh,
      above: room.above >= bh,
      right: room.right >= bw,
      left: room.left >= bw,
    };
    const side =
      (['below', 'above', 'right', 'left'] as const).find((s) => fits[s]) ??
      (['below', 'above', 'right', 'left'] as const).reduce((a, b) => (room[b] / (b === 'left' || b === 'right' ? bw : bh) > room[a] / (a === 'left' || a === 'right' ? bw : bh) ? b : a));
    let x: number;
    let y: number;
    if (side === 'below' || side === 'above') {
      x = (hx0 + hx1) / 2 - bw / 2;
      y = side === 'below' ? hy1 + GAP : hy0 - GAP - bh;
    } else {
      x = side === 'right' ? hx1 + GAP : hx0 - GAP - bw;
      y = (hy0 + hy1) / 2 - bh / 2;
    }
    x = clamp(x, EDGE, vw - EDGE - bw);
    y = clamp(y, EDGE, Math.max(EDGE, vh - EDGE - bh));
    // Never under the × button: move to its left, or else below it.
    const c = this.close?.getBoundingClientRect();
    if (c && x < c.right && x + bw > c.left && y < c.bottom && y + bh > c.top) {
      if (c.left - GAP - bw >= EDGE) x = c.left - GAP - bw;
      else y = c.bottom + GAP;
    }
    this.box.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  private key(e: KeyboardEvent): void {
    // The tour takes every key while it runs (no shortcut reaches the app).
    if (e.key === 'Tab') return; // keep keyboard focus moving (to the × button)
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.repeat) return;
    const onClose = e.target instanceof HTMLElement && e.target.classList.contains('tour-close');
    if (e.key === 'Escape' || (onClose && (e.key === 'Enter' || e.key === ' '))) this.end();
    else if (e.key === 'ArrowRight' || e.key === 'Enter' || e.key === ' ') this.next();
    else if (e.key === 'ArrowLeft') this.previous();
  }
}

/** The element exists and takes up space on the page. */
function visible(e: HTMLElement | null): boolean {
  if (!e || !e.isConnected) return false;
  const r = e.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function setBox(e: HTMLElement, x: number, y: number, w: number, h: number): void {
  e.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  e.style.width = `${Math.round(w)}px`;
  e.style.height = `${Math.round(h)}px`;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
