import { type CompiledPotential, loadTexParser, type TexParser } from '../analysis/latex';
import type { ProcessCapabilities } from '../sim/process';
import { byId, CollapsiblePanel } from './collapsiblePanel';
import { FormulaInput } from './formulaInput';

type Name = 'u_1' | 'u_2' | 's_1' | 's_2';
type Pair = readonly [CompiledPotential, CompiledPotential];

/** The process settings in the state (see AppState). */
export interface ProcessSettings {
  extraDrift: boolean;
  driftU1: string;
  driftU2: string;
  noiseFormula: boolean;
  noiseS1: string;
  noiseS2: string;
}

const KEYS: Record<Name, keyof ProcessSettings> = { u_1: 'driftU1', u_2: 'driftU2', s_1: 'noiseS1', s_2: 'noiseS2' };
const NAMES: readonly Name[] = ['u_1', 'u_2', 's_1', 's_2'];

/**
 * The "Drift & noise" window: turns the overdamped Langevin equation into a general SDE with
 * diagonal noise,
 *
 *     dX_t = (−∇Ψ + u)(t, X_t) dt + diag(s₁, s₂)(t, X_t) dW_t ,
 *
 * with an extra (e.g. non-gradient) drift u = (u₁, u₂) and noise coefficients s₁, s₂ typed in
 * LaTeX (functions of t, x, y and σ; their derivatives for Milstein are derived symbolically).
 * Each part is switched on separately; off, u = 0 and s₁ = s₂ = σ.
 *
 * Like the potential window, the formula engine is loaded when the window is first opened or a
 * formula is first needed (e.g. by a scenario), and `pending` holds the simulation until the
 * formulas in the state are compiled, so it never runs with the wrong process. The window also
 * tells which analysis tools apply: the Gibbs measure is only known for the Langevin case.
 */
export class ProcessPanel {
  private readonly kind = byId('process-kind');
  private readonly info = byId('process-info');
  private readonly driftToggle = byId<HTMLInputElement>('proc-drift');
  private readonly noiseToggle = byId<HTMLInputElement>('proc-noise');
  private readonly inputs: Record<Name, FormulaInput>;
  private readonly panel: CollapsiblePanel;
  private parser: TexParser | null = null;
  private loadStarted = false;
  private loadFailed = false;
  private mathLoaded = false;
  /** Compiled formulas by name and LaTeX (the ones in use, and recent ones). */
  private readonly compiled = new Map<string, CompiledPotential>();
  /** The pairs handed out by `pair`, so the same formulas give the same object. */
  private readonly pairs = new Map<string, Pair>();
  /** The parts given to the simulation (null: off). */
  private active: { drift: Pair | null; noise: Pair | null } = { drift: null, noise: null };

  constructor(
    private readonly actions: {
      settings(): ProcessSettings;
      set(change: Partial<ProcessSettings>): void;
      /** Gives the simulation its extra drift and noise (null: u = 0, resp. s = σ). */
      apply(drift: Pair | null, noise: Pair | null): void;
      /** What is known about the process now (after `apply`). */
      capabilities(): ProcessCapabilities;
    },
  ) {
    const input = (name: Name) =>
      new FormulaInput(byId(`proc-${name.replace('_', '')}-field`), `${name}(t,x,y) = `, {
        tryUse: (tex) => {
          const r = this.parser!.parseCoefficient(tex, name);
          if (!r.ok) return r.message;
          this.remember(name, tex, r.potential);
          return null;
        },
        committed: (tex) => this.actions.set({ [KEYS[name]]: tex }), // → sync() applies it
      });
    this.inputs = { u_1: input('u_1'), u_2: input('u_2'), s_1: input('s_1'), s_2: input('s_2') };
    this.panel = new CollapsiblePanel({ section: 'process', toggle: 'process-toggle', body: 'process-body' }, (open) => {
      if (!open) return;
      this.load();
      for (const name of NAMES) this.inputs[name].loadPreview();
      this.loadMath();
    });
    this.driftToggle.addEventListener('change', () => this.actions.set({ extraDrift: this.driftToggle.checked }));
    this.noiseToggle.addEventListener('change', () => this.actions.set({ noiseFormula: this.noiseToggle.checked }));
    // Examples set both components at once (and switch the part on).
    for (const b of document.querySelectorAll<HTMLButtonElement>('#process-body button[data-part]')) {
      b.addEventListener('click', () => {
        const first = b.dataset.first ?? '';
        const second = b.dataset.second ?? '';
        if (b.dataset.part === 'drift') this.actions.set({ extraDrift: true, driftU1: first, driftU2: second });
        else this.actions.set({ noiseFormula: true, noiseS1: first, noiseS2: second });
      });
    }
    const s = actions.settings();
    for (const name of NAMES) this.inputs[name].input.value = s[KEYS[name]] as string;
    this.panel.setOpen(false);
    this.sync();
  }

  get open(): boolean {
    return this.panel.open;
  }

  setOpen(open: boolean): void {
    this.panel.setOpen(open);
  }

  /** A part is switched on but its formulas are not compiled yet: the simulation must wait. */
  get pending(): boolean {
    const s = this.actions.settings();
    return (s.extraDrift && !this.pair(s, 'u_1', 'u_2')) || (s.noiseFormula && !this.pair(s, 's_1', 's_2'));
  }

  /** Brings the window and the simulation in line with the state. */
  sync(): void {
    const s = this.actions.settings();
    this.driftToggle.checked = s.extraDrift;
    this.noiseToggle.checked = s.noiseFormula;
    if (s.extraDrift || s.noiseFormula) this.load();
    for (const name of NAMES) this.inputs[name].setValue(s[KEYS[name]] as string);
    const drift = s.extraDrift ? this.pair(s, 'u_1', 'u_2') : null;
    const noise = s.noiseFormula ? this.pair(s, 's_1', 's_2') : null;
    // Still compiling (or invalid): keep the old process, `pending` holds the simulation.
    if (drift !== undefined && noise !== undefined) {
      if (drift !== this.active.drift || noise !== this.active.noise) {
        this.active = { drift, noise };
        this.actions.apply(drift, noise);
      }
    }
    this.showInfo();
  }

  private pair(s: ProcessSettings, a: Name, b: Name): Pair | undefined {
    const first = this.compiled.get(`${a}|${s[KEYS[a]]}`);
    const second = this.compiled.get(`${b}|${s[KEYS[b]]}`);
    if (!first || !second) return undefined;
    // The same objects as long as the formulas are the same (so `sync` notices real changes).
    const key = `${a}${b}`;
    const cached = this.pairs.get(key);
    if (cached && cached[0] === first && cached[1] === second) return cached;
    const p: Pair = [first, second];
    this.pairs.set(key, p);
    return p;
  }

  private remember(name: Name, tex: string, c: CompiledPotential): void {
    this.compiled.set(`${name}|${tex}`, c);
    if (this.compiled.size > 32) this.compiled.delete(this.compiled.keys().next().value!);
  }

  private load(): void {
    if (this.loadStarted) return;
    this.loadStarted = true;
    loadTexParser()
      .then((parser) => {
        this.parser = parser;
        const s = this.actions.settings();
        for (const name of NAMES) {
          const tex = s[KEYS[name]] as string;
          const input = this.inputs[name];
          // A formula typed while the engine was loading counts as entered; else the state's.
          const typed = input.input.value.trim();
          if (typed !== tex) input.setReady();
          else input.setReady(tex);
          if (!this.compiled.has(`${name}|${tex}`)) {
            const r = parser.parseCoefficient(tex, name);
            if (r.ok) this.remember(name, tex, r.potential);
            else input.showError(r.message);
          }
        }
        this.sync();
      })
      .catch((err) => {
        console.error(err);
        this.loadFailed = true;
        this.showInfo();
      });
  }

  /** Typesets the window's equation (KaTeX, loaded on first opening). */
  private loadMath(): void {
    if (this.mathLoaded) return;
    this.mathLoaded = true;
    import('./helpMath')
      .then((m) => m.renderMath(byId('process-body'), '.tex[data-tex]'))
      .catch((err) => console.error(err)); // the plain-text equation stays
  }

  private showInfo(): void {
    const s = this.actions.settings();
    const general = s.extraDrift || s.noiseFormula;
    this.kind.textContent = general ? 'general' : 'Langevin';
    if (this.loadFailed) {
      this.info.textContent = 'The formula engine could not be loaded. Check the connection and reload.';
      return;
    }
    if (this.pending) {
      this.info.textContent = this.parser
        ? 'A formula is not valid: the simulation waits.'
        : 'Loading the formula engine… (the simulation waits)';
      return;
    }
    const caps = this.actions.capabilities();
    const parts: string[] = [];
    parts.push(
      caps.gibbs
        ? 'Overdamped Langevin: the invariant measure is the Gibbs measure π ∝ e^(−2Ψ/σ²), so KL to π and ∫ f dπ are available.'
        : 'No closed-form invariant measure: KL to π and the exact ∫ f dπ are off.',
    );
    if (s.noiseFormula) {
      parts.push(
        caps.additiveNoise
          ? 'Additive noise: Milstein coincides with Euler–Maruyama.'
          : caps.diagonalNoise
            ? 'Diagonal noise (s₁ = s₁(t, x), s₂ = s₂(t, y)): Milstein has strong order 1.'
            : 's₁ depends on y or s₂ on x: Milstein drops the Lévy-area terms (strong order ½ only).',
      );
    }
    this.info.textContent = parts.join(' ');
  }
}
