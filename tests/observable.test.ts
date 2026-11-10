import { beforeAll, describe, expect, it } from 'vitest';
import { EquilibriumMonitor } from '../src/analysis/equilibrium';
import { loadTexParser, type TexParser } from '../src/analysis/latex';
import { exactExpectation, ObservableMonitor } from '../src/analysis/observable';
import { MAX_POINTS, TimeSeries } from '../src/analysis/timeSeries';
import { PotentialField } from '../src/sim/field';
import { ParticleSystem } from '../src/sim/particles';
import { Rng } from '../src/sim/rng';

let parser: TexParser;
beforeAll(async () => {
  parser = await loadTexParser();
});

/** A potential given as a function, in the form the analysis code takes. */
function sampler(sample: (x: number, y: number) => number) {
  return {
    sample,
    samplePoints(xs: Float64Array, ys: Float64Array, n: number, out: Float64Array) {
      for (let i = 0; i < n; i++) out[i] = sample(xs[i], ys[i]);
    },
  };
}

function compile(tex: string) {
  const r = parser.parse(tex);
  if (!r.ok) throw new Error(r.message);
  return r.fn;
}

describe('exact Gibbs expectation', () => {
  const grid = { x0: -5, y0: -5, cell: 10 / 64, nx: 64, ny: 64 };

  it('matches closed forms for a Gaussian Gibbs measure', () => {
    // Ψ = (x² + y²)/2 and σ = 1 give π ∝ exp(−x² − y²): N(0, ½ I).
    const field = sampler((x: number, y: number) => (x * x + y * y) / 2);
    const ctx = { sigma: 1, psi: field.sample };
    expect(exactExpectation(grid, compile('x^2'), field, ctx)).toBeCloseTo(0.5, 4);
    expect(exactExpectation(grid, compile('x^2 + y^2'), field, ctx)).toBeCloseTo(1, 4);
    expect(exactExpectation(grid, compile('x'), field, ctx)).toBeCloseTo(0, 10);
    expect(exactExpectation(grid, compile('\\mathbf{1}_{x>0}'), field, ctx)).toBeCloseTo(0.5, 10);
    expect(exactExpectation(grid, compile('\\cos x'), field, ctx)).toBeCloseTo(Math.exp(-0.25), 4);
    // E[Ψ] = 1/2 for this π (equipartition: σ²/4 per dimension).
    expect(exactExpectation(grid, compile('\\Psi'), field, ctx)).toBeCloseTo(0.5, 4);
  });

  it('is uniform on the box where Ψ is flat, and undefined for σ = 0', () => {
    const field = sampler(() => 0);
    const box = { x0: -1, y0: -1, cell: 2 / 100, nx: 100, ny: 100 };
    expect(exactExpectation(box, compile('x^2'), field, { sigma: 0.5, psi: field.sample })).toBeCloseTo(1 / 3, 4);
    expect(exactExpectation(box, compile('x'), field, { sigma: 0, psi: field.sample })).toBeNaN();
    expect(exactExpectation(box, compile('\\ln x'), field, { sigma: 1, psi: field.sample })).toBeNaN();
  });
});

describe('ObservableMonitor', () => {
  function setup() {
    const field = new PotentialField({ cellSize: 0.04, cap: 5 });
    const ps = new ParticleSystem(new Rng(1));
    const kl = new EquilibriumMonitor(field, ps);
    kl.setBox({ x0: -1, y0: -1, x1: 1, y1: 1 });
    const obs = new ObservableMonitor(field, ps, kl);
    obs.enabled = true;
    return { field, ps, kl, obs };
  }

  it('estimates the mean with a 95 % interval over the particles in the box', () => {
    const { ps, obs } = setup();
    const xs = [-0.5, -0.2, 0.1, 0.4, 0.6];
    for (const x of xs) ps.add(x, 0, 0);
    ps.add(3, 3, 0); // outside the box: ignored
    obs.setFunction(compile('x'));
    expect(obs.update(0, 1, 0.09)).toBe(true);
    const s = obs.latest!;
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1));
    expect(s.inside).toBe(5);
    expect(s.total).toBe(6);
    expect(s.mean).toBeCloseTo(mean, 12);
    expect(s.ci).toBeCloseTo((1.959963984540054 * sd) / Math.sqrt(5), 12);
    expect(s.exact).toBeCloseTo(0, 6); // flat Ψ: uniform on the box
    expect(obs.series.length).toBe(1);
  });

  it('recomputes the exact value at a limited rate while Ψ is edited, then catches up', () => {
    const { field, ps, obs } = setup();
    ps.add(0.2, 0.1, 0);
    obs.setFunction(compile('x'));
    obs.update(0, 1, 0.09);
    const flat = obs.latest!.exact;
    expect(obs.latest!.exactStale).toBe(false);

    // A brush stroke right after: the exact value is kept for now and flagged.
    field.applyBrush(0.5, 0, -3, 0.3);
    expect(obs.update(100, 1, 0.09)).toBe(true);
    expect(obs.latest!.exactStale).toBe(true);
    expect(obs.latest!.exact).toBe(flat);

    // Ψ has settled: a later update (nothing else changed) recomputes it.
    let now = 100;
    while (obs.latest!.exactStale && now < 10_000) {
      now += 100;
      obs.update(now, 1, 0.09);
    }
    expect(obs.latest!.exactStale).toBe(false);
    expect(obs.latest!.exact).toBeGreaterThan(flat + 0.1); // the new well at x = 0.5 pulls π right
    expect(now).toBeLessThanOrEqual(1000);
    expect(obs.update(now + 100, 1, 0.09)).toBe(false); // up to date: no more work

    // A new σ or f is never delayed.
    field.applyBrush(-0.5, 0, -3, 0.3);
    obs.update(now + 200, 1.3, 0.09);
    expect(obs.latest!.exactStale).toBe(false);
  });

  it('skips points where f is undefined and does no work when nothing changed', () => {
    const { ps, obs } = setup();
    ps.add(0, 0, 0);
    ps.add(0.5, 0, 0);
    obs.setFunction(compile('\\frac{1}{x}'));
    obs.update(0, 1, 0.09);
    expect(obs.latest!.undefinedAt).toBe(1);
    expect(obs.latest!.mean).toBe(2);
    expect(obs.latest!.ci).toBeNaN();
    expect(obs.update(500, 1, 0.09)).toBe(false); // same inputs
    obs.setFunction(null);
    expect(obs.active).toBe(false);
    expect(obs.update(1000, 1, 0.09)).toBe(false);
  });

  it('converges to the exact value for samples from π', () => {
    const { ps, obs } = setup();
    // Flat Ψ: π_B is uniform on [-1, 1]², so uniform samples have E[x² + y²] = 2/3.
    const rng = new Rng(7);
    for (let i = 0; i < 4000; i++) ps.add(rng.float() * 2 - 1, rng.float() * 2 - 1, 0);
    obs.setFunction(compile('x^2 + y^2'));
    obs.update(0, 0.8, 0.09);
    const s = obs.latest!;
    expect(s.exact).toBeCloseTo(2 / 3, 4);
    expect(Math.abs(s.mean - s.exact)).toBeLessThan(s.ci * 1.5);
    expect(s.ci).toBeLessThan(0.02);
  });
});

describe('TimeSeries', () => {
  it('replaces the last point when time does not advance and stays bounded', () => {
    const ts = new TimeSeries(['a', 'b'] as const);
    ts.push(0, { a: 1, b: 2 });
    ts.push(0, { a: 3, b: 4 });
    expect(ts.length).toBe(1);
    expect(ts.channels.a[0]).toBe(3);
    for (let k = 1; k <= 3 * MAX_POINTS; k++) ts.push(k, { a: k, b: -k });
    expect(ts.length).toBeLessThanOrEqual(MAX_POINTS);
    expect(ts.times[0]).toBe(0);
    expect(ts.channels.b[ts.length - 1]).toBe(-ts.times[ts.length - 1]);
  });
});
