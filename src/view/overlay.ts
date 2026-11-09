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
}

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
