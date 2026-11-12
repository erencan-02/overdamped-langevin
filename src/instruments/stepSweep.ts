import { runSweep, type SweepResult } from '../analysis/stepSweep';
import type { ParticleSystem } from '../sim/particles';
import { Sde } from '../sim/process';
import type { Rng } from '../sim/rng';
import { SCHEME_ORDER, SCHEMES, type SchemeId } from '../sim/schemes';
import { CollapsiblePanel, formatOrDash as fmt } from '../ui/collapsiblePanel';
import { LogLogPlot } from '../ui/logLogPlot';
import * as kit from '../ui/panelKit';
import type { FrameContext, Instrument } from './instrument';

const COLORS: Record<SchemeId, string> = { heun: '#2563eb', 'euler-maruyama': '#e11d48', milstein: '#059669' };
/** Step sizes T/2^ℓ of the sweep and of the reference run. */
const LEVELS = [3, 4, 5, 6, 7, 8];
const REF_LEVEL = 11;

/**
 * The Δt sweep: strong and weak errors of every scheme against the step size, on the current
 * process, from the current particle positions (see analysis/stepSweep.ts). It runs on demand
 * (a button), in chunks so the page stays responsive, and only then; the simulation itself is
 * not touched. The fitted slopes are the measured convergence orders.
 */
export class StepSweepInstrument implements Instrument {
  readonly id = 'sweep';
  readonly title = 'Δt sweep';
  private readonly panel: CollapsiblePanel;
  private readonly plot: LogLogPlot;
  private readonly infoLine: HTMLElement;
  private readonly value: HTMLOutputElement;
  private readonly run: HTMLButtonElement;
  private readonly pathsInput: HTMLInputElement;
  private readonly horizonInput: HTMLInputElement;
  private result: SweepResult | null = null;
  private running = false;
  private cancelled = false;

  constructor(
    private readonly particles: ParticleSystem,
    private readonly actions: {
      /** The process now (it is copied, so later changes do not affect a running sweep). */
      process(): Sde;
      /** Random numbers for the sweep's Brownian paths. */
      rng(): Rng;
      /** The simulation cannot be used now (e.g. a formula is still compiling). */
      blocked(): string | null;
    },
  ) {
    const parts = kit.createPanel({ id: 'sweep', title: 'Δt sweep', label: 'Step size sweep', before: 'analysis' });
    this.value = parts.value;
    kit.note(
      parts.body,
      'Integrates M paths over [t, t + T] with every scheme at Δt = T/8 … T/256, driven by the same Brownian paths, and compares with the same scheme at Δt = T/2048.',
    );
    const row = document.createElement('div');
    row.className = 'bd-rates';
    parts.body.append(row);
    this.pathsInput = kit.numberField(row, { id: 'sweep-paths', label: 'Paths M', value: 400, min: 20, max: 4000, step: 10 });
    this.horizonInput = kit.numberField(row, { id: 'sweep-horizon', label: 'Horizon T', value: 1, min: 0.05, max: 20, step: 0.05 });
    kit.caption(parts.body, 'Error at time T against the step size (log–log)');
    const canvas = kit.plotCanvas(parts.body, 'Strong and weak errors against the step size');
    this.plot = new LogLogPlot(canvas);
    kit.legend(parts.body, [
      ...SCHEME_ORDER.map((id) => [COLORS[id], SCHEMES[id].short] as const),
      ['line', 'strong E|X − X_ref|'],
      ['dash:#0f172a', 'weak |E|X|² − E|X_ref|²|'],
    ]);
    this.infoLine = kit.info(parts.body);
    [this.run] = kit.buttons(parts.body, ['Run sweep']);
    this.run.addEventListener('click', () => (this.running ? (this.cancelled = true) : void this.start()));
    this.panel = new CollapsiblePanel(parts.ids, (open) => {
      if (open) this.draw();
    });
    new ResizeObserver(() => this.draw()).observe(canvas);
    this.panel.setOpen(false);
  }

  get active(): boolean {
    return this.running;
  }

  setOpen(open: boolean): void {
    this.panel.setOpen(open);
  }

  onFrame(_ctx: FrameContext): void {}

  readout(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const s of this.result?.schemes ?? []) {
      out[`strongOrder.${s.id}`] = s.strongOrder;
      out[`weakOrder.${s.id}`] = s.weakOrder;
    }
    return out;
  }

  reset(): void {
    this.cancelled = this.running;
    this.result = null;
    this.draw();
  }

  /** Runs the sweep from the current particles (or the origin, if there are none). */
  async start(): Promise<void> {
    const blocked = this.actions.blocked();
    if (blocked) {
      this.infoLine.textContent = blocked;
      return;
    }
    const M = clampInt(this.pathsInput.value, 20, 4000, 400);
    const T = clampNum(this.horizonInput.value, 0.05, 20, 1);
    this.pathsInput.value = String(M);
    this.horizonInput.value = String(T);
    const ps = this.particles;
    const x0 = new Float64Array(M);
    const y0 = new Float64Array(M);
    for (let m = 0; m < M && ps.count > 0; m++) {
      x0[m] = ps.x[m % ps.count];
      y0[m] = ps.y[m % ps.count];
    }
    const live = this.actions.process();
    const process = new Sde();
    process.potential = live.potential;
    process.extraDrift = live.extraDrift;
    process.noise = live.noise;
    process.sigma = live.sigma;

    this.running = true;
    this.cancelled = false;
    this.run.textContent = 'Cancel';
    this.value.textContent = '…';
    try {
      this.result = await runSweep({
        process,
        x0,
        y0,
        t0: ps.time,
        T,
        levels: LEVELS,
        refLevel: REF_LEVEL,
        schemes: SCHEME_ORDER,
        rng: this.actions.rng(),
        chunk: Math.max(8, Math.round(64 * (400 / M))),
        pause: async () => {
          await new Promise((r) => setTimeout(r, 0));
          if (this.cancelled) throw new Cancelled();
        },
        onProgress: (f) => {
          this.infoLine.textContent = `Running… ${Math.round(100 * f)} % (${M} paths, ${SCHEME_ORDER.length} schemes)`;
        },
      });
    } catch (err) {
      if (!(err instanceof Cancelled)) throw err;
      this.infoLine.textContent = 'Cancelled.';
    } finally {
      this.running = false;
      this.run.textContent = 'Run sweep';
      this.draw();
    }
  }

  private draw(): void {
    const r = this.result;
    if (!this.running) {
      this.value.textContent = r ? 'done' : '';
      if (r) {
        const orders = r.schemes
          .map((s) => `${SCHEMES[s.id].short}: strong ${fmt(s.strongOrder)}, weak ${fmt(s.weakOrder)}`)
          .join(' · ');
        this.infoLine.textContent = `Measured orders (slopes) with ${r.paths} paths, T = ${fmt(r.T)}: ${orders}.`;
      } else if (this.infoLine.textContent !== 'Cancelled.') {
        this.infoLine.textContent = 'Uses the current process and particle positions (the origin if there are none).';
      }
    }
    if (!this.panel?.open) return;
    const curves = (r?.schemes ?? []).flatMap((s) => [
      { xs: r!.dts, ys: s.strong, color: COLORS[s.id] },
      { xs: r!.dts, ys: s.weak, color: COLORS[s.id], dashed: true },
    ]);
    this.plot.draw(curves, 'Δt');
  }
}

class Cancelled extends Error {}

function clampInt(text: string, min: number, max: number, fallback: number): number {
  const v = Math.round(Number(text));
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
}

function clampNum(text: string, min: number, max: number, fallback: number): number {
  const v = Number(text);
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
}
