import { PALETTE } from '../config';
import type { PotentialField } from '../sim/field';
import type { ParticleSystem } from '../sim/particles';
import type { AppState } from '../state';
import type { Camera } from '../view/camera';

/** Particles per second while spraying (Shift + drag in particle mode). */
const SPRAY_RATE = 80;
/** Spray jitter radius in CSS pixels. */
const SPRAY_JITTER = 14;
/** Pick radius for removing a particle with the right mouse button (CSS px). */
const PICK_RADIUS = 14;

/**
 * Pointer and wheel interaction with the 2D landscape:
 *  - middle-drag (or Alt + left-drag) pans, the wheel zooms around the cursor,
 *  - brush mode: left raises Ψ, right lowers Ψ (Gaussian brush, applied continuously),
 *  - particle mode: left click drops a particle, Shift + drag sprays, right click removes.
 */
export class InputController {
  /** Cursor in CSS pixels relative to the stage. */
  readonly cursor = { x: 0, y: 0, visible: false };
  brushSign = 0;
  panning = false;
  nextColor = 0;

  private spraying = false;
  private sprayCarry = 0;
  private lastBrush: { x: number; y: number } | null = null;
  /** Whether the current brush press has deposited anything yet (a quick click may not). */
  private brushApplied = false;
  private panPointer = -1;
  private toolPointer = -1;
  private lastPan = { x: 0, y: 0 };

  /** Called after any user interaction that changes the scene. */
  onInteract: () => void = () => {};

  constructor(
    private readonly el: HTMLElement,
    private readonly cam: Camera,
    private readonly field: PotentialField,
    private readonly ps: ParticleSystem,
    private readonly state: AppState,
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
    return this.brushSign !== 0 || this.panning || this.spraying;
  }

  private local(e: PointerEvent | WheelEvent): { x: number; y: number } {
    const r = this.el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private pickNextColor(): void {
    let c = Math.floor(Math.random() * PALETTE.length);
    if (c === this.nextColor) c = (c + 1 + Math.floor(Math.random() * (PALETTE.length - 1))) % PALETTE.length;
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
    const p = this.local(e);
    this.cursor.x = p.x;
    this.cursor.y = p.y;
    this.cursor.visible = true;

    const wantsPan = e.button === 1 || (e.button === 0 && e.altKey);
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

    const wx = this.cam.toWorldX(p.x);
    const wy = this.cam.toWorldY(p.y);

    if (this.state.mode === 'brush') {
      this.toolPointer = e.pointerId;
      this.brushSign = e.button === 0 ? 1 : -1;
      this.lastBrush = { x: wx, y: wy };
      this.brushApplied = false;
      this.capture(e.pointerId);
    } else if (e.button === 0) {
      if (e.shiftKey) {
        this.toolPointer = e.pointerId;
        this.spraying = true;
        this.sprayCarry = 1; // the first particle appears immediately
        this.capture(e.pointerId);
      } else {
        this.dropParticle(wx, wy);
      }
    } else {
      const i = this.ps.nearest(wx, wy, PICK_RADIUS / this.cam.scale);
      if (i >= 0) {
        this.ps.removeAt(i);
        this.onInteract();
      }
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
  };

  private onUp = (e: PointerEvent): void => {
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
      this.toolPointer = -1;
      this.brushSign = 0;
      this.spraying = false;
      this.lastBrush = null;
    }
    if (this.el.hasPointerCapture(e.pointerId)) this.el.releasePointerCapture(e.pointerId);
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const p = this.local(e);
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    const dy = Math.max(-300, Math.min(300, e.deltaY * unit));
    // Pinch gestures on trackpads arrive as ctrl + wheel with small deltas.
    const k = e.ctrlKey ? 0.01 : 0.0015;
    this.cam.zoomAt(p.x, p.y, Math.exp(-dy * k));
  };

  /** Ends any drag, brush stroke or spray in progress. */
  cancel(): void {
    this.toolPointer = -1;
    this.panPointer = -1;
    this.brushSign = 0;
    this.panning = false;
    this.spraying = false;
    this.lastBrush = null;
  }

  private dropParticle(wx: number, wy: number): void {
    if (this.ps.add(wx, wy, this.nextColor)) {
      this.pickNextColor();
      this.onInteract();
    }
  }

  /** Applies continuous tools (brush, spray). Called once per frame with the real-time step. */
  update(dt: number): void {
    const cx = this.cam.toWorldX(this.cursor.x);
    const cy = this.cam.toWorldY(this.cursor.y);

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
      const jitter = SPRAY_JITTER / this.cam.scale;
      while (this.sprayCarry >= 1 && !this.ps.full) {
        this.sprayCarry -= 1;
        const a = Math.random() * Math.PI * 2;
        const rr = jitter * Math.sqrt(Math.random());
        this.dropParticle(cx + rr * Math.cos(a), cy + rr * Math.sin(a));
      }
      if (this.ps.full) this.sprayCarry = 0;
    }
  }
}
