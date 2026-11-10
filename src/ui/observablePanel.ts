import { loadTexParser, type TexParser } from '../analysis/latex';
import type { ObservableMonitor } from '../analysis/observable';
import { byId, CollapsiblePanel, formatValue } from './collapsiblePanel';
import { TimeSeriesPlot } from './timeSeriesPlot';

/** Delay after the last keystroke before the input is parsed (no red flashes while typing). */
const PARSE_DELAY_MS = 350;

/**
 * The observables window: a LaTeX input for a test function f(x, y), validated as it is typed
 * (red outline and message on errors, a rendered preview otherwise), and a live plot of the
 * particle mean of f with its 95 % confidence band against the exact Gibbs expectation.
 *
 * Parsing and the preview use the Compute Engine and KaTeX, both loaded when the window is
 * first opened. While the input is invalid, the last valid function stays in use (and in the
 * state).
 */
export class ObservablePanel {
  private readonly input = byId<HTMLInputElement>('obs-input');
  private readonly error = byId('obs-error');
  private readonly preview = byId('obs-preview');
  private readonly value = byId('obs-value');
  private readonly info = byId('obs-info');
  private readonly plot = new TimeSeriesPlot(byId<HTMLCanvasElement>('obs-plot'), 'linear');
  private readonly panel: CollapsiblePanel;
  private timer = 0;
  /** The expression the monitor currently uses ('' until the parser has loaded). */
  private applied = '';
  private parser: TexParser | null = null;
  private loadFailed = false;
  private loadStarted = false;
  private katex: typeof import('./helpMath') | null = null;

  constructor(
    private readonly monitor: ObservableMonitor,
    private readonly actions: {
      /** The current expression from the state. */
      expression(): string;
      /** A new valid expression was entered. */
      setExpression(tex: string): void;
      fitBox(): void;
    },
  ) {
    this.panel = new CollapsiblePanel(
      { section: 'observable', toggle: 'observable-toggle', body: 'observable-body' },
      (open) => {
        this.monitor.enabled = open;
        if (open) {
          if (!this.monitor.keepRunning) this.monitor.reset();
          this.load();
          this.draw();
        } else {
          this.value.textContent = '';
        }
      },
    );
    this.input.addEventListener('input', () => {
      window.clearTimeout(this.timer);
      this.timer = window.setTimeout(() => this.commit(), PARSE_DELAY_MS);
    });
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.commit();
      } else if (e.key === 'Escape') {
        // Give up the edit: back to the expression in use (and nothing else reacts to Escape).
        e.stopPropagation();
        if (this.applied) this.input.value = this.applied;
        this.commit();
        this.input.blur();
      }
    });
    this.input.addEventListener('blur', () => this.commit());
    for (const b of document.querySelectorAll<HTMLButtonElement>('.obs-examples button')) {
      b.addEventListener('click', () => {
        this.input.value = b.dataset.tex ?? '';
        this.commit();
      });
    }
    byId('obs-fit').addEventListener('click', () => actions.fitBox());
    byId('obs-reset').addEventListener('click', () => {
      this.monitor.reset();
      this.draw();
    });
    new ResizeObserver(() => this.draw()).observe(byId('obs-plot'));

    this.input.value = actions.expression();
    this.panel.setOpen(false);
  }

  /** Takes over an expression set from outside (a restored recording). */
  sync(): void {
    const tex = this.actions.expression();
    if (tex === this.applied) return;
    if (document.activeElement !== this.input) this.input.value = tex;
    if (this.parser) this.use(tex);
    // Otherwise the input holds it until the parser has loaded.
  }

  /** Loads the parser and KaTeX (once), then starts using the expression in the input. */
  private load(): void {
    if (this.loadStarted) return;
    this.loadStarted = true;
    import('./helpMath')
      .then((m) => {
        this.katex = m;
        this.renderPreview();
      })
      .catch((err) => console.error(err)); // the preview is optional
    loadTexParser()
      .then((parser) => {
        this.parser = parser;
        this.commit();
        this.draw();
      })
      .catch((err) => {
        console.error(err);
        this.loadFailed = true;
        this.draw();
      });
  }

  /** Parses the input: shows the error, or starts using the new function. */
  private commit(): void {
    window.clearTimeout(this.timer);
    if (!this.parser) return;
    const tex = this.input.value.trim();
    if (tex === this.applied) {
      this.showError(null);
      return;
    }
    if (this.use(tex)) this.actions.setExpression(tex);
  }

  /** Starts using `tex` if it is valid; otherwise shows why not. */
  private use(tex: string): boolean {
    const r = this.parser!.parse(tex);
    if (!r.ok) {
      this.showError(r.message);
      return false;
    }
    this.showError(null);
    this.applied = tex;
    this.monitor.setFunction(r.fn);
    this.renderPreview();
    this.draw();
    return true;
  }

  private showError(message: string | null): void {
    this.input.setAttribute('aria-invalid', String(message !== null));
    this.error.hidden = message === null;
    this.error.textContent = message ?? '';
    // The preview keeps showing the function in use, dimmed while the input differs from it.
    this.preview.classList.toggle('stale', message !== null);
  }

  private renderPreview(): void {
    if (!this.katex || !this.applied) return;
    this.katex.renderTex(this.preview, `f(x,y) = ${this.applied}`);
  }

  /** Updates the readouts and the plot from the monitor's latest sample. */
  draw(): void {
    const s = this.monitor.latest;
    if (this.monitor.enabled) {
      this.value.textContent = s && Number.isFinite(s.mean) ? formatValue(s.mean) : '—';
      const undef = s && s.undefinedAt > 0 ? ` · f undefined at ${s.undefinedAt}` : '';
      if (this.loadFailed) {
        this.info.textContent = 'The formula engine could not be loaded. Check the connection and reload.';
      } else if (!this.parser) {
        this.info.textContent = 'Loading the formula engine…';
      } else if (!this.applied) {
        this.info.textContent = 'Enter a valid function to start.';
      } else if (!s) {
        this.info.textContent = 'Waiting for particles…';
      } else if (s.inside === 0) {
        this.info.textContent = `No particles in the box (${s.total} in total)${undef}.`;
      } else {
        const exact = Number.isFinite(s.exact)
          ? `∫f dπ ${s.exactStale ? '≈' : '='} ${formatValue(s.exact)}${s.exactStale ? ' (updating)' : ''}`
          : this.monitor.sigmaIsZero
            ? 'σ = 0: π has no density'
            : '∫f dπ undefined (f not finite)';
        const ci = Number.isFinite(s.ci) ? ` ± ${formatValue(s.ci)}` : '';
        const bias = Number.isFinite(s.exact) ? ` · error ${formatValue(s.mean - s.exact)}${ci}` : '';
        this.info.textContent = `${s.inside} / ${s.total} in the box · ${exact}${bias}${undef}`;
      }
    }
    const { times, channels } = this.monitor.series;
    this.plot.draw({
      times,
      values: channels.mean,
      band: { lo: channels.lo, hi: channels.hi },
      reference: channels.exact,
    });
  }
}
