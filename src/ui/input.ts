import { PALETTE } from '../config';
import type { PotentialField } from '../sim/field';
import type { UndoHistory } from '../sim/history';
import { MAX_PARTICLES, type ParticleSystem } from '../sim/particles';
import { forEachGridPoint, spawnGrid } from '../sim/spawnGrid';
import type { RandomStreams } from '../sim/random';
import type { AppState } from '../state';
import type { Camera } from '../view/camera';
import type { WorldPick } from '../view3d/types';

/** Particles per second while spraying (Shift + drag in particle mode). */
const SPRAY_RATE = 80;
/** Spray jitter radius in CSS pixels. */
const SPRAY_JITTER = 14;
/** Pick radius for removing a particle with the right mouse button (CSS px). */
const PICK_RADIUS = 14;
/** A right-press that moves less than this (CSS px) is a click (remove), not a rectangle. */
const DRAG_THRESHOLD = 4;

/** Rectangle being dragged with the right mouse button in particle mode (world units). */
export interface GridSelection {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  spacing: number;
  /** How many more particles fit before MAX_PARTICLES is reached. */
  room: number;
}

/**
 * Pointer and wheel interaction with the 2D landscape:
 *  - middle-drag (or Alt + left-drag) pans, the wheel zooms around the cursor,
 *  - brush mode: left raises Ψ, right lowers Ψ (Gaussian brush, applied continuously),
 *  - particle mode: left click drops a particle, Shift + drag sprays, right click removes,
 *    right-drag spans a rectangle that is filled with an equidistant grid of particles.
 * Every stroke, spray, click and grid is one step of the undo history.
 *
 * In the 3D view the same tools work on the surface: `picker` then maps the mouse to the point of
 * the surface under it. Orbiting is the 3D camera's (middle button, Alt + left, touch); the
 * right-drag grid and the 2D pan and zoom are not available there.
 */
export class InputController {
  /** Cursor in CSS pixels relative to the stage. */
  readonly cursor = { x: 0, y: 0, visible: false };
  brushSign = 0;
  panning = false;
  nextColor = 0;
  /** False during 2D ↔ 3D transitions: presses and the wheel are ignored. */
  enabled = true;
  /**
   * Maps a stage point (CSS px) to the world point under it in the 3D view, or null in 2D (the
   * 2D camera is used then).
   */
  picker: ((sx: number, sy: number) => WorldPick | null) | null = null;
  /** Painting is refused while Ψ is a formula; this is called instead (e.g. to explain why). */
  paintBlocked: () => boolean = () => false;

  private spraying = false;
  private sprayCarry = 0;
  private lastBrush: { x: number; y: number } | null = null;
  /** Whether the current brush press has deposited anything yet (a quick click may not). */
  private brushApplied = false;
  private panPointer = -1;
  private toolPointer = -1;
  private lastPan = { x: 0, y: 0 };
  /** A brush stroke or spray is being recorded as one undo step. */
  private stepOpen = false;
  /** Right-press: anchor in world units, press position in CSS px, world units per px there. */
  private grid: { ax: number; ay: number; sx: number; sy: number; dragged: boolean; perPx: number } | null = null;

  /** Called after any user interaction that changes the scene. */
  onInteract: () => void = () => {};
  /** Called after a grid was spawned; `requested` > `spawned` when the particle limit was hit. */
  onGridSpawned: (spawned: number, requested: number) => void = () => {};

  constructor(
    private readonly el: HTMLElement,
    private readonly cam: Camera,
    private readonly field: PotentialField,
    private readonly ps: ParticleSystem,
    private readonly state: AppState,
    private readonly random: RandomStreams,
    private readonly history: UndoHistory,
  ) {
    this.pickNextColor();
    el.addEventListener('pointerdown', this.onDown);
    el.addEventListener('pointermove', this.onMove);
    el.addEventListener('pointerup', this.onUp);
    el.addEventListener('pointercancel', this.onUp);
    el.addEventListener('lostpointercapture', this.onUp);
    el.addEventListener('pointerenter', this.onEnter);
    el.addEventListener('pointerleave', this.onLeave);
    el.addEventListener('wheel', this.onWheel, { passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    // Prevent the browser's middle-click auto-scroll.
    el.addEventListener('mousedown', (e) => {
      if (e.button === 1) e.preventDefault();
    });
    window.addEventListener('blur', () => this.cancel());
  }

  get busy(): boolean {
    return this.brushSign !== 0 || this.panning || this.spraying || this.grid !== null;
  }

  /** The rectangle currently being dragged (for the preview), or null. 2D only. */
  get selection(): GridSelection | null {
    const g = this.grid;
    if (!g || !g.dragged || this.picker) return null;
    return {
      ax: g.ax,
      ay: g.ay,
      bx: this.cam.toWorldX(this.cursor.x),
      by: this.cam.toWorldY(this.cursor.y),
      spacing: this.state.particleSpacing,
      room: MAX_PARTICLES - this.ps.count,
    };
  }

  /** The world point under stage point (sx, sy): the 3D surface's, or the 2D camera's. */
  pick(sx: number, sy: number): WorldPick | null {
    if (this.picker) return this.picker(sx, sy);
    return { x: this.cam.toWorldX(sx), y: this.cam.toWorldY(sy), perPx: 1 / this.cam.scale };
  }

  private local(e: PointerEvent | WheelEvent): { x: number; y: number } {
    const r = this.el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private pickNextColor(): void {
    const rng = this.random.get('colors');
    let c = rng.int(PALETTE.length);
    if (c === this.nextColor) c = (c + 1 + rng.int(PALETTE.length - 1)) % PALETTE.length;
    this.nextColor = c;
  }

  private capture(id: number): void {
    try {
      this.el.setPointerCapture(id);
    } catch {
      // Pointer no longer active (e.g. released during the event dispatch): nothing to capture.
    }
  }

  private onEnter = (e: PointerEvent): void => {
    const p = this.local(e);
    this.cursor.x = p.x;
    this.cursor.y = p.y;
    this.cursor.visible = true;
  };

  private onLeave = (): void => {
    if (this.toolPointer < 0 && this.panPointer < 0) this.cursor.visible = false;
  };

  private onDown = (e: PointerEvent): void => {
    if (!this.enabled) return;
    const p = this.local(e);
    this.cursor.x = p.x;
    this.cursor.y = p.y;
    this.cursor.visible = true;

    const wantsPan = e.button === 1 || (e.button === 0 && e.altKey);
    // In 3D these orbit the camera (OrbitControls), and so does a finger.
    if (this.picker && (wantsPan || e.pointerType === 'touch')) return;
    if (wantsPan) {
      if (this.panPointer >= 0) return;
      e.preventDefault();
      this.panPointer = e.pointerId;
      this.panning = true;
      this.lastPan = p;
      this.capture(e.pointerId);
      return;
    }
    if (e.button !== 0 && e.button !== 2) return;
    if (this.toolPointer >= 0) return;

    const hit = this.pick(p.x, p.y);
    if (!hit) return; // in 3D: not on the surface
    const wx = hit.x;
    const wy = hit.y;

    if (this.state.mode === 'brush') {
      if (this.paintBlocked()) return;
      this.toolPointer = e.pointerId;
      this.brushSign = e.button === 0 ? 1 : -1;
      this.lastBrush = { x: wx, y: wy };
      this.brushApplied = false;
      this.beginStep('Brush stroke');
      this.capture(e.pointerId);
    } else if (e.button === 0) {
      if (e.shiftKey) {
        this.toolPointer = e.pointerId;
        this.spraying = true;
        this.sprayCarry = 1; // the first particle appears immediately
        this.beginStep('Spray particles');
        this.capture(e.pointerId);
      } else {
        this.history.run('Add particle', () => this.dropParticle(wx, wy));
      }
    } else {
      // Right button: a click removes the nearest particle, a drag spans a spawn rectangle.
      this.toolPointer = e.pointerId;
      this.grid = { ax: wx, ay: wy, sx: p.x, sy: p.y, dragged: false, perPx: hit.perPx };
      this.capture(e.pointerId);
    }
  };

  private onMove = (e: PointerEvent): void => {
    const p = this.local(e);
    this.cursor.x = p.x;
    this.cursor.y = p.y;
    this.cursor.visible = true;
    if (this.panning && e.pointerId === this.panPointer) {
      this.cam.panBy(p.x - this.lastPan.x, p.y - this.lastPan.y);
      this.lastPan = p;
    }
    const g = this.grid;
    if (g && !g.dragged && e.pointerId === this.toolPointer) {
      g.dragged = Math.hypot(p.x - g.sx, p.y - g.sy) >= DRAG_THRESHOLD;
    }
  };

  private onUp = (e: PointerEvent): void => {
    if (e.pointerId === this.toolPointer && e.type === 'pointerup') {
      // The release position is the final corner of a spawn rectangle.
      const p = this.local(e);
      this.cursor.x = p.x;
      this.cursor.y = p.y;
    }
    if (e.pointerId === this.panPointer) {
      this.panPointer = -1;
      this.panning = false;
    }
    if (e.pointerId === this.toolPointer) {
      if (this.brushSign !== 0 && !this.brushApplied && this.lastBrush) {
        // A click shorter than one frame still leaves a mark worth one 60 Hz frame.
        const amount = (this.brushSign * this.state.brushStrength) / 60;
        this.field.applyBrush(this.lastBrush.x, this.lastBrush.y, amount, this.state.brushRadius);
        this.onInteract();
      }
      if (this.grid) this.finishGrid(e.type === 'pointerup');
      this.toolPointer = -1;
      this.brushSign = 0;
      this.spraying = false;
      this.lastBrush = null;
      this.endStep();
    }
    if (this.el.hasPointerCapture(e.pointerId)) this.el.releasePointerCapture(e.pointerId);
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    if (!this.enabled || this.picker) return; // in 3D the wheel zooms the 3D camera
    const p = this.local(e);
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    const dy = Math.max(-300, Math.min(300, e.deltaY * unit));
    // Pinch gestures on trackpads arrive as ctrl + wheel with small deltas.
    const k = e.ctrlKey ? 0.01 : 0.0015;
    this.cam.zoomAt(p.x, p.y, Math.exp(-dy * k));
  };

  /** Ends any drag, brush stroke or spray in progress (a pending grid is discarded). */
  cancel(): void {
    this.grid = null;
    this.toolPointer = -1;
    this.panPointer = -1;
    this.brushSign = 0;
    this.panning = false;
    this.spraying = false;
    this.lastBrush = null;
    this.endStep(); // what was painted or sprayed so far stays, as one step
  }

  private beginStep(label: string): void {
    if (this.stepOpen) return;
    this.stepOpen = true;
    this.history.begin(label);
  }

  private endStep(): void {
    if (!this.stepOpen) return;
    this.stepOpen = false;
    this.history.end();
  }

  /** Completes a right-press: spawn the grid (drag) or remove a particle (click). */
  private finishGrid(released: boolean): void {
    const sel = this.selection;
    const g = this.grid;
    this.grid = null;
    if (!g || !released) return; // cancelled (e.g. pointer capture lost)
    if (this.picker && g.dragged) return; // no grid rectangles in 3D
    if (!sel) {
      const i = this.ps.nearest(g.ax, g.ay, PICK_RADIUS * g.perPx);
      if (i >= 0) {
        this.history.run('Remove particle', () => this.ps.removeAt(i));
        this.onInteract();
      }
      return;
    }
    const grid = spawnGrid(sel.ax, sel.ay, sel.bx, sel.by, sel.spacing);
    const spawned = this.history.run('Add particle grid', () =>
      forEachGridPoint(grid, sel.room, (x, y) => {
        this.ps.add(x, y, this.nextColor);
        this.pickNextColor();
      }),
    );
    if (spawned > 0) this.onInteract();
    this.onGridSpawned(spawned, grid.count);
  }

  private dropParticle(wx: number, wy: number): void {
    if (this.ps.add(wx, wy, this.nextColor)) {
      this.pickNextColor();
      this.onInteract();
    }
  }

  /** Applies continuous tools (brush, spray). Called once per frame with the real-time step. */
  update(dt: number): void {
    const active = (this.brushSign !== 0 && this.lastBrush !== null) || this.spraying;
    // In 3D the cursor can be off the surface: then nothing is painted or sprayed this frame.
    const at = active ? this.pick(this.cursor.x, this.cursor.y) : null;
    if (!at) return;
    const cx = at.x;
    const cy = at.y;

    if (this.brushSign !== 0 && this.lastBrush) {
      // Deposit strength·dt per frame, distributed along the path travelled since the last
      // frame so that fast strokes stay smooth and continuous.
      const r = this.state.brushRadius;
      const total = this.brushSign * this.state.brushStrength * dt;
      const dx = cx - this.lastBrush.x;
      const dy = cy - this.lastBrush.y;
      const dist = Math.hypot(dx, dy);
      const n = Math.min(200, Math.max(1, Math.ceil(dist / (0.25 * r))));
      for (let k = 1; k <= n; k++) {
        const t = k / n;
        this.field.applyBrush(this.lastBrush.x + dx * t, this.lastBrush.y + dy * t, total / n, r);
      }
      this.lastBrush = { x: cx, y: cy };
      this.brushApplied = true;
      this.onInteract();
    }

    if (this.spraying) {
      this.sprayCarry += SPRAY_RATE * dt;
      const jitter = SPRAY_JITTER * at.perPx;
      while (this.sprayCarry >= 1 && !this.ps.full) {
        this.sprayCarry -= 1;
        const spawn = this.random.get('spawn');
        const a = spawn.float() * Math.PI * 2;
        const rr = jitter * Math.sqrt(spawn.float());
        this.dropParticle(cx + rr * Math.cos(a), cy + rr * Math.sin(a));
      }
      if (this.ps.full) this.sprayCarry = 0;
    }
  }
}
