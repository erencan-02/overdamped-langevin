import type { EquilibriumMonitor } from '../analysis/equilibrium';
import type { Box } from '../analysis/kde';
import { PALETTE } from '../config';
import { CHUNK, type PotentialField } from '../sim/field';
import type { ParticleSystem } from '../sim/particles';
import type { Camera } from '../view/camera';
import { StateComponent } from './component';

/** Particles: positions, stable ids, colours, simulated time, and the exact integrator state. */
export interface ParticlesSnapshot {
  ids: ArrayLike<number>;
  x: ArrayLike<number>;
  y: ArrayLike<number>;
  colors: ArrayLike<number>;
  time: number;
  /** Simulated time carried over to the next step (fixed clock). */
  clockRemainder?: number;
  /** Next id to hand out. */
  nextId?: number;
  /** State of the 'dynamics' random stream, so a run continues exactly from here. */
  rngState?: ArrayLike<number>;
  /** Keep trails if the particles are the same as before (playback). */
  continueTrails?: boolean;
}

export class ParticlesComponent extends StateComponent<ParticlesSnapshot> {
  readonly key = 'particles';
  override readonly order = 40;

  constructor(private readonly ps: ParticleSystem) {
    super();
  }

  capture(): ParticlesSnapshot {
    const n = this.ps.count;
    return {
      ids: this.ps.id.slice(0, n),
      x: this.ps.x.slice(0, n),
      y: this.ps.y.slice(0, n),
      colors: this.ps.color.slice(0, n),
      time: this.ps.time,
      clockRemainder: this.ps.clockRemainder,
      nextId: this.ps.nextId,
      rngState: this.ps.rng.getState(),
    };
  }

  apply(v: ParticlesSnapshot): void {
    const n = v.ids.length;
    if (v.x.length < n || v.y.length < n || v.colors.length < n) throw new Error('Inconsistent particle snapshot');
    const colors = Uint8Array.from({ length: n }, (_, i) =>
      Math.min(PALETTE.length - 1, Math.max(0, Number(v.colors[i]) | 0)),
    );
    this.ps.load({ ids: v.ids, x: v.x, y: v.y, colors }, v.continueTrails ?? false);
    if (Number.isFinite(v.time)) this.ps.time = v.time;
    if (v.clockRemainder !== undefined && Number.isFinite(v.clockRemainder)) {
      this.ps.clockRemainder = v.clockRemainder;
    }
    if (v.nextId !== undefined && Number.isFinite(v.nextId)) this.ps.nextId = Math.max(this.ps.nextId, v.nextId);
    if (v.rngState && v.rngState.length === 4) this.ps.rng.setState(v.rngState);
  }

  override revision(): string {
    return String(this.ps.version);
  }
}

/**
 * Ψ on a rectangular lattice: values[j·nx + i] at (x0 + i·cell, y0 + j·cell), rows upwards.
 * Applying replaces the whole field with this patch (zero elsewhere).
 */
export interface PotentialSnapshot {
  x0: number;
  y0: number;
  cell: number;
  nx: number;
  ny: number;
  values: ArrayLike<number>;
}

export class PotentialComponent extends StateComponent<PotentialSnapshot | null> {
  readonly key = 'potential';
  override readonly order = 30;

  constructor(private readonly field: PotentialField) {
    super();
  }

  /** Ψ on the lattice over the bounding box of everything painted (null if nothing is). */
  capture(): PotentialSnapshot | null {
    const f = this.field;
    if (f.chunks.size === 0) return null;
    let cx0 = Infinity;
    let cy0 = Infinity;
    let cx1 = -Infinity;
    let cy1 = -Infinity;
    for (const c of f.chunks.values()) {
      cx0 = Math.min(cx0, c.cx);
      cy0 = Math.min(cy0, c.cy);
      cx1 = Math.max(cx1, c.cx);
      cy1 = Math.max(cy1, c.cy);
    }
    const i0 = cx0 * CHUNK;
    const j0 = cy0 * CHUNK;
    const nx = (cx1 - cx0 + 1) * CHUNK;
    const ny = (cy1 - cy0 + 1) * CHUNK;
    const values = new Float32Array(nx * ny);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) values[j * nx + i] = f.node(i0 + i, j0 + j);
    return { x0: i0 * f.h, y0: j0 * f.h, cell: f.h, nx, ny, values };
  }

  apply(v: PotentialSnapshot | null): void {
    this.field.clear();
    if (!v) return;
    const { nx, ny, cell } = v;
    if (!(nx >= 2 && ny >= 2 && cell > 0) || v.values.length < nx * ny) throw new Error('Inconsistent Ψ snapshot');
    // writeGrid wants rows from the top down; snapshots store them from the bottom up.
    const rows = new Float32Array(nx * ny);
    for (let j = 0; j < ny; j++) {
      const src = (ny - 1 - j) * nx;
      for (let i = 0; i < nx; i++) rows[j * nx + i] = Number(v.values[src + i]) || 0;
    }
    this.field.writeGrid(rows, nx, ny, v.x0, v.y0 + (ny - 1) * cell, cell);
  }

  override revision(): string {
    return `${this.field.revision}|${this.field.epoch}`;
  }
}

/** The KL analysis box (where the equilibrium is measured). */
export class AnalysisBoxComponent extends StateComponent<Box | null> {
  readonly key = 'analysisBox';
  override readonly order = 50;
  override readonly tracksChanges = false;

  constructor(private readonly monitor: EquilibriumMonitor) {
    super();
  }

  capture(): Box | null {
    return this.monitor.box ? { ...this.monitor.box } : null;
  }

  apply(v: Box | null): void {
    if (!v || ![v.x0, v.y0, v.x1, v.y1].every(Number.isFinite) || v.x1 <= v.x0 || v.y1 <= v.y0) return;
    this.monitor.setBox(v);
  }
}

/** Camera position and zoom. */
export interface ViewSnapshot {
  x: number;
  y: number;
  scale: number;
}

export class ViewComponent extends StateComponent<ViewSnapshot> {
  readonly key = 'view';
  override readonly order = 60;
  override readonly tracksChanges = false;

  constructor(private readonly camera: Camera) {
    super();
  }

  capture(): ViewSnapshot {
    return { x: this.camera.x, y: this.camera.y, scale: this.camera.scale };
  }

  apply(v: ViewSnapshot): void {
    if (!v || ![v.x, v.y, v.scale].every(Number.isFinite) || v.scale <= 0) return;
    this.camera.x = v.x;
    this.camera.y = v.y;
    this.camera.zoomAt(this.camera.width / 2, this.camera.height / 2, v.scale / this.camera.scale);
  }
}
