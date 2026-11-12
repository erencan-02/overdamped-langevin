import type { TimeSeries } from '../analysis/timeSeries';
import type { ParticleSystem, StepEvents } from '../sim/particles';
import type { Sde } from '../sim/process';

/**
 * Instruments are the analysis tools of the app (KL to equilibrium, observables, ergodicity,
 * first-passage times, …). They share one small interface, so the frame loop, the integrator,
 * recordings and worksheets treat them all alike, and a new tool is a new class plus one
 * `register` call:
 *
 *  - `onStep` runs after every integrator step (exact simulated times), for tools that follow
 *    individual paths;
 *  - `onFrame` runs once per animation frame, for estimates over the ensemble (throttled by the
 *    instrument itself, and only while it is active);
 *  - `series` is what it plots over simulated time, `readout` its current numbers by name.
 */

/** What an instrument may look at in a frame. */
export interface FrameContext {
  /** Real time (ms, performance.now()). */
  readonly now: number;
  readonly particles: ParticleSystem;
  /** The process at the current Ψ and σ. */
  readonly process: Sde;
  readonly sigma: number;
  readonly kernelVariance: number;
  /** A recording is running (instruments that are recorded keep running while it does). */
  readonly recording: boolean;
}

export interface Instrument {
  /** Unique id, also the prefix of its readouts (e.g. "ergodicity.timeAverage"). */
  readonly id: string;
  /** Human-readable name. */
  readonly title: string;
  /** Computing now (its window is open, or something else needs it). */
  readonly active: boolean;
  /** Its window is open. */
  readonly open?: boolean;
  /** After every integrator step while active; `t` is the simulated time at the end of the step. */
  onStep?(particles: ParticleSystem, t: number): void;
  /** Once per animation frame. */
  onFrame(ctx: FrameContext): void;
  /** What it plots over simulated time (if anything). */
  readonly series?: TimeSeries;
  /** Its current numbers by name (NaN when undefined), e.g. for worksheets. */
  readout(): Record<string, number>;
  /** Starts over (clears its series and state). */
  reset(): void;
  /** Opens or closes its window (if it has one). */
  setOpen?(open: boolean): void;
}

/**
 * All instruments of the app. It is also the integrator's step hook (`StepEvents`), so the
 * instruments that follow paths see every step.
 */
export class InstrumentRegistry implements StepEvents {
  private readonly list: Instrument[] = [];

  register<T extends Instrument>(instrument: T): T {
    if (this.list.some((i) => i.id === instrument.id)) throw new Error(`Duplicate instrument "${instrument.id}"`);
    this.list.push(instrument);
    return instrument;
  }

  get(id: string): Instrument | undefined {
    return this.list.find((i) => i.id === id);
  }

  get all(): readonly Instrument[] {
    return this.list;
  }

  afterStep(ps: ParticleSystem, t: number): void {
    for (const i of this.list) if (i.onStep && i.active) i.onStep(ps, t);
  }

  frame(ctx: FrameContext): void {
    for (const i of this.list) i.onFrame(ctx);
  }

  /** Every readout as "instrument.name" → value. */
  readouts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const i of this.list) for (const [k, v] of Object.entries(i.readout())) out[`${i.id}.${k}`] = v;
    return out;
  }

  /** Starts every instrument over (e.g. after a scenario was loaded). */
  resetAll(): void {
    for (const i of this.list) i.reset();
  }
}

/** Runs several step hooks after each other (e.g. births and deaths, then the instruments). */
export function chainSteps(...hooks: StepEvents[]): StepEvents {
  return {
    afterStep(ps, t) {
      for (const h of hooks) h.afterStep(ps, t);
    },
  };
}
