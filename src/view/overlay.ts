import { spawnGrid } from '../sim/spawnGrid';
import type { GridSelection } from '../ui/input';
import type { Camera } from './camera';
import { gridSpacing } from './gridSpacing';

export interface OverlayState {
  grid: boolean;
  mode: 'brush' | 'particles';
  cursor: { x: number; y: number; visible: boolean };
  brushRadius: number;
  /** +1 while raising, −1 while lowering, 0 when idle. */
  brushSign: number;
  nextColor: string;
  panning: boolean;
  /** Right-drag spawn rectangle in progress, if any. */
  selection: GridSelection | null;
}

/** Preview dots are drawn only if there are at most this many and they are this far apart. */
const MAX_PREVIEW_DOTS = 2500;
const MIN_PREVIEW_GAP_PX = 4;

const INK = 'rgba(15, 23, 42, 0.55)';
const RAISE = '#ea580c';
const LOWER = '#2563eb';

/** 2D canvas drawn over the WebGL view: axis labels and the tool cursor. */
export class Overlay {
  private readonly ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private w = 1;
  private h = 1;

  constructor(readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D is not supported.');
    this.ctx = ctx;
  }

  resize(w: number, h: number, dpr: number): void {
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    const W = Math.max(1, Math.round(w * dpr));
    const H = Math.max(1, Math.round(h * dpr));
    if (this.canvas.width !== W || this.canvas.height !== H) {
      this.canvas.width = W;
      this.canvas.height = H;
    }
  }

  draw(cam: Camera, s: OverlayState): void {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    if (s.grid) this.drawLabels(cam);
    if (s.selection) {
      this.drawSelection(cam, s.selection);
      return;
    }
    if (s.cursor.visible && !s.panning) {
      if (s.mode === 'brush') this.drawBrushCursor(cam, s);
      else this.drawParticleCursor(s);
    }
  }

  private drawLabels(cam: Camera): void {
    const ctx = this.ctx;
    const { major, decimals } = gridSpacing(cam.scale);
    const b = cam.bounds();
    const fmt = (v: number) => {
      const t = v.toFixed(decimals);
      return /^-0(\.0*)?$/.test(t) ? t.slice(1) : t;
    };
    ctx.font = '500 11px Inter, ui-sans-serif, system-ui, sans-serif';
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.fillStyle = 'rgba(51, 65, 85, 0.8)';

    // Labels sit next to the axes, but stick to the screen edges when an axis is off-screen.
    const axisY = clamp(cam.toScreenY(0) + 14, 14, this.h - 6);
    const axisX = clamp(cam.toScreenX(0) + 5, 5, this.w - 44);

    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    const i0 = Math.ceil(b.x0 / major);
    const i1 = Math.floor(b.x1 / major);
    for (let i = i0; i <= i1; i++) {
      const sx = cam.toScreenX(i * major);
      const text = fmt(i * major);
      ctx.strokeText(text, sx + 4, axisY);
      ctx.fillText(text, sx + 4, axisY);
    }
    const j0 = Math.ceil(b.y0 / major);
    const j1 = Math.floor(b.y1 / major);
    for (let j = j0; j <= j1; j++) {
      if (j === 0) continue; // "0" is already printed on the x axis
      const sy = cam.toScreenY(j * major);
      const text = fmt(j * major);
      ctx.strokeText(text, axisX, sy - 4);
      ctx.fillText(text, axisX, sy - 4);
    }
  }

  private drawBrushCursor(cam: Camera, s: OverlayState): void {
    const ctx = this.ctx;
    const { x, y } = s.cursor;
    const r = s.brushRadius * cam.scale;
    const color = s.brushSign > 0 ? RAISE : s.brushSign < 0 ? LOWER : INK;
    ctx.save();
    // 1σ circle (solid) and 2σ circle (dashed) of the Gaussian brush.
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 1.25;
    ctx.strokeStyle = color;
    ctx.stroke();
    ctx.setLineDash([3, 4]);
    ctx.globalAlpha = 0.6;
    ctx.beginPath();
    ctx.arc(x, y, 2 * r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    // Centre mark: "+" or "−" while painting, a dot otherwise.
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    if (s.brushSign !== 0) {
      ctx.moveTo(x - 4, y);
      ctx.lineTo(x + 4, y);
      if (s.brushSign > 0) {
        ctx.moveTo(x, y - 4);
        ctx.lineTo(x, y + 4);
      }
      ctx.stroke();
    } else {
      ctx.fillStyle = color;
      ctx.arc(x, y, 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /** Rectangle, the grid points that will be spawned and a count label. */
  private drawSelection(cam: Camera, sel: GridSelection): void {
    const ctx = this.ctx;
    const g = spawnGrid(sel.ax, sel.ay, sel.bx, sel.by, sel.spacing);
    const x0 = cam.toScreenX(Math.min(sel.ax, sel.bx));
    const x1 = cam.toScreenX(Math.max(sel.ax, sel.bx));
    const y0 = cam.toScreenY(Math.max(sel.ay, sel.by));
    const y1 = cam.toScreenY(Math.min(sel.ay, sel.by));
    const over = g.count > sel.room;
    ctx.save();

    // Rectangle: faint fill, white halo under a dashed ink outline.
    ctx.fillStyle = 'rgba(15, 23, 42, 0.05)';
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0, y1 - y0);
    ctx.lineWidth = 1.25;
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = over ? '#e11d48' : 'rgba(15, 23, 42, 0.7)';
    ctx.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0, y1 - y0);
    ctx.setLineDash([]);

    // Where the particles will appear (the ones beyond the particle limit are left out).
    const gapPx = g.spacing * cam.scale;
    const shown = Math.min(g.count, sel.room);
    if (shown > 0 && shown <= MAX_PREVIEW_DOTS && gapPx >= MIN_PREVIEW_GAP_PX) {
      const r = Math.min(3, gapPx / 4);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
      ctx.strokeStyle = 'rgba(15, 23, 42, 0.55)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let k = 0; k < shown; k++) {
        const sx = cam.toScreenX(g.x0 + (k % g.nx) * g.spacing);
        const sy = cam.toScreenY(g.y0 + Math.floor(k / g.nx) * g.spacing);
        ctx.moveTo(sx + r, sy);
        ctx.arc(sx, sy, r, 0, Math.PI * 2);
      }
      ctx.fill();
      ctx.stroke();
    }

    // Count label next to the moving corner, kept on screen.
    const plural = g.count === 1 ? 'particle' : 'particles';
    const text = over
      ? `${g.nx} × ${g.ny} = ${g.count} ${plural} · only ${Math.max(0, sel.room)} fit`
      : `${g.nx} × ${g.ny} = ${g.count} ${plural}`;
    ctx.font = '600 11.5px Inter, ui-sans-serif, system-ui, sans-serif';
    const tw = ctx.measureText(text).width;
    const w = tw + 16;
    const h = 22;
    const cx = cam.toScreenX(sel.bx);
    const cy = cam.toScreenY(sel.by);
    let lx = cx + 14;
    let ly = cy + 14;
    if (lx + w > this.w - 8) lx = cx - 14 - w;
    if (ly + h > this.h - 8) ly = cy - 14 - h;
    lx = clamp(lx, 8, this.w - 8 - w);
    ly = clamp(ly, 8, this.h - 8 - h);
    ctx.fillStyle = over ? '#be123c' : 'rgba(15, 23, 42, 0.9)';
    ctx.beginPath();
    ctx.roundRect(lx, ly, w, h, 7);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText(text, lx + 8, ly + h / 2 + 0.5);
    ctx.restore();
  }

  private drawParticleCursor(s: OverlayState): void {
    const ctx = this.ctx;
    const { x, y } = s.cursor;
    ctx.save();
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = s.nextColor;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(x, y, 5.8, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.globalAlpha = 0.45;
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(x, y, 11, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
