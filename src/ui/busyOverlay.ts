/**
 * Full-screen dimmed overlay with a spinner that blocks all input while something is loading
 * (images, recordings). Shared, so there is one notion of "busy" for the whole app.
 */
export class BusyOverlay {
  private readonly overlay = el('loading-overlay');
  private readonly title = el('loading-title');
  private readonly name = el('loading-name');
  private activeCount = 0;

  constructor() {
    // The overlay swallows every pointer, wheel and touch interaction.
    for (const type of ['pointerdown', 'wheel', 'contextmenu', 'touchstart'] as const) {
      this.overlay.addEventListener(type, (e) => e.preventDefault(), { passive: false });
    }
  }

  get active(): boolean {
    return this.activeCount > 0;
  }

  show(title: string, name = ''): void {
    this.activeCount++;
    this.title.textContent = title;
    this.name.textContent = name;
    this.overlay.hidden = false;
    document.body.classList.add('is-busy');
    (document.activeElement as HTMLElement | null)?.blur?.();
  }

  hide(): void {
    this.activeCount = Math.max(0, this.activeCount - 1);
    if (this.activeCount > 0) return;
    this.overlay.hidden = true;
    document.body.classList.remove('is-busy');
  }

  /**
   * Runs `task` with the overlay shown for at least `minMs`, so it never just flashes.
   */
  async run<T>(title: string, name: string, task: () => Promise<T>, minMs = 450): Promise<T> {
    this.show(title, name);
    const started = performance.now();
    try {
      return await task();
    } finally {
      const wait = minMs - (performance.now() - started);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.hide();
    }
  }
}

function el(id: string): HTMLElement {
  const e = document.getElementById(id);
  if (!e) throw new Error(`Missing element #${id}`);
  return e;
}
