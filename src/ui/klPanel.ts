import type { EquilibriumMonitor } from '../analysis/equilibrium';

const INK = '#0f172a';
const FLOOR = '#3a9bdc';
const GRID = 'rgba(15, 23, 42, 0.08)';
const LABEL = 'rgba(51, 65, 85, 0.75)';
/** Values are plotted on a log scale; anything below this is drawn at this value. */
const MIN_PLOTTED = 1e-4;

/**
 * The "Distance to equilibrium" window: live plot of KL(ρ̂_h ‖ π) over simulated time (log
 * scale) with the smoothing floor, the current value, particles in the box, and actions.
 */
export class KlPanel {
  private readonly section = el('analysis');
  private readonly toggle = el('analysis-toggle');
  private readonly body = el('analysis-body');
  private readonly value = el('kl-value');
  private readonly info = el('kl-info');
  private readonly canvas = el('kl-plot') as HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;

  constructor(
    private readonly monitor: EquilibriumMonitor,
    actions: { fitBox(): void },
  ) {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D is not supported.');
    this.ctx = ctx;
    this.toggle.addEventListener('click', () => this.setOpen(!this.monitor.enabled));
    el('kl-fit').addEventListener('click', () => actions.fitBox());
    el('kl-reset').addEventListener('click', () => {
      this.monitor.reset();
      this.draw();
    });
    new ResizeObserver(() => this.draw()).observe(this.canvas);
    // Start collapsed on short screens, where the window would crowd the settings.
    this.setOpen(window.innerHeight >= 760 && window.innerWidth > 640);
  }

  setOpen(open: boolean): void {
    this.monitor.enabled = open;
    this.toggle.setAttribute('aria-expanded', String(open));
    this.body.hidden = !open;
    this.section.classList.toggle('collapsed', !open);
    if (open) {
      // The curve was not tracked while closed (unless something kept the monitor running).
      if (!this.monitor.keepRunning) this.monitor.reset();
      this.draw();
    } else {
      this.value.textContent = '';
    }
  }

  /** Updates the readouts and the plot from the monitor's latest sample. */
  draw(): void {
    const s = this.monitor.latest;
    if (this.monitor.enabled) {
      this.value.textContent = s && Number.isFinite(s.kl) ? formatValue(s.kl) : '—';
      this.info.textContent = !s
        ? 'Waiting for particles…'
        : !Number.isFinite(s.floor)
          ? 'σ = 0: the Gibbs measure has no density.'
          : s.inside === 0
            ? `No particles in the box (${s.total} in total).`
            : `h = ${s.h.toFixed(2)} · ${s.inside} / ${s.total} in the box · floor ${formatValue(s.floor)}` +
              (s.kernelCells < 0.75 ? ' · kernel finer than the grid' : '');
    }
    this.plot();
  }

  private plot(): void {
    const canvas = this.canvas;
    const ctx = this.ctx;
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

    const { times, values, latest } = this.monitor;
    const floor = latest?.floor ?? NaN;

    // Log-scale range over the data and the floor, whole decades, at least one decade.
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of values) {
      if (!Number.isFinite(v)) continue;
      const y = Math.log10(Math.max(MIN_PLOTTED, v));
      if (y < lo) lo = y;
      if (y > hi) hi = y;
    }
    if (Number.isFinite(floor) && floor > 0) {
      const y = Math.log10(Math.max(MIN_PLOTTED, floor));
      lo = Math.min(lo, y);
      hi = Math.max(hi, y);
    }
    if (!Number.isFinite(lo)) {
      lo = -2;
      hi = 0;
    }
    let y0 = Math.floor(lo);
    let y1 = Math.ceil(hi);
    y0 = Math.max(y0, Math.log10(MIN_PLOTTED));
    if (y1 - y0 < 1) y1 = y0 + 1;

    const padL = 30;
    const padR = 6;
    const padT = 6;
    const padB = 16;
    const pw = w - padL - padR;
    const ph = h - padT - padB;
    const yOf = (v: number) => padT + ((y1 - Math.log10(Math.max(MIN_PLOTTED, v))) / (y1 - y0)) * ph;

    // Decade grid and labels.
    ctx.font = '500 9.5px Inter, ui-sans-serif, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    ctx.lineWidth = 1;
    for (let d = y0; d <= y1; d++) {
      const y = Math.round(padT + ((y1 - d) / (y1 - y0)) * ph) + 0.5;
      ctx.strokeStyle = GRID;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(w - padR, y);
      ctx.stroke();
      ctx.fillStyle = LABEL;
      ctx.fillText(decadeLabel(d), padL - 4, y);
    }

    // Time axis: first and last simulated time.
    const t0 = times.length ? times[0] : 0;
    const t1 = times.length ? Math.max(times[times.length - 1], t0 + 1e-9) : 1;
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = LABEL;
    ctx.textAlign = 'left';
    ctx.fillText(`t = ${t0.toFixed(1)}`, padL, h - 3);
    ctx.textAlign = 'right';
    ctx.fillText(`${t1.toFixed(1)}`, w - padR, h - 3);
    const xOf = (t: number) => padL + ((t - t0) / (t1 - t0)) * pw;

    // Smoothing floor.
    if (Number.isFinite(floor)) {
      const y = yOf(floor);
      ctx.save();
      ctx.strokeStyle = FLOOR;
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(w - padR, y);
      ctx.stroke();
      ctx.restore();
    }

    // KL curve (gaps where undefined).
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    let pen = false;
    let lastX = 0;
    let lastY = 0;
    for (let k = 0; k < values.length; k++) {
      const v = values[k];
      if (!Number.isFinite(v)) {
        pen = false;
        continue;
      }
      const x = times.length > 1 ? xOf(times[k]) : padL + pw;
      const y = yOf(v);
      if (pen) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
      pen = true;
      lastX = x;
      lastY = y;
    }
    ctx.stroke();
    if (pen) {
      ctx.fillStyle = INK;
      ctx.beginPath();
      ctx.arc(lastX, lastY, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function decadeLabel(d: number): string {
  if (d >= 0) return String(10 ** d);
  return (10 ** d).toFixed(-d);
}

function formatValue(v: number): string {
  if (v >= 100) return v.toFixed(0);
  if (v >= 1) return v.toFixed(2);
  if (v >= 0.01) return v.toFixed(3);
  return v.toExponential(1);
}

function el(id: string): HTMLElement {
  const e = document.getElementById(id);
  if (!e) throw new Error(`Missing element #${id}`);
  return e;
}
