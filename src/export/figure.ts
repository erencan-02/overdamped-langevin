import { downloadBlob, safeFileName } from '../ui/download';
import { notify } from '../ui/notify';
import { BAND, EXPORT_LOOK, INK, type PlotLook, REFERENCE } from '../ui/plotDraw';

/**
 * Figure export: a plot of a window as a high-resolution PNG or as an SVG, with a title, axis
 * titles and a legend, ready for papers and lecture notes. The plot is drawn by the same code as
 * on screen (ui/plotDraw.ts), on a large canvas or on a context that records SVG.
 */

/** A legend entry: a solid ('line') or dashed ('dash') curve, a shaded band, or a coloured curve. */
export interface LegendEntry {
  kind: 'line' | 'dash' | 'band';
  label: string;
  /** Colour of the curve (default: the plot's own colours). */
  color?: string;
}

/** What a figure shows besides the plot. */
export interface FigureInfo {
  title: string;
  xLabel: string;
  yLabel: string;
  legend: readonly LegendEntry[];
}

/** A plot that can be exported. */
export interface Exportable {
  /** Nothing to show yet (export is refused with a hint). */
  readonly empty: boolean;
  info(): FigureInfo;
  /** Draws the plot into (0, 0, w, h) of `ctx`. */
  drawPlot(ctx: CanvasRenderingContext2D, w: number, h: number, look: PlotLook): void;
}

/** Size of an exported figure in CSS px; the PNG has PNG_SCALE times as many pixels. */
const WIDTH = 800;
const HEIGHT = 500;
const PNG_SCALE = 3;
const FONT_FAMILY = 'Inter, ui-sans-serif, system-ui, sans-serif';

export async function exportFigure(plot: Exportable, format: 'png' | 'svg'): Promise<void> {
  const info = plot.info();
  const name = `${safeFileName(info.title, 'plot')}.${format}`;
  if (format === 'svg') {
    const { Context } = await import('svgcanvas'); // loaded on first use
    const svg = new Context({ width: WIDTH, height: HEIGHT });
    drawFigure(svg as unknown as CanvasRenderingContext2D, plot, info);
    downloadBlob(new Blob([svg.getSerializedSvg(true)], { type: 'image/svg+xml' }), name);
    return;
  }
  const canvas = document.createElement('canvas');
  canvas.width = WIDTH * PNG_SCALE;
  canvas.height = HEIGHT * PNG_SCALE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.reject(new Error('Canvas 2D is not supported.'));
  ctx.scale(PNG_SCALE, PNG_SCALE);
  drawFigure(ctx, plot, info);
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => {
      if (!blob) return reject(new Error('The picture could not be made.'));
      downloadBlob(blob, name);
      resolve();
    }, 'image/png'),
  );
}

/** Title, axis titles, the plot and the legend on a white page of WIDTH × HEIGHT. */
function drawFigure(ctx: CanvasRenderingContext2D, plot: Exportable, info: FigureInfo): void {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  const margin = 24;
  ctx.fillStyle = INK;
  ctx.font = `600 17px ${FONT_FAMILY}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(info.title, margin, margin + 14);

  // Legend rows at the bottom (wrapped to the width).
  ctx.font = `500 12.5px ${FONT_FAMILY}`;
  const rows = legendRows(ctx, info.legend, WIDTH - 2 * margin);
  const rowHeight = 20;
  const legendHeight = rows.length * rowHeight;

  const top = margin + 30;
  const left = margin + 22; // room for the y title
  const bottom = HEIGHT - margin - legendHeight - (info.xLabel ? 26 : 6);
  const plotW = WIDTH - left - margin;
  const plotH = bottom - top;

  // Axis titles.
  ctx.fillStyle = INK;
  ctx.font = `500 13px ${FONT_FAMILY}`;
  if (info.yLabel) {
    ctx.save();
    ctx.translate(margin + 4, top + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(info.yLabel, 0, -6);
    ctx.restore();
  }
  if (info.xLabel) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(info.xLabel, left + plotW / 2, bottom + 22);
  }

  ctx.save();
  ctx.translate(left, top);
  plot.drawPlot(ctx, plotW, plotH, EXPORT_LOOK);
  ctx.restore();

  // Legend.
  ctx.font = `500 12.5px ${FONT_FAMILY}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  rows.forEach((row, r) => {
    const y = HEIGHT - margin - legendHeight + r * rowHeight + rowHeight / 2;
    let x = margin;
    for (const { entry, width } of row) {
      legendMark(ctx, entry, x, y);
      ctx.fillStyle = INK;
      ctx.fillText(entry.label, x + 30, y);
      x += width;
    }
  });
}

const MARK = 30;
const ITEM_GAP = 22;

function legendRows(ctx: CanvasRenderingContext2D, legend: readonly LegendEntry[], maxWidth: number) {
  const rows: { entry: LegendEntry; width: number }[][] = [];
  let row: { entry: LegendEntry; width: number }[] = [];
  let used = 0;
  for (const entry of legend) {
    const width = MARK + ctx.measureText(entry.label).width + ITEM_GAP;
    if (row.length && used + width > maxWidth) {
      rows.push(row);
      row = [];
      used = 0;
    }
    row.push({ entry, width });
    used += width;
  }
  if (row.length) rows.push(row);
  return rows;
}

function legendMark(ctx: CanvasRenderingContext2D, e: LegendEntry, x: number, y: number): void {
  ctx.save();
  if (e.kind === 'band') {
    ctx.fillStyle = BAND;
    ctx.fillRect(x, y - 6, 24, 12);
  } else {
    ctx.strokeStyle = e.color ?? (e.kind === 'dash' ? REFERENCE : INK);
    ctx.lineWidth = 2;
    ctx.setLineDash(e.kind === 'dash' ? [6, 4] : []);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + 24, y);
    ctx.stroke();
  }
  ctx.restore();
}

const DOWNLOAD_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11" /><path d="m7 10.5 5 5 5-5" /><path d="M5 19.5h14" /></svg>';

/**
 * Puts a small export button on a plot canvas (top right, shown on hover or focus): it opens a
 * menu with PNG and SVG.
 */
export function attachExportButton(canvas: HTMLCanvasElement, plot: Exportable): void {
  const onError = notify;
  const wrap = document.createElement('div');
  wrap.className = 'plot-wrap';
  canvas.replaceWith(wrap);
  wrap.append(canvas);

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'plot-export icon-btn';
  button.title = 'Export this plot (PNG or SVG)';
  button.setAttribute('aria-label', 'Export this plot');
  button.setAttribute('aria-haspopup', 'true');
  button.setAttribute('aria-expanded', 'false');
  button.innerHTML = DOWNLOAD_ICON;
  const menu = document.createElement('div');
  menu.className = 'plot-export-menu card';
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  const item = (label: string, format: 'png' | 'svg') => {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.textContent = label;
    b.addEventListener('click', () => {
      close();
      if (plot.empty) {
        onError('Nothing to export yet: this plot is still empty.');
        return;
      }
      exportFigure(plot, format).catch((err) => {
        console.error(err);
        onError('The plot could not be exported.');
      });
    });
    menu.append(b);
  };
  item('PNG (high resolution)', 'png');
  item('SVG (vector)', 'svg');
  const close = () => {
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true);
  };
  const outside = (e: PointerEvent) => {
    if (!wrap.contains(e.target as Node)) close();
  };
  button.addEventListener('click', () => {
    if (!menu.hidden) return close();
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', outside, true);
  });
  menu.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
      button.focus();
    }
  });
  wrap.append(button, menu);
}
