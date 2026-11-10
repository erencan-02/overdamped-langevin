import { TimeSeries } from '../analysis/timeSeries';
import type { BirthDeath } from '../sim/birthDeath';
import { MAX_PARTICLES, type ParticleSystem } from '../sim/particles';
import { byId, CollapsiblePanel, formatValue } from './collapsiblePanel';
import { FormulaInput } from './formulaInput';
import { TimeSeriesPlot } from './timeSeriesPlot';

/** The population curve is sampled at most this often (real time) while the window is open. */
const INTERVAL_MS = 100;
/** Largest rate accepted (per unit of simulated time; the step is 2 ms). */
const MAX_RATE = 100;

/**
 * The birth/death window: a switch, the birth rate λ and the death rate μ (validated inputs),
 * and the number of particles over simulated time against its expectation N₀·e^{(λ−μ)(t−t₀)}.
 * The expectation restarts from the actual count whenever the count changes for another reason
 * (particles added or removed by hand) or the rates change.
 *
 * The curve is only sampled while the window is open.
 */
export class BirthDeathPanel {
  private readonly value = byId('bd-value');
  private readonly info = byId('bd-info');
  private readonly toggle = byId<HTMLInputElement>('bd-enabled');
  private readonly plot = new TimeSeriesPlot(byId<HTMLCanvasElement>('bd-plot'), 'linear');
  private readonly panel: CollapsiblePanel;
  private readonly birth: FormulaInput;
  private readonly death: FormulaInput;
  private readonly series = new TimeSeries(['count', 'expected'] as const);
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
  ) {
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
    if (key !== this.base.key || (this.last.n >= 0 && n - this.last.n !== own)) this.base = { t, n, key };
    this.last = { n, births: this.process.births, deaths: this.process.deaths };
    const growth = s.enabled ? s.birthRate - s.deathRate : 0;
    this.series.push(t, { count: n, expected: this.base.n * Math.exp(growth * (t - this.base.t)) });
    this.draw();
  }

  /** Clears the curve and the counters; the expectation starts from now. */
  private restart(): void {
    this.series.clear();
    this.process.resetCounts();
    const s = this.actions.settings();
    this.base = { t: this.particles.time, n: this.particles.count, key: `${s.enabled}|${s.birthRate}|${s.deathRate}` };
    this.last = { n: this.particles.count, births: 0, deaths: 0 };
    this.lastRun = -Infinity;
  }

  private draw(): void {
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
    this.plot.draw({ times, values: channels.count, reference: channels.expected });
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
