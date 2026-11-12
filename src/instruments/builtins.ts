import type { EquilibriumMonitor } from '../analysis/equilibrium';
import type { ObservableMonitor } from '../analysis/observable';
import type { KlPanel } from '../ui/klPanel';
import type { ObservablePanel } from '../ui/observablePanel';
import type { PotentialPanel } from '../ui/potentialPanel';
import type { FrameContext, Instrument } from './instrument';

/**
 * The analysis windows that existed before the instrument registry, as instruments: the monitor
 * does the estimating, the window shows it, and these adapters give both the common interface
 * (and keep the hooks that recordings need).
 */

/** KL(ρ̂_h ‖ π) inside the analysis box. */
export class KlInstrument implements Instrument {
  readonly id = 'kl';
  readonly title = 'KL to equilibrium';

  constructor(
    private readonly monitor: EquilibriumMonitor,
    private readonly panel: KlPanel,
    private readonly hooks: {
      /** The smoothed density is drawn on the scene (it needs estimates while the window is closed). */
      showDensity(): boolean;
      /** A new estimate was taken (e.g. for a recording). */
      sampled(t: number): void;
    },
  ) {}

  get active(): boolean {
    return this.monitor.active;
  }

  get series() {
    return this.monitor.series;
  }

  setOpen(open: boolean): void {
    this.panel.setOpen(open);
  }

  onFrame(ctx: FrameContext): void {
    const density = this.hooks.showDensity();
    this.monitor.keepRunning = ctx.recording || density;
    if (this.monitor.update(ctx.now, ctx.sigma, ctx.kernelVariance, density ? 33 : 100)) {
      this.panel.draw();
      this.hooks.sampled(ctx.particles.time);
    }
  }

  readout(): Record<string, number> {
    const s = this.monitor.latest;
    return { kl: s?.kl ?? Number.NaN, floor: s?.floor ?? Number.NaN, inside: s?.inside ?? Number.NaN };
  }

  reset(): void {
    this.monitor.reset();
    this.panel.draw();
  }
}

/** E[f(X_t)] over the particles in the analysis box, with its CI and ∫ f dπ. */
export class ObservableInstrument implements Instrument {
  readonly id = 'observable';
  readonly title = 'Observable';

  constructor(
    private readonly monitor: ObservableMonitor,
    private readonly panel: ObservablePanel,
    private readonly hooks: { sampled(t: number): void },
  ) {}

  get active(): boolean {
    return this.monitor.active;
  }

  get series() {
    return this.monitor.series;
  }

  setOpen(open: boolean): void {
    this.panel.setOpen(open);
  }

  onFrame(ctx: FrameContext): void {
    this.monitor.keepRunning = ctx.recording;
    if (this.monitor.update(ctx.now, ctx.sigma, ctx.kernelVariance)) {
      this.panel.draw();
      this.hooks.sampled(ctx.particles.time);
    }
  }

  readout(): Record<string, number> {
    const s = this.monitor.latest;
    return { mean: s?.mean ?? Number.NaN, ci: s?.ci ?? Number.NaN, exact: s?.exact ?? Number.NaN, inside: s?.inside ?? Number.NaN };
  }

  reset(): void {
    this.monitor.reset();
    this.panel.draw();
  }
}

/** ‖∇Ψ‖ in L² of the analysis box (the potential window). */
export class GradientNormInstrument implements Instrument {
  readonly id = 'potential';
  readonly title = 'Potential';

  constructor(private readonly panel: PotentialPanel) {}

  get active(): boolean {
    return this.panel.open;
  }

  setOpen(open: boolean): void {
    this.panel.setOpen(open);
  }

  onFrame(ctx: FrameContext): void {
    this.panel.update(ctx.now);
  }

  readout(): Record<string, number> {
    return { gradientNorm: this.panel.gradientNorm };
  }

  reset(): void {}
}
