import { PotentialPanel } from '../ui/potentialPanel';
import { ProcessPanel } from '../ui/processPanel';
import type { App } from './app';

/**
 * The parts of the process typed as formulas: Ψ(t, x, y) (Potential window: painted, or a
 * formula with exact gradient) and the extra drift u and noise s (Drift & noise window; while both
 * are off, the process is the Langevin equation). Formulas compile in the background.
 */
export class Formulas {
  readonly potentialPanel: PotentialPanel;
  readonly processPanel: ProcessPanel;
  private readonly brandEq = document.querySelector<HTMLElement>('.brand-eq');

  constructor(private readonly app: App) {
    const core = app.core;
    const { state, potential, sde } = core;

    this.potentialPanel = new PotentialPanel({
      mode: () => state.potentialMode,
      expression: () => state.potentialTex,
      // Entering or picking a formula means using it.
      setExpression: (tex) => app.session.apply({ physics: { potentialTex: tex, potentialMode: 'formula' } }),
      setMode: (mode) => {
        if (mode === 'formula') app.liveCamera.stop(); // the camera paints the lattice
        app.session.apply({ physics: { potentialMode: mode } });
      },
      // ‖∇Ψ‖ over the analysis box; the key changes with Ψ (incl. time, for a formula) and the box.
      gradientNorm: () => {
        const b = app.analysis.monitor.box;
        if (!b) return null;
        return {
          key: `${potential.revision}|${potential.epoch}|${b.x0},${b.y0},${b.x1},${b.y1}`,
          compute: () => potential.gradientNormL2(b),
        };
      },
      apply: (compiled) => {
        potential.setFormula(compiled);
        app.graphics.refreshFormula();
      },
    });

    this.processPanel = new ProcessPanel({
      settings: () => state,
      set: (change) => app.session.apply({ physics: change }),
      apply: (drift, noise) => {
        sde.extraDrift = drift;
        sde.noise = noise;
        core.capabilities = sde.capabilities;
        // The equilibrium tools need the Gibbs measure to be the invariant measure.
        app.analysis.setGibbs(core.capabilities.gibbs);
        this.showEquation();
        app.arrows.replaced();
      },
      capabilities: () => core.capabilities,
    });
  }

  /** The simulation must wait: a formula of Ψ, u or s is not compiled yet. */
  waiting(): boolean {
    return this.potentialPanel.pending || this.processPanel.pending;
  }

  /** The equation in the title card follows the process. */
  private showEquation(): void {
    if (!this.brandEq) return;
    const sde = this.app.core.sde;
    const drift = sde.extraDrift ? '(−∇Ψ + u)(t, X<sub>t</sub>)' : '−∇Ψ(t, X<sub>t</sub>)';
    const noise = sde.noise ? 's(t, X<sub>t</sub>)' : 'σ';
    this.brandEq.innerHTML = `dX<sub>t</sub> = ${drift} dt + ${noise} dW<sub>t</sub>`; // fixed markup only
  }
}
