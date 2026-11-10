import type { PotentialField } from '../sim/field';
import type { ParticleSystem } from '../sim/particles';
import type { CameraPose, Cursor3D, Formula3D, Rect, Scene3DView, WorldPick } from './types';

export type ViewMode = '2d' | '3d';

/** Length of the 2D ↔ 3D transition. */
export const TRANSITION_MS = 1100;
/** With reduced motion: a short cross-fade instead of the camera flight. */
const REDUCED_MS = 220;
/** The 3D canvas fades in during this first part of the way to 3D (and out during the last part back). */
const FADE_PART = 0.28;
/** Camera tilt (from straight above) of the 3D view, and how much further away it ends up. */
const TILT = (50 * Math.PI) / 180;
const PULL_BACK = 1.18;
/** The 3D view looks north, i.e. the camera stands south of its target, as "up" is +y in 2D. */
const SOUTH = -Math.PI / 2;

export interface ViewSwitchHooks {
  /** World rectangle currently shown by the 2D view. */
  view2D(): Rect;
  /** The view mode changed (at the start of a transition). */
  onModeChange(mode: ViewMode): void;
  /** Called when 3D cannot be shown (e.g. WebGL unavailable). */
  onError(message: string): void;
}

export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

/** Interpolates two camera poses (target linearly, distance geometrically, angles the short way). */
export function lerpPose(a: CameraPose, b: CameraPose, t: number): CameraPose {
  let dAz = b.azimuth - a.azimuth;
  dAz = Math.atan2(Math.sin(dAz), Math.cos(dAz));
  return {
    target: [0, 1, 2].map((k) => a.target[k] + (b.target[k] - a.target[k]) * t) as [number, number, number],
    distance: a.distance * (b.distance / a.distance) ** t,
    polar: a.polar + (b.polar - a.polar) * t,
    azimuth: a.azimuth + dAz * t,
  };
}

interface Transition {
  to: ViewMode;
  start: number;
  duration: number;
  fromPose: CameraPose;
  toPose: CameraPose;
  fromRelief: number;
  toRelief: number;
  fromOpacity: number;
}

/**
 * Switches between the 2D view and the 3D view, with a smooth transition: going to
 * 3D, the 3D canvas fades in while it still shows the flat scene from straight above (it then
 * looks exactly like the 2D view), and the camera tilts while Ψ rises into a relief. Going back
 * runs the same flight in reverse, from wherever the user has moved the 3D camera, and the 2D
 * view appears exactly as it was. Switching again mid-way reverses from the current state.
 *
 * three.js is loaded only when 3D is first requested.
 */
export class ViewSwitch {
  mode: ViewMode = '2d';
  private scene: Scene3DView | null = null;
  private loading: Promise<Scene3DView | null> | null = null;
  private transition: Transition | null = null;
  private relief = 0;
  private opacity = 0;
  private size = { w: 1, h: 1, dpr: 1 };
  /** The GPU may be used (the 3D view needs it). */
  private gpu = true;

  constructor(
    private readonly container: HTMLElement,
    /** The lattice to show in 3D (the painted Ψ, or the one a formula is drawn into). */
    private readonly field: () => PotentialField,
    private readonly particles: ParticleSystem,
    private readonly hooks: ViewSwitchHooks,
  ) {}

  /** The 3D canvas is visible (in 3D, or during a transition either way). */
  get show3D(): boolean {
    return this.opacity > 0;
  }

  /** The 2D view is visible underneath (anything but a finished switch to 3D). */
  get show2D(): boolean {
    return !(this.mode === '3d' && this.transition === null && this.opacity >= 1);
  }

  /** The 2D view takes mouse input: only in 2D with no transition running. */
  get interactive2D(): boolean {
    return this.mode === '2d' && this.transition === null && this.opacity === 0;
  }

  /** The 3D view takes mouse input: fully in 3D, no transition running. */
  get interactive3D(): boolean {
    return this.mode === '3d' && this.transition === null && this.opacity >= 1 && this.scene !== null;
  }

  /** The surface point under a stage point (only meaningful while interactive3D). */
  pick(sx: number, sy: number): WorldPick | null {
    return this.scene?.pick(sx, sy) ?? null;
  }

  setCursor(c: Cursor3D | null): void {
    this.scene?.setCursor(c);
  }

  toggle(): void {
    this.set(this.mode === '2d' ? '3d' : '2d');
  }

  /**
   * Allows or forbids the GPU. Without it the 3D view is closed at once (no transition) and its
   * WebGL context released; switching to 3D is refused until the GPU is allowed again.
   */
  setGpu(allowed: boolean): void {
    this.gpu = allowed;
    if (allowed) return;
    const wasIn3D = this.mode === '3d';
    this.mode = '2d';
    this.transition = null;
    this.opacity = 0;
    this.relief = 0;
    if (this.scene) {
      this.scene.canvas.remove();
      this.scene.dispose();
    }
    this.scene = null;
    this.loading = null; // a load in progress is dropped when it finishes (see load)
    if (wasIn3D) this.hooks.onModeChange('2d');
  }

  set(mode: ViewMode): void {
    if (mode === this.mode) return;
    if (mode === '3d' && !this.gpu) {
      this.hooks.onError('The 3D view needs the GPU. Turn it on with the GPU button.');
      return;
    }
    this.mode = mode;
    this.hooks.onModeChange(mode);
    if (mode === '3d') void this.enter3D();
    else this.leave3D();
  }

  resize(w: number, h: number, dpr: number): void {
    this.size = { w, h, dpr };
    this.scene?.resize(w, h, dpr);
  }

  /** Call once per animation frame: advances a transition and draws the 3D view if visible. */
  frame(nowMs: number, grid: boolean, contours: boolean, formula: Formula3D | null = null): void {
    const scene = this.scene;
    const tr = this.transition;
    if (!scene) return;
    if (tr) {
      const p = Math.min(1, (nowMs - tr.start) / tr.duration);
      const e = easeInOutCubic(p);
      scene.setPose(lerpPose(tr.fromPose, tr.toPose, e));
      this.relief = tr.fromRelief + (tr.toRelief - tr.fromRelief) * e;
      scene.setRelief(this.relief);
      // Fade while the picture is (nearly) flat: at the start towards 3D, at the end towards 2D.
      const fade = tr.to === '3d' ? Math.min(1, p / FADE_PART) : Math.min(1, (1 - p) / FADE_PART);
      this.opacity = tr.to === '3d' ? Math.max(tr.fromOpacity, fade) : Math.min(tr.fromOpacity, fade);
      if (p >= 1) {
        this.transition = null;
        this.opacity = tr.to === '3d' ? 1 : 0;
        if (tr.to === '3d') scene.setControlsEnabled(true);
      }
      this.applyOpacity();
    }
    if (this.opacity > 0) {
      scene.setGrid(grid);
      scene.setContours(contours);
      scene.setFormula(formula);
      scene.render(nowMs);
    }
  }

  private async enter3D(): Promise<void> {
    const scene = await this.load();
    if (!scene || this.mode !== '3d') return; // failed, or switched back while loading
    const fromPose = this.transition || this.opacity > 0 ? scene.getPose() : null;
    if (!fromPose) {
      // Starting from 2D: build the surface around the current 2D view, camera straight above.
      scene.resize(this.size.w, this.size.h, this.size.dpr);
      scene.prepare(this.hooks.view2D());
      this.relief = 0;
    }
    const start = fromPose ?? scene.getPose();
    const home = scene.homePose(this.hooks.view2D());
    this.begin('3d', start, { ...home, distance: home.distance * PULL_BACK, polar: TILT, azimuth: SOUTH }, 1);
  }

  private leave3D(): void {
    const scene = this.scene;
    if (!scene || this.opacity === 0) {
      this.transition = null; // 3D never appeared (e.g. still loading)
      return;
    }
    scene.setControlsEnabled(false);
    scene.setCursor(null);
    // Back to straight above the 2D view, which has not moved while in 3D.
    this.begin('2d', scene.getPose(), scene.homePose(this.hooks.view2D()), 0);
  }

  private begin(to: ViewMode, fromPose: CameraPose, toPose: CameraPose, toRelief: number): void {
    this.scene?.setControlsEnabled(false);
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    // Reversing mid-way takes only as long as the way back.
    const prev = this.transition;
    const full = reduced ? REDUCED_MS : TRANSITION_MS;
    const done = prev ? Math.min(1, (performance.now() - prev.start) / prev.duration) : 1;
    this.transition = {
      to,
      start: performance.now(),
      duration: prev ? Math.max(200, full * done) : full,
      fromPose: reduced ? toPose : fromPose,
      toPose,
      fromRelief: reduced ? toRelief : this.relief,
      toRelief,
      fromOpacity: this.opacity,
    };
    if (to === '3d') this.canvasVisible(true);
  }

  private applyOpacity(): void {
    const c = this.scene?.canvas;
    if (!c) return;
    c.style.opacity = String(this.opacity);
    if (this.opacity === 0 && !this.transition) this.canvasVisible(false);
  }

  private canvasVisible(on: boolean): void {
    const c = this.scene?.canvas;
    if (c) c.hidden = !on;
  }

  private load(): Promise<Scene3DView | null> {
    if (this.scene) return Promise.resolve(this.scene);
    this.loading ??= import('./scene3d')
      .then(({ Scene3D }) => {
        if (!this.gpu) return null; // the GPU was switched off while loading
        const scene = new Scene3D(this.field, this.particles);
        const c = scene.canvas;
        c.className = 'view3d';
        c.hidden = true;
        c.style.opacity = '0';
        c.setAttribute('aria-label', '3D view: drag to orbit, right-drag to pan, scroll to zoom');
        // Right-drag pans the 3D view: no context menu. (The 2D tools ignore the mouse while the
        // 3D view is up; OrbitControls needs its events to reach the document, so they bubble.)
        c.addEventListener('contextmenu', (e) => e.preventDefault());
        this.container.appendChild(c);
        this.scene = scene;
        return scene;
      })
      .catch((err) => {
        console.error(err);
        this.loading = null;
        this.mode = '2d';
        this.hooks.onModeChange('2d');
        this.hooks.onError('The 3D view could not be started (WebGL is needed).');
        return null;
      });
    return this.loading;
  }
}
