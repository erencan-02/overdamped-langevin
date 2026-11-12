import { describe, expect, it } from 'vitest';
import { PotentialField } from '../src/sim/field';
import { ParticleSystem } from '../src/sim/particles';
import { RandomStreams } from '../src/sim/random';
import { SCHEMES } from '../src/sim/schemes';
import { ParticlesComponent, PotentialComponent } from '../src/session/components';
import { BooleanField, EnumField, IntegerField, NumberField } from '../src/session/fields';
import { Session } from '../src/session/session';
import { DisplaySettings, PhysicsSettings } from '../src/session/settings';
import { initialState } from '../src/state';
import { langevin } from '../src/sim/process';

function setup() {
  const state = initialState();
  const random = new RandomStreams(state.seed);
  const field = new PotentialField({ cellSize: 0.04, cap: 5 });
  const ps = new ParticleSystem(random.get('dynamics'));
  let changes = 0;
  const onChange = () => changes++;
  const session = new Session()
    .register(new ParticlesComponent(ps))
    .register(new DisplaySettings(state, onChange))
    .register(new PotentialComponent(field))
    .register(new PhysicsSettings(state, onChange, ps, random));
  return { state, random, field, ps, session, changes: () => changes };
}

describe('fields', () => {
  it('validate and coerce untrusted values', () => {
    expect(new NumberField('a', 0, 3).coerce(7)).toBe(3);
    expect(new NumberField('a', 0, 3).coerce('1.5')).toBe(1.5);
    expect(new NumberField('a').coerce(NaN)).toBeUndefined();
    expect(new IntegerField('a', 0, 10).coerce(2.6)).toBe(3);
    expect(new BooleanField('a').coerce(1)).toBe(true);
    expect(new BooleanField('a').coerce('yes')).toBeUndefined();
    expect(new EnumField('a', ['x', 'y'] as const).coerce('z')).toBeUndefined();
  });
});

describe('Session', () => {
  it('orders components (physics first, data later) and rejects duplicate keys', () => {
    const { session } = setup();
    expect(session.keys).toEqual(['physics', 'display', 'potential', 'particles']);
    expect(() => session.register(new PotentialComponent(new PotentialField({ cellSize: 0.04, cap: 5 })))).toThrow();
  });

  it('applies settings with validation and side effects', () => {
    const { state, ps, random, session, changes } = setup();
    session.apply({ physics: { sigma: 99, scheme: 'euler-maruyama', seed: 5, bogus: 1 }, display: { grid: 'no' } });
    expect(state.sigma).toBe(3); // clamped to the slider range
    expect(state.scheme).toBe('euler-maruyama');
    expect(ps.scheme).toBe(SCHEMES['euler-maruyama']);
    expect(random.seed).toBe(5);
    expect(state.grid).toBe(true); // invalid value ignored
    expect(changes()).toBe(1);
    session.apply({ physics: { sigma: 3 } }); // unchanged → no callback
    expect(changes()).toBe(1);
  });

  it('round-trips particles and Ψ, including the exact integrator state', () => {
    const a = setup();
    a.field.applyBrush(0.3, -0.2, -2, 0.5);
    for (let i = 0; i < 20; i++) a.ps.add(i * 0.05, 0, i % 12);
    a.ps.advance(langevin(a.field, 0.5), 0.123);
    const snap = a.session.capture();

    const b = setup();
    b.session.apply(snap);
    expect(b.ps.count).toBe(20);
    expect(b.ps.time).toBe(a.ps.time);
    expect(b.field.sample(0.3, -0.2)).toBeCloseTo(a.field.sample(0.3, -0.2), 6);
    // Continuing both gives identical trajectories (same positions, clock and random state).
    a.ps.advance(langevin(a.field, 0.5), 0.2);
    b.ps.advance(langevin(b.field, 0.5), 0.2);
    for (let i = 0; i < 20; i++) expect(b.ps.x[i]).toBe(a.ps.x[i]);
  });

  it('fingerprints change when tracked state changes', () => {
    const { session, field, ps, state } = setup();
    const f0 = session.fingerprint();
    expect(session.fingerprint()).toBe(f0);
    field.applyBrush(0, 0, 1, 0.3);
    const f1 = session.fingerprint();
    expect(f1).not.toBe(f0);
    ps.add(0, 0, 0);
    const f2 = session.fingerprint();
    expect(f2).not.toBe(f1);
    state.sigma = 1.7; // physics settings alter the simulation
    const f3 = session.fingerprint();
    expect(f3).not.toBe(f2);
    state.trails = false; // display settings do not
    expect(session.fingerprint()).toBe(f3);
  });
});
