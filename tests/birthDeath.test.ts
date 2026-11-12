import { describe, expect, it } from 'vitest';
import { readNpz } from '../src/record/npzRead';
import { Recorder } from '../src/record/recorder';
import { RecordingTimeline } from '../src/record/timeline';
import { BirthDeath } from '../src/sim/birthDeath';
import { PotentialField } from '../src/sim/field';
import { UndoHistory } from '../src/sim/history';
import { MAX_PARTICLES, ParticleSystem } from '../src/sim/particles';
import { Rng } from '../src/sim/rng';
import { langevin } from '../src/sim/process';

const flat = { gradient: (_x: number, _y: number, out: Float64Array) => out.fill(0) };

function system(n: number, seed = 1, birthRate = 0, deathRate = 0) {
  const ps = new ParticleSystem(new Rng(seed));
  for (let i = 0; i < n; i++) ps.add(i * 0.01, 0, i % 12);
  const events: string[] = [];
  const bd = new BirthDeath(new Rng(seed + 100), {
    birth: (t, p, c) => events.push(`b ${t.toFixed(6)} ${p} ${c}`),
    death: (t, id) => events.push(`d ${t.toFixed(6)} ${id}`),
  });
  bd.configure(true, birthRate, deathRate);
  ps.events = bd;
  return { ps, bd, events };
}

describe('birth–death process', () => {
  it('pure death: the surviving fraction is exp(−μt)', () => {
    const { ps, bd } = system(1600, 3, 0, 0.7);
    ps.advance(langevin(flat, 0), 1);
    const expected = 1600 * Math.exp(-0.7);
    const sd = Math.sqrt(1600 * Math.exp(-0.7) * (1 - Math.exp(-0.7)));
    expect(Math.abs(ps.count - expected)).toBeLessThan(4 * sd);
    expect(bd.deaths).toBe(1600 - ps.count);
    expect(bd.births).toBe(0);
  });

  it('pure birth: the mean grows like exp(λt) (Yule process), children start at their parent', () => {
    // Many independent runs from 20 particles, λ = 0.8 for t = 1: E[N] = 20 e^{0.8}.
    let total = 0;
    const runs = 40;
    for (let r = 0; r < runs; r++) {
      const { ps, events } = system(20, 10 + r, 0.8, 0);
      const positions = new Map<number, [number, number]>();
      for (let i = 0; i < ps.count; i++) positions.set(ps.id[i], [ps.x[i], ps.y[i]]);
      ps.advance(langevin(flat, 0), 1); // σ = 0: nobody moves, so a child sits exactly where its parent is
      total += ps.count;
      for (const e of events) {
        const [, , parent, child] = e.split(' ');
        const p = positions.get(Number(parent))!;
        positions.set(Number(child), p);
        const i = Array.from(ps.id.subarray(0, ps.count)).indexOf(Number(child));
        expect([ps.x[i], ps.y[i]]).toEqual(p);
      }
    }
    const mean = total / runs;
    const expected = 20 * Math.exp(0.8);
    // Var N = 20 e^{λt}(e^{λt} − 1) for a Yule process from 20.
    const sdMean = Math.sqrt((20 * Math.exp(0.8) * (Math.exp(0.8) - 1)) / runs);
    expect(Math.abs(mean - expected)).toBeLessThan(4 * sdMean);
  });

  it('children keep their parent colour; the same seed gives the same history', () => {
    const a = system(50, 7, 1.5, 1);
    const b = system(50, 7, 1.5, 1);
    a.ps.advance(langevin(flat, 0.5), 2);
    b.ps.advance(langevin(flat, 0.5), 2);
    expect(a.events.length).toBeGreaterThan(20);
    expect(b.events).toEqual(a.events);
    expect(Array.from(b.ps.x.subarray(0, b.ps.count))).toEqual(Array.from(a.ps.x.subarray(0, a.ps.count)));
    const colourOf = new Map<number, number>();
    for (let i = 0; i < 50; i++) colourOf.set(i, i % 12);
    for (const e of a.events) {
      const [kind, , parent, child] = e.split(' ');
      if (kind === 'b') colourOf.set(Number(child), colourOf.get(Number(parent))!);
    }
    for (let i = 0; i < a.ps.count; i++) expect(a.ps.color[i]).toBe(colourOf.get(a.ps.id[i]));
  });

  it('does nothing while off or with zero rates, and respects the particle limit', () => {
    const off = system(100, 2, 5, 5);
    off.bd.configure(false, 5, 5);
    off.ps.advance(langevin(flat, 0), 1);
    expect(off.ps.count).toBe(100);
    const zero = system(100, 2, 0, 0);
    zero.ps.advance(langevin(flat, 0), 1);
    expect(zero.ps.count).toBe(100);
    // Near the limit (birth rate 50: a few steps give far more births than there is room for).
    const full = system(MAX_PARTICLES - 5, 4, 50, 0);
    full.ps.advance(langevin(flat, 0), 0.01);
    expect(full.ps.count).toBe(MAX_PARTICLES);
    expect(full.bd.blocked).toBeGreaterThan(0);
  }, 30_000);

  it('is never part of an undo step', () => {
    const field = new PotentialField({ cellSize: 0.04, cap: 5 });
    const { ps } = system(200, 5, 2, 2);
    const history = new UndoHistory(field, ps);
    history.begin('Brush stroke'); // e.g. painting while the simulation runs
    ps.advance(langevin(flat, 0.3), 0.5);
    field.applyBrush(0, 0, 1, 0.5);
    history.end();
    const count = ps.count;
    expect(history.undo()).toBe('Brush stroke'); // only Ψ is restored
    expect(ps.count).toBe(count);
  });
});

describe('recordings with births and deaths', () => {
  it('store the rates per frame and every event, and restore the settings', async () => {
    const field = new PotentialField({ cellSize: 0.04, cap: 5 });
    const { ps, bd } = system(100, 9, 1, 1);
    const rec = new Recorder({
      field,
      particles: ps,
      params: () => ({ sigma: 0.5, speed: 1, kernelVariance: 0.09, scheme: 'heun', seed: 0, playing: true, birthDeath: true, birthRate: 1, deathRate: 1 }),
    });
    const births: number[][] = [];
    const deaths: number[][] = [];
    bd.configure(false, 1, 1);
    const recorded = new BirthDeath(new Rng(77), {
      birth: (t, p, c) => {
        births.push([t, p, c]);
        rec.addBirth(t, p, c);
      },
      death: (t, id) => {
        deaths.push([t, id]);
        rec.addDeath(t, id);
      },
    });
    recorded.configure(true, 1, 1);
    ps.events = recorded;
    rec.start(0, { x0: -1, y0: -1, x1: 1, y1: 1 });
    ps.advance(langevin(flat, 0.5), 0.5);
    rec.tick(100);
    const run = rec.stop(200)!;
    const arrays = await readNpz(await run.toNpz());
    const col = (name: string) => Array.from(arrays.get(name)!.data!);
    expect(births.length + deaths.length).toBeGreaterThan(10);
    expect(col('birth_t')).toEqual(births.map((b) => b[0]));
    expect(col('birth_parent')).toEqual(births.map((b) => b[1]));
    expect(col('birth_child')).toEqual(births.map((b) => b[2]));
    expect(col('death_id')).toEqual(deaths.map((d) => d[1]));
    const t = new RecordingTimeline(arrays);
    expect(t.frameSnapshot(0, -2, false).physics).toMatchObject({ birthDeath: true, birthRate: 1, deathRate: 1 });
  });
});
