import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOLD_DELAY_MS, StepKey } from '../src/ui/stepKey';
import { PotentialField } from '../src/sim/field';
import { DEFAULT_DT_MAX, ParticleSystem } from '../src/sim/particles';
import { Rng } from '../src/sim/rng';

describe('StepKey (→)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup() {
    const events: string[] = [];
    const key = new StepKey({
      step: () => events.push('step'),
      startHold: () => events.push('play'),
      endHold: () => events.push('pause'),
    });
    return { key, events };
  }

  it('a tap takes one step and does not start playing', () => {
    const { key, events } = setup();
    key.press();
    vi.advanceTimersByTime(HOLD_DELAY_MS - 50);
    key.release();
    vi.advanceTimersByTime(1000);
    expect(events).toEqual(['step']);
  });

  it('holding plays until release; auto-repeat key-downs are ignored', () => {
    const { key, events } = setup();
    key.press();
    for (let k = 0; k < 10; k++) {
      vi.advanceTimersByTime(40);
      key.press(); // keyboard auto-repeat
    }
    vi.advanceTimersByTime(HOLD_DELAY_MS);
    expect(key.isHolding).toBe(true);
    key.release();
    expect(events).toEqual(['step', 'play', 'pause']);
    key.press();
    key.release();
    expect(events).toEqual(['step', 'play', 'pause', 'step']);
  });
});

describe('a single step', () => {
  it('advances the simulation by exactly one integrator step', () => {
    const field = new PotentialField({ cellSize: 0.04, cap: 5 });
    field.applyBrush(0, 0, -3, 0.6);
    const a = new ParticleSystem(new Rng(4));
    const b = new ParticleSystem(new Rng(4));
    for (const ps of [a, b]) for (let i = 0; i < 5; i++) ps.add(i * 0.1, 0, 0);
    a.advance(field, DEFAULT_DT_MAX, 0.7);
    b.step(field, DEFAULT_DT_MAX, 0.7);
    expect(a.time).toBeCloseTo(DEFAULT_DT_MAX, 15);
    expect(a.lastSubsteps).toBe(1);
    for (let i = 0; i < 5; i++) expect(a.x[i]).toBe(b.x[i]);
  });
});
