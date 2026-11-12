import { Rng } from './rng';
import type { Process } from './process';
import { DEFAULT_SCHEME, SCHEMES, type Scheme } from './schemes';

/**
 * Most particles at once. Up to CPU_PARTICLES they are always integrated on the CPU (exact,
 * double precision); larger ensembles go to the GPU where it can (see sim/gpu/).
 */
export const MAX_PARTICLES = 200_000;
/** Ensembles up to this size are always integrated on the CPU. */
export const CPU_PARTICLES = 2000;
/** Trails are stored for the first this-many particles (a trail per particle of 200 000 would not fit). */
export const TRAIL_PARTICLES = 2000;
/** Number of stored trail points per particle. */
export const TRAIL_LEN = 40;
/** Simulated time between two stored trail points. */
export const TRAIL_DT = 1 / 50;
/**
 * Time step of the integrator. The simulation runs on a fixed clock: every step has exactly this
 * length and leftover time is carried over to the next frame, so a run depends only on the seed
 * and on what the user does, not on the frame rate.
 */
export const DEFAULT_DT_MAX = 1 / 500;
/** Upper bound on sub-steps per frame so a frame can never stall the UI. */
const MAX_SUBSTEPS = 160;
/**
 * Upper bound on drift evaluations per `advance` call. With very many particles at high speed
 * the simulation then runs slower than real time instead of stalling the frame; the step size
 * never changes.
 */
export const DEFAULT_WORK_BUDGET = 80_000;

/** A particle as it was added or removed (for undo). */
export interface ParticleRecord {
  id: number;
  x: number;
  y: number;
  color: number;
}

/** Something that happens to the ensemble after every integrator step (e.g. births and deaths). */
export interface StepEvents {
  /** Called after each step; `t` is the simulated time at its end. */
  afterStep(ps: ParticleSystem, t: number): void;
}

/** A change of the particle set: who was added and who was removed (see beginEdit). */
export interface ParticleEdit {
  added: ParticleRecord[];
  removed: ParticleRecord[];
}

/**
 * Ensemble of independent particles following an SDE in ℝ² (a `Process`, see process.ts), by
 * default the overdamped Langevin equation
 *
 *     dX_t = −∇Ψ(X_t) dt + σ dW_t ,   X_t ∈ ℝ²
 *
 * The particle system owns the state (positions, colours, trails) and the time stepping
 * (sub-steps, work budget, trail recording); the numerical scheme that performs a single step
 * is pluggable (see `schemes.ts`) and can be switched at any time.
 */
export class ParticleSystem {
  readonly x = new Float64Array(MAX_PARTICLES);
  readonly y = new Float64Array(MAX_PARTICLES);
  /** Palette index of each particle. */
  readonly color = new Uint8Array(MAX_PARTICLES);
  /**
   * Stable identity of each particle. Indices change when particles are removed (the last one
   * moves into the gap), ids never do, so recordings can follow every particle through a run.
   */
  readonly id = new Uint32Array(MAX_PARTICLES);
  /** Id that the next added particle receives. */
  nextId = 0;
  /**
   * Per-particle event clocks (simulated times of the next birth and death, see birthDeath.ts);
   * NaN = not scheduled. They move with their particle when indices change.
   */
  readonly birthAt = new Float64Array(MAX_PARTICLES).fill(Number.NaN);
  readonly deathAt = new Float64Array(MAX_PARTICLES).fill(Number.NaN);
  /** Called after every step of `advance` (births and deaths); null = nothing. */
  events: StepEvents | null = null;
  /** Ring buffers of past positions, TRAIL_LEN (x, y) slots per particle (the first TRAIL_PARTICLES). */
  readonly trail = new Float32Array(TRAIL_PARTICLES * TRAIL_LEN * 2);
  /** Number of valid trail slots per particle (the first TRAIL_PARTICLES; see `trailLength`). */
  readonly trailCount = new Uint16Array(TRAIL_PARTICLES);
  /** Slot that holds the most recent trail point (shared by all particles). */
  trailHead = 0;
  /** Number of trail recordings so far (each one writes slot `trailHead` of every particle). */
  trailWrites = 0;
  /**
   * Incremented when existing trail rows change other than by a recording (removal, reset),
   * telling the renderer to re-upload the whole ring buffer.
   */
  trailLayout = 0;

  count = 0;
  /** Simulated time. */
  time = 0;
  /** Incremented whenever positions or membership change (lets the renderer skip uploads). */
  version = 0;

  /** Simulated time requested but not yet integrated (always less than one step). */
  clockRemainder = 0;

  /** Numerical scheme used by `step` and `advance`. */
  scheme: Scheme;

  private trailClock = 0;
  /** While an edit is recorded: particles added and removed since beginEdit, by id. */
  private editLog: { added: Map<number, ParticleRecord>; removed: Map<number, ParticleRecord> } | null = null;

  constructor(
    readonly rng: Rng = new Rng(),
    scheme: Scheme = SCHEMES[DEFAULT_SCHEME],
  ) {
    this.scheme = scheme;
  }

  get full(): boolean {
    return this.count >= MAX_PARTICLES;
  }

  /** Number of stored trail points of particle i (0 for particles without a trail). */
  trailLength(i: number): number {
    return i < TRAIL_PARTICLES ? this.trailCount[i] : 0;
  }

  add(x: number, y: number, color: number): boolean {
    if (this.count >= MAX_PARTICLES) return false;
    const i = this.count++;
    this.x[i] = x;
    this.y[i] = y;
    this.color[i] = color;
    this.id[i] = this.nextId++;
    if (i < TRAIL_PARTICLES) this.trailCount[i] = 0;
    this.birthAt[i] = Number.NaN;
    this.deathAt[i] = Number.NaN;
    this.version++;
    this.editLog?.added.set(this.id[i], { id: this.id[i], x, y, color });
    return true;
  }

  /** Removes particle i in O(TRAIL_LEN) by moving the last particle into its place. */
  removeAt(i: number): void {
    if (i < 0 || i >= this.count) return;
    this.noteRemoval(i);
    const last = --this.count;
    if (i !== last) {
      this.x[i] = this.x[last];
      this.y[i] = this.y[last];
      this.color[i] = this.color[last];
      this.id[i] = this.id[last];
      this.birthAt[i] = this.birthAt[last];
      this.deathAt[i] = this.deathAt[last];
      if (i < TRAIL_PARTICLES) {
        // The moved particle takes over the trail slot (it has a trail only if it had one).
        if (last < TRAIL_PARTICLES) {
          this.trailCount[i] = this.trailCount[last];
          const n = TRAIL_LEN * 2;
          this.trail.copyWithin(i * n, last * n, last * n + n);
        } else {
          this.trailCount[i] = 0;
        }
        this.trailLayout++;
      }
    }
    this.version++;
  }

  /**
   * Replaces all particles at once (used when restoring a snapshot or playing back a
   * recording). With `continueTrails`, and if the particles are the same ones in the same order,
   * their trails are kept and the new positions are appended to them, so a played-back run still
   * shows trails; otherwise trails start empty.
   */
  load(
    p: { ids: ArrayLike<number>; x: ArrayLike<number>; y: ArrayLike<number>; colors: ArrayLike<number> },
    continueTrails = false,
  ): void {
    const n = Math.min(p.ids.length, MAX_PARTICLES);
    let same = continueTrails && n === this.count;
    for (let i = 0; same && i < n; i++) same = this.id[i] === p.ids[i];
    let maxId = -1;
    for (let i = 0; i < n; i++) {
      this.x[i] = p.x[i];
      this.y[i] = p.y[i];
      this.color[i] = p.colors[i];
      this.id[i] = p.ids[i];
      if (p.ids[i] > maxId) maxId = p.ids[i];
    }
    this.birthAt.fill(Number.NaN, 0, n); // clocks start afresh (exponential clocks are memoryless)
    this.deathAt.fill(Number.NaN, 0, n);
    this.count = n;
    this.nextId = Math.max(this.nextId, maxId + 1);
    if (same) {
      this.recordTrail();
    } else {
      this.trailCount.fill(0);
      this.trailLayout++;
    }
    this.version++;
  }

    /** Index of the particle closest to (x, y) within maxDist, or −1. */
  nearest(x: number, y: number, maxDist: number): number {
    let best = -1;
    let bestD2 = maxDist * maxDist;
    for (let i = 0; i < this.count; i++) {
      const dx = this.x[i] - x;
      const dy = this.y[i] - y;
      const d2 = dx * dx + dy * dy;
      if (d2 <= bestD2) {
        bestD2 = d2;
        best = i;
      }
    }
    return best;
  }

  clear(): void {
    if (this.editLog) for (let i = 0; i < this.count; i++) this.noteRemoval(i);
    this.count = 0;
    this.version++;
  }

  // ---------------------------------------------------------------- undo support

  /** Starts recording which particles are added and removed (see endEdit). */
  beginEdit(): void {
    this.editLog ??= { added: new Map(), removed: new Map() };
  }

  /** Stops recording; returns the particles added and removed, or null if there were none. */
  endEdit(): ParticleEdit | null {
    const log = this.editLog;
    this.editLog = null;
    if (!log || (log.added.size === 0 && log.removed.size === 0)) return null;
    return { added: [...log.added.values()], removed: [...log.removed.values()] };
  }

  /**
   * Runs `change` without recording it in an open edit: for changes that are part of the
   * simulation (births, deaths), which undo must not revert.
   */
  untracked<T>(change: () => T): T {
    const log = this.editLog;
    this.editLog = null;
    try {
      return change();
    } finally {
      this.editLog = log;
    }
  }

  /** Removes every particle whose id is in `ids` (ids that are not present are ignored). */
  removeIds(ids: ReadonlySet<number>): void {
    if (ids.size === 0) return;
    // Backwards, so the particle that removeAt moves into slot i has been checked already.
    for (let i = this.count - 1; i >= 0; i--) if (ids.has(this.id[i])) this.removeAt(i);
  }

  /**
   * Adds particles back with their original ids and colours (undo/redo). Ids that are present
   * already are skipped. Returns how many were added (fewer if MAX_PARTICLES is reached).
   */
  restore(records: readonly ParticleRecord[]): number {
    const present = new Set<number>();
    for (let i = 0; i < this.count; i++) present.add(this.id[i]);
    let added = 0;
    for (const r of records) {
      if (present.has(r.id)) continue;
      if (this.count >= MAX_PARTICLES) break;
      const i = this.count++;
      this.x[i] = r.x;
      this.y[i] = r.y;
      this.color[i] = r.color;
      this.id[i] = r.id;
      if (i < TRAIL_PARTICLES) this.trailCount[i] = 0;
      this.birthAt[i] = Number.NaN;
      this.deathAt[i] = Number.NaN;
      if (r.id >= this.nextId) this.nextId = r.id + 1;
      present.add(r.id);
      added++;
    }
    if (added) this.version++;
    return added;
  }

  /** Records the removal of particle i in the open edit (an added-then-removed one cancels out). */
  private noteRemoval(i: number): void {
    const log = this.editLog;
    if (!log) return;
    const id = this.id[i];
    if (log.added.has(id)) log.added.delete(id);
    else log.removed.set(id, { id, x: this.x[i], y: this.y[i], color: this.color[i] });
  }

  clearTrails(): void {
    this.trailCount.fill(0);
    this.trailLayout++;
    this.version++;
  }

  /**
   * Advances the ensemble by simulated time T in fixed steps of length dt. Time that does not
   * fill a whole step is carried over to the next call. At most `workBudget` drift evaluations
   * are spent; if that is not enough, the missing time is dropped (the simulation falls behind
   * real time) rather than taking larger steps. Returns the simulated time actually advanced.
   */
  advance(
    process: Process,
    T: number,
    dt = DEFAULT_DT_MAX,
    workBudget = Infinity,
  ): number {
    if (!(T > 0)) return 0;
    // Only a finite budget (the live frame loop) limits the work per call.
    const costPerStep = Math.max(1, this.count) * this.scheme.driftEvals;
    const limit = Number.isFinite(workBudget)
      ? Math.max(1, Math.min(MAX_SUBSTEPS, Math.floor(workBudget / costPerStep)))
      : Infinity;
    const n = this.planSteps(T, dt, limit);
    const t0 = this.time;
    for (let s = 0; s < n; s++) {
      this.stepAt(process, dt, t0 + s * dt);
      this.events?.afterStep(this, t0 + (s + 1) * dt);
      this.trailClock += dt;
      if (this.trailClock >= TRAIL_DT - 1e-12) {
        this.trailClock -= TRAIL_DT;
        if (this.trailClock >= TRAIL_DT) this.trailClock = 0;
        this.recordTrail();
      }
    }
    const advanced = n * dt;
    this.time += advanced;
    this.lastSubsteps = n;
    return advanced;
  }

  /**
   * The number of steps of length dt that simulated time T (plus the time carried over) asks for,
   * at most `maxSteps`; the time carried over to the next call is updated (if the steps were
   * capped, the missing time is dropped). Used by `advance`, and by integrators elsewhere (the
   * GPU), which then apply their result with `commitSteps`.
   */
  planSteps(T: number, dt: number, maxSteps = Infinity): number {
    if (!(T > 0)) return 0;
    const pending = this.clockRemainder + T;
    let n = Math.floor(pending / dt + 1e-9);
    if (n > maxSteps) {
      n = maxSteps;
      this.clockRemainder = 0;
    } else {
      this.clockRemainder = Math.max(0, pending - n * dt);
    }
    return n;
  }

  /**
   * Takes the positions after `n` steps of length dt computed elsewhere (the GPU integrator), as
   * interleaved (x, y) pairs: advances the time, and records a trail point if one is due.
   */
  commitSteps(n: number, dt: number, xy: ArrayLike<number>): void {
    for (let i = 0, m = this.count; i < m; i++) {
      this.x[i] = xy[2 * i];
      this.y[i] = xy[2 * i + 1];
    }
    this.time += n * dt;
    this.lastSubsteps = n;
    this.version++;
    this.trailClock += n * dt;
    if (this.trailClock >= TRAIL_DT - 1e-12) {
      this.trailClock %= TRAIL_DT;
      this.recordTrail();
    }
  }

  /** Number of sub-steps taken by the last `advance` call. */
  lastSubsteps = 0;

  /** Drift evaluations performed by the last `advance` call (for adaptive work budgets). */
  get lastWork(): number {
    return this.lastSubsteps * this.count * this.scheme.driftEvals;
  }

  /** One step of size dt for every particle, using the current scheme (does not advance `time`). */
  step(process: Process, dt: number): void {
    this.stepAt(process, dt, this.time);
  }

  /** One step of size dt starting at time t (the drift may depend on time). */
  private stepAt(process: Process, dt: number, t: number): void {
    this.scheme.step(this, process, dt, this.rng, t);
    this.version++;
  }

  private recordTrail(): void {
    const head = (this.trailHead + 1) % TRAIL_LEN;
    this.trailHead = head;
    this.trailWrites++;
    const { x, y, trail, trailCount } = this;
    for (let i = 0, n = Math.min(this.count, TRAIL_PARTICLES); i < n; i++) {
      const k = (i * TRAIL_LEN + head) * 2;
      trail[k] = x[i];
      trail[k + 1] = y[i];
      if (trailCount[i] < TRAIL_LEN) trailCount[i]++;
    }
  }
}
