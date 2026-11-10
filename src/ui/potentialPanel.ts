import { type CompiledPotential, loadTexParser, type TexParser } from '../analysis/latex';
import type { PotentialMode } from '../state';
import { byId, CollapsiblePanel } from './collapsiblePanel';
import { FormulaInput } from './formulaInput';

/**
 * The potential window: Ψ painted on a lattice (brush, images, camera) or given by a formula
 * Ψ(t, x, y) in LaTeX. A formula is compiled with its exact gradient (derived symbolically), so
 * the dynamics have neither a lattice nor a cap; it may depend on time t and on σ.
 *
 * The formula engine is loaded when the window is first opened or a formula is first needed
 * (e.g. a recording made with one). Until the formula in the state is compiled, `pending` is
 * true and the simulation waits, so it never runs with the wrong potential.
 */
export class PotentialPanel {
  private readonly mode = byId('psi-mode');
  private readonly info = byId('psi-info');
  private readonly toggle = byId<HTMLInputElement>('psi-use-formula');
  private readonly panel: CollapsiblePanel;
  private readonly formula: FormulaInput;
  private parser: TexParser | null = null;
  private loadStarted = false;
  private loadFailed = false;
  /** Compiled formulas by LaTeX (the one in use, and recent ones). */
  private readonly compiled = new Map<string, CompiledPotential>();
  /** The formula given to the simulation (null: the painted lattice). */
  private active: CompiledPotential | null = null;

  constructor(
    private readonly actions: {
      mode(): PotentialMode;
      expression(): string;
      /** A new valid formula was entered. */
      setExpression(tex: string): void;
      setMode(mode: PotentialMode): void;
      /** Gives the simulation its potential: a compiled formula, or null for the painted lattice. */
      apply(potential: CompiledPotential | null): void;
    },
  ) {
    this.formula = new FormulaInput(byId('potential-body'), '\\Psi(t,x,y) = ', {
      tryUse: (tex) => {
        const r = this.parser!.parsePotential(tex);
        if (!r.ok) return r.message;
        this.compiled.set(tex, r.potential);
        if (this.compiled.size > 16) this.compiled.delete(this.compiled.keys().next().value!);
        return null;
      },
      committed: (tex) => this.actions.setExpression(tex), // → sync() applies it
    });
    this.panel = new CollapsiblePanel(
      { section: 'potential', toggle: 'potential-toggle', body: 'potential-body' },
      (open) => {
        if (open) {
          this.load();
          this.formula.loadPreview();
        }
      },
    );
    this.toggle.addEventListener('change', () => this.actions.setMode(this.toggle.checked ? 'formula' : 'painted'));
    this.formula.input.value = actions.expression();
    this.panel.setOpen(false);
    this.sync();
  }

  /** A formula is wanted but not compiled yet (or invalid): the simulation must wait. */
  get pending(): boolean {
    return this.actions.mode() === 'formula' && this.active !== this.compiled.get(this.actions.expression());
  }

  /** Brings the window and the simulation in line with the state (mode and formula). */
  sync(): void {
    const mode = this.actions.mode();
    const tex = this.actions.expression();
    this.toggle.checked = mode === 'formula';
    this.mode.textContent = mode === 'formula' ? 'formula' : 'painted';
    if (mode === 'formula') this.load();
    this.formula.setValue(tex);
    const next = mode === 'formula' ? (this.compiled.get(tex) ?? null) : null;
    if (mode === 'formula' && !next) {
      this.showInfo();
      return; // still compiling (or invalid): keep the old potential, `pending` holds the simulation
    }
    if (next !== this.active || (mode === 'painted' && this.active !== null)) {
      this.active = next;
      this.actions.apply(next);
    }
    this.showInfo();
  }

  private load(): void {
    if (this.loadStarted) return;
    this.loadStarted = true;
    loadTexParser()
      .then((parser) => {
        this.parser = parser;
        this.formula.setReady();
        // The formula in the state (also one restored from a recording) is compiled now.
        const tex = this.actions.expression();
        if (!this.compiled.has(tex)) {
          const r = parser.parsePotential(tex);
          if (r.ok) this.compiled.set(tex, r.potential);
          else this.formula.showError(r.message);
        }
        this.sync();
      })
      .catch((err) => {
        console.error(err);
        this.loadFailed = true;
        this.showInfo();
      });
  }

  private showInfo(): void {
    const formula = this.actions.mode() === 'formula';
    const f = this.active;
    this.info.textContent = this.loadFailed
      ? 'The formula engine could not be loaded. Check the connection and reload.'
      : !formula
        ? 'Ψ is painted on a lattice (h = 0.04, |Ψ| ≤ 5): brush, presets, images and the camera.'
        : this.pending
          ? this.parser
            ? 'The formula is not valid: the simulation waits.'
            : 'Loading the formula engine… (the simulation waits)'
          : `Exact ∇Ψ, no lattice, no cap${f?.timeDependent ? ' · depends on t' : ''}${f?.usesSigma ? ' · depends on σ' : ''}. ` +
            'The colours saturate at |Ψ| = 5.';
  }
}
