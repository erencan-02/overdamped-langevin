import { MAX_PARTICLES, type ParticleSystem, type StepEvents } from './particles';
import type { Rng } from './rng';

/** What happened, for recordings (lineage) and statistics. */
export interface BirthDeathHooks {
  /** Particle `parent` gave birth to particle `child` (at the parent's position) at time t. */
  birth?(t: number, parent: number, child: number): void;
  /** Particle `id` died at time t. */
  death?(t: number, id: number): void;
}

/**
 * Births and deaths of particles (a linear birth–death process on top of the diffusion).
 *
 * Every particle carries two independent exponential clocks: the time to its next birth, with
 * rate λ, and the time of its death, with rate μ. When the birth clock rings the particle gets a
 * child at its current position (with the same colour, and fresh clocks), and the birth clock is
 * wound up again; when the death clock rings the particle is removed. So the number of
 * particles grows on average like N₀·e^{(λ−μ)t}, and each particle lives Exp(μ)-long.
 *
 * Clocks are checked after every integrator step, so events happen at the end of the step of
 * length Δt in which they fall (an error of at most Δt in their timing). Clocks are kept as
 * absolute simulated times in the particle system (they move with their particles); a particle
 * without clocks (just added, restored, …) gets them at the next step. Because exponential
 * clocks are memoryless, changing a rate simply rewinds all clocks with the new rate.
 *
 * The clocks draw from their own random stream, so births and deaths never change the Brownian
 * noise, and with the same seed and actions a run is reproduced exactly. Births and deaths are
 * part of the simulation, not edits, so undo never reverts them.
 */
export class BirthDeath implements StepEvents {
  private enabled = false;
  private birthRate = 0;
  private deathRate = 0;
  /** Clocks must be wound up again (rates changed or the process was switched on). */
  private rewind = true;
  /** Counters since the last `resetCounts`. */
  births = 0;
  deaths = 0;
  /** Births that did not happen because the particle limit was reached. */
  blocked = 0;

  constructor(
    private readonly rng: Rng,
    private readonly hooks: BirthDeathHooks = {},
  ) {}

  get active(): boolean {
    return this.enabled;
  }

  get rates(): { birth: number; death: number } {
    return { birth: this.birthRate, death: this.deathRate };
  }

  /** Switches the process on or off and sets the rates λ (birth) and μ (death) per unit time. */
  configure(enabled: boolean, birthRate: number, deathRate: number): void {
    if (enabled === this.enabled && birthRate === this.birthRate && deathRate === this.deathRate) return;
    this.enabled = enabled;
    this.birthRate = Math.max(0, birthRate);
    this.deathRate = Math.max(0, deathRate);
    this.rewind = true;
  }

  resetCounts(): void {
    this.births = 0;
    this.deaths = 0;
    this.blocked = 0;
  }

  afterStep(ps: ParticleSystem, t: number): void {
    if (!this.enabled) return;
    if (this.rewind) {
      ps.birthAt.fill(Number.NaN, 0, ps.count);
      ps.deathAt.fill(Number.NaN, 0, ps.count);
      this.rewind = false;
    }
    ps.untracked(() => {
      // Particles are visited in index order; a death moves the last particle into slot i, which
      // is then visited too, and children are appended, so they are visited in this step as well.
      let i = 0;
      while (i < ps.count) {
        if (Number.isNaN(ps.birthAt[i])) ps.birthAt[i] = t + this.wait(this.birthRate);
        if (Number.isNaN(ps.deathAt[i])) ps.deathAt[i] = t + this.wait(this.deathRate);
        const birth = ps.birthAt[i];
        const death = ps.deathAt[i];
        if (death <= t && death <= birth) {
          const id = ps.id[i];
          ps.removeAt(i);
          this.deaths++;
          this.hooks.death?.(death, id);
          continue; // slot i now holds another particle
        }
        if (birth <= t) {
          // The clock is wound up again from the moment it rang (several births per step are possible).
          ps.birthAt[i] = birth + this.wait(this.birthRate);
          if (ps.count < MAX_PARTICLES && ps.add(ps.x[i], ps.y[i], ps.color[i])) {
            const c = ps.count - 1;
            // The child's own clocks start at its birth.
            ps.birthAt[c] = birth + this.wait(this.birthRate);
            ps.deathAt[c] = birth + this.wait(this.deathRate);
            this.births++;
            this.hooks.birth?.(birth, ps.id[i], ps.id[c]);
          } else {
            this.blocked++;
          }
          continue; // check particle i again: another event may fall in this step
        }
        i++;
      }
    });
  }

  /** An exponential waiting time with the given rate (∞ for rate 0). */
  private wait(rate: number): number {
    if (!(rate > 0)) return Number.POSITIVE_INFINITY;
    return -Math.log(1 - this.rng.float()) / rate; // 1 − U ∈ (0, 1]
  }
}
