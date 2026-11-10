import type { PotentialEdit, PotentialField } from './field';
import type { ParticleEdit, ParticleSystem } from './particles';

/** At most this many steps are kept… */
const MAX_STEPS = 200;
/** …and at most this much memory for the Ψ copies (oldest steps are dropped first). */
const MAX_BYTES = 128 * 1024 * 1024;

/** One undoable step: what an action did to Ψ and to the particles. */
interface Step {
  label: string;
  potential: PotentialEdit | null;
  particles: ParticleEdit | null;
  bytes: number;
}

/**
 * Undo and redo for the user's edits of the scene: brush strokes and other changes of Ψ, and
 * particles that were added or removed.
 *
 * An action is wrapped in begin(label) … end() (or run(label, fn)); in between, the field
 * records the chunks it changes and the particle system the particles it adds and removes, so
 * a step stores only what changed. Undo puts the touched chunks of Ψ back and removes or
 * re-adds the particles; the motion of the particles in between is not undone (it is the
 * simulation, not an edit). Wraps nest: only the outermost one makes a step.
 *
 * Changes that are not edits (playback, the live camera) make the steps meaningless; the app
 * calls clear() for them.
 */
export class UndoHistory {
  private readonly undoSteps: Step[] = [];
  private readonly redoSteps: Step[] = [];
  private depth = 0;
  private label = '';
  private bytes = 0;

  constructor(
    private readonly field: PotentialField,
    private readonly particles: ParticleSystem,
  ) {}

  /** An action is being recorded (e.g. a brush stroke in progress). */
  get recording(): boolean {
    return this.depth > 0;
  }

  get canUndo(): boolean {
    return this.undoSteps.length > 0;
  }

  get canRedo(): boolean {
    return this.redoSteps.length > 0;
  }

  begin(label: string): void {
    if (this.depth++ > 0) return;
    this.label = label;
    this.field.beginEdit();
    this.particles.beginEdit();
  }

  end(): void {
    if (this.depth === 0 || --this.depth > 0) return;
    const potential = this.field.endEdit();
    const particles = this.particles.endEdit();
    if (!potential && !particles) return; // nothing changed (e.g. a click on a full system)
    const bytes = (potential?.bytes ?? 0) + 40 * ((particles?.added.length ?? 0) + (particles?.removed.length ?? 0));
    this.undoSteps.push({ label: this.label, potential, particles, bytes });
    this.bytes += bytes;
    for (const s of this.redoSteps) this.bytes -= s.bytes;
    this.redoSteps.length = 0; // a new edit ends the redo branch
    while (this.undoSteps.length > MAX_STEPS || (this.bytes > MAX_BYTES && this.undoSteps.length > 1)) {
      this.bytes -= this.undoSteps.shift()!.bytes;
    }
  }

  /** Records everything `fn` does as one step. */
  run<T>(label: string, fn: () => T): T {
    this.begin(label);
    try {
      return fn();
    } finally {
      this.end();
    }
  }

  /** Undoes the last step; returns its label, or null if there is nothing to undo. */
  undo(): string | null {
    if (this.depth > 0) return null;
    const step = this.undoSteps.pop();
    if (!step) return null;
    if (step.potential) this.field.applyChunks(step.potential.before);
    if (step.particles) {
      this.particles.removeIds(new Set(step.particles.added.map((r) => r.id)));
      this.particles.restore(step.particles.removed);
    }
    this.redoSteps.push(step);
    return step.label;
  }

  /** Redoes the last undone step; returns its label, or null if there is nothing to redo. */
  redo(): string | null {
    if (this.depth > 0) return null;
    const step = this.redoSteps.pop();
    if (!step) return null;
    if (step.potential) this.field.applyChunks(step.potential.after);
    if (step.particles) {
      this.particles.removeIds(new Set(step.particles.removed.map((r) => r.id)));
      this.particles.restore(step.particles.added);
    }
    this.undoSteps.push(step);
    return step.label;
  }

  /** Forgets all steps (and abandons an action being recorded). */
  clear(): void {
    if (this.depth > 0) {
      this.depth = 0;
      this.field.endEdit();
      this.particles.endEdit();
    }
    this.undoSteps.length = 0;
    this.redoSteps.length = 0;
    this.bytes = 0;
  }
}
