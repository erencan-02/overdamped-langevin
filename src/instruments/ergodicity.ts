import { type CompiledObservable, type EvalContext, loadTexParser, type TexParser } from '../analysis/latex';
import { TimeSeries } from '../analysis/timeSeries';
import type { ParticleSystem } from '../sim/particles';
import type { PotentialSampler } from '../sim/potential';
import { CollapsiblePanel, formatOrDash as fmt } from '../ui/collapsiblePanel';
import { FormulaInput } from '../ui/formulaInput';
import * as kit from '../ui/panelKit';
import { TimeSeriesPlot } from '../ui/timeSeriesPlot';
import { texToText } from '../export/texText';
import type { FrameContext, Instrument } from './instrument';

/** The ensemble mean is sampled at most this often (real time). */
const INTERVAL_MS = 100;

/**
 * Ergodicity: the time average of f along one tagged particle,
 *
 *     (1/t) ∫₀ᵗ f(X_s) ds ,
 *
 * against the ensemble mean (1/N) Σᵢ f(Xᵢ(t)) over all particles at the same instant. For an
 * ergodic process both tend to ∫ f dπ; how fast the time average gets there shows the mixing
 * time (slow in a double well with small σ: metastability).
 *
 * The integral is accumulated after every integrator step (right-endpoint rule), so it does not
 * depend on the frame rate. Nothing is computed while the window is closed.
 */
export class ErgodicityInstrument implements Instrument {
  readonly id = 'ergodicity';
  readonly title = 'Ergodicity';
  readonly series = new TimeSeries(['time', 'ensemble'] as const);
  private readonly panel: CollapsiblePanel;
  private readonly formula: FormulaInput;
  private readonly plot: TimeSeriesPlot;
  private readonly infoLine: HTMLElement;
  private readonly value: HTMLOutputElement;
  private parser: TexParser | null = null;
  private loadStarted = false;
  private fn: CompiledObservable | null = null;
  private readonly ctx: EvalContext;
  /** The tagged particle (−1: none yet), its last known index, and whether it died. */
  private tagId = -1;
  private tagIndex = -1;
  private died = false;
  /** Simulated time of the last step seen, the integral of f and the time integrated. */
  private lastT = NaN;
  private integral = 0;
  private elapsed = 0;
  private ensembleMean = NaN;
  private lastRun = -Infinity;
  private nextTag = 0;
  private readonly one = { x: new Float64Array(1), y: new Float64Array(1) };

  constructor(
    private readonly particles: ParticleSystem,
    potential: PotentialSampler,
    private readonly actions: {
      expression(): string;
      setExpression(tex: string): void;
      sigma(): number;
    },
  ) {
    this.ctx = { sigma: 0, psi: (x, y) => potential.sample(x, y) };
    const parts = kit.createPanel({ id: 'ergodicity', title: 'Ergodicity', label: 'Ergodicity', before: 'analysis' });
    this.value = parts.value;
    const field = kit.formulaField(parts.body, {
      id: 'erg-input',
      label: 'Test function f(x, y)',
      examples: [
        ['x', 'x'],
        ['r²', 'x^2 + y^2'],
        ['𝟏{x>0}', '\\mathbf{1}_{x > 0}'],
      ],
    });
    kit.caption(parts.body, 'Time average of f along the ringed particle against the mean over all particles');
    const canvas = kit.plotCanvas(parts.body, 'Time average and ensemble mean over time');
    this.plot = new TimeSeriesPlot(canvas, 'linear', () => ({
      title: `Ergodicity, f = ${texToText(this.actions.expression())}`,
      xLabel: 'simulated time t',
      yLabel: 'f',
      legend: [
        { kind: 'line', label: 'time average (1/t) ∫₀ᵗ f(Xₛ) ds of one particle' },
        { kind: 'dash', label: 'ensemble mean over all particles' },
      ],
    }));
    kit.legend(parts.body, [
      ['line', 'time average (1/t)∫f(X_s)ds'],
      ['dash', 'ensemble mean'],
    ]);
    this.infoLine = kit.info(parts.body);
    const [tag, reset] = kit.buttons(parts.body, ['Follow another particle', 'Reset']);
    tag.addEventListener('click', () => this.tagNext());
    reset.addEventListener('click', () => this.reset());

    this.formula = new FormulaInput(field, 'f(x,y) = ', {
      tryUse: (tex) => {
        const r = this.parser!.parse(tex);
        if (!r.ok) return r.message;
        this.fn = r.fn;
        this.reset();
        return null;
      },
      committed: (tex) => this.actions.setExpression(tex),
    });
    this.formula.input.value = actions.expression();
    this.panel = new CollapsiblePanel(parts.ids, (open) => {
      if (open) {
        this.load();
        this.formula.loadPreview();
        this.reset();
      } else {
        this.value.textContent = '';
      }
      this.draw();
    });
    new ResizeObserver(() => this.draw()).observe(canvas);
    this.panel.setOpen(false);
  }

  get active(): boolean {
    return this.panel.open && this.fn !== null;
  }

  get open(): boolean {
    return this.panel.open;
  }

  setOpen(open: boolean): void {
    this.panel.setOpen(open);
  }

  /** Takes over an expression set from outside (a scenario, a recording). */
  sync(): void {
    this.formula.setValue(this.actions.expression());
  }

  /** The followed particle, for the overlay (null if none or the window is closed). */
  marker(): { x: number; y: number; label: string } | null {
    if (!this.panel.open || this.tagId < 0 || this.died) return null;
    const i = this.indexOfTag();
    return i < 0 ? null : { x: this.particles.x[i], y: this.particles.y[i], label: 'time average' };
  }

  onStep(ps: ParticleSystem, t: number): void {
    if (this.tagId < 0 || this.died) return;
    const i = this.indexOfTag();
    if (i < 0) {
      this.died = true;
      return;
    }
    if (!Number.isFinite(this.lastT)) {
      this.lastT = t;
      return;
    }
    const dt = t - this.lastT;
    this.lastT = t;
    this.one.x[0] = ps.x[i];
    this.one.y[0] = ps.y[i];
    this.ctx.sigma = this.actions.sigma();
    const v = this.fn!.evaluate(this.one.x, this.one.y, 1, this.ctx)[0];
    if (!Number.isFinite(v)) return; // f undefined there: that moment is left out
    this.integral += v * dt;
    this.elapsed += dt;
  }

  onFrame(ctx: FrameContext): void {
    if (!this.active || ctx.now - this.lastRun < INTERVAL_MS) return;
    this.lastRun = ctx.now;
    const ps = ctx.particles;
    if (this.tagId < 0 && ps.count > 0) this.tagNext();
    // Ensemble mean of f over all particles now (one batch).
    const n = ps.count;
    let mean = NaN;
    if (n > 0) {
      this.ctx.sigma = ctx.sigma;
      const values = this.fn!.evaluate(ps.x, ps.y, n, this.ctx);
      let sum = 0;
      let k = 0;
      for (let i = 0; i < n; i++) {
        if (Number.isFinite(values[i])) {
          sum += values[i];
          k++;
        }
      }
      mean = k > 0 ? sum / k : NaN;
    }
    this.ensembleMean = mean;
    if (this.elapsed > 0 || Number.isFinite(mean)) this.series.push(ps.time, { time: this.timeAverage, ensemble: mean });
    this.draw();
  }

  get timeAverage(): number {
    return this.elapsed > 0 ? this.integral / this.elapsed : NaN;
  }

  readout(): Record<string, number> {
    return { timeAverage: this.timeAverage, ensembleMean: this.ensembleMean, elapsed: this.elapsed };
  }

  /** Starts the time average and the plot over (the followed particle stays). */
  reset(): void {
    this.series.clear();
    this.integral = 0;
    this.elapsed = 0;
    this.lastT = NaN;
    this.ensembleMean = NaN;
    this.lastRun = -Infinity;
    if (this.died) this.tagId = -1; // follow a living particle next
    this.died = false;
    this.draw();
  }

  /** Follows the next particle (in index order) and starts over. */
  private tagNext(): void {
    const ps = this.particles;
    if (ps.count === 0) {
      this.tagId = -1;
      return;
    }
    const i = this.nextTag++ % ps.count;
    this.tagId = ps.id[i];
    this.tagIndex = i;
    this.died = false;
    this.reset();
  }

  private indexOfTag(): number {
    const ps = this.particles;
    const i = this.tagIndex;
    if (i >= 0 && i < ps.count && ps.id[i] === this.tagId) return i;
    for (let k = 0; k < ps.count; k++) {
      if (ps.id[k] === this.tagId) {
        this.tagIndex = k;
        return k;
      }
    }
    return -1;
  }

  private load(): void {
    if (this.loadStarted) return;
    this.loadStarted = true;
    loadTexParser()
      .then((parser) => {
        this.parser = parser;
        this.formula.setReady(this.actions.expression());
        this.draw();
      })
      .catch((err) => {
        console.error(err);
        this.infoLine.textContent = 'The formula engine could not be loaded. Check the connection and reload.';
      });
  }

  private draw(): void {
    if (this.panel?.open) {
      const avg = this.timeAverage;
      this.value.textContent = fmt(avg);
      this.infoLine.textContent = !this.parser
        ? 'Loading the formula engine…'
        : !this.fn
          ? 'Enter a valid function to start.'
          : this.tagId < 0
            ? 'Add particles: one of them is followed.'
            : this.died
              ? 'The followed particle has died. Follow another one.'
              : `Particle #${this.tagId} over t = ${fmt(this.elapsed)}: time average ${fmt(avg)}` +
                ` · ensemble mean now ${fmt(this.ensembleMean)}` +
                ` (N = ${this.particles.count})`;
    }
    const { times, channels } = this.series;
    this.plot.draw({ times, values: channels.time, reference: channels.ensemble });
  }
}
