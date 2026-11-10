import type { Box } from '../analysis/kde';
import type { ParticlesSnapshot, PotentialSnapshot } from '../session/components';
import type { Snapshot } from '../session/session';
import type { SchemeId } from '../sim/schemes';
import type { NpyValue, NumericArray } from './npzRead';
import { RECORDING_FORMATS } from './recorder';

const SCHEME_NAMES: SchemeId[] = ['heun', 'euler-maruyama'];

/** A recording that cannot be used, with a message suitable for the user. */
export class RecordingError extends Error {}

/**
 * A recording read from an .npz file, exposed as a sequence of session snapshots: one initial
 * snapshot (settings, analysis box, view) and one per frame (physics settings, Ψ, particles).
 * Accepts format versions 1 and 2; quantities missing in older files fall back to defaults.
 */
export class RecordingTimeline {
  readonly frames: number;
  readonly version: number;
  /** Simulated time and wall-clock seconds of every frame. */
  readonly t: Float64Array;
  readonly wall: Float64Array;

  private readonly offsets: Float64Array;
  private readonly ids: NumericArray;
  private readonly x: NumericArray;
  private readonly y: NumericArray;
  private readonly colorOf = new Map<number, number>();
  private readonly perFrame: Record<'sigma' | 'speed' | 'kernelVariance' | 'scheme' | 'seed', NumericArray | null>;
  private readonly rngState: NumericArray | null;
  private readonly clockRemainder: NumericArray | null;
  private readonly nextId: NumericArray | null;
  private readonly psi: { values: NumericArray; nx: number; ny: number; x0: number; y0: number; cell: number } | null;
  private readonly psiWall: Float64Array;
  /** First frame of each Ψ snapshot (format 2), or null to match by wall-clock time (format 1). */
  private readonly psiFrame: NumericArray | null;
  private readonly metadata: Record<string, unknown>;
  private readonly klBox: Box | null;

  constructor(arrays: Map<string, NpyValue>) {
    const num = (name: string, required = false): NumericArray | null => {
      const a = arrays.get(name);
      if (!a || !a.data) {
        if (required) throw new RecordingError(`The file has no "${name}" array, so it is not a recording of this app.`);
        return null;
      }
      return a.data;
    };
    const f64 = (a: NumericArray | null) => (a ? Float64Array.from(a) : null);

    const metaText = arrays.get('metadata')?.strings?.[0];
    let meta: Record<string, unknown> = {};
    if (metaText) {
      try {
        meta = JSON.parse(metaText) as Record<string, unknown>;
      } catch {
        throw new RecordingError('The recording metadata is damaged.');
      }
    }
    if (meta.format !== undefined && !RECORDING_FORMATS.includes(meta.format as string)) {
      throw new RecordingError('This .npz file is not a Langevin Dynamics recording.');
    }
    this.metadata = meta;
    this.version = typeof meta.format_version === 'number' ? meta.format_version : 1;

    this.t = f64(num('t', true))!;
    this.frames = this.t.length;
    if (this.frames === 0) throw new RecordingError('The recording contains no frames.');
    this.offsets = f64(num('frame_offsets', true))!;
    this.ids = num('particle_id', true)!;
    this.x = num('x', true)!;
    this.y = num('y', true)!;
    const total = this.offsets[this.frames];
    if (
      this.offsets.length !== this.frames + 1 ||
      !(total <= this.ids.length && total <= this.x.length && total <= this.y.length)
    ) {
      throw new RecordingError('The particle arrays of the recording are inconsistent.');
    }
    this.wall = f64(num('wall_time')) ?? Float64Array.from(this.t);
    // Pacing assumes non-decreasing times; guard against odd files.
    for (let k = 1; k < this.frames; k++) if (!(this.wall[k] >= this.wall[k - 1])) this.wall[k] = this.wall[k - 1];

    const idList = num('ids');
    const idColor = num('id_color');
    if (idList && idColor) for (let k = 0; k < idList.length; k++) this.colorOf.set(idList[k], idColor[k] ?? 0);

    this.perFrame = {
      sigma: num('sigma'),
      speed: num('speed'),
      kernelVariance: num('kernel_variance'),
      scheme: num('scheme'),
      seed: num('seed'),
    };
    this.rngState = num('rng_state');
    this.clockRemainder = num('clock_remainder');
    this.nextId = num('next_id');

    const psi = arrays.get('psi');
    const grid = num('psi_grid');
    if (psi?.data && grid && psi.shape.length === 3 && psi.shape[0] > 0 && grid.length >= 3) {
      const [, ny, nx] = psi.shape;
      this.psi = { values: psi.data, nx, ny, x0: grid[0], y0: grid[1], cell: grid[2] };
    } else {
      this.psi = null;
    }
    this.psiWall = f64(num('psi_wall_time')) ?? f64(num('psi_t')) ?? new Float64Array(this.psi ? 1 : 0);
    this.psiFrame = num('psi_frame');

    const box = num('kl_box');
    this.klBox = box && box.length >= 4 ? { x0: box[0], y0: box[1], x1: box[2], y1: box[3] } : null;
  }

  /** Simulated duration of the recording. */
  get duration(): number {
    return this.t[this.frames - 1] - this.t[0];
  }

  /** Wall-clock duration of the recording in seconds. */
  get wallDuration(): number {
    return this.wall[this.frames - 1] - this.wall[0];
  }

  get name(): string {
    return typeof this.metadata.name === 'string' ? this.metadata.name : 'Recording';
  }

  /** Last frame whose wall-clock time is at most `seconds` (binary search). */
  frameAtWall(seconds: number): number {
    let lo = 0;
    let hi = this.frames - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.wall[mid] <= seconds) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** Index of the Ψ snapshot in effect at frame k (−1 if the recording has none). */
  potentialIndexAt(k: number): number {
    if (!this.psi) return -1;
    let s = 0;
    if (this.psiFrame && this.psiFrame.length) {
      for (let i = 1; i < this.psiFrame.length; i++) if (this.psiFrame[i] <= k) s = i;
      return s;
    }
    const w = this.wall[k] + 1e-9;
    for (let i = 1; i < this.psiWall.length; i++) if (this.psiWall[i] <= w) s = i;
    return s;
  }

  /** Settings, analysis box and view that apply to the whole recording. */
  initialSnapshot(): Snapshot {
    const snap: Snapshot = {};
    const settings = this.metadata.settings;
    if (settings && typeof settings === 'object') {
      // Settings captured by the recorder's session (format 2); only known keys are used.
      for (const key of ['display', 'tools', 'analysis']) {
        const v = (settings as Record<string, unknown>)[key];
        if (v && typeof v === 'object') snap[key] = v;
      }
    }
    const region = this.psiRegion();
    if (this.klBox) snap.analysisBox = this.klBox;
    else if (region) snap.analysisBox = region;
    return snap;
  }

  /** World rectangle covered by the Ψ snapshots (or null). */
  psiRegion(): Box | null {
    const p = this.psi;
    if (!p) return null;
    return { x0: p.x0, y0: p.y0, x1: p.x0 + (p.nx - 1) * p.cell, y1: p.y0 + (p.ny - 1) * p.cell };
  }

  /** World rectangle around all particles of all frames (for framing the view). */
  particleBounds(): Box | null {
    const n = this.offsets[this.frames];
    if (n === 0) return null;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let i = 0; i < n; i++) {
      x0 = Math.min(x0, this.x[i]);
      x1 = Math.max(x1, this.x[i]);
      y0 = Math.min(y0, this.y[i]);
      y1 = Math.max(y1, this.y[i]);
    }
    return { x0, y0, x1, y1 };
  }

  /** The Ψ snapshot number s. */
  potential(s: number): PotentialSnapshot | null {
    const p = this.psi;
    if (!p || s < 0) return null;
    const n = p.nx * p.ny;
    return { x0: p.x0, y0: p.y0, cell: p.cell, nx: p.nx, ny: p.ny, values: p.values.subarray(s * n, (s + 1) * n) };
  }

  /**
   * Snapshot of frame k: physics settings and particles, plus Ψ if `potentialIndex` differs from
   * the one already applied (`previousPotential`).
   */
  frameSnapshot(k: number, previousPotential: number, continueTrails: boolean): Snapshot {
    const snap: Snapshot = {};
    const physics: Record<string, unknown> = {};
    const pf = this.perFrame;
    if (pf.sigma) physics.sigma = pf.sigma[k];
    if (pf.speed) physics.speed = pf.speed[k];
    if (pf.scheme) physics.scheme = SCHEME_NAMES[pf.scheme[k]] ?? 'heun';
    physics.seed = pf.seed ? pf.seed[k] : 0;
    snap.physics = physics;
    if (pf.kernelVariance) snap.analysis = { kernelVariance: pf.kernelVariance[k] };

    const s = this.potentialIndexAt(k);
    if (s !== previousPotential) snap.potential = this.potential(s);

    const a = this.offsets[k];
    const b = this.offsets[k + 1];
    const ids = this.ids.subarray(a, b);
    const colors = Uint8Array.from(ids, (id) => this.colorOf.get(id) ?? id % 12);
    const particles: ParticlesSnapshot = {
      ids,
      x: this.x.subarray(a, b),
      y: this.y.subarray(a, b),
      colors,
      time: this.t[k],
      continueTrails,
    };
    if (this.clockRemainder) particles.clockRemainder = this.clockRemainder[k];
    if (this.nextId) particles.nextId = this.nextId[k];
    if (this.rngState && this.rngState.length >= 4 * (k + 1)) {
      particles.rngState = this.rngState.subarray(4 * k, 4 * k + 4);
    }
    snap.particles = particles;
    return snap;
  }
}
