import { CHUNK, type PotentialField } from '../field';
import { CPU_PARTICLES, MAX_PARTICLES, type ParticleSystem } from '../particles';
import type { Potential } from '../potential';
import type { Sde } from '../process';
import type { SchemeId } from '../schemes';
import { kernelSource, type KernelSpec, paramsData, PROBE_STRIDE, type StepParams } from './kernel';
import type { GpuLost, GpuReply, GpuRequest } from './protocol';

/**
 * Integrates large ensembles on the GPU (WebGPU compute shaders, in a worker): up to
 * CPU_PARTICLES particles the CPU integrator runs as always (exact, double precision); above, the
 * GPU takes over whenever it can, so 100 000+ particles run in real time while the page stays
 * smooth. It cannot when something needs every single step on the CPU (births and deaths, the
 * path-following windows), when a formula has no GPU form, or without WebGPU; the CPU integrates
 * then (slower than real time for large ensembles, but exact).
 *
 * Every kernel is checked before it is used: drift and diffusion at sample points (particles and
 * fixed points) must agree with the CPU's values to single precision, otherwise the CPU keeps
 * integrating. The GPU computes in single precision with its own random numbers (see kernel.ts),
 * so a GPU run is reproducible on the same machine but not identical to a CPU run.
 *
 * One batch of steps per frame is on its way at a time; its result is applied only if nothing
 * changed the particles meanwhile (an edit, a CPU step): otherwise it is dropped and the GPU gets
 * the particles again.
 */

export type GpuStatus = 'off' | 'starting' | 'ready' | 'unavailable';

/** What the integrator works on, for one frame. */
export interface GpuFrame {
  particles: ParticleSystem;
  /** The process at the current Ψ and σ (as for the CPU integrator). */
  process: Sde;
  potential: Potential;
  seed: number;
  scheme: SchemeId;
  dt: number;
  /** Names of what needs every step on the CPU (empty: nothing). */
  stepHooks: readonly string[];
}

/** Most steps in one batch (simulated time beyond that is dropped, as on the CPU). */
const MAX_BATCH_STEPS = 500;
/** The lattice's chunk index may have at most this many entries (its bounding box in chunks). */
const MAX_INDEX = 4_000_000;
/** Sample points of a kernel check: up to this many particles, plus the fixed points below. */
const CHECK_PARTICLES = 48;
const CHECK_POINTS: readonly [number, number][] = [
  [0.37, -0.61],
  [1.3, 0.8],
  [-0.9, 1.7],
  [-1.6, -0.45],
  [2.2, 0.15],
  [0.05, -1.25],
  [3.4, -2.7],
  [-2.9, 3.1],
];

export class GpuIntegrator {
  status: GpuStatus = 'off';
  /** Why the GPU integrator is not available (status 'unavailable'). */
  problem = '';
  /** The last frame's integrator: whether the GPU stepped, and if not, why (null: small ensemble). */
  lastReason: string | null = null;
  usedLastFrame = false;

  private worker: Worker | null = null;
  private nextId = 1;
  private readonly waiting = new Map<number, (r: GpuReply) => void>();
  private maxChunks = 0;
  /** Kernels by source: their key in the worker and whether they passed the check. */
  private readonly kernels = new Map<string, { key: string; state: 'pending' | 'ok' | 'bad' }>();
  private nextKernel = 1;
  /** Particles on the GPU: the ParticleSystem version they match (−1: none / stale). */
  private uploadedVersion = -1;
  /** The lattice on the GPU. */
  private fieldEpoch = -1;
  private fieldRevision = -1;
  private readonly slotOf = new Map<number, { slot: number; version: number }>();
  private slots = 0;
  private index = { x0: 0, y0: 0, w: 0, h: 0 };
  private fieldTooLarge = false;
  private pending = false;
  /** Simulated time asked for while a batch was on its way. */
  private carry = 0;

  constructor(private readonly hooks: { changed(): void }) {}

  /** The GPU may be used (the GPU button is on). */
  private allowed = false;

  /**
   * Allows the GPU (the GPU button is on) or gives it back. The worker and the device are only
   * set up when a large ensemble first needs them.
   */
  enable(on: boolean): void {
    this.allowed = on;
    if (on && this.status === 'unavailable') {
      // Try again (e.g. after the device was lost), when it is next needed.
      this.status = 'off';
      this.problem = '';
    }
    if (!on && this.status !== 'off') this.stop();
  }

  /** Large ensembles can be integrated on the GPU here (it is allowed and WebGPU exists). */
  get available(): boolean {
    return this.allowed && this.status !== 'unavailable' && typeof navigator !== 'undefined' && 'gpu' in navigator;
  }

  private start(): void {
    if (typeof Worker === 'undefined' || !('gpu' in navigator)) {
      this.fail('this browser offers no WebGPU');
      return;
    }
    this.status = 'starting';
    this.problem = '';
    this.worker = new Worker(new URL('./gpu.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<{ id: number; reply: GpuReply } | GpuLost>) => {
      const d = e.data;
      if ('type' in d && d.type === 'lost') {
        this.fail(`the GPU device was lost (${d.message})`);
        return;
      }
      const m = d as { id: number; reply: GpuReply };
      const resolve = this.waiting.get(m.id);
      this.waiting.delete(m.id);
      resolve?.(m.reply);
    };
    this.worker.onerror = (e) => {
      e.preventDefault();
      this.fail(e.message || 'the GPU worker failed');
    };
    void this.request({ type: 'init', capacity: MAX_PARTICLES }).then((r) => {
      if (this.status !== 'starting') return;
      if (r.type !== 'ready') return this.fail(r.type === 'failed' ? r.message : 'unexpected reply');
      this.maxChunks = r.maxChunks;
      this.status = 'ready';
      this.hooks.changed();
    });
    this.hooks.changed();
  }

  private stop(): void {
    this.worker?.terminate(); // gives the GPU device back
    this.reset();
    this.status = 'off';
    this.hooks.changed();
  }

  private fail(problem: string): void {
    this.worker?.terminate();
    this.reset();
    this.status = 'unavailable';
    this.problem = problem;
    this.hooks.changed();
  }

  private reset(): void {
    this.worker = null;
    for (const resolve of this.waiting.values()) resolve({ type: 'failed', message: 'stopped' });
    this.waiting.clear();
    this.kernels.clear();
    this.uploadedVersion = -1;
    this.fieldEpoch = -1;
    this.fieldRevision = -1;
    this.slotOf.clear();
    this.slots = 0;
    this.pending = false;
    this.carry = 0;
  }

  private request(r: GpuRequest, transfer: Transferable[] = []): Promise<GpuReply> {
    const w = this.worker;
    if (!w) return Promise.resolve({ type: 'failed', message: 'no GPU worker' });
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      w.postMessage({ id, request: r }, transfer);
    });
  }

  /**
   * Advances the particles by simulated time T on the GPU, if it can. Returns false if not: then
   * the CPU must step this frame (`lastReason` says why).
   */
  advance(frame: GpuFrame, T: number): boolean {
    if (this.pending) {
      // A batch is on its way: the time is taken along by the next one.
      this.carry += T;
      this.usedLastFrame = true;
      return true;
    }
    const reason = this.blocker(frame);
    this.lastReason = reason;
    this.usedLastFrame = reason === null;
    if (reason !== null) {
      this.carry = 0;
      return false;
    }
    const ps = frame.particles;
    const steps = ps.planSteps(T + this.carry, frame.dt, MAX_BATCH_STEPS);
    this.carry = 0;
    if (steps === 0) return true;
    const key = this.kernels.get(this.source!)!.key;
    if (!frame.potential.analytic) this.syncField(frame.potential.lattice);
    this.syncParticles(ps);
    const n = ps.count;
    const params = paramsData(this.params(frame, n, steps, 0));
    const sent = { version: ps.version, time: ps.time, count: n };
    this.pending = true;
    void this.request({ type: 'step', key, params, n }).then((reply) => {
      this.pending = false;
      if (reply.type !== 'positions') {
        if (this.status === 'ready') this.fail(reply.type === 'failed' ? reply.message : 'unexpected reply');
        return;
      }
      if (ps.version !== sent.version || ps.time !== sent.time || ps.count !== sent.count) {
        this.uploadedVersion = -1; // changed meanwhile: this result is dropped
        return;
      }
      ps.commitSteps(steps, frame.dt, reply.pos);
      this.uploadedVersion = ps.version; // the GPU holds exactly these positions
    });
    return true;
  }

  /** The simulation is paused this frame (nothing to integrate). */
  idle(): void {
    this.carry = 0;
    this.usedLastFrame = false;
  }

  /** The kernel source of the current frame (set by `blocker`). */
  private source: string | null = null;

  /** Why the GPU does not integrate this frame (null: it does). Starts preparing kernels. */
  private blocker(frame: GpuFrame): string | null {
    this.source = null;
    if (frame.particles.count <= CPU_PARTICLES) return 'small';
    if (!this.allowed) return 'the GPU is switched off (GPU button)';
    if (this.status === 'off') this.start(); // first needed now
    if (this.status === 'starting') return 'the GPU is starting';
    if (this.status === 'unavailable') return `no GPU integrator: ${this.problem}`;
    if (frame.stepHooks.length) return `${frame.stepHooks.join(' and ')} need${frame.stepHooks.length === 1 ? 's' : ''} every single step`;
    const spec = specOf(frame);
    if (!spec) return 'a formula of the process has no GPU form';
    if (spec.psi.kind === 'lattice') {
      this.syncField(frame.potential.lattice);
      if (this.fieldTooLarge) return 'the painted area is too large for the GPU';
    }
    const source = kernelSource(spec);
    const k = this.kernels.get(source);
    if (!k) {
      void this.prepare(source, frame);
      return 'preparing the GPU';
    }
    if (k.state === 'pending') return 'preparing the GPU';
    if (k.state === 'bad') return 'the GPU did not match the CPU for this process';
    this.source = source;
    return null;
  }

  private params(frame: GpuFrame, n: number, steps: number, probeN: number): StepParams {
    const ps = frame.particles;
    return {
      n,
      steps,
      seed: frame.seed,
      stepIndex: Math.round(ps.time / frame.dt),
      scheme: frame.scheme,
      noisy: !frame.process.deterministic,
      probeN,
      t0: ps.time,
      dt: frame.dt,
      sigma: frame.process.sigma,
      invH: frame.potential.lattice.invH,
      index: this.index,
    };
  }

  /** Compiles a kernel and checks it against the CPU before it is used. */
  private async prepare(source: string, frame: GpuFrame): Promise<void> {
    const key = `k${this.nextKernel++}`;
    const entry = { key, state: 'pending' as 'pending' | 'ok' | 'bad' };
    this.kernels.set(source, entry);
    const compiled = await this.request({ type: 'kernel', key, code: source });
    // The process changed while compiling: check this kernel when it is needed again.
    const now = specOf(frame);
    if (!now || kernelSource(now) !== source) {
      if (this.kernels.get(source) === entry) this.kernels.delete(source);
      return;
    }
    if (compiled.type !== 'done') {
      console.warn('GPU kernel:', compiled.type === 'failed' ? compiled.message : compiled.type);
      entry.state = 'bad';
      this.hooks.changed();
      return;
    }
    // Drift and diffusion at sample points, on the GPU and exactly on the CPU (now, synchronously:
    // the process may change while waiting).
    const ps = frame.particles;
    const pts: [number, number][] = [...CHECK_POINTS];
    const stride = Math.max(1, Math.floor(ps.count / CHECK_PARTICLES));
    for (let i = 0; i < ps.count && pts.length < CHECK_POINTS.length + CHECK_PARTICLES; i += stride) pts.push([ps.x[i], ps.y[i]]);
    const m = pts.length;
    const xs = Float64Array.from(pts, (p) => Math.fround(p[0]));
    const ys = Float64Array.from(pts, (p) => Math.fround(p[1]));
    const cpu = Array.from({ length: 6 }, () => new Float64Array(m));
    const p = frame.process;
    p.drift(xs, ys, m, ps.time, cpu[0], cpu[1]);
    p.diffusion(xs, ys, m, ps.time, cpu[2], cpu[3], cpu[4], cpu[5]);
    const points = new Float32Array(m * PROBE_STRIDE);
    for (let k = 0; k < m; k++) {
      points[k * PROBE_STRIDE] = xs[k];
      points[k * PROBE_STRIDE + 1] = ys[k];
    }
    if (!frame.potential.analytic) this.syncField(frame.potential.lattice);
    const params = paramsData(this.params(frame, 0, 0, m));
    const probed = await this.request({ type: 'probe', key, params, points, count: m }, [points.buffer]);
    if (probed.type !== 'probed') {
      entry.state = 'bad';
    } else {
      const bad = mismatch(probed.values, cpu, xs, ys);
      entry.state = bad ? 'bad' : 'ok';
      if (bad) console.warn(`GPU check failed, the CPU integrates this process: ${bad}`);
    }
    this.hooks.changed();
  }

  /** Sends the particles if the GPU's copy is not the current one. */
  private syncParticles(ps: ParticleSystem): void {
    if (this.uploadedVersion === ps.version) return;
    const n = ps.count;
    const pos = new Float32Array(n * 2);
    const ids = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      pos[2 * i] = ps.x[i];
      pos[2 * i + 1] = ps.y[i];
      ids[i] = ps.id[i];
    }
    void this.request({ type: 'particles', n, pos, ids }, [pos.buffer, ids.buffer]);
    this.uploadedVersion = ps.version;
  }

  /** Sends the chunks of the lattice whose gradient changed since the last time. */
  private syncField(field: PotentialField): void {
    if (field.epoch === this.fieldEpoch && field.revision === this.fieldRevision) return;
    if (field.epoch !== this.fieldEpoch) {
      this.slotOf.clear();
      this.slots = 0;
      this.fieldEpoch = field.epoch;
    }
    this.fieldRevision = field.revision;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    let added = false;
    for (const c of field.chunks.values()) {
      if (!this.slotOf.has(c.key)) {
        this.slotOf.set(c.key, { slot: this.slotOf.size, version: -1 });
        added = true;
      }
      x0 = Math.min(x0, c.cx);
      y0 = Math.min(y0, c.cy);
      x1 = Math.max(x1, c.cx);
      y1 = Math.max(y1, c.cy);
    }
    const count = this.slotOf.size;
    const w = count ? x1 - x0 + 1 : 0;
    const h = count ? y1 - y0 + 1 : 0;
    this.fieldTooLarge = count > this.maxChunks || w * h > MAX_INDEX;
    if (this.fieldTooLarge) {
      this.fieldRevision = -1; // look again after the next change
      return;
    }
    // Room for more chunks: a larger buffer, into which every chunk is written again.
    let grow = false;
    if (count > this.slots) {
      this.slots = Math.min(this.maxChunks, Math.max(count, 2 * this.slots, 16));
      for (const e of this.slotOf.values()) e.version = -1;
      grow = true;
    }
    const writes: { slot: number; grad: Float32Array<ArrayBuffer> }[] = [];
    for (const c of field.chunks.values()) {
      const e = this.slotOf.get(c.key)!;
      if (e.version === c.version) continue;
      e.version = c.version;
      const grad = new Float32Array(CHUNK * CHUNK * 2);
      for (let k = 0; k < CHUNK * CHUNK; k++) {
        grad[2 * k] = c.gx[k];
        grad[2 * k + 1] = c.gy[k];
      }
      writes.push({ slot: e.slot, grad });
    }
    if (!writes.length && !added && !grow) return;
    this.index = { x0: count ? x0 : 0, y0: count ? y0 : 0, w, h };
    const index = new Int32Array(w * h).fill(-1);
    for (const c of field.chunks.values()) index[(c.cy - y0) * w + (c.cx - x0)] = this.slotOf.get(c.key)!.slot;
    void this.request({ type: 'field', slots: this.slots, index, writes }, [index.buffer, ...writes.map((x) => x.grad.buffer)]);
  }
}

/** The kernel for the frame's process, or null if a formula has no GPU form. */
function specOf(frame: GpuFrame): KernelSpec | null {
  const pot = frame.potential;
  let psi: KernelSpec['psi'];
  if (pot.analytic) {
    const w = pot.compiled?.wgsl;
    if (!w) return null;
    psi = { kind: 'formula', f: w };
  } else {
    psi = { kind: 'lattice' };
  }
  const u = frame.process.extraDrift;
  const s = frame.process.noise;
  if (u && !(u[0].wgsl && u[1].wgsl)) return null;
  if (s && !(s[0].wgsl && s[1].wgsl)) return null;
  return {
    psi,
    drift: u ? [u[0].wgsl!, u[1].wgsl!] : null,
    noise: s ? [s[0].wgsl!, s[1].wgsl!] : null,
  };
}

/** A description of the first value where GPU and CPU disagree beyond single precision, or null. */
function mismatch(gpu: Float32Array, cpu: Float64Array[], xs: Float64Array, ys: Float64Array): string | null {
  const names = ['b₁', 'b₂', 's₁', 's₂', '∂s₁/∂x', '∂s₂/∂y'];
  for (let k = 0; k < xs.length; k++) {
    for (let q = 0; q < 6; q++) {
      const g = gpu[k * PROBE_STRIDE + 2 + q];
      const c = cpu[q][k];
      const same = Number.isFinite(c) ? Number.isFinite(g) && Math.abs(g - c) <= 2e-3 * Math.max(1, Math.abs(c)) : !Number.isFinite(g);
      if (!same) return `${names[q]} at (${xs[k].toFixed(3)}, ${ys[k].toFixed(3)}): GPU ${g}, CPU ${c}`;
    }
  }
  return null;
}
