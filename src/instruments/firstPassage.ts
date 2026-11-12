import { type CompiledObservable, type EvalContext, loadTexParser, type TexParser } from '../analysis/latex';
import { TimeSeries } from '../analysis/timeSeries';
import type { ParticleSystem } from '../sim/particles';
import type { PotentialSampler } from '../sim/potential';
import { CollapsiblePanel, formatOrDash as fmt } from '../ui/collapsiblePanel';
import { FormulaInput } from '../ui/formulaInput';
import * as kit from '../ui/panelKit';
import { TimeSeriesPlot } from '../ui/timeSeriesPlot';
import { type Rect, type RegionImage, RegionRaster } from '../view/regionRaster';
import type { FrameContext, Instrument } from './instrument';

/** The curve is sampled at most this often (real time). */
const INTERVAL_MS = 100;

/**
 * First-passage times τ = inf{t ≥ t₀ : X_t ∈ A} into a target set A = {g(x, y) > 0}, for the
 * particles present when the measurement starts (the cohort).
 *
 * After every integrator step the particles that have not arrived yet are checked, so τ is
 * known to within one step (2 ms). Particles that die before arriving are censored, and the
 * distribution is the Kaplan–Meier estimate: S(t) = P(τ > t) drops by the factor
 * (1 − arrivals / at risk) at each step with arrivals. The window shows P(τ ≤ t) = 1 − S(t), the
 * mean τ of the arrived particles and the restricted mean E[τ ∧ t] = ∫₀ᵗ S(u) du, which equals
 * E[τ] once every particle has arrived (and is a lower bound before).
 */
export class FirstPassageInstrument implements Instrument {
  readonly id = 'firstPassage';
  readonly title = 'First passage';
  readonly series = new TimeSeries(['hit'] as const);
  private readonly panel: CollapsiblePanel;
  private readonly formula: FormulaInput;
  private readonly plot: TimeSeriesPlot;
  private readonly infoLine: HTMLElement;
  private readonly value: HTMLOutputElement;
  private parser: TexParser | null = null;
  private loadStarted = false;
  private fn: CompiledObservable | null = null;
  /** What g depends on besides x and y (its picture changes with them), and a version per formula. */
  private fnUses = { psi: false, sigma: false };
  private fnVersion = 0;
  private readonly ctx: EvalContext;
  /** The target set A drawn on the scene (only while the window is open). */
  private readonly raster = new RegionRaster();

  /** Arrival time by particle id (NaN: not arrived yet) for the cohort; empty: not started. */
  private readonly status = new Map<number, number>();
  private started = false;
  private t0 = 0;
  private lastT = 0;
  private cohort = 0;
  private atRisk = 0;
  private hits = 0;
  private censored = 0;
  /** Kaplan–Meier survival S(t) = P(τ > t), and ∫ S dt since t₀. */
  private survival = 1;
  private restricted = 0;
  private sumHit = 0;
  private lastRun = -Infinity;
  private xs = new Float64Array(64);
  private ys = new Float64Array(64);
  private ids = new Uint32Array(64);

  constructor(
    potential: PotentialSampler,
    private readonly actions: {
      expression(): string;
      setExpression(tex: string): void;
      sigma(): number;
    },
  ) {
    this.ctx = { sigma: 0, psi: (x, y) => potential.sample(x, y) };
    const parts = kit.createPanel({ id: 'passage', title: 'First passage τ_A', label: 'First passage', before: 'analysis' });
    this.value = parts.value;
    const field = kit.formulaField(parts.body, {
      id: 'passage-input',
      label: 'Target A = {g(x, y) > 0}, g =',
      examples: [
        ['x > 0', 'x'],
        ['x > 2', 'x - 2'],
        ['disc at (2, 0)', '1 - (x - 2)^2 - y^2'],
        ['outside r = 3', 'x^2 + y^2 - 9'],
      ],
    });
    kit.note(parts.body, 'A is shaded on the scene while this window is open.');
    kit.caption(parts.body, 'Fraction of the particles that have reached A, over simulated time');
    const canvas = kit.plotCanvas(parts.body, 'Fraction arrived over time');
    this.plot = new TimeSeriesPlot(canvas, 'linear');
    kit.legend(parts.body, [['line', 'P(τ_A ≤ t), Kaplan–Meier']]);
    this.infoLine = kit.info(parts.body);
    const [restart] = kit.buttons(parts.body, ['Start again from now']);
    restart.addEventListener('click', () => this.reset());

    this.formula = new FormulaInput(field, 'g(x,y) = ', {
      tryUse: (tex) => {
        const r = this.parser!.parse(tex);
        if (!r.ok) return r.message;
        this.fn = r.fn;
        this.fnUses = { psi: r.usesPsi, sigma: r.usesSigma };
        this.fnVersion++;
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

  /**
   * The target set A = {g > 0} as a tint for the scene, or null while the window is closed or
   * g is not ready. Computed only on request, and only again when g, the view (beyond a margin)
   * or what g depends on (Ψ, σ) changed.
   */
  targetRegion(view: Rect, pxPerUnit: number, psiRevision: string): RegionImage | null {
    const fn = this.fn;
    if (!this.panel.open || !fn) return null;
    const sigma = this.actions.sigma();
    const key = `${this.fnVersion}|${this.fnUses.sigma ? sigma : ''}|${this.fnUses.psi ? psiRevision : ''}`;
    return this.raster.image(view, pxPerUnit, key, (xs, ys, n) => {
      this.ctx.sigma = sigma;
      return fn.evaluate(xs, ys, n, this.ctx);
    });
  }

  /** Takes over a target set from outside (a scenario, a recording). */
  sync(): void {
    this.formula.setValue(this.actions.expression());
  }

  onStep(ps: ParticleSystem, t: number): void {
    if (!this.started) return;
    this.restricted += this.survival * (t - this.lastT);
    this.lastT = t;
    this.check(ps, t);
  }

  onFrame(ctx: FrameContext): void {
    if (!this.active) return;
    const ps = ctx.particles;
    if (!this.started && ps.count > 0) this.start(ps);
    if (!this.started || ctx.now - this.lastRun < INTERVAL_MS) return;
    this.lastRun = ctx.now;
    this.series.push(ps.time, { hit: 1 - this.survival });
    this.draw();
  }

  readout(): Record<string, number> {
    const all = this.started && this.atRisk === 0 && this.censored === 0;
    return {
      fraction: this.started ? 1 - this.survival : NaN,
      hits: this.hits,
      cohort: this.cohort,
      meanHit: this.hits > 0 ? this.sumHit / this.hits : NaN,
      restrictedMean: this.started ? this.restricted : NaN,
      meanTau: all ? this.sumHit / this.hits : NaN,
    };
  }

  /** Starts a new measurement with the particles present now (at the next frame). */
  reset(): void {
    this.started = false;
    this.status.clear();
    this.series.clear();
    this.cohort = this.atRisk = this.hits = this.censored = 0;
    this.survival = 1;
    this.restricted = 0;
    this.sumHit = 0;
    this.lastRun = -Infinity;
    this.draw();
  }

  private start(ps: ParticleSystem): void {
    if (!this.fn) return;
    this.started = true;
    this.t0 = this.lastT = ps.time;
    for (let i = 0; i < ps.count; i++) this.status.set(ps.id[i], Number.NaN);
    this.cohort = this.atRisk = ps.count;
    this.check(ps, ps.time); // particles already in A arrive at once (τ = 0)
  }

  /** Checks the particles that have not arrived yet; updates the survival estimate. */
  private check(ps: ParticleSystem, t: number): void {
    if (this.atRisk === 0) return;
    if (this.xs.length < ps.count) {
      this.xs = new Float64Array(ps.x.length);
      this.ys = new Float64Array(ps.x.length);
      this.ids = new Uint32Array(ps.x.length);
    }
    let n = 0;
    for (let i = 0; i < ps.count; i++) {
      const s = this.status.get(ps.id[i]);
      if (s === undefined || !Number.isNaN(s)) continue; // not in the cohort, or arrived
      this.xs[n] = ps.x[i];
      this.ys[n] = ps.y[i];
      this.ids[n] = ps.id[i];
      n++;
    }
    // Cohort particles that are gone without arriving have died: censored at this time.
    if (n < this.atRisk) {
      this.censored += this.atRisk - n;
      this.atRisk = n;
    }
    if (n === 0) return;
    this.ctx.sigma = this.actions.sigma();
    const g = this.fn!.evaluate(this.xs, this.ys, n, this.ctx);
    let arrived = 0;
    for (let k = 0; k < n; k++) {
      if (g[k] > 0) {
        this.status.set(this.ids[k], t);
        this.sumHit += t - this.t0;
        arrived++;
      }
    }
    if (arrived > 0) {
      this.survival *= 1 - arrived / this.atRisk;
      this.atRisk -= arrived;
      this.hits += arrived;
    }
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
      const r = this.readout();
      this.value.textContent = this.started ? `${this.hits}/${this.cohort}` : '—';
      const elapsed = this.lastT - this.t0;
      this.infoLine.textContent = !this.parser
        ? 'Loading the formula engine…'
        : !this.fn
          ? 'Enter a valid function g to start.'
          : !this.started
            ? 'Add particles: the ones present when the measurement starts are followed.'
            : `${this.hits} / ${this.cohort} reached A` +
              (this.censored ? ` (${this.censored} died before)` : '') +
              ` · P(τ ≤ ${fmt(elapsed)}) = ${fmt(r.fraction)}` +
              (Number.isFinite(r.meanTau)
                ? ` · all arrived: E[τ] ≈ ${fmt(r.meanTau)}`
                : ` · mean τ of those: ${fmt(r.meanHit)} · E[τ ∧ t] = ${fmt(r.restrictedMean)} (a lower bound for E[τ])`);
    }
    const { times, channels } = this.series;
    this.plot.draw({ times, values: channels.hit });
  }
}
