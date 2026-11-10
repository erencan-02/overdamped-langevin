/**
 * Small canvas plot of a time series over the simulated time, shared by the analysis panels:
 * one curve (with a dot at its end and gaps where it is undefined), an optional shaded band
 * (e.g. a confidence interval) and an optional dashed reference (a constant or its own curve).
 * The value axis is logarithmic (whole decades) or linear (nice round ticks).
 */

const INK = '#0f172a';
const REFERENCE = '#3a9bdc';
const BAND = 'rgba(15, 23, 42, 0.12)';
const GRID = 'rgba(15, 23, 42, 0.08)';
const LABEL = 'rgba(51, 65, 85, 0.75)';
const FONT = '500 9.5px Inter, ui-sans-serif, system-ui, sans-serif';
/** On a log scale, anything below this is drawn at this value. */
const MIN_LOG = 1e-4;

export interface PlotData {
  times: readonly number[];
  values: readonly number[];
  /** Lower and upper ends of a band around the curve (same length as `values`). */
  band?: { lo: readonly number[]; hi: readonly number[] };
  /** Dashed reference: a constant, or a value per time (gaps where NaN). */
  reference?: number | readonly number[];
}

export class TimeSeriesPlot {
  private readonly ctx: CanvasRenderingContext2D;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly scale: 'log' | 'linear',
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D is not supported.');
    this.ctx = ctx;
  }

  draw(data: PlotData): void {
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

    const { times, values, band, reference } = data;
    const log = this.scale === 'log';
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

    ctx.font = FONT;
    let labelWidth = 0;
    for (const l of ticks.labels) labelWidth = Math.max(labelWidth, ctx.measureText(l).width);
    const padL = Math.max(30, Math.ceil(labelWidth) + 7);
    const padR = 6;
    const padT = 6;
    const padB = 16;
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
      ctx.fillText(ticks.labels[k], padL - 4, y);
    });

    // Time axis: first and last simulated time.
    const t0 = times.length ? times[0] : 0;
    const t1 = times.length ? Math.max(times[times.length - 1], t0 + 1e-9) : 1;
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = LABEL;
    ctx.textAlign = 'left';
    ctx.fillText(`t = ${t0.toFixed(1)}`, padL, h - 3);
    ctx.textAlign = 'right';
    ctx.fillText(`${t1.toFixed(1)}`, w - padR, h - 3);
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
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1.25;
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
        this.path(reference, xOf, yOf);
      }
      ctx.stroke();
      ctx.restore();
    }

    // Curve, with a dot at its end.
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    const last = this.path(values, xOf, yOf);
    ctx.stroke();
    if (last) {
      ctx.fillStyle = INK;
      ctx.beginPath();
      ctx.arc(last[0], last[1], 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /** Adds a polyline with gaps at undefined values; returns its last point. */
  private path(
    values: readonly number[],
    xOf: (k: number) => number,
    yOf: (v: number) => number,
  ): [number, number] | null {
    const ctx = this.ctx;
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
