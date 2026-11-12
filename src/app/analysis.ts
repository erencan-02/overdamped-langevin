import { EquilibriumMonitor } from '../analysis/equilibrium';
import { ObservableMonitor } from '../analysis/observable';
import { GradientNormInstrument, KlInstrument, ObservableInstrument } from '../instruments/builtins';
import { ErgodicityInstrument } from '../instruments/ergodicity';
import { FirstPassageInstrument } from '../instruments/firstPassage';
import { chainSteps, InstrumentRegistry } from '../instruments/instrument';
import { StepSweepInstrument } from '../instruments/stepSweep';
import { BirthDeath } from '../sim/birthDeath';
import { BirthDeathPanel } from '../ui/birthDeathPanel';
import { KlPanel } from '../ui/klPanel';
import { ObservablePanel } from '../ui/observablePanel';
import type { App } from './app';

/**
 * The measurements: the distance to equilibrium (KL), observables E[f(X_t)], births and deaths,
 * and the instruments (ergodicity, first passage, Δt sweep, ‖∇Ψ‖). All analysis tools are behind
 * one interface (see instruments/instrument.ts): each gets every frame, the path-following ones
 * also every integrator step (after births and deaths). Build after the formulas.
 */
export class Analysis {
  /** Distance to equilibrium: KL between the kernel-smoothed particles and the Gibbs measure. */
  readonly monitor: EquilibriumMonitor;
  readonly klPanel: KlPanel;
  /** Weak convergence: E[f(X_t)] for a test function typed in LaTeX, against ∫ f dπ. */
  readonly observables: ObservableMonitor;
  readonly observablePanel: ObservablePanel;
  /**
   * Births and deaths: exponential clocks per particle, run after every integrator step. They
   * draw from their own random stream, and recordings get every event (the lineage).
   */
  readonly birthDeath: BirthDeath;
  readonly birthDeathPanel: BirthDeathPanel;
  readonly instruments = new InstrumentRegistry();
  readonly ergodicity: ErgodicityInstrument;
  readonly firstPassage: FirstPassageInstrument;

  constructor(private readonly app: App) {
    const { state, particles, potential, random } = app.core;
    const recorder = () => app.recording.recorder;

    this.monitor = new EquilibriumMonitor(potential, particles);
    const fitBox = () => this.fitBoxToView();
    this.klPanel = new KlPanel(this.monitor, { fitBox, opened: () => app.layout.typesetSidePanels() });
    this.observables = new ObservableMonitor(potential, particles, this.monitor);
    this.observablePanel = new ObservablePanel(this.observables, {
      expression: () => state.observable,
      setExpression: (tex) => {
        state.observable = tex;
      },
      fitBox,
    });

    this.birthDeath = new BirthDeath(random.get('births'), {
      birth: (t, parent, child) => recorder().addBirth(t, parent, child),
      death: (t, id) => recorder().addDeath(t, id),
    });
    this.birthDeathPanel = new BirthDeathPanel(
      this.birthDeath,
      particles,
      {
        settings: () => ({ enabled: state.birthDeath, birthRate: state.birthRate, deathRate: state.deathRate }),
        set: (change) => app.session.apply({ physics: change }),
      },
      random.get('replicas'),
    );

    // The registration order is the order of the windows' readouts and of their updates.
    const instruments = this.instruments;
    particles.events = chainSteps(this.birthDeath, instruments);
    instruments.register(new GradientNormInstrument(app.formulas.potentialPanel));
    instruments.register(this.birthDeathPanel);
    this.ergodicity = instruments.register(
      new ErgodicityInstrument(particles, potential, {
        expression: () => state.ergodicF,
        setExpression: (tex) => app.session.apply({ analysis: { ergodicF: tex } }),
        sigma: () => state.sigma,
      }),
    );
    this.firstPassage = instruments.register(
      new FirstPassageInstrument(potential, {
        expression: () => state.passageTarget,
        setExpression: (tex) => app.session.apply({ analysis: { passageTarget: tex } }),
        sigma: () => state.sigma,
      }),
    );
    instruments.register(
      new StepSweepInstrument(particles, {
        process: () => app.core.processNow(),
        rng: () => random.get('sweep'),
        blocked: () => (app.formulas.waiting() ? 'A formula is not ready yet: wait until it has compiled.' : null),
      }),
    );
    instruments.register(
      new ObservableInstrument(this.observables, this.observablePanel, {
        sampled: (t) => {
          const sample = this.observables.latest;
          if (recorder().recording && sample) recorder().addObservable(t, sample, state.observable);
        },
      }),
    );
    instruments.register(
      new KlInstrument(this.monitor, this.klPanel, {
        showDensity: () => state.showDensity,
        sampled: (t) => {
          const sample = this.monitor.latest;
          const region = this.monitor.region;
          if (recorder().recording && sample && region) recorder().addKl(t, sample, region);
        },
      }),
    );
  }

  /**
   * What needs every single integrator step on the CPU now: births and deaths, and the open
   * windows that follow paths (ergodicity, first passage). The GPU integrator waits for them.
   */
  stepHooks(): string[] {
    const names = this.instruments.all.filter((i) => i.onStep && i.active).map((i) => i.title);
    return this.birthDeath.active ? ['Birth / death', ...names] : names;
  }

  /** Whether the Gibbs measure is the invariant measure (the equilibrium tools need it). */
  setGibbs(gibbs: boolean): void {
    this.monitor.gibbs = gibbs;
    this.observables.gibbs = gibbs;
    this.klPanel.draw();
    this.observablePanel.draw();
  }

  /**
   * Fits the analysis box to the view. Both analyses (KL, observable) work on the same box, so
   * both curves restart.
   */
  fitBoxToView(): void {
    this.monitor.setBox(this.app.core.camera.bounds());
    this.observables.reset();
    this.klPanel.draw();
    this.observablePanel.draw();
  }

  /** The analysis curves restart (e.g. after a jump in time during playback). */
  restartCurves(): void {
    this.monitor.reset();
    this.observables.reset();
  }

  /** The box drawn on the scene, while a window that uses it is open. */
  visibleBox() {
    const m = this.monitor;
    return m.active || this.observables.active || this.app.formulas.potentialPanel.open ? (m.region ?? m.box) : null;
  }
}
