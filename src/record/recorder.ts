import { CELL_SIZE, PALETTE, PALETTE_RGB, PSI_CAP } from '../config';
import type { EquilibriumSample } from '../analysis/equilibrium';
import type { ObservableSample } from '../analysis/observable';
import type { Box } from '../analysis/kde';
import type { PotentialField } from '../sim/field';
import { DEFAULT_DT_MAX, MAX_PARTICLES, type ParticleSystem } from '../sim/particles';
import type { SchemeId } from '../sim/schemes';
import { type NpyArray, npyString, npzArchive } from './npz';

/** Minimum real time between two recorded particle frames (20 frames per second at most). */
const FRAME_INTERVAL_MS = 50;
/** Minimum real time between two Ψ snapshots (Ψ changes every frame while painting or filming). */
const PSI_INTERVAL_MS = 200;
/** Ψ snapshots use at most this many lattice nodes (larger boxes are subsampled). */
const MAX_PSI_NODES = 200_000;
/** Recording stops automatically when the raw data reaches this size. */
export const MAX_RUN_BYTES = 400 * 1024 * 1024;

const SCHEME_CODES: Record<SchemeId, number> = { heun: 0, 'euler-maruyama': 1 };

/** Simulation parameters recorded with every frame. */
export interface RecordedParams {
  sigma: number;
  speed: number;
  kernelVariance: number;
  scheme: SchemeId;
  seed: number;
  playing: boolean;
  /** Ψ from a formula (LaTeX), or undefined/null if Ψ is the painted lattice. */
  potentialTex?: string | null;
}

/** Format name in the metadata of recordings (files made before the app was renamed say 'potential-sde-run'). */
export const RECORDING_FORMAT = 'langevin-dynamics-run';
/** Format names accepted when reading a recording. */
export const RECORDING_FORMATS: readonly string[] = [RECORDING_FORMAT, 'potential-sde-run'];

/** Current version of the recording format (see `metadata.format_version`). */
export const FORMAT_VERSION = 2;

/** Ψ snapshot region: lattice nodes x0 + i·cell, y0 + j·cell for i < nx, j < ny. */
interface PsiGrid {
  i0: number;
  j0: number;
  stride: number;
  nx: number;
  ny: number;
}

/** One recorded run, kept in memory until it is downloaded or deleted. */
export class Run {
  readonly name: string;
  readonly startedAt = new Date();
  /** Real time (performance.now) at the start. */
  readonly wallStart: number;
  stoppedAt: Date | null = null;
  bytes = 0;

  // Particle frames (variable number of particles per frame).
  readonly t: number[] = [];
  readonly wall: number[] = [];
  readonly counts: number[] = [];
  readonly ids: Uint32Array[] = [];
  readonly xs: Float64Array[] = [];
  readonly ys: Float64Array[] = [];
  /** Exact integrator state per frame, so a run can be continued from any frame. */
  readonly rngState: Uint32Array[] = [];
  readonly clockRemainder: number[] = [];
  readonly nextId: number[] = [];
  readonly colorOf = new Map<number, number>();

  // Parameters per frame.
  readonly sigma: number[] = [];
  readonly speed: number[] = [];
  readonly kernelVariance: number[] = [];
  readonly scheme: number[] = [];
  readonly playing: number[] = [];
  readonly seed: number[] = [];
  /** Per frame: index into `potentialExpressions` of the formula Ψ, or −1 for the painted lattice. */
  readonly potentialExpr: number[] = [];
  readonly potentialExpressions: string[] = [];

  // Ψ snapshots.
  readonly psiGrid: PsiGrid;
  readonly psi: Float32Array[] = [];
  readonly psiT: number[] = [];
  readonly psiWall: number[] = [];
  /** Frame index from which each Ψ snapshot applies. */
  readonly psiFrame: number[] = [];

  // KL time series.
  readonly klT: number[] = [];
  readonly kl: number[] = [];
  readonly klFloor: number[] = [];
  readonly klH: number[] = [];
  readonly klInside: number[] = [];
  readonly klBox: number[] = [];

  // Observable time series: E[f(X_t)] with its confidence interval and the exact value.
  readonly obsT: number[] = [];
  readonly obsMean: number[] = [];
  readonly obsCi: number[] = [];
  readonly obsExact: number[] = [];
  readonly obsInside: number[] = [];
  /** Index into `obsExpressions` of the test function of each sample. */
  readonly obsExpr: number[] = [];
  readonly obsExpressions: string[] = [];

  readonly startParams: RecordedParams;
  /** Full settings snapshot at the start (session groups: display, tools, view, …). */
  readonly startSettings: Record<string, unknown>;

  constructor(
    index: number,
    wallStart: number,
    psiBox: Box,
    params: RecordedParams,
    settings: Record<string, unknown>,
  ) {
    this.name = `Run ${index}`;
    this.wallStart = wallStart;
    this.startParams = { ...params };
    this.startSettings = settings;
    const i0 = Math.ceil(psiBox.x0 / CELL_SIZE);
    const i1 = Math.floor(psiBox.x1 / CELL_SIZE);
    const j0 = Math.ceil(psiBox.y0 / CELL_SIZE);
    const j1 = Math.floor(psiBox.y1 / CELL_SIZE);
    const full = Math.max(1, i1 - i0 + 1) * Math.max(1, j1 - j0 + 1);
    const stride = Math.max(1, Math.ceil(Math.sqrt(full / MAX_PSI_NODES)));
    this.psiGrid = {
      i0,
      j0,
      stride,
      nx: Math.max(1, Math.floor((i1 - i0) / stride) + 1),
      ny: Math.max(1, Math.floor((j1 - j0) / stride) + 1),
    };
  }

  get frames(): number {
    return this.t.length;
  }

  /** Simulated time covered by the run. */
  get duration(): number {
    return this.t.length ? this.t[this.t.length - 1] - this.t[0] : 0;
  }

  /** Builds the .npz file. */
  async toNpz(): Promise<Uint8Array> {
    const F = this.frames;
    const offsets = new Int32Array(F + 1);
    for (let k = 0; k < F; k++) offsets[k + 1] = offsets[k] + this.counts[k];
    const total = offsets[F];
    const pid = new Uint32Array(total);
    const px = new Float64Array(total);
    const py = new Float64Array(total);
    for (let k = 0; k < F; k++) {
      pid.set(this.ids[k], offsets[k]);
      px.set(this.xs[k], offsets[k]);
      py.set(this.ys[k], offsets[k]);
    }
    const ids = Uint32Array.from([...this.colorOf.keys()].sort((a, b) => a - b));
    const colors = Uint8Array.from(ids, (id) => this.colorOf.get(id) ?? 0);

    const g = this.psiGrid;
    const S = this.psi.length;
    const psi = new Float32Array(S * g.nx * g.ny);
    for (let s = 0; s < S; s++) psi.set(this.psi[s], s * g.nx * g.ny);

    const f8 = (v: number[]): NpyArray => ({ dtype: '<f8', shape: [v.length], data: Float64Array.from(v) });
    const u1 = (v: number[]): NpyArray => ({ dtype: '|u1', shape: [v.length], data: Uint8Array.from(v) });
    const K = this.kl.length;
    const O = this.obsT.length;
    const arrays: Record<string, NpyArray> = {
      t: f8(this.t),
      wall_time: f8(this.wall),
      frame_offsets: { dtype: '<i4', shape: [F + 1], data: offsets },
      particle_id: { dtype: '<u4', shape: [total], data: pid },
      x: { dtype: '<f8', shape: [total], data: px },
      y: { dtype: '<f8', shape: [total], data: py },
      ids: { dtype: '<u4', shape: [ids.length], data: ids },
      id_color: { dtype: '|u1', shape: [colors.length], data: colors },
      palette_rgb: { dtype: '<f4', shape: [PALETTE.length, 3], data: PALETTE_RGB },
      sigma: f8(this.sigma),
      speed: f8(this.speed),
      kernel_variance: f8(this.kernelVariance),
      scheme: u1(this.scheme),
      playing: u1(this.playing),
      seed: { dtype: '<u4', shape: [F], data: Uint32Array.from(this.seed) },
      potential_expr: { dtype: '<i4', shape: [F], data: Int32Array.from(this.potentialExpr) },
      rng_state: { dtype: '<u4', shape: [F, 4], data: concatU32(this.rngState) },
      clock_remainder: f8(this.clockRemainder),
      next_id: { dtype: '<u4', shape: [F], data: Uint32Array.from(this.nextId) },
      psi: { dtype: '<f4', shape: [S, g.ny, g.nx], data: psi },
      psi_t: f8(this.psiT),
      psi_wall_time: f8(this.psiWall),
      psi_frame: { dtype: '<i4', shape: [S], data: Int32Array.from(this.psiFrame) },
      psi_grid: {
        dtype: '<f8',
        shape: [3],
        data: Float64Array.from([g.i0 * CELL_SIZE, g.j0 * CELL_SIZE, g.stride * CELL_SIZE]),
      },
      kl_t: f8(this.klT),
      kl: f8(this.kl),
      kl_floor: f8(this.klFloor),
      kl_h: f8(this.klH),
      kl_inside: { dtype: '<i4', shape: [K], data: Int32Array.from(this.klInside) },
      kl_box: { dtype: '<f8', shape: [K, 4], data: Float64Array.from(this.klBox) },
      obs_t: f8(this.obsT),
      obs_mean: f8(this.obsMean),
      obs_ci: f8(this.obsCi),
      obs_exact: f8(this.obsExact),
      obs_inside: { dtype: '<i4', shape: [O], data: Int32Array.from(this.obsInside) },
      obs_expr: { dtype: '<i4', shape: [O], data: Int32Array.from(this.obsExpr) },
    };
    const metadata = {
      format: RECORDING_FORMAT,
      format_version: FORMAT_VERSION,
      name: this.name,
      started_at: this.startedAt.toISOString(),
      stopped_at: this.stoppedAt?.toISOString() ?? null,
      equation: 'dX_t = -grad Psi(X_t) dt + sigma dW_t',
      gibbs: 'pi(x) proportional to exp(-2 Psi(x) / sigma^2), restricted to the KL box',
      kl: 'KL(rho_h || pi) with rho_h = empirical measure * N(0, h^2 I), on the KL box; NaN = undefined',
      observable: 'mean of f over the particles in the KL box, 95% CI half width 1.96 s / sqrt(n), exact = integral of f d(pi) on the box',
      observable_expressions: this.obsExpressions,
      potential_expressions: this.potentialExpressions,
      constants: {
        psi_cap: PSI_CAP,
        psi_lattice_spacing: CELL_SIZE,
        max_particles: MAX_PARTICLES,
        dt: DEFAULT_DT_MAX,
        palette: PALETTE,
        schemes: ['heun', 'euler-maruyama'],
      },
      start_parameters: this.startParams,
      settings: this.startSettings,
      arrays: {
        t: 'simulated time of each frame (F)',
        wall_time: 'seconds since the recording started, per frame (F)',
        frame_offsets: 'frame k holds particle_id/x/y[frame_offsets[k]:frame_offsets[k+1]] (F+1)',
        particle_id: 'stable particle id (sum of counts)',
        x: 'x position, float64 (sum of counts)',
        y: 'y position, float64 (sum of counts)',
        ids: 'all particle ids that appear (M)',
        id_color: 'palette index of each id in `ids` (M)',
        palette_rgb: 'particle palette, RGB in [0, 1] (12 x 3)',
        sigma: 'diffusivity per frame (F)',
        speed: 'simulated time per real second, per frame (F)',
        kernel_variance: 'KDE kernel variance h^2 per frame (F)',
        scheme: '0 = stochastic Heun, 1 = Euler-Maruyama, per frame (F)',
        playing: '1 if the simulation was running, per frame (F)',
        seed: 'seed of the random streams, per frame (F)',
        potential_expr:
          'index into metadata.potential_expressions (LaTeX of Psi(t, x, y)) per frame, or -1 if Psi is the painted lattice in `psi` (F)',
        rng_state: "state of the 'dynamics' xoshiro128** stream after each frame (F x 4)",
        clock_remainder: 'simulated time carried over to the next fixed step, per frame (F)',
        next_id: 'id the next new particle would get, per frame (F)',
        psi: 'Psi snapshots, psi[s, j, i] at (psi_grid[0] + i*psi_grid[2], psi_grid[1] + j*psi_grid[2]) (S x ny x nx)',
        psi_t: 'simulated time of each Psi snapshot (S)',
        psi_wall_time: 'seconds since the recording started, per Psi snapshot (S)',
        psi_frame: 'first frame at which each Psi snapshot applies (S)',
        psi_grid: '[x0, y0, spacing] of the Psi snapshots',
        kl_t: 'simulated time of each KL estimate (K)',
        kl: 'KL(rho_h || pi) (K)',
        kl_floor: 'smoothing floor KL(pi * K_h || pi) (K)',
        kl_h: 'kernel standard deviation h (K)',
        kl_inside: 'particles inside the KL box (K)',
        kl_box: 'KL box [x0, y0, x1, y1] (K x 4)',
        obs_t: 'simulated time of each observable estimate (O)',
        obs_mean: 'mean of f(X_i) over the particles in the box (O)',
        obs_ci: 'half width of the 95% confidence interval of obs_mean (O)',
        obs_exact: 'exact Gibbs expectation of f on the box; NaN while Psi was being edited faster than it was recomputed (O)',
        obs_inside: 'particles in the box at which f is defined (O)',
        obs_expr: 'index into metadata.observable_expressions (LaTeX) of f, per estimate (O)',
      },
    };
    arrays.metadata = npyString(JSON.stringify(metadata, null, 2));
    return npzArchive(arrays);
  }
}

export interface RecorderSources {
  field: PotentialField;
  particles: ParticleSystem;
  params(): RecordedParams;
  /** Full settings snapshot stored in the metadata (optional). */
  settings?(): Record<string, unknown>;
}

/**
 * Records runs: particle positions (with stable ids), parameters, Ψ snapshots and the KL time
 * series. Frames are taken at most 20 times per second of real time and only when something
 * changed; Ψ snapshots at most 5 times per second and only when Ψ changed.
 */
export class Recorder {
  readonly runs: Run[] = [];
  current: Run | null = null;

  private lastFrame = -Infinity;
  private lastPsi = -Infinity;
  private frameKey = '';
  private psiKey = '';
  private runIndex = 0;

  constructor(private readonly src: RecorderSources) {}

  get recording(): boolean {
    return this.current !== null;
  }

  /** Starts a run; Ψ is recorded on `psiBox` (fixed for the run). */
  start(nowMs: number, psiBox: Box): Run {
    if (this.current) return this.current;
    const run = new Run(++this.runIndex, nowMs, psiBox, this.src.params(), this.src.settings?.() ?? {});
    this.current = run;
    this.lastFrame = -Infinity;
    this.lastPsi = -Infinity;
    this.frameKey = '';
    this.psiKey = '';
    this.tick(nowMs, true);
    return run;
  }

  /** Stops the current run (with a final frame and Ψ snapshot) and returns it. */
  stop(nowMs: number): Run | null {
    const run = this.current;
    if (!run) return null;
    this.tick(nowMs, true);
    run.stoppedAt = new Date();
    this.current = null;
    this.runs.unshift(run);
    return run;
  }

  remove(run: Run): void {
    const k = this.runs.indexOf(run);
    if (k >= 0) this.runs.splice(k, 1);
  }

  /**
   * Records a frame and/or Ψ snapshot if due. Returns true if the run hit the memory limit and
   * was stopped.
   */
  tick(nowMs: number, force = false): boolean {
    const run = this.current;
    if (!run) return false;
    const { field, particles: ps } = this.src;
    const p = this.src.params();
    const wall = (nowMs - run.wallStart) / 1000;

    // A Ψ snapshot always comes with a frame, so that it can be tied to an exact frame index.
    const pKey = `${field.revision}|${field.epoch}`;
    const psiDue = pKey !== this.psiKey && (force || nowMs - this.lastPsi >= PSI_INTERVAL_MS);
    const fKey = `${ps.version}|${p.sigma}|${p.speed}|${p.kernelVariance}|${p.scheme}|${p.seed}|${p.playing}|${p.potentialTex ?? ''}`;
    if (force || psiDue || (nowMs - this.lastFrame >= FRAME_INTERVAL_MS && fKey !== this.frameKey)) {
      this.lastFrame = nowMs;
      this.frameKey = fKey;
      const n = ps.count;
      run.t.push(ps.time);
      run.wall.push(wall);
      run.counts.push(n);
      run.ids.push(ps.id.slice(0, n));
      run.xs.push(ps.x.slice(0, n));
      run.ys.push(ps.y.slice(0, n));
      run.rngState.push(Uint32Array.from(ps.rng.getState()));
      run.clockRemainder.push(ps.clockRemainder);
      run.nextId.push(ps.nextId);
      run.seed.push(p.seed);
      if (p.potentialTex) {
        let e = run.potentialExpressions.indexOf(p.potentialTex);
        if (e < 0) e = run.potentialExpressions.push(p.potentialTex) - 1;
        run.potentialExpr.push(e);
      } else {
        run.potentialExpr.push(-1);
      }
      for (let i = 0; i < n; i++) if (!run.colorOf.has(ps.id[i])) run.colorOf.set(ps.id[i], ps.color[i]);
      run.sigma.push(p.sigma);
      run.speed.push(p.speed);
      run.kernelVariance.push(p.kernelVariance);
      run.scheme.push(SCHEME_CODES[p.scheme]);
      run.playing.push(p.playing ? 1 : 0);
      run.bytes += n * 20 + 96;
    }

    if (psiDue) {
      this.lastPsi = nowMs;
      this.psiKey = pKey;
      const g = run.psiGrid;
      const snap = new Float32Array(g.nx * g.ny);
      for (let j = 0; j < g.ny; j++) {
        const nj = g.j0 + j * g.stride;
        for (let i = 0; i < g.nx; i++) snap[j * g.nx + i] = field.node(g.i0 + i * g.stride, nj);
      }
      run.psi.push(snap);
      run.psiT.push(ps.time);
      run.psiWall.push(wall);
      run.psiFrame.push(run.frames - 1);
      run.bytes += snap.byteLength;
    }

    if (run.bytes >= MAX_RUN_BYTES) {
      this.stop(nowMs);
      return true;
    }
    return false;
  }

  /** Adds a KL estimate to the current run. */
  addKl(t: number, s: EquilibriumSample, box: Box): void {
    const run = this.current;
    if (!run) return;
    run.klT.push(t);
    run.kl.push(s.kl);
    run.klFloor.push(s.floor);
    run.klH.push(s.h);
    run.klInside.push(s.inside);
    run.klBox.push(box.x0, box.y0, box.x1, box.y1);
    run.bytes += 56;
  }

  /** Adds an observable estimate (for the test function `tex`) to the current run. */
  addObservable(t: number, s: ObservableSample, tex: string): void {
    const run = this.current;
    if (!run) return;
    let k = run.obsExpressions.indexOf(tex);
    if (k < 0) k = run.obsExpressions.push(tex) - 1;
    run.obsT.push(t);
    run.obsMean.push(s.mean);
    run.obsCi.push(s.ci);
    run.obsExact.push(s.exactStale ? NaN : s.exact); // a stale value belongs to an earlier Ψ
    run.obsInside.push(s.inside);
    run.obsExpr.push(k);
    run.bytes += 44;
  }
}

function concatU32(parts: Uint32Array[]): Uint32Array {
  const out = new Uint32Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
