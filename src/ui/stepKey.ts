/** A press shorter than this is a single step; holding the key longer plays. */
export const HOLD_DELAY_MS = 350;

export interface StepKeyHooks {
  /** One step (on every press). */
  step(): void;
  /** The key is still held after HOLD_DELAY_MS: start playing. */
  startHold(): void;
  /** The held key was released: stop playing. */
  endHold(): void;
}

/**
 * Frame-advance key (→): a press takes exactly one step; keeping it held plays the simulation
 * until it is released, like holding the step button of a video player. The hold is timed here
 * rather than taken from the keyboard's auto-repeat, so it behaves the same whatever the
 * system's repeat delay and rate are.
 */
export class StepKey {
  private down = false;
  private holding = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly hooks: StepKeyHooks,
    private readonly delayMs = HOLD_DELAY_MS,
  ) {}

  /** The key is held and playing. */
  get isHolding(): boolean {
    return this.holding;
  }

  /** Key down (repeated key-down events while it is held are ignored). */
  press(): void {
    if (this.down) return;
    this.down = true;
    this.hooks.step();
    this.timer = setTimeout(() => {
      if (!this.down) return;
      this.holding = true;
      this.hooks.startHold();
    }, this.delayMs);
  }

  /** Key up, or anything that ends the hold (the window losing focus). */
  release(): void {
    if (!this.down) return;
    this.down = false;
    clearTimeout(this.timer);
    if (this.holding) {
      this.holding = false;
      this.hooks.endHold();
    }
  }
}
