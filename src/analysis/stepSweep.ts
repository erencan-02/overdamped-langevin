import type { NormalSource, Process } from '../sim/process';
import type { Rng } from '../sim/rng';
import { type Ensemble, SCHEMES, type SchemeId } from '../sim/schemes';

/**
 * Convergence in the step size Δt (a "Δt sweep"): M paths are integrated over [t₀, t₀ + T] with
 * each scheme at several step sizes Δt = T / 2^ℓ, all driven by the same Brownian paths, and
 * compared with a reference run of the same scheme at a much finer step (self-convergence):
 *
 *     strong error  E |X_T^{Δt} − X_T^{ref}|,      weak error  |E f(X_T^{Δt}) − E f(X_T^{ref})|,
 *
 * with f(x) = |x|². The slopes of log error against log Δt estimate the strong and weak orders.
 *
 * All runs advance in lockstep through the finest increments, so memory is O(M · levels): the
 * Brownian increment of a coarse step is the sum of the fine increments it covers, rescaled to a
 * standard normal. Work is split into chunks between which `pause` is awaited (to keep a page
 * responsive); `onProgress` gets the fraction done.
 */

export interface SweepOptions {
  process: Process;
  /** Start of each path (M = x0.length). */
  x0: Float64Array;
  y0: Float64Array;
  /** Start time and horizon. */
  t0: number;
  T: number;
  /** Levels: Δt = T / 2^ℓ for each ℓ (ascending), and the reference level (finer than all). */
  levels: readonly number[];
  refLevel: number;
  schemes: readonly SchemeId[];
  rng: Rng;
  pause?: () => Promise<void>;
  onProgress?: (fraction: number) => void;
  /** Fine steps between pauses. */
  chunk?: number;
}

export interface SchemeSweep {
  id: SchemeId;
  /** Per level, in the order of `dts`. */
  strong: number[];
  weak: number[];
  /** Least-squares slopes of log error against log Δt (NaN if not defined). */
  strongOrder: number;
  weakOrder: number;
}

export interface SweepResult {
  dts: number[];
  refDt: number;
  paths: number;
  T: number;
  schemes: SchemeSweep[];
}

/** Normals read from an array in order (one coarse step's increments). */
class Increments implements NormalSource {
  k = 0;
  constructor(public z: Float64Array) {}
  normal(): number {
    return this.z[this.k++];
  }
}

export async function runSweep(o: SweepOptions): Promise<SweepResult> {
  const M = o.x0.length;
  const fine = 2 ** o.refLevel;
  const refDt = o.T / fine;
  const ensemble = (): Ensemble & { x: Float64Array; y: Float64Array } => ({
    x: Float64Array.from(o.x0),
    y: Float64Array.from(o.y0),
    count: M,
  });
  const runs = o.schemes.map((id) => ({
    id,
    ref: ensemble(),
    levels: o.levels.map(() => ensemble()),
  }));
  // Per level: the sum of the fine normals since its last step, and how many fine steps it spans.
  const spans = o.levels.map((l) => 2 ** (o.refLevel - l));
  const sums = o.levels.map(() => new Float64Array(2 * M));
  const z = new Float64Array(2 * M);
  const fineSource = new Increments(z);
  const coarse = new Increments(new Float64Array(2 * M));
  const chunk = o.chunk ?? 64;
  const noisy = !o.process.deterministic;

  for (let j = 0; j < fine; j++) {
    if (noisy) for (let c = 0; c < 2 * M; c++) z[c] = o.rng.normal();
    const t = o.t0 + j * refDt;
    for (const run of runs) {
      fineSource.k = 0;
      SCHEMES[run.id].step(run.ref, o.process, refDt, fineSource, t);
    }
    for (let l = 0; l < spans.length; l++) {
      const sum = sums[l];
      if (noisy) for (let c = 0; c < 2 * M; c++) sum[c] += z[c];
      const span = spans[l];
      if ((j + 1) % span !== 0) continue;
      const scale = 1 / Math.sqrt(span);
      for (let c = 0; c < 2 * M; c++) coarse.z[c] = sum[c] * scale;
      sum.fill(0);
      const dt = o.T / 2 ** o.levels[l];
      const start = o.t0 + (j + 1 - span) * refDt;
      for (const run of runs) {
        coarse.k = 0;
        SCHEMES[run.id].step(run.levels[l], o.process, dt, coarse, start);
      }
    }
    if ((j + 1) % chunk === 0) {
      o.onProgress?.((j + 1) / fine);
      if (o.pause) await o.pause();
    }
  }
  o.onProgress?.(1);

  const dts = o.levels.map((l) => o.T / 2 ** l);
  const f = (x: number, y: number) => x * x + y * y;
  const schemes = runs.map((run) => {
    let refMean = 0;
    for (let m = 0; m < M; m++) refMean += f(run.ref.x[m], run.ref.y[m]);
    refMean /= M;
    const strong: number[] = [];
    const weak: number[] = [];
    for (const e of run.levels) {
      let s = 0;
      let w = 0;
      for (let m = 0; m < M; m++) {
        s += Math.hypot(e.x[m] - run.ref.x[m], e.y[m] - run.ref.y[m]);
        w += f(e.x[m], e.y[m]);
      }
      strong.push(s / M);
      weak.push(Math.abs(w / M - refMean));
    }
    return { id: run.id, strong, weak, strongOrder: slope(dts, strong), weakOrder: slope(dts, weak) };
  });
  return { dts, refDt, paths: M, T: o.T, schemes };
}

/** Least-squares slope of log(err) against log(dt) over the finite, positive errors. */
export function slope(dts: readonly number[], errors: readonly number[]): number {
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < dts.length; i++) {
    if (errors[i] > 0 && Number.isFinite(errors[i])) {
      xs.push(Math.log(dts[i]));
      ys.push(Math.log(errors[i]));
    }
  }
  if (xs.length < 2) return Number.NaN;
  const mx = xs.reduce((a, b) => a + b) / xs.length;
  const my = ys.reduce((a, b) => a + b) / ys.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  return den > 0 ? num / den : Number.NaN;
}
