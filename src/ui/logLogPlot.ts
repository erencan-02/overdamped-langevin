/**
 * Small canvas plot of several curves on log–log axes (e.g. errors against the step size), in
 * the style of TimeSeriesPlot: each curve is a colour, solid or dashed, with a dot per point.
 */

const GRID = 'rgba(15, 23, 42, 0.08)';
const LABEL = 'rgba(51, 65, 85, 0.75)';
const FONT = '500 9.5px Inter, ui-sans-serif, system-ui, sans-serif';

export interface LogLogCurve {
  xs: readonly number[];
  ys: readonly number[];
  color: string;
  dashed?: boolean;
}

export class LogLogPlot {
  private readonly ctx: CanvasRenderingContext2D;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D is not supported.');
    this.ctx = ctx;
  }

  draw(curves: readonly LogLogCurve[], xLabel: string): void {
    const { canvas, ctx } = this;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0 || h === 0) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const W = Math.round(w * dpr);
    const H = Math.round(h * dpr);
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W;
      canvas.height = H;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (const c of curves) {
      for (let i = 0; i < c.xs.length; i++) {
        if (!(c.xs[i] > 0 && c.ys[i] > 0)) continue;
        const lx = Math.log10(c.xs[i]);
        const ly = Math.log10(c.ys[i]);
        x0 = Math.min(x0, lx);
        x1 = Math.max(x1, lx);
        y0 = Math.min(y0, ly);
        y1 = Math.max(y1, ly);
      }
    }
    ctx.font = FONT;
    ctx.fillStyle = LABEL;
    if (!Number.isFinite(x0)) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Run the sweep to see the errors', w / 2, h / 2);
      return;
    }
    // Whole decades on the error axis, a little room on the Δt axis.
    y0 = Math.floor(y0);
    y1 = Math.max(Math.ceil(y1), y0 + 1);
    const padX = 0.06 * Math.max(x1 - x0, 0.5);
    x0 -= padX;
    x1 += padX;
    const left = 34;
    const right = 8;
    const top = 6;
    const bottom = 16;
    const xOf = (lx: number) => left + ((lx - x0) / (x1 - x0)) * (w - left - right);
    const yOf = (ly: number) => top + ((y1 - ly) / (y1 - y0)) * (h - top - bottom);

    ctx.strokeStyle = GRID;
    ctx.lineWidth = 1;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const step = Math.max(1, Math.ceil((y1 - y0) / 4));
    for (let d = y0; d <= y1; d += step) {
      const y = Math.round(yOf(d)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(w - right, y);
      ctx.stroke();
      ctx.fillText(`1e${d}`, left - 4, y);
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    for (let d = Math.ceil(x0); d <= Math.floor(x1); d++) ctx.fillText(`1e${d}`, xOf(d), h - 4);
    ctx.textAlign = 'right';
    ctx.fillText(xLabel, w - right, h - 4 - 10);

    for (const c of curves) {
      ctx.strokeStyle = c.color;
      ctx.fillStyle = c.color;
      ctx.lineWidth = 1.6;
      ctx.setLineDash(c.dashed ? [4, 3] : []);
      ctx.beginPath();
      let pen = false;
      for (let i = 0; i < c.xs.length; i++) {
        if (!(c.xs[i] > 0 && c.ys[i] > 0)) {
          pen = false;
          continue;
        }
        const x = xOf(Math.log10(c.xs[i]));
        const y = yOf(Math.log10(c.ys[i]));
        if (pen) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
        pen = true;
      }
      ctx.stroke();
      ctx.setLineDash([]);
      for (let i = 0; i < c.xs.length; i++) {
        if (!(c.xs[i] > 0 && c.ys[i] > 0)) continue;
        ctx.beginPath();
        ctx.arc(xOf(Math.log10(c.xs[i])), yOf(Math.log10(c.ys[i])), 2, 0, 2 * Math.PI);
        ctx.fill();
      }
    }
  }
}
