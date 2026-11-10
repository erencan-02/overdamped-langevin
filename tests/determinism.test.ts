import { describe, expect, it } from 'vitest';
import { PotentialField } from '../src/sim/field';
import { ParticleSystem } from '../src/sim/particles';
import { RandomStreams } from '../src/sim/random';
import { Rng } from '../src/sim/rng';

function makeRun(seed: number) {
  const field = new PotentialField({ cellSize: 0.04, cap: 5 });
  field.applyBrush(0, 0, -3, 0.8);
  const streams = new RandomStreams(seed);
  const ps = new ParticleSystem(streams.get('dynamics'));
  for (let i = 0; i < 50; i++) ps.add((i % 10) * 0.2 - 1, Math.floor(i / 10) * 0.2 - 0.5, i % 12);
  return { field, ps, streams };
}

describe('reproducibility', () => {
  it('does not depend on how simulated time is split into frames', () => {
    const a = makeRun(0);
    const b = makeRun(0);
    // Same total time (1 s), very different "frame rates".
    for (let k = 0; k < 60; k++) a.ps.advance(a.field, 1 / 60, 0.7);
    const chunks = [0.013, 0.1, 0.0005, 0.25, 0.3365, 0.3];
    for (const t of chunks) b.ps.advance(b.field, t, 0.7);
    expect(a.ps.time).toBeCloseTo(b.ps.time, 12);
    for (let i = 0; i < a.ps.count; i++) {
      expect(a.ps.x[i]).toBe(b.ps.x[i]);
      expect(a.ps.y[i]).toBe(b.ps.y[i]);
    }
  });

  it('is fully determined by the seed', () => {
    const a = makeRun(42);
    const b = makeRun(42);
    const c = makeRun(43);
    for (const r of [a, b, c]) r.ps.advance(r.field, 0.5, 0.7);
    expect(Array.from(a.ps.x.subarray(0, 50))).toEqual(Array.from(b.ps.x.subarray(0, 50)));
    expect(a.ps.x[0]).not.toBe(c.ps.x[0]);
  });

  it('reseeding restarts every stream, and streams are independent', () => {
    const s = new RandomStreams(7);
    const first = [s.get('dynamics').float(), s.get('colors').float()];
    s.get('colors').float(); // extra draws in one stream...
    s.reseed(7);
    expect([s.get('dynamics').float(), s.get('colors').float()]).toEqual(first);
    expect(first[0]).not.toBe(first[1]);
    expect(s.seed).toBe(7);
  });

  it('continues exactly from a saved generator state', () => {
    const r = new Rng(5);
    for (let i = 0; i < 10; i++) r.normal();
    const state = r.getState();
    const expected = [r.normal(), r.normal(), r.float()];
    const r2 = new Rng(999);
    r2.setState(state);
    expect([r2.normal(), r2.normal(), r2.float()]).toEqual(expected);
  });
});
