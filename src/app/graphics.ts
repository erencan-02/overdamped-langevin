import { CpuRenderer } from '../render/cpuRenderer';
import { detectGpu, type GpuInfo } from '../render/gpuInfo';
import { Renderer } from '../render/renderer';
import type { Potential } from '../sim/potential';
import type { AppState } from '../state';
import { Overlay } from '../view/overlay';

/**
 * Drawing the 2D view: WebGL2 on the GPU, or Canvas 2D on the CPU (without WebGL2, or with the GPU
 * switched off by the GPU button). Switching off releases the WebGL context, so the app then holds
 * no GPU resources at all; switching on restores it. The overlay (cursor, boxes, markers) is drawn
 * on its own canvas above either one.
 *
 * A hardware GPU is used from the start; with WebGL only emulated in software (or none), the CPU
 * renderer starts instead (this sets `state.gpu`).
 */
export class Graphics {
  readonly gpuInfo: GpuInfo;
  readonly overlay: Overlay;
  /**
   * A formula Ψ is drawn by the GPU (2D heat map and 3D relief, evaluated per pixel and per
   * vertex) when its GLSL passes the renderer's check against the exact values; otherwise from the
   * CPU through the display lattice. Kept up to date by `refreshFormula`.
   */
  formulaOnGpu = false;

  private renderer: Renderer | null = null;
  private cpuRenderer: CpuRenderer | null = null;
  private readonly glCanvas = byId<HTMLCanvasElement>('gl');
  private readonly cpuCanvas = document.createElement('canvas');
  private readonly loseContext: WEBGL_lose_context | null;
  private size = { w: 1, h: 1, dpr: 1 };

  constructor(
    private readonly state: AppState,
    private readonly potential: Potential,
    /** The WebGL context came back (GPU reset, driver update, …) and was rebuilt. */
    restored: () => void,
  ) {
    try {
      this.renderer = new Renderer(this.glCanvas);
    } catch (err) {
      console.warn('WebGL2 is not available: drawing on the CPU.', err);
    }
    this.gpuInfo = detectGpu(this.renderer?.gl ?? null);
    this.loseContext = this.renderer?.gl.getExtension('WEBGL_lose_context') ?? null;
    state.gpu = this.gpuInfo.available && this.gpuInfo.hardware;
    this.cpuCanvas.id = 'cpu';
    this.cpuCanvas.hidden = true;
    this.glCanvas.after(this.cpuCanvas);
    if (this.renderer && !state.gpu) this.loseContext?.loseContext(); // software WebGL: start on the CPU
    this.overlay = new Overlay(byId<HTMLCanvasElement>('overlay'));

    // Context loss: rebuild the renderer when the context is restored.
    this.glCanvas.addEventListener('webglcontextlost', (e) => e.preventDefault());
    this.glCanvas.addEventListener('webglcontextrestored', () => {
      if (!state.gpu) {
        this.loseContext?.loseContext(); // restored by the browser while the GPU is switched off
        return;
      }
      try {
        this.renderer = new Renderer(this.glCanvas);
        this.refreshFormula(); // the new context needs the formula's shader again
        restored();
      } catch (err) {
        console.error(err);
      }
    });
  }

  /** The WebGL renderer (null without WebGL2), e.g. for debugging. */
  get gpuRenderer(): Renderer | null {
    return this.renderer;
  }

  /** The GPU draws now (allowed, and its context is alive). */
  gpuReady(): boolean {
    return this.state.gpu && this.renderer !== null && !this.renderer.gl.isContextLost();
  }

  /** Uses the GPU (`state.gpu` was just set) or releases it. */
  useGpu(on: boolean): void {
    if (on) {
      if (this.renderer?.gl.isContextLost()) this.loseContext?.restoreContext(); // → webglcontextrestored
      this.refreshFormula();
    } else {
      this.formulaOnGpu = false; // a formula is drawn from the CPU now
      this.loseContext?.loseContext();
    }
  }

  /** Gives the GPU the current formula of Ψ (if it can draw it): sets `formulaOnGpu`. */
  refreshFormula(): void {
    const f = this.potential.compiled;
    const r = this.renderer;
    if (!r || !this.gpuReady()) {
      this.formulaOnGpu = false; // drawn from the CPU (restored later if the GPU comes back)
    } else if (!f?.glsl) {
      this.formulaOnGpu = r.setFormula(null);
    } else {
      this.formulaOnGpu = r.setFormula({ glsl: f.glsl, exact: (xs, ys, n, t, sigma, out) => f.value(xs, ys, n, t, sigma, out) });
    }
  }

  /** The GPU button's tooltip: whether there is a GPU, which one, and whether it is used. */
  tip(): string {
    const info = this.gpuInfo;
    if (!info.available) {
      return 'No GPU available: this browser offers no WebGL2, so everything is drawn on the CPU (no 3D view)';
    }
    const model = info.name ?? 'model not reported by the browser';
    const what = info.hardware ? `GPU available: ${model}` : `No hardware GPU: WebGL runs in software (${model})`;
    return this.state.gpu
      ? `${what} · in use · click to draw on the CPU instead`
      : `GPU off: drawing on the CPU (no 3D view) · ${what} · click to use it`;
  }

  resize(w: number, h: number, dpr: number): void {
    this.size = { w, h, dpr };
    this.renderer?.resize(w, h, dpr);
    this.cpuRenderer?.resize(w, h, dpr);
    this.overlay.resize(w, h, dpr);
  }

  /**
   * Shows the canvas of the renderer that draws now and returns whether that is the GPU. Call
   * once per frame, before `renderer2D`.
   */
  showActiveCanvas(): boolean {
    const onGpu = this.gpuReady();
    if (this.glCanvas.hidden === onGpu) this.glCanvas.hidden = !onGpu;
    if (this.cpuCanvas.hidden !== onGpu) this.cpuCanvas.hidden = onGpu;
    return onGpu;
  }

  /** The renderer of the 2D view: the GPU's, or the CPU's (created the first time it is needed). */
  renderer2D(onGpu: boolean): Renderer | CpuRenderer {
    if (onGpu) return this.renderer!;
    if (!this.cpuRenderer) {
      this.cpuRenderer = new CpuRenderer(this.cpuCanvas);
      this.cpuRenderer.resize(this.size.w, this.size.h, this.size.dpr);
    }
    return this.cpuRenderer;
  }
}

function byId<T extends HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`Missing element #${id}`);
  return e as T;
}
