import { attachExportButton, type FigureInfo } from '../export/figure';
import { drawTimeSeries, type PlotData, SCREEN_LOOK } from './plotDraw';

export type { PlotData } from './plotDraw';

/**
 * Small canvas plot of a time series over the simulated time, shared by the analysis windows
 * (drawn by ui/plotDraw.ts). With a figure description it can be exported as PNG or SVG.
 */
export class TimeSeriesPlot {
  private readonly ctx: CanvasRenderingContext2D;
  private last: PlotData | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly scale: 'log' | 'linear',
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
          return plot.last === null || plot.last.times.length === 0;
        },
        info: figure,
        drawPlot: (c, w, h, look) => drawTimeSeries(c, w, h, plot.last!, plot.scale, look),
      });
    }
  }

  draw(data: PlotData): void {
    this.last = data;
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
    drawTimeSeries(ctx, w, h, data, this.scale, SCREEN_LOOK);
  }
}
