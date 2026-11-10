/**
 * A piece of application state that can be captured into a plain snapshot and restored from
 * one. The session (session.ts) combines all components, so a whole configuration (settings,
 * particles, Ψ, view, …) can be saved, loaded or replayed through one interface.
 *
 * To make something new persistent, subclass StateComponent (or SettingsGroup for scalar
 * settings) and register it with the session; recordings and playback pick it up automatically.
 */
export abstract class StateComponent<T> {
  /** Unique key of this component in a snapshot. */
  abstract readonly key: string;

  /**
   * Components are applied in ascending order. Settings that change how others are interpreted
   * (e.g. the seed, which resets the random streams) come first, data (Ψ, particles) later.
   */
  readonly order: number = 50;

  /**
   * Whether a change of this component counts as the user altering the simulation (used to
   * leave playback mode). Pure viewing state such as the camera does not.
   */
  readonly tracksChanges: boolean = true;

  /** Returns a snapshot of the current state (must not alias live, mutable buffers). */
  abstract capture(): T;

  /** Restores the state from a snapshot. Implementations validate untrusted input. */
  abstract apply(value: T): void;

  /**
   * A cheap token that changes whenever the state changes. The default serialises the capture,
   * which is fine for small state; large components override it with a version counter.
   */
  revision(): string {
    return JSON.stringify(this.capture());
  }
}
