import { type CompiledPotential, loadTexParser, type TexParser } from '../analysis/latex';
import type { PotentialMode } from '../state';
import { byId, CollapsiblePanel, formatValue } from './collapsiblePanel';
import { FormulaInput } from './formulaInput';

/** ‖∇Ψ‖ is refreshed at most this often (real time), and only when something changed. */
const NORM_INTERVAL_MS = 100;

/**
 * The potential window: Ψ painted on a lattice (brush, images, camera) or given by a formula
 * Ψ(t, x, y) in LaTeX. A formula is compiled with its exact gradient (derived symbolically), so
 * the dynamics have neither a lattice nor a cap; it may depend on time t and on σ.
 *
 * The formula engine is loaded when the window is first opened or a formula is first needed
 * (e.g. a recording made with one). Until the formula in the state is compiled, `pending` is
 * true and the simulation waits, so it never runs with the wrong potential.
 *
 * It also shows ‖∇Ψ‖ in L² of the analysis box, computed only while the window is open and only
 * when Ψ, the time (for a time-dependent Ψ) or the box changed.
 */
export class PotentialPanel {
  private readonly mode = byId('psi-mode');
  private readonly info = byId('psi-info');
  private readonly toggle = byId<HTMLInputElement>('psi-use-formula');
  private readonly norm = byId('psi-norm');
  private normKey = '';
  private normAt = -Infinity;
  private mathLoaded = false;
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
      /**
       * ‖∇Ψ‖ in L² of the analysis box now (null: there is no box), and a key that changes
       * whenever that value may have changed.
       */
      gradientNorm(): { key: string; compute(): number } | null;
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
          this.loadMath();
          this.normKey = ''; // computed afresh on the next frame
          this.normAt = -Infinity;
        }
      },
    );
    this.toggle.addEventListener('change', () => this.actions.setMode(this.toggle.checked ? 'formula' : 'painted'));
    this.formula.input.value = actions.expression();
    this.panel.setOpen(false);
    this.sync();
  }

  /** The window is open (the analysis box is shown then, as the norm refers to it). */
  get open(): boolean {
    return this.panel.open;
  }

  /** Call every frame: refreshes ‖∇Ψ‖ while the window is open and something changed. */
  update(nowMs: number): void {
    if (!this.panel.open || nowMs - this.normAt < NORM_INTERVAL_MS) return;
    const source = this.pending ? null : this.actions.gradientNorm();
    const key = source ? source.key : 'none';
    if (key === this.normKey) return;
    this.normKey = key;
    this.normAt = nowMs;
    const value = source ? source.compute() : Number.NaN;
    this.norm.textContent = Number.isFinite(value) ? formatValue(value) : '—';
  }

  /** Typesets the window's label formulas (KaTeX, loaded on first opening). */
  private loadMath(): void {
    if (this.mathLoaded) return;
    this.mathLoaded = true;
    import('./helpMath')
      .then((m) => m.renderMath(byId('potential-body'), '.tex[data-tex]'))
      .catch((err) => console.error(err)); // the plain-text label stays
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
        // Only a formula the user typed or picked while the engine was loading counts as
        // entered (and switches to formula mode). The pre-filled one is just shown.
        const typed = this.formula.input.value.trim();
        if (typed !== this.actions.expression()) this.formula.setReady();
        else this.formula.setReady(typed);
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
