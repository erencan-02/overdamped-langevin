import type { Core } from './core';
import { changeDetector } from './watch';

/**
 * The force arrows of the whole drift b = −∇Ψ + u, for when there is an extra drift u (otherwise
 * the renderers draw −∇Ψ of the potential themselves). The renderers expect a gradient, so this
 * hands them −b. `epoch` and `revision` tell them when to rebuild: a new epoch at once (the drift
 * was replaced), a new revision at their refresh rate (Ψ was edited, or time or σ moved on).
 */
export class DriftArrows {
  private epochCount = 0;
  private revisionCount = 0;
  private readonly psiReplaced = changeDetector();
  private readonly driftChanged = changeDetector();

  constructor(private readonly core: Core) {}

  get epoch(): number {
    return this.epochCount;
  }

  get revision(): number {
    return this.revisionCount;
  }

  /** The drift was replaced (e.g. new formulas for u): the arrows are rebuilt at once. */
  replaced(): void {
    this.epochCount++;
  }

  /** Call once per frame, after Ψ was set to the current time. */
  update(): void {
    const { sde, potential, particles, state } = this.core;
    if (!sde.extraDrift || !state.forceField) return;
    // A replaced Ψ rebuilds them at once (epoch); edits and time only at the refresh rate.
    if (this.psiReplaced(`${potential.epoch}`)) this.epochCount++;
    const timeKey = sde.coefficientsDependOnTime ? `${particles.time}|${state.sigma}` : '';
    if (this.driftChanged(`${potential.revision}|${timeKey}`)) this.revisionCount++;
  }

  gradient(x: number, y: number, out: Float64Array): void {
    const bx = new Float64Array(1);
    const by = new Float64Array(1);
    this.core.processNow().drift(Float64Array.of(x), Float64Array.of(y), 1, this.core.particles.time, bx, by);
    out[0] = -bx[0];
    out[1] = -by[0];
  }

  gradientBatch(xs: Float64Array, ys: Float64Array, n: number, _t: number, gx: Float64Array, gy: Float64Array): void {
    this.core.processNow().drift(xs, ys, n, this.core.particles.time, gx, gy);
    for (let i = 0; i < n; i++) {
      gx[i] = -gx[i];
      gy[i] = -gy[i];
    }
  }
}
