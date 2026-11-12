/**
 * Drawing of the app's plots on any Canvas 2D context: a small plot in a window (on screen), a
 * large PNG or an SVG (figure export, which records the same calls as SVG). The look (fonts, line
 * widths, margins) is a parameter; the plot fills the rectangle (0, 0, w, h) of the context.
 */

export const INK = '#0f172a';
export const REFERENCE = '#3a9bdc';
export const BAND = 'rgba(15, 23, 42, 0.12)';
const GRID = 'rgba(15, 23, 42, 0.08)';
const AXIS = 'rgba(15, 23, 42, 0.45)';
const LABEL = 'rgba(51, 65, 85, 0.75)';
/** On a log scale, anything below this is drawn at this value. */
const MIN_LOG = 1e-4;

/** Sizes and decorations of a plot. */
export interface PlotLook {
  /** Font of the tick labels. */
  font: string;
  /** Height of a tick label in px (for spacing). */
  fontSize: number;
  curve: number;
  reference: number;
  dash: readonly number[];
  dot: number;
  /** Margins around the plotting area (the left one grows with the tick labels). */
  pad: { l: number; r: number; t: number; b: number };
  /** Ticks with values along the time / Δt axis (otherwise only its ends are labelled). */
  xTicks: boolean;
  /** Axis lines on the left and at the bottom. */
  axes: boolean;
}

export const SCREEN_LOOK: PlotLook = {
  font: '500 9.5px Inter, ui-sans-serif, system-ui, sans-serif',
  fontSize: 9.5,
  curve: 1.5,
  reference: 1.25,
  dash: [4, 3],
  dot: 2.5,
  pad: { l: 30, r: 6, t: 6, b: 16 },
  xTicks: false,
  axes: false,
};

export const EXPORT_LOOK: PlotLook = {
  font: '500 12px Inter, ui-sans-serif, system-ui, sans-serif',
  fontSize: 12,
  curve: 2,
  reference: 1.6,
  dash: [6, 4],
  dot: 3,
  pad: { l: 40, r: 10, t: 8, b: 22 },
  xTicks: true,
  axes: true,
};

export interface PlotData {
  times: readonly number[];
  values: readonly number[];
  /** Lower and upper ends of a band around the curve (same length as `values`). */
  band?: { lo: readonly number[]; hi: readonly number[] };
  /** Dashed reference: a constant, or a value per time (gaps where NaN). */
  reference?: number | readonly number[];
}

/**
 * A time series over the simulated time: one curve (with a dot at its end and gaps where it is
 * undefined), an optional shaded band (e.g. a confidence interval) and an optional dashed
 * reference (a constant or its own curve). The value axis is logarithmic (whole decades) or
 * linear (nice round ticks).
 */
export function drawTimeSeries(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  data: PlotData,
  scale: 'log' | 'linear',
  look: PlotLook,
): void {
  const { times, values, band, reference } = data;
  const log = scale === 'log';
  // Values as plotted on the axis (log10 on a log scale).
  const axis = (v: number) => (log ? Math.log10(Math.max(MIN_LOG, v)) : v);

  // Range over everything that is drawn.
  let lo = Infinity;
  let hi = -Infinity;
  const include = (v: number) => {
    if (!Number.isFinite(v) || (log && !(v > 0) && v !== 0)) return;
    const a = axis(v);
    if (a < lo) lo = a;
    if (a > hi) hi = a;
  };
  for (const v of values) include(v);
  if (band) {
    for (const v of band.lo) include(v);
    for (const v of band.hi) include(v);
  }
  if (typeof reference === 'number') include(reference);
  else if (reference) for (const v of reference) include(v);

  const ticks = log ? logTicks(lo, hi) : linearTicks(lo, hi);
  const y0 = ticks.values[0];
  const y1 = ticks.values[ticks.values.length - 1];

  ctx.font = look.font;
  let labelWidth = 0;
  for (const l of ticks.labels) labelWidth = Math.max(labelWidth, ctx.measureText(l).width);
  const gap = look.fontSize * 0.42;
  const padL = Math.max(look.pad.l, Math.ceil(labelWidth) + Math.round(gap + 3));
  const { r: padR, t: padT, b: padB } = look.pad;
  const pw = w - padL - padR;
  const ph = h - padT - padB;
  const yOf = (v: number) => padT + ((y1 - axis(v)) / (y1 - y0)) * ph;

  // Grid and value labels.
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'right';
  ctx.lineWidth = 1;
  ticks.values.forEach((tv, k) => {
    const y = Math.round(padT + ((y1 - tv) / (y1 - y0)) * ph) + 0.5;
    ctx.strokeStyle = GRID;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(w - padR, y);
    ctx.stroke();
    ctx.fillStyle = LABEL;
    ctx.fillText(ticks.labels[k], padL - Math.round(gap), y);
  });

  // Time axis.
  const t0 = times.length ? times[0] : 0;
  const t1 = times.length ? Math.max(times[times.length - 1], t0 + 1e-9) : 1;
  ctx.fillStyle = LABEL;
  if (look.xTicks) {
    timeTicks(ctx, t0, t1, padL, pw, h - padB, look);
  } else {
    // Only the first and last simulated time.
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.fillText(`t = ${t0.toFixed(1)}`, padL, h - 3);
    ctx.textAlign = 'right';
    ctx.fillText(`${t1.toFixed(1)}`, w - padR, h - 3);
  }
  if (look.axes) drawAxes(ctx, padL, padT, pw, ph);
  const xOf = (k: number) => (times.length > 1 ? padL + ((times[k] - t0) / (t1 - t0)) * pw : padL + pw);

  // Band: one filled polygon per run of points where both ends are defined.
  if (band) {
    ctx.fillStyle = BAND;
    let k = 0;
    while (k < values.length) {
      while (k < values.length && !(Number.isFinite(band.lo[k]) && Number.isFinite(band.hi[k]))) k++;
      const start = k;
      while (k < values.length && Number.isFinite(band.lo[k]) && Number.isFinite(band.hi[k])) k++;
      if (k - start < 1) continue;
      ctx.beginPath();
      for (let i = start; i < k; i++) ctx.lineTo(xOf(i), yOf(band.hi[i]));
      for (let i = k - 1; i >= start; i--) ctx.lineTo(xOf(i), yOf(band.lo[i]));
      ctx.closePath();
      ctx.fill();
      if (k - start === 1) {
        // A single point: draw the interval as a short bar.
        ctx.fillRect(xOf(start) - 1.5, yOf(band.hi[start]), 3, yOf(band.lo[start]) - yOf(band.hi[start]));
      }
    }
  }

  // Reference.
  if (reference !== undefined) {
    ctx.save();
    ctx.strokeStyle = REFERENCE;
    ctx.setLineDash(look.dash as number[]);
    ctx.lineWidth = look.reference;
    ctx.beginPath();
    if (typeof reference === 'number') {
      if (Number.isFinite(reference)) {
        const y = yOf(reference);
        ctx.moveTo(padL, y);
        ctx.lineTo(w - padR, y);
      }
    } else if (times.length <= 1) {
      const v = reference[reference.length - 1];
      if (Number.isFinite(v)) {
        ctx.moveTo(padL, yOf(v));
        ctx.lineTo(w - padR, yOf(v));
      }
    } else {
      path(ctx, reference, xOf, yOf);
    }
    ctx.stroke();
    ctx.restore();
  }

  // Curve, with a dot at its end.
  ctx.strokeStyle = INK;
  ctx.lineWidth = look.curve;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  const last = path(ctx, values, xOf, yOf);
  ctx.stroke();
  if (last) {
    ctx.fillStyle = INK;
    ctx.beginPath();
    ctx.arc(last[0], last[1], look.dot, 0, Math.PI * 2);
    ctx.fill();
  }
}

export interface LogLogCurve {
  xs: readonly number[];
  ys: readonly number[];
  color: string;
  dashed?: boolean;
}

/** Several curves on log–log axes (e.g. errors against the step size), with a dot per point. */
export function drawLogLog(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  curves: readonly LogLogCurve[],
  xLabel: string,
  look: PlotLook,
): void {
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
  ctx.font = look.font;
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
  const s = look.fontSize / SCREEN_LOOK.fontSize;
  const left = Math.round(34 * s);
  const right = Math.round(8 * s);
  const top = Math.round(6 * s);
  const bottom = Math.round(16 * s);
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
    ctx.fillText(`1e${d}`, left - 4 * s, y);
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  for (let d = Math.ceil(x0); d <= Math.floor(x1); d++) ctx.fillText(`1e${d}`, xOf(d), h - 4 * s);
  ctx.textAlign = 'right';
  if (xLabel) ctx.fillText(xLabel, w - right, h - 4 * s - 10 * s);
  if (look.axes) drawAxes(ctx, left, top, w - left - right, h - top - bottom);

  for (const c of curves) {
    ctx.strokeStyle = c.color;
    ctx.fillStyle = c.color;
    ctx.lineWidth = 1.6 * (look.curve / SCREEN_LOOK.curve);
    ctx.setLineDash(c.dashed ? (look.dash as number[]) : []);
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
      ctx.arc(xOf(Math.log10(c.xs[i])), yOf(Math.log10(c.ys[i])), 2 * (look.dot / SCREEN_LOOK.dot), 0, 2 * Math.PI);
      ctx.fill();
    }
  }
}

/** Adds a polyline with gaps at undefined values; returns its last point. */
function path(
  ctx: CanvasRenderingContext2D,
  values: readonly number[],
  xOf: (k: number) => number,
  yOf: (v: number) => number,
): [number, number] | null {
  let pen = false;
  let last: [number, number] | null = null;
  for (let k = 0; k < values.length; k++) {
    const v = values[k];
    if (!Number.isFinite(v)) {
      pen = false;
      continue;
    }
    const x = xOf(k);
    const y = yOf(v);
    if (pen) ctx.lineTo(x, y);
    else ctx.moveTo(x, y);
    pen = true;
    last = [x, y];
  }
  return last;
}

/** Labelled ticks along the time axis, inside [t0, t1]. */
function timeTicks(
  ctx: CanvasRenderingContext2D,
  t0: number,
  t1: number,
  left: number,
  width: number,
  bottom: number,
  look: PlotLook,
): void {
  const ticks = linearTicks(t0, t1);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.strokeStyle = AXIS;
  ctx.lineWidth = 1;
  ticks.values.forEach((tv, k) => {
    if (tv < t0 - 1e-9 * (t1 - t0) || tv > t1 + 1e-9 * (t1 - t0)) return;
    const x = Math.round(left + ((tv - t0) / (t1 - t0)) * width) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, bottom);
    ctx.lineTo(x, bottom + 4);
    ctx.stroke();
    ctx.fillText(ticks.labels[k], x, bottom + 6 + look.fontSize * 0.1);
  });
}

function drawAxes(ctx: CanvasRenderingContext2D, left: number, top: number, width: number, height: number): void {
  ctx.save();
  ctx.strokeStyle = AXIS;
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(left + 0.5, top);
  ctx.lineTo(left + 0.5, top + height + 0.5);
  ctx.lineTo(left + width, top + height + 0.5);
  ctx.stroke();
  ctx.restore();
}

interface Ticks {
  /** Tick positions on the axis (log10 values on a log scale), ascending; first and last are the ends. */
  values: number[];
  labels: string[];
}

/** Whole decades covering [lo, hi] (log10 values), at least one decade. */
function logTicks(lo: number, hi: number): Ticks {
  if (!Number.isFinite(lo)) {
    lo = -2;
    hi = 0;
  }
  const d0 = Math.max(Math.floor(lo), Math.log10(MIN_LOG));
  let d1 = Math.ceil(hi);
  if (d1 - d0 < 1) d1 = d0 + 1;
  const values: number[] = [];
  for (let d = d0; d <= d1; d++) values.push(d);
  return { values, labels: values.map((d) => (d >= 0 ? String(10 ** d) : (10 ** d).toFixed(-d))) };
}

/** Two to five round ticks covering [lo, hi]; the axis ends on the outer ticks. */
export function linearTicks(lo: number, hi: number): Ticks {
  if (!Number.isFinite(lo)) {
    lo = 0;
    hi = 1;
  }
  if (!(hi - lo > 1e-12 * Math.max(1, Math.abs(lo), Math.abs(hi)))) {
    const d = Math.max(Math.abs(hi) * 0.05, 0.05);
    lo -= d;
    hi += d;
  }
  const raw = (hi - lo) / 3;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const r = raw / mag;
  const step = (r <= 1 ? 1 : r <= 2 ? 2 : r <= 2.5 ? 2.5 : r <= 5 ? 5 : 10) * mag;
  const a = Math.floor(lo / step + 1e-9);
  const b = Math.ceil(hi / step - 1e-9);
  const values: number[] = [];
  for (let k = a; k <= Math.max(b, a + 1); k++) values.push(k * step);
  const decimals = Math.max(0, -Math.floor(Math.log10(step) + 1e-9) + (step / mag === 2.5 ? 1 : 0));
  const big = Math.max(Math.abs(values[0]), Math.abs(values[values.length - 1]));
  const labels = values.map((v) => {
    if (Math.abs(v) < step * 1e-6) return '0';
    if (big >= 1e5 || decimals > 4) return v.toExponential(1);
    return v.toFixed(decimals);
  });
  return { values, labels };
}
