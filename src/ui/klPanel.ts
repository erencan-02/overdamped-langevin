import type { EquilibriumMonitor } from '../analysis/equilibrium';
import { byId, CollapsiblePanel, formatValue, roomForPanels } from './collapsiblePanel';
import { TimeSeriesPlot } from './timeSeriesPlot';

/**
 * The "Distance to equilibrium" window: live plot of KL(ρ̂_h ‖ π) over simulated time (log
 * scale) with the smoothing floor, the current value, particles in the box, and actions.
 *
 * Nothing is estimated while the window is closed (unless a recording or the density view needs
 * it), and its typeset formulas are only loaded when it is first opened.
 */
export class KlPanel {
  private readonly value = byId('kl-value');
  private readonly info = byId('kl-info');
  private readonly plot = new TimeSeriesPlot(byId<HTMLCanvasElement>('kl-plot'), 'log');
  private readonly panel: CollapsiblePanel;

  constructor(
    private readonly monitor: EquilibriumMonitor,
    actions: {
      fitBox(): void;
      /** The window was opened (e.g. to typeset its formulas on first use). */
      opened(): void;
    },
  ) {
    this.panel = new CollapsiblePanel({ section: 'analysis', toggle: 'analysis-toggle', body: 'analysis-body' }, (open) => {
      this.monitor.enabled = open;
      if (open) {
        actions.opened();
        // The curve was not tracked while closed (unless something kept the monitor running).
        if (!this.monitor.keepRunning) this.monitor.reset();
        this.draw();
      } else {
        this.value.textContent = '';
      }
    });
    byId('kl-fit').addEventListener('click', () => actions.fitBox());
    byId('kl-reset').addEventListener('click', () => {
      this.monitor.reset();
      this.draw();
    });
    new ResizeObserver(() => this.draw()).observe(byId('kl-plot'));
    this.panel.setOpen(roomForPanels());
  }

  setOpen(open: boolean): void {
    this.panel.setOpen(open);
  }

  /** Updates the readouts and the plot from the monitor's latest sample. */
  draw(): void {
    const s = this.monitor.latest;
    if (this.monitor.enabled) {
      this.value.textContent = s && Number.isFinite(s.kl) ? formatValue(s.kl) : '—';
      this.info.textContent = !this.monitor.gibbs
        ? 'Not available: with a drift u or state-dependent noise the invariant measure is not known in closed form.'
        : !s
          ? 'Waiting for particles…'
          : !Number.isFinite(s.floor)
            ? 'σ = 0: the Gibbs measure has no density.'
            : s.inside === 0
              ? `No particles in the box (${s.total} in total).`
              : `h = ${s.h.toFixed(2)} · ${s.inside} / ${s.total} in the box · floor ${formatValue(s.floor)}` +
                (s.kernelCells < 0.75 ? ' · kernel finer than the grid' : '');
    }
    const { times, channels } = this.monitor.series;
    this.plot.draw({ times, values: channels.kl, reference: s?.floor ?? NaN });
  }
}
