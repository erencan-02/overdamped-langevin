import { describe, expect, it } from 'vitest';
import { runSweep, slope } from '../src/analysis/stepSweep';
import { TimeSeries } from '../src/analysis/timeSeries';
import { chainSteps, type Instrument, InstrumentRegistry } from '../src/instruments/instrument';
import { BranchingReplicas, populationMoments, transition } from '../src/sim/branching';
import { ParticleSystem } from '../src/sim/particles';
import { type Coefficient, langevin, Sde } from '../src/sim/process';
import { Rng } from '../src/sim/rng';

describe('independent runs of the birth–death process', () => {
  it('uses a transition law with the right mean', () => {
    for (const [l, m] of [
      [1.2, 0.4],
      [0.3, 0.9],
      [0.7, 0.7],
      [0, 0.5],
      [0.5, 0],
    ]) {
      const d = 0.8;
      const { alpha, beta } = transition(d, l, m);
      // E[descendants] = (1 − α) / (1 − β) = e^{(λ−μ)Δ}
      expect((1 - alpha) / (1 - beta)).toBeCloseTo(Math.exp((l - m) * d), 10);
    }
  });

  it('matches the exact mean and variance of N(t), in one step or many', () => {
    const lambda = 0.9;
    const mu = 0.4;
    const t = 1.5;
    const exact = populationMoments(50, t, lambda, mu);
    for (const steps of [1, 30]) {
      const runs = new BranchingReplicas(new Rng(steps), 4000);
      runs.start(50);
      for (let k = 0; k < steps; k++) runs.advance(t / steps, lambda, mu);
      const s = runs.stats();
      expect(Math.abs(s.mean - exact.mean) / exact.mean).toBeLessThan(0.02);
      expect(Math.abs(s.sd ** 2 - exact.variance) / exact.variance).toBeLessThan(0.08);
      expect(s.lo).toBeLessThan(s.mean);
      expect(s.hi).toBeGreaterThan(s.mean);
    }
  });

  it('is critical for λ = μ (variance 2N₀λt) and respects the cap', () => {
    const runs = new BranchingReplicas(new Rng(3), 4000);
    runs.start(20);
    runs.advance(2, 0.5, 0.5);
    const s = runs.stats();
    const exact = populationMoments(20, 2, 0.5, 0.5);
    expect(Math.abs(s.mean - 20) / 20).toBeLessThan(0.04);
    expect(Math.abs(s.sd ** 2 - exact.variance) / exact.variance).toBeLessThan(0.1);
    const capped = new BranchingReplicas(new Rng(4), 50);
    capped.start(100);
    capped.advance(3, 2, 0, 150);
    expect(Math.max(...capped.counts)).toBe(150);
  });
});

/** c(x, y) = f with gradient, written out (for a process without the formula engine). */
function coef(variables: string[], f: (x: number, y: number) => number, fx = () => 0, fy = () => 0): Coefficient {
  return {
    variables: new Set(variables),
    timeDependent: false,
    usesSigma: false,
    value(xs, ys, n, _t, _s, out) {
      for (let i = 0; i < n; i++) out[i] = f(xs[i], ys[i]);
    },
    gradient(_xs, _ys, n, _t, _s, gx, gy) {
      for (let i = 0; i < n; i++) {
        gx[i] = fx();
        gy[i] = fy();
      }
    },
  };
}

describe('the Δt sweep', () => {
  const levels = [3, 4, 5, 6, 7];
  const start = (M: number) => ({ x0: new Float64Array(M).fill(1), y0: new Float64Array(M).fill(-0.5) });

  it('measures the orders in the drift for a deterministic problem (EM 1, Heun 2)', async () => {
    // dX = −X dt: no noise, so the errors are those of the ODE solvers.
    const field = { gradient: (x: number, y: number, out: Float64Array) => ((out[0] = x), (out[1] = y)) };
    const r = await runSweep({
      process: langevin(field, 0),
      ...start(4),
      t0: 0,
      T: 1,
      levels,
      refLevel: 11,
      schemes: ['euler-maruyama', 'heun'],
      rng: new Rng(1),
    });
    const [em, heun] = r.schemes;
    expect(em.strongOrder).toBeGreaterThan(0.9);
    expect(em.strongOrder).toBeLessThan(1.1);
    expect(heun.strongOrder).toBeGreaterThan(1.85);
    expect(heun.strongOrder).toBeLessThan(2.15);
    expect(r.dts).toEqual(levels.map((l) => 2 ** -l));
  });

  it('measures strong order ½ (EM) and 1 (Milstein) for multiplicative noise', async () => {
    const p = new Sde();
    p.extraDrift = [coef(['x'], (x) => 0.3 * x), coef(['y'], (_x, y) => 0.3 * y)];
    p.noise = [coef(['x'], (x) => 0.7 * x, () => 0.7), coef(['y'], (_x, y) => 0.7 * y, undefined, () => 0.7)];
    const r = await runSweep({
      process: p,
      ...start(1500),
      t0: 0,
      T: 1,
      levels,
      refLevel: 11,
      schemes: ['euler-maruyama', 'milstein'],
      rng: new Rng(2),
    });
    const [em, milstein] = r.schemes;
    expect(em.strongOrder).toBeGreaterThan(0.35);
    expect(em.strongOrder).toBeLessThan(0.7);
    expect(milstein.strongOrder).toBeGreaterThan(0.85);
    expect(milstein.strongOrder).toBeLessThan(1.2);
  });

  it('fits slopes on log–log axes', () => {
    expect(slope([0.1, 0.05, 0.025], [0.2, 0.05, 0.0125])).toBeCloseTo(2, 10);
    expect(slope([0.1, 0.05], [0, 0])).toBeNaN();
  });
});

describe('the instrument registry', () => {
  const make = (id: string, active: boolean, log: string[]): Instrument => ({
    id,
    title: id,
    active,
    series: new TimeSeries(['v'] as const),
    onStep: (_ps, t) => log.push(`${id}@${t}`),
    onFrame: () => log.push(`${id} frame`),
    readout: () => ({ value: id.length }),
    reset: () => log.push(`${id} reset`),
  });

  it('steps only active instruments, frames all, and names readouts by instrument', () => {
    const log: string[] = [];
    const reg = new InstrumentRegistry();
    reg.register(make('a', true, log));
    reg.register(make('bb', false, log));
    expect(() => reg.register(make('a', true, log))).toThrow();
    const ps = new ParticleSystem(new Rng(1));
    ps.add(0, 0, 0);
    const births: number[] = [];
    ps.events = chainSteps({ afterStep: (_p, t) => births.push(t) }, reg);
    ps.advance(langevin(null, 0.5), 0.004);
    expect(births).toEqual([0.002, 0.004]);
    expect(log).toEqual(['a@0.002', 'a@0.004']);
    reg.frame({} as never);
    expect(log.slice(2)).toEqual(['a frame', 'bb frame']);
    expect(reg.readouts()).toEqual({ 'a.value': 1, 'bb.value': 2 });
    reg.resetAll();
    expect(log.slice(4)).toEqual(['a reset', 'bb reset']);
  });
});
