/**
 * A card with a header button that expands and collapses its body (the analysis panels).
 * Markup: <section id> with a header <button id="…-toggle" aria-expanded> and a body element.
 */
export class CollapsiblePanel {
  private readonly section: HTMLElement;
  private readonly toggle: HTMLElement;
  private readonly body: HTMLElement;
  private isOpen = false;

  constructor(
    ids: { section: string; toggle: string; body: string },
    /** Called after the panel opened or closed. */
    private readonly onChange: (open: boolean) => void,
  ) {
    this.section = byId(ids.section);
    this.toggle = byId(ids.toggle);
    this.body = byId(ids.body);
    this.toggle.addEventListener('click', () => this.setOpen(!this.isOpen));
  }

  get open(): boolean {
    return this.isOpen;
  }

  setOpen(open: boolean): void {
    this.isOpen = open;
    this.toggle.setAttribute('aria-expanded', String(open));
    this.body.hidden = !open;
    this.section.classList.toggle('collapsed', !open);
    this.onChange(open);
  }
}

/** Whether a panel should start open: not on short or narrow screens, where it would crowd the UI. */
export function roomForPanels(): boolean {
  return window.innerHeight >= 760 && window.innerWidth > 640;
}

/** Compact number for readouts. */
export function formatValue(v: number): string {
  const a = Math.abs(v);
  if (a === 0) return '0';
  if (a >= 1e5 || a < 1e-3) return v.toExponential(2);
  if (a >= 100) return v.toFixed(0);
  if (a >= 1) return v.toFixed(2);
  if (a >= 0.01) return v.toFixed(3);
  return v.toFixed(4);
}

export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`Missing element #${id}`);
  return e as T;
}
