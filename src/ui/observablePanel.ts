import { loadTexParser, type TexParser } from '../analysis/latex';
import type { ObservableMonitor } from '../analysis/observable';
import { byId, CollapsiblePanel, formatValue } from './collapsiblePanel';
import { FormulaInput } from './formulaInput';
import { TimeSeriesPlot } from './timeSeriesPlot';
import { texToText } from '../export/texText';

/**
 * The observables window: a LaTeX input for a test function f(x, y) (FormulaInput: validated as
 * it is typed, with a rendered preview and examples), and a live plot of the particle mean of f
 * with its 95 % confidence band against the exact Gibbs expectation.
 *
 * Nothing is computed while the window is closed (unless a recording needs it), and the formula
 * engine and KaTeX are only loaded when it is first opened.
 */
export class ObservablePanel {
  private readonly value = byId('obs-value');
  private readonly info = byId('obs-info');
  private readonly plot = new TimeSeriesPlot(byId<HTMLCanvasElement>('obs-plot'), 'linear', () => ({
    title: `Observable E[f(Xₜ)], f = ${texToText(this.actions.expression())}`,
    xLabel: 'simulated time t',
    yLabel: 'E[f(Xₜ) | Xₜ ∈ B]',
    legend: [
      { kind: 'line', label: 'particle mean' },
      { kind: 'band', label: '95 % confidence interval' },
      { kind: 'dash', label: 'exact ∫ f dπ' },
    ],
  }));
  private readonly panel: CollapsiblePanel;
  private readonly formula: FormulaInput;
  private parser: TexParser | null = null;
  private loadFailed = false;
  private loadStarted = false;

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
    this.formula = new FormulaInput(byId('observable-body'), 'f(x,y) = ', {
      tryUse: (tex) => {
        const r = this.parser!.parse(tex);
        if (!r.ok) return r.message;
        this.monitor.setFunction(r.fn);
        this.draw();
        return null;
      },
      committed: (tex) => this.actions.setExpression(tex),
    });
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
    byId('obs-fit').addEventListener('click', () => actions.fitBox());
    byId('obs-reset').addEventListener('click', () => {
      this.monitor.reset();
      this.draw();
    });
    new ResizeObserver(() => this.draw()).observe(byId('obs-plot'));

    this.formula.input.value = actions.expression();
    this.panel.setOpen(false);
  }

  setOpen(open: boolean): void {
    this.panel.setOpen(open);
  }

  /** Takes over an expression set from outside (a restored recording). */
  sync(): void {
    this.formula.setValue(this.actions.expression());
  }

  /** Loads the parser and KaTeX (once), then starts using the expression in the input. */
  private load(): void {
    this.formula.loadPreview();
    if (this.loadStarted) return;
    this.loadStarted = true;
    loadTexParser()
      .then((parser) => {
        this.parser = parser;
        this.formula.setReady();
        this.draw();
      })
      .catch((err) => {
        console.error(err);
        this.loadFailed = true;
        this.draw();
      });
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
      } else if (!this.formula.applied) {
        this.info.textContent = 'Enter a valid function to start.';
      } else if (!s) {
        this.info.textContent = 'Waiting for particles…';
      } else if (s.inside === 0) {
        this.info.textContent = `No particles in the box (${s.total} in total)${undef}.`;
      } else {
        const exact = !this.monitor.gibbs
          ? 'no closed-form π for this process'
          : Number.isFinite(s.exact)
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
