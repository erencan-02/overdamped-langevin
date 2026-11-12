import { CollapsiblePanel } from '../ui/collapsiblePanel';
import { fullAppUrl, isEmbedded, toolsParam } from '../ui/embed';
import type { App } from './app';

/**
 * Embedded in another page (an iframe): a compact start (see ui/embed.ts) and a way out to the
 * full app, in the Scene menu and on the title card. Call once at start.
 */
export function setUpEmbedding(): boolean {
  const embedded = isEmbedded();
  document.documentElement.classList.toggle('embedded', embedded);
  if (embedded) {
    document.querySelector<HTMLElement>('[data-action="open-full"]')!.hidden = false;
    const open = document.createElement('a');
    open.className = 'brand-open';
    open.target = '_blank';
    open.rel = 'noopener';
    open.textContent = 'Open the full app ↗';
    open.addEventListener('click', () => (open.href = fullAppUrl())); // the address at the time of the click
    open.href = fullAppUrl();
    document.querySelector('.brand')?.append(open);
  }
  return embedded;
}

/** Phones: the side windows and the Scenario window would cover each other. */
export const narrow = (): boolean => window.matchMedia('(max-width: 640px)').matches;

/**
 * The frame of the page around the scene: the side windows on the left fold away under one
 * header, the settings card folds like the analysis windows, and everything follows the size of
 * the window.
 */
export class Layout {
  /** The settings card (open at start). */
  readonly settingsPanel: CollapsiblePanel;
  /**
   * All side windows on the left, under one header: open at start, except on phones (where they
   * would cover the scene) and when embedded. Folded windows keep their state and keep measuring.
   */
  readonly toolsPanel: CollapsiblePanel;

  private sideMathLoaded = false;
  /** The analysis box was set: from the first real size of the view, or by a scenario. */
  private analysisBoxSet = false;

  constructor(
    private readonly app: App,
    embedded: boolean,
  ) {
    this.settingsPanel = new CollapsiblePanel({ section: 'settings', toggle: 'settings-toggle', body: 'panel' }, () => {});
    this.settingsPanel.setOpen(true);
    this.toolsPanel = new CollapsiblePanel({ section: 'left-col', toggle: 'left-toggle', body: 'left-body' }, (open) => {
      // On phones, opening one folds the other. (At start the Scenario window does not exist
      // yet; it starts folded.)
      if (open && narrow()) app.scenarios?.panel.setOpen(false);
    });
    this.toolsPanel.setOpen(toolsParam() ?? (!narrow() && !embedded));
  }

  /**
   * Formulas in the side windows (e.g. ρ̂_h in the KL window) are typeset with KaTeX, which is
   * loaded the first time a window that shows one is opened.
   */
  typesetSidePanels(): void {
    const sidePanels = document.querySelector<HTMLElement>('.left-col');
    if (this.sideMathLoaded || !sidePanels) return;
    this.sideMathLoaded = true;
    void import('../ui/helpMath').then((m) => m.renderMath(sidePanels, '.tex[data-tex]')).catch((err) => console.error(err));
  }

  /** A scenario sets the analysis box itself: the first real size of the view no longer does. */
  analysisBoxGiven(): void {
    this.analysisBoxSet = true;
  }

  /** Follows the size of the window from now on (and sizes everything once). */
  start(): void {
    const stage = document.getElementById('stage')!;
    new ResizeObserver(() => this.resize()).observe(stage);
    window.addEventListener('resize', () => this.resize());
    this.resize();
    document.fonts?.ready.then(() => this.app.controls.sync());
  }

  /** Sizes the camera, the renderers and the 3D view to the stage. */
  resize(): void {
    const { camera } = this.app.core;
    const stage = document.getElementById('stage')!;
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    camera.setViewport(w, h);
    this.app.graphics.resize(w, h, dpr);
    this.app.viewSwitch.resize(w, h, dpr);
    // The analysis box starts as the initial view: set once the stage has a real size (a page
    // opened in a background tab is laid out with a 1-pixel stage at first).
    if (!this.analysisBoxSet && w > 1 && h > 1) {
      this.analysisBoxSet = true;
      this.app.analysis.monitor.setBox(camera.bounds());
    }
    this.app.controls.sync();
  }
}
