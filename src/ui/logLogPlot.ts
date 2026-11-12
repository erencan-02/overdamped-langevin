import { attachExportButton, type FigureInfo } from '../export/figure';
import { drawLogLog, type LogLogCurve, SCREEN_LOOK } from './plotDraw';

export type { LogLogCurve } from './plotDraw';

/**
 * Small canvas plot of several curves on log–log axes (e.g. errors against the step size), drawn
 * by ui/plotDraw.ts. With a figure description it can be exported as PNG or SVG.
 */
export class LogLogPlot {
  private readonly ctx: CanvasRenderingContext2D;
  private last: { curves: readonly LogLogCurve[]; xLabel: string } | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    /** Title, axis titles and legend of the exported figure. */
    figure?: () => FigureInfo,
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D is not supported.');
    this.ctx = ctx;
    if (figure) {
      const plot = this;
      attachExportButton(canvas, {
        get empty() {
          return !plot.last?.curves.some((c) => c.xs.length > 0);
        },
        info: figure,
        // The figure has its own x title, so the plot does not repeat it.
        drawPlot: (c, w, h, look) => drawLogLog(c, w, h, plot.last!.curves, '', look),
      });
    }
  }

  draw(curves: readonly LogLogCurve[], xLabel: string): void {
    this.last = { curves, xLabel };
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
    drawLogLog(ctx, w, h, curves, xLabel, SCREEN_LOOK);
  }
}
