import type { DensityImage } from '../analysis/equilibrium';
import { COLORMAP, hexToRgb, PALETTE } from '../config';
import type { PotentialField } from '../sim/field';
import { type ParticleSystem, TRAIL_LEN } from '../sim/particles';
import type { Camera } from '../view/camera';
import { ARROW_FLOATS, arrowSpacing, buildArrows } from '../view/forceField';
import { gridSpacing } from '../view/gridSpacing';
import type { RenderOptions } from './renderer';

/** The heat map is sampled with at most about this many points per frame (then scaled up). */
const MAX_SAMPLES = 160_000;
/** Entries of the colour look-up table over Ψ/cap ∈ [−1, 1]. */
const LUT_SIZE = 2048;
/** While only Ψ's values change, force arrows are rebuilt at most this often (as on the GPU). */
const ARROW_REFRESH_MS = 33;
/** Trails are drawn in this many bands of fading opacity and width. */
const TRAIL_BANDS = 5;
const INK = '15, 23, 42';

/**
 * Draws the 2D view with the CPU (Canvas 2D) instead of WebGL: for devices without a usable GPU,
 * or when the GPU is switched off. It draws what the WebGL renderer draws (heat map with
 * iso-lines, grid, smoothed density, force arrows, trails, particles) in the same colours, with
 * simplifications where the GPU's per-pixel work would be too slow:
 *  - the heat map is sampled on a coarser grid and scaled up smoothly, and only recomputed when
 *    Ψ or the view changes;
 *  - trails fade in a few bands instead of per segment; the density has no iso-lines.
 */
export class CpuRenderer {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private readonly lut = buildLut();

  private readonly heat = document.createElement('canvas');
  private heatKey = '';
  private heatBlock = 1;
  private readonly fieldIds = new WeakMap<PotentialField, number>();
  private nextFieldId = 1;

  private readonly densityCanvas = document.createElement('canvas');
  private densityVersion = -1;

  private arrowData: Float32Array<ArrayBufferLike> = new Float32Array(0);
  private arrowCount = 0;
  private arrowKey = '';
  private arrowArea: { x0: number; y0: number; x1: number; y1: number } | null = null;
  private arrowBuiltAt = -Infinity;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D is not supported.');
    this.ctx = ctx;
  }

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    this.dpr = dpr;
    const w = Math.max(1, Math.round(cssWidth * dpr));
    const h = Math.max(1, Math.round(cssHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.heatKey = '';
    }
  }

  /** Formulas are not compiled for the CPU renderer: they are drawn through the display lattice. */
  setFormula(_formula: unknown): boolean {
    return false;
  }

  render(cam: Camera, field: PotentialField, ps: ParticleSystem, opts: RenderOptions): void {
    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const scale = cam.scale * this.dpr; // device px per world unit
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);

    this.drawHeat(cam, field, scale, W, H, opts.contours);
    if (opts.grid) this.drawGrid(cam, scale, W, H);
    if (opts.density) this.drawDensity(cam, opts.density, scale, W, H);
    if (opts.forceField) this.drawArrows(cam, opts.arrows ?? field, scale, W, H, opts.formula?.t ?? 0);
    const fade = opts.density ? 0.35 : 1;
    if (opts.trails && ps.count > 0) this.drawTrails(cam, ps, scale, W, H, fade);
    if (ps.count > 0) this.drawParticles(cam, ps, scale, W, H, fade);
  }

  // ---------------------------------------------------------------- heat map

  private drawHeat(cam: Camera, field: PotentialField, scale: number, W: number, H: number, contours: boolean): void {
    if (field.chunks.size === 0) return; // Ψ = 0 everywhere: white
    let id = this.fieldIds.get(field);
    if (!id) this.fieldIds.set(field, (id = this.nextFieldId++));
    const key = `${id}|${field.revision}|${field.epoch}|${cam.x}|${cam.y}|${scale}|${W}|${H}|${contours}`;
    if (key !== this.heatKey) {
      this.heatKey = key;
      this.computeHeat(cam, field, scale, W, H, contours);
    }
    const b = this.heatBlock;
    const ctx = this.ctx;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    // Sample (i, j) belongs at device pixel (i·b, j·b); drawImage centres a texel in its block.
    ctx.drawImage(this.heat, -b / 2, -b / 2, this.heat.width * b, this.heat.height * b);
  }

  /** Ψ on a grid of blocks of b device px, coloured with the colour map and the iso-lines. */
  private computeHeat(cam: Camera, field: PotentialField, scale: number, W: number, H: number, contours: boolean): void {
    const b = Math.max(1, Math.ceil(Math.sqrt((W * H) / MAX_SAMPLES)));
    this.heatBlock = b;
    const gw = Math.ceil(W / b) + 1;
    const gh = Math.ceil(H / b) + 1;
    const n = gw * gh;
    const values = new Float32Array(n);
    for (let j = 0; j < gh; j++) {
      const y = cam.y + (H / 2 - j * b) / scale;
      for (let i = 0; i < gw; i++) values[j * gw + i] = field.sample(cam.x + (i * b - W / 2) / scale, y);
    }
    if (this.heat.width !== gw || this.heat.height !== gh) {
      this.heat.width = gw;
      this.heat.height = gh;
    }
    const hctx = this.heat.getContext('2d')!;
    const image = hctx.createImageData(gw, gh);
    const px = image.data;
    const cap = field.cap;
    const lut = this.lut;
    for (let j = 0; j < gh; j++) {
      for (let i = 0; i < gw; i++) {
        const k = j * gw + i;
        const v = values[k];
        const t = Math.min(1, Math.max(-1, v / cap));
        const e = Math.round(((t + 1) / 2) * (LUT_SIZE - 1)) * 3;
        let r = lut[e];
        let g = lut[e + 1];
        let bl = lut[e + 2];
        if (contours) {
          // As in the shader: iso-lines at Ψ = (k + ½)·cap/10, about one pixel wide, faded where
          // they would be too dense. Derivatives from the neighbouring samples (b px apart).
          const lv = (v * 10) / cap;
          const dx = i + 1 < gw ? Math.abs((values[k + 1] * 10) / cap - lv) : 0;
          const dy = j + 1 < gh ? Math.abs((values[k + gw] * 10) / cap - lv) : 0;
          const fw = Math.max(dx, dy) / b; // per device pixel
          const d = Math.abs(lv - Math.floor(lv) - 0.5) / Math.max(fw, 1e-6);
          const line = (1 - smoothstep(0.5, 1.5 + b * 0.5, d)) * (1 - smoothstep(0.15, 0.45, fw));
          const m = 1 - 0.22 * 0.55 * line; // mix(c, 0.78·c, 0.55·line)
          r *= m;
          g *= m;
          bl *= m;
        }
        const o = k * 4;
        px[o] = r;
        px[o + 1] = g;
        px[o + 2] = bl;
        px[o + 3] = 255;
      }
    }
    hctx.putImageData(image, 0, 0);
  }

  // ---------------------------------------------------------------- grid

  private drawGrid(cam: Camera, scale: number, W: number, H: number): void {
    const ctx = this.ctx;
    const { major, minor } = gridSpacing(cam.scale);
    const minorAlpha = smoothstep(5, 14, minor * cam.scale);
    const toX = (x: number) => Math.round(W / 2 + (x - cam.x) * scale) + 0.5;
    const toY = (y: number) => Math.round(H / 2 - (y - cam.y) * scale) + 0.5;
    const x0 = cam.x - W / 2 / scale;
    const x1 = cam.x + W / 2 / scale;
    const y0 = cam.y - H / 2 / scale;
    const y1 = cam.y + H / 2 / scale;
    const lines = (step: number, alpha: number, skip: (k: number) => boolean) => {
      if (alpha <= 0.001) return;
      ctx.beginPath();
      for (let k = Math.ceil(x0 / step); k <= Math.floor(x1 / step); k++) {
        if (skip(k)) continue;
        const x = toX(k * step);
        ctx.moveTo(x, 0);
        ctx.lineTo(x, H);
      }
      for (let k = Math.ceil(y0 / step); k <= Math.floor(y1 / step); k++) {
        if (skip(k)) continue;
        const y = toY(k * step);
        ctx.moveTo(0, y);
        ctx.lineTo(W, y);
      }
      ctx.strokeStyle = `rgba(${INK}, ${alpha})`;
      ctx.lineWidth = this.dpr;
      ctx.stroke();
    };
    const ratio = Math.round(major / minor);
    lines(minor, 0.06 * minorAlpha, (k) => k % ratio === 0);
    lines(major, 0.13, (k) => k === 0);
    // Axes.
    ctx.beginPath();
    ctx.moveTo(toX(0), 0);
    ctx.lineTo(toX(0), H);
    ctx.moveTo(0, toY(0));
    ctx.lineTo(W, toY(0));
    ctx.strokeStyle = `rgba(${INK}, 0.42)`;
    ctx.lineWidth = 1.5 * this.dpr;
    ctx.stroke();
  }

  // ---------------------------------------------------------------- smoothed density

  private drawDensity(cam: Camera, d: DensityImage, scale: number, W: number, H: number): void {
    const c = this.densityCanvas;
    if (d.version !== this.densityVersion) {
      this.densityVersion = d.version;
      c.width = d.nx;
      c.height = d.ny;
      const dctx = c.getContext('2d')!;
      const image = dctx.createImageData(d.nx, d.ny);
      let max = 0;
      for (let k = 0; k < d.nx * d.ny; k++) if (d.values[k] > max) max = d.values[k];
      const inv = max > 0 ? 1 / max : 0;
      // Hot pink as in the shader: #fbcfe8 → #ec4899, opacity 0.42·d^0.6 (rows flipped: row 0 is y0).
      for (let j = 0; j < d.ny; j++) {
        for (let i = 0; i < d.nx; i++) {
          const v = Math.min(1, d.values[j * d.nx + i] * inv);
          const o = ((d.ny - 1 - j) * d.nx + i) * 4;
          image.data[o] = 251 + (236 - 251) * v;
          image.data[o + 1] = 207 + (72 - 207) * v;
          image.data[o + 2] = 232 + (153 - 232) * v;
          image.data[o + 3] = 255 * 0.42 * v ** 0.6;
        }
      }
      dctx.putImageData(image, 0, 0);
    }
    const ctx = this.ctx;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(
      c,
      W / 2 + (d.x0 - cam.x) * scale,
      H / 2 - (d.y1 - cam.y) * scale,
      (d.x1 - d.x0) * scale,
      (d.y1 - d.y0) * scale,
    );
  }

  // ---------------------------------------------------------------- force arrows

  private drawArrows(
    cam: Camera,
    field: Parameters<typeof buildArrows>[0] & { readonly revision: number; readonly epoch: number },
    scale: number,
    W: number,
    H: number,
    t: number,
  ): void {
    const b = cam.bounds();
    const spacing = arrowSpacing(cam.scale);
    const key = `${spacing},${field.revision},${field.epoch}`;
    const a = this.arrowArea;
    const inside = a && b.x0 >= a.x0 && b.x1 <= a.x1 && b.y0 >= a.y0 && b.y1 <= a.y1;
    const now = performance.now();
    const viewChanged = !inside || !this.arrowKey.startsWith(`${spacing},`) || !this.arrowKey.endsWith(`,${field.epoch}`);
    if (key !== this.arrowKey && (viewChanged || now - this.arrowBuiltAt >= ARROW_REFRESH_MS)) {
      this.arrowBuiltAt = now;
      this.arrowKey = key;
      const padX = 0.5 * (b.x1 - b.x0);
      const padY = 0.5 * (b.y1 - b.y0);
      this.arrowArea = { x0: b.x0 - padX, y0: b.y0 - padY, x1: b.x1 + padX, y1: b.y1 + padY };
      const { data, count } = buildArrows(field, this.arrowArea, cam.scale, this.arrowData, t);
      this.arrowData = data;
      this.arrowCount = count;
    }
    const ctx = this.ctx;
    const spacingPx = spacing * scale;
    const headHalf = 3.4 * this.dpr;
    const d = this.arrowData;
    // Two passes: a soft white halo under all arrows, then the ink.
    for (const pass of [0, 1]) {
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (let k = 0; k < this.arrowCount; k++) {
        const o = k * ARROW_FLOATS;
        const cx = W / 2 + (d[o] - cam.x) * scale;
        const cy = H / 2 - (d[o + 1] - cam.y) * scale;
        if (cx < -spacingPx || cx > W + spacingPx || cy < -spacingPx || cy > H + spacingPx) continue;
        const ux = d[o + 2];
        const uy = -d[o + 3]; // screen y points down
        const len = d[o + 4] * spacingPx;
        const alpha = d[o + 5];
        const headLen = Math.min(0.55 * len, 5.5 * this.dpr);
        const hw = Math.min(headHalf, 0.7 * headLen);
        const tx = cx + (ux * len) / 2;
        const ty = cy + (uy * len) / 2;
        const bx = tx - ux * headLen;
        const by = ty - uy * headLen;
        ctx.beginPath();
        ctx.moveTo(cx - (ux * len) / 2, cy - (uy * len) / 2);
        ctx.lineTo(bx + ux * headLen * 0.5, by + uy * headLen * 0.5);
        ctx.moveTo(tx, ty);
        ctx.lineTo(bx - uy * hw, by + ux * hw);
        ctx.lineTo(bx + uy * hw, by - ux * hw);
        ctx.closePath();
        if (pass === 0) {
          ctx.strokeStyle = `rgba(255, 255, 255, ${0.6 * alpha})`;
          ctx.lineWidth = 4 * this.dpr;
          ctx.stroke();
        } else {
          ctx.strokeStyle = `rgba(${INK}, ${0.78 * alpha})`;
          ctx.fillStyle = `rgba(${INK}, ${0.78 * alpha})`;
          ctx.lineWidth = 1.3 * this.dpr;
          ctx.stroke();
          ctx.fill();
        }
      }
    }
  }

  // ---------------------------------------------------------------- trails and particles

  private drawTrails(cam: Camera, ps: ParticleSystem, scale: number, W: number, H: number, fade: number): void {
    const ctx = this.ctx;
    const toX = (x: number) => W / 2 + (x - cam.x) * scale;
    const toY = (y: number) => H / 2 - (y - cam.y) * scale;
    const per = Math.ceil(TRAIL_LEN / TRAIL_BANDS);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    // Point k of particle i: k = 0 is the particle, k ≥ 1 the k-th most recent stored point.
    const point = (i: number, k: number): [number, number] => {
      if (k === 0) return [ps.x[i], ps.y[i]];
      const slot = (ps.trailHead - (k - 1) + TRAIL_LEN) % TRAIL_LEN;
      const o = (i * TRAIL_LEN + slot) * 2;
      return [ps.trail[o], ps.trail[o + 1]];
    };
    for (let band = 0; band < TRAIL_BANDS; band++) {
      const k0 = band * per;
      const life = 1 - (k0 + per / 2) / (TRAIL_LEN + 1);
      if (life <= 0) break;
      ctx.lineWidth = 2.2 * this.dpr * (0.35 + 0.65 * life);
      ctx.globalAlpha = 0.6 * fade * life * life;
      // One path per colour.
      for (let c = 0; c < PALETTE.length; c++) {
        ctx.beginPath();
        let any = false;
        for (let i = 0; i < ps.count; i++) {
          if (ps.color[i] !== c) continue;
          const stored = ps.trailCount[i];
          const k1 = Math.min(stored, k0 + per);
          if (k1 <= k0) continue;
          let [x, y] = point(i, k0);
          ctx.moveTo(toX(x), toY(y));
          for (let k = k0 + 1; k <= k1; k++) {
            [x, y] = point(i, k);
            ctx.lineTo(toX(x), toY(y));
          }
          any = true;
        }
        if (any) {
          ctx.strokeStyle = PALETTE[c];
          ctx.stroke();
        }
      }
    }
    ctx.globalAlpha = 1;
  }

  private drawParticles(cam: Camera, ps: ParticleSystem, scale: number, W: number, H: number, fade: number): void {
    const ctx = this.ctx;
    const r = 5.5 * this.dpr;
    const ring = 1.8 * this.dpr;
    const outline = 1.1 * this.dpr;
    const xs = new Float32Array(ps.count);
    const ys = new Float32Array(ps.count);
    for (let i = 0; i < ps.count; i++) {
      xs[i] = W / 2 + (ps.x[i] - cam.x) * scale;
      ys[i] = H / 2 - (ps.y[i] - cam.y) * scale;
    }
    const visible = (i: number) => xs[i] > -20 && xs[i] < W + 20 && ys[i] > -20 && ys[i] < H + 20;
    const disks = (radius: number, style: string, only?: number) => {
      ctx.beginPath();
      for (let i = 0; i < ps.count; i++) {
        if (!visible(i) || (only !== undefined && ps.color[i] !== only)) continue;
        ctx.moveTo(xs[i] + radius, ys[i]);
        ctx.arc(xs[i], ys[i], radius, 0, Math.PI * 2);
      }
      ctx.fillStyle = style;
      ctx.fill();
    };
    ctx.globalAlpha = fade;
    disks(r + ring + outline, 'rgba(0, 0, 0, 0.55)'); // dark outline: visible on any background
    disks(r + ring, '#ffffff'); // white ring
    for (let c = 0; c < PALETTE.length; c++) disks(r, PALETTE[c], c);
    ctx.globalAlpha = 1;
  }
}

/** sRGB colour map (as PSI_COLOR_GLSL's psiRamp) at LUT_SIZE points of Ψ/cap ∈ [−1, 1], as bytes. */
function buildLut(): Uint8ClampedArray {
  const stops: readonly number[] = COLORMAP.stops;
  const hot = COLORMAP.hot.map(hexToRgb);
  const cold = COLORMAP.cold.map(hexToRgb);
  const lut = new Uint8ClampedArray(LUT_SIZE * 3);
  for (let e = 0; e < LUT_SIZE; e++) {
    const t = (e / (LUT_SIZE - 1)) * 2 - 1;
    const a = Math.abs(t);
    const ramp = t >= 0 ? hot : cold;
    let c = [1, 1, 1];
    for (let i = 0; i < stops.length - 1; i++) {
      if (a >= stops[i]) {
        const s = Math.min(1, Math.max(0, (a - stops[i]) / (stops[i + 1] - stops[i])));
        c = [0, 1, 2].map((q) => ramp[i][q] + (ramp[i + 1][q] - ramp[i][q]) * s);
      }
    }
    lut[e * 3] = Math.round(c[0] * 255);
    lut[e * 3 + 1] = Math.round(c[1] * 255);
    lut[e * 3 + 2] = Math.round(c[2] * 255);
  }
  return lut;
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
