import type { StateComponent } from './component';

/** A (partial) snapshot of the whole application: component key → that component's snapshot. */
export type Snapshot = Record<string, unknown>;

/**
 * Registry of all persistent state. Captures and applies whole or partial snapshots through the
 * components, in their declared order, and provides a fingerprint that changes whenever the user
 * alters anything tracked (used to leave playback mode).
 */
export class Session {
  private readonly components: StateComponent<unknown>[] = [];

  register<T>(component: StateComponent<T>): this {
    if (this.components.some((c) => c.key === component.key)) {
      throw new Error(`Duplicate state component "${component.key}"`);
    }
    this.components.push(component as StateComponent<unknown>);
    this.components.sort((a, b) => a.order - b.order);
    return this;
  }

  get keys(): string[] {
    return this.components.map((c) => c.key);
  }

  /** Captures the given components (default: all). */
  capture(keys?: readonly string[]): Snapshot {
    const out: Snapshot = {};
    for (const c of this.components) if (!keys || keys.includes(c.key)) out[c.key] = c.capture();
    return out;
  }

  /** Applies every component present in the snapshot, in component order. Unknown keys are ignored. */
  apply(snapshot: Snapshot): void {
    for (const c of this.components) if (c.key in snapshot) c.apply(snapshot[c.key]);
  }

  /** Changes whenever a tracked component changes. */
  fingerprint(): string {
    let s = '';
    for (const c of this.components) if (c.tracksChanges) s += `${c.key}:${c.revision()};`;
    return s;
  }
}
