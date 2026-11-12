import { TimeSeries } from '../analysis/timeSeries';
import type { FrameContext, Instrument } from '../instruments/instrument';
import type { BirthDeath } from '../sim/birthDeath';
import { BranchingReplicas } from '../sim/branching';
import type { Rng } from '../sim/rng';
import { MAX_PARTICLES, type ParticleSystem } from '../sim/particles';
import { byId, CollapsiblePanel, formatValue } from './collapsiblePanel';
import { FormulaInput } from './formulaInput';
import { TimeSeriesPlot } from './timeSeriesPlot';

/** The population curve is sampled at most this often (real time) while the window is open. */
const INTERVAL_MS = 100;
/** Largest rate accepted (per unit of simulated time; the step is 2 ms). */
const MAX_RATE = 100;

/**
 * The birth/death window (an instrument): a switch, the birth rate λ and the death rate μ
 * (validated inputs), and the number of particles over simulated time against its expectation
 * N₀·e^{(λ−μ)(t−t₀)} and the spread of N(t) across 200 independent runs (5–95 % band, sampled
 * exactly, see branching.ts). Expectation and runs restart from the actual count whenever the
 * count changes for another reason (particles added or removed by hand) or the rates change.
 *
 * The curve is only sampled while the window is open.
 */
export class BirthDeathPanel implements Instrument {
  readonly id = 'population';
  readonly title = 'Birth / death';
  private readonly value = byId('bd-value');
  private readonly info = byId('bd-info');
  private readonly toggle = byId<HTMLInputElement>('bd-enabled');
  private readonly plot = new TimeSeriesPlot(byId<HTMLCanvasElement>('bd-plot'), 'linear');
  private readonly panel: CollapsiblePanel;
  private readonly birth: FormulaInput;
  private readonly death: FormulaInput;
  readonly series = new TimeSeries(['count', 'expected', 'lo', 'hi', 'runsMean'] as const);
  /** Independent runs of N(t) from the same start (the spread across runs). */
  private readonly runs: BranchingReplicas;
  private runsT = 0;
  /** Start of the current expectation: time, count, and the process settings it assumes. */
  private base = { t: 0, n: 0, key: '' };
  private last = { n: -1, births: 0, deaths: 0 };
  private lastRun = -Infinity;

  constructor(
    private readonly process: BirthDeath,
    private readonly particles: ParticleSystem,
    private readonly actions: {
      settings(): { enabled: boolean; birthRate: number; deathRate: number };
      set(change: { birthDeath?: boolean; birthRate?: number; deathRate?: number }): void;
    },
    /** Random numbers for the independent runs (their own stream). */
    replicaRng: Rng,
  ) {
    this.runs = new BranchingReplicas(replicaRng);
    const rateInput = (id: string, key: 'birthRate' | 'deathRate') =>
      new FormulaInput(byId(id), '', {
        tryUse: (text) => validateRate(text),
        committed: (text) => this.actions.set({ [key]: Number(text) }),
      });
    this.birth = rateInput('bd-birth-field', 'birthRate');
    this.death = rateInput('bd-death-field', 'deathRate');
    // Plain numbers: nothing to load. The state's rates are shown as they are.
    const initial = actions.settings();
    this.birth.setReady(String(initial.birthRate));
    this.death.setReady(String(initial.deathRate));
    this.panel = new CollapsiblePanel(
      { section: 'birthdeath', toggle: 'birthdeath-toggle', body: 'birthdeath-body' },
      (open) => {
        if (open) this.restart();
        this.draw();
      },
    );
    this.toggle.addEventListener('change', () => this.actions.set({ birthDeath: this.toggle.checked }));
    byId('bd-reset').addEventListener('click', () => this.restart());
    new ResizeObserver(() => this.draw()).observe(byId('bd-plot'));
    this.panel.setOpen(false);
    this.sync();
  }

  /** Shows the state's switch and rates (e.g. after a restored recording). */
  sync(): void {
    const s = this.actions.settings();
    this.toggle.checked = s.enabled;
    this.birth.setValue(String(s.birthRate));
    this.death.setValue(String(s.deathRate));
    this.value.textContent = s.enabled ? `N ${this.particles.count}` : 'off';
  }

  get active(): boolean {
    return this.panel.open;
  }

  setOpen(open: boolean): void {
    this.panel.setOpen(open);
  }

  onFrame(ctx: FrameContext): void {
    this.update(ctx.now);
  }

  readout(): Record<string, number> {
    const n = this.series.length;
    const last = (c: 'expected' | 'runsMean' | 'lo' | 'hi') => (n ? this.series.channels[c][n - 1] : NaN);
    return {
      count: this.particles.count,
      expected: last('expected'),
      runsMean: last('runsMean'),
      runsLow: last('lo'),
      runsHigh: last('hi'),
      runsSd: this.panel.open ? this.runs.stats().sd : NaN,
    };
  }

  reset(): void {
    this.restart();
    this.draw();
  }

  /** Call every frame: samples the population curve (only while the window is open). */
  update(nowMs: number): void {
    const s = this.actions.settings();
    this.value.textContent = s.enabled ? `N ${this.particles.count}` : 'off';
    if (!this.panel.open || nowMs - this.lastRun < INTERVAL_MS) return;
    this.lastRun = nowMs;
    const ps = this.particles;
    const n = ps.count;
    const t = ps.time;
    const key = `${s.enabled}|${s.birthRate}|${s.deathRate}`;
    // Changes of the count that the process did not make (hand edits, playback, …) and new
    // settings start a new expectation from the current state.
    const own = this.process.births - this.last.births - (this.process.deaths - this.last.deaths);
    if (key !== this.base.key || (this.last.n >= 0 && n - this.last.n !== own)) {
      this.base = { t, n, key };
      this.runs.start(n);
      this.runsT = t;
    }
    this.last = { n, births: this.process.births, deaths: this.process.deaths };
    const growth = s.enabled ? s.birthRate - s.deathRate : 0;
    if (s.enabled) this.runs.advance(t - this.runsT, s.birthRate, s.deathRate, MAX_PARTICLES);
    this.runsT = t;
    const r = this.runs.stats();
    this.series.push(t, {
      count: n,
      expected: this.base.n * Math.exp(growth * (t - this.base.t)),
      lo: r.lo,
      hi: r.hi,
      runsMean: r.mean,
    });
    this.draw();
  }

  /** Clears the curve and the counters; the expectation starts from now. */
  private restart(): void {
    this.series.clear();
    this.process.resetCounts();
    const s = this.actions.settings();
    this.base = { t: this.particles.time, n: this.particles.count, key: `${s.enabled}|${s.birthRate}|${s.deathRate}` };
    this.runs.start(this.particles.count);
    this.runsT = this.particles.time;
    this.last = { n: this.particles.count, births: 0, deaths: 0 };
    this.lastRun = -Infinity;
  }

  draw(): void {
    const s = this.actions.settings();
    const p = this.process;
    if (!s.enabled) {
      this.info.textContent = 'Off: the number of particles only changes when you add or remove particles.';
    } else {
      const lifetime = s.deathRate > 0 ? `mean lifetime 1/μ = ${formatValue(1 / s.deathRate)}` : 'no deaths';
      const full = p.blocked > 0 ? ` · ${p.blocked} births skipped (limit of ${MAX_PARTICLES} particles)` : '';
      this.info.textContent =
        `N = ${this.particles.count} · births ${p.births} · deaths ${p.deaths} · ` +
        `growth λ − μ = ${formatValue(s.birthRate - s.deathRate)} · ${lifetime}${full}`;
    }
    const { times, channels } = this.series;
    this.plot.draw({ times, values: channels.count, reference: channels.expected, band: { lo: channels.lo, hi: channels.hi } });
  }
}

/** null if `text` is an acceptable rate, else the message for the user. */
function validateRate(text: string): string | null {
  const t = text.trim();
  if (t === '') return 'Enter a rate, e.g. 0.5.';
  if (!/^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t)) return 'Enter a number ≥ 0, e.g. 0.5 (per unit of time).';
  const v = Number(t);
  if (!Number.isFinite(v) || v < 0) return 'Enter a number ≥ 0, e.g. 0.5 (per unit of time).';
  if (v > MAX_RATE) return `At most ${MAX_RATE} per unit of time.`;
  return null;
}
