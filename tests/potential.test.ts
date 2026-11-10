import { beforeAll, describe, expect, it } from 'vitest';
import { loadTexParser, type TexParser } from '../src/analysis/latex';
import { readNpz } from '../src/record/npzRead';
import { Recorder } from '../src/record/recorder';
import { RecordingTimeline } from '../src/record/timeline';
import { PotentialField } from '../src/sim/field';
import { ParticleSystem } from '../src/sim/particles';
import { Potential } from '../src/sim/potential';
import { Rng } from '../src/sim/rng';
import { type DriftField, SCHEMES } from '../src/sim/schemes';

let parser: TexParser;
beforeAll(async () => {
  parser = await loadTexParser();
});

function formulaPotential(tex: string): Potential {
  const r = parser.parsePotential(tex);
  if (!r.ok) throw new Error(r.message);
  const p = new Potential(new PotentialField({ cellSize: 0.04, cap: 5 }));
  p.setFormula(r.potential);
  return p;
}

describe('batched drift in the schemes', () => {
  it('gives bit-identical paths to the per-particle drift, for both schemes', () => {
    // The same drift, ∇Ψ for Ψ = (x² − 1)² + y²/2, once per particle and once in batch form.
    const grad = (x: number, y: number, out: Float64Array) => {
      out[0] = 4 * x * (x * x - 1);
      out[1] = y;
    };
    const single: DriftField = { gradient: grad };
    const g = new Float64Array(2);
    const batch: DriftField = {
      gradient: grad,
      gradientBatch(xs, ys, n, _t, gx, gy) {
        for (let i = 0; i < n; i++) {
          grad(xs[i], ys[i], g);
          gx[i] = g[0];
          gy[i] = g[1];
        }
      },
    };
    for (const scheme of Object.values(SCHEMES)) {
      const a = new ParticleSystem(new Rng(11), scheme);
      const b = new ParticleSystem(new Rng(11), scheme);
      for (const ps of [a, b]) for (let i = 0; i < 50; i++) ps.add(Math.cos(i), Math.sin(2 * i), 0);
      a.advance(single, 0.5, 0.7);
      b.advance(batch, 0.5, 0.7);
      for (let i = 0; i < 50; i++) {
        expect(b.x[i]).toBe(a.x[i]);
        expect(b.y[i]).toBe(a.y[i]);
      }
    }
  });
});

describe('formula potentials in the simulation', () => {
  it('a time-dependent Ψ is evaluated at the time of each step', () => {
    // A strong well moving on a circle of radius 2: at t = π/2 its centre is at (0, 2).
    const p = formulaPotential('20\\left((x - 2\\cos t)^2 + (y - 2\\sin t)^2\\right)');
    expect(p.timeDependent).toBe(true);
    const ps = new ParticleSystem(new Rng(1));
    ps.add(2, 0, 0);
    ps.advance(p.drift, Math.PI / 2, 0); // deterministic: it follows the well closely
    expect(ps.time).toBeCloseTo(Math.PI / 2, 2);
    const cx = 2 * Math.cos(ps.time);
    const cy = 2 * Math.sin(ps.time);
    // It lags slightly behind the moving centre (by about speed / stiffness).
    expect(Math.hypot(ps.x[0] - cx, ps.y[0] - cy)).toBeLessThan(0.1);
  });

  it('reproduces the stationary variance of an Ornstein–Uhlenbeck process (no lattice, no cap)', () => {
    // Ψ = x²/2 + y²/2: stationary X ~ N(0, σ²/2 · I). With σ = 1: Var = 1/2. Far from the
    // origin Ψ exceeds the painted cap (5) with no effect on the drift.
    const p = formulaPotential('\\frac{x^2 + y^2}{2}');
    const ps = new ParticleSystem(new Rng(5));
    for (let i = 0; i < 2000; i++) ps.add(4, -4, 0); // Ψ = 16 > cap: the drift is still exact
    ps.advance(p.drift, 8, 1);
    let m2 = 0;
    for (let i = 0; i < ps.count; i++) m2 += ps.x[i] ** 2 + ps.y[i] ** 2;
    const variance = m2 / (2 * ps.count);
    expect(Math.abs(variance - 0.5)).toBeLessThan(0.04);
  });

  it('samples exactly and changes its cache key when time moves on', () => {
    const p = formulaPotential('x^2 + y \\cos t');
    p.setTime(0, 0.6);
    const k0 = `${p.revision}|${p.epoch}`;
    expect(p.sample(3, 2)).toBeCloseTo(9 + 2, 12); // 9 + 2 > cap: no clamping
    p.setTime(Math.PI, 0.6);
    expect(p.sample(3, 2)).toBeCloseTo(9 - 2, 12);
    expect(`${p.revision}|${p.epoch}`).not.toBe(k0);
    const xs = Float64Array.of(1, 2);
    const ys = Float64Array.of(0, 1);
    const out = new Float64Array(2);
    p.samplePoints(xs, ys, 2, out);
    expect(Array.from(out)).toEqual([1, 4 - 1]);
  });

  it('draws the formula into the display lattice around the view, capped like the paint', () => {
    const p = formulaPotential('\\frac{x}{2}');
    p.updateDisplay({ x0: -4, y0: -3, x1: 4, y1: 3 }, 0);
    expect(p.display).toBe(p.raster);
    expect(p.display.sample(2, 1)).toBeCloseTo(1, 3);
    expect(p.display.sample(-3, 0)).toBeCloseTo(-1.5, 3);
    p.setFormula(null);
    expect(p.display).toBe(p.lattice);
    expect(p.drift).toBe(p.lattice);
  });
});

describe('recordings with a formula potential', () => {
  it('store the formula per frame and restore it', async () => {
    const field = new PotentialField({ cellSize: 0.04, cap: 5 });
    const ps = new ParticleSystem(new Rng(2));
    ps.add(0, 0, 0);
    let tex: string | null = '\\frac{x^2+y^2}{2}';
    const rec = new Recorder({
      field,
      particles: ps,
      params: () => ({ sigma: 0.6, speed: 1, kernelVariance: 0.09, scheme: 'heun', seed: 0, playing: true, potentialTex: tex }),
    });
    rec.start(0, { x0: -1, y0: -1, x1: 1, y1: 1 });
    ps.advance(field, 0.1, 0.6);
    rec.tick(100);
    tex = null; // back to the painted lattice
    ps.advance(field, 0.1, 0.6);
    rec.tick(200);
    const run = rec.stop(300)!;
    const t = new RecordingTimeline(await readNpz(await run.toNpz()));
    const physics = (k: number) => t.frameSnapshot(k, -2, false).physics as Record<string, unknown>;
    expect(physics(0)).toMatchObject({ potentialMode: 'formula', potentialTex: '\\frac{x^2+y^2}{2}' });
    expect(physics(t.frames - 1)).toMatchObject({ potentialMode: 'painted' });
  });
});

describe('L² norm of the gradient field', () => {
  const box = { x0: -1, y0: -1, x1: 1, y1: 1 };

  it('formula: matches the closed form (and follows time)', () => {
    // Ψ = (x² + y²)/2: |∇Ψ|² = x² + y², ∫ over [−1, 1]² = 8/3.
    expect(formulaPotential(String.raw`\frac{x^2 + y^2}{2}`).gradientNormL2(box)).toBeCloseTo(Math.sqrt(8 / 3), 3);
    // Ψ = 3x − 4y: |∇Ψ| = 5 everywhere, so the norm is 5·√area = 10.
    expect(formulaPotential('3x - 4y').gradientNormL2(box)).toBeCloseTo(10, 10);
    // Ψ = x cos t: |∇Ψ| = |cos t|.
    const p = formulaPotential(String.raw`x \cos t`);
    p.setTime(0, 0.6);
    expect(p.gradientNormL2(box)).toBeCloseTo(2, 10);
    p.setTime(Math.PI / 3, 0.6);
    expect(p.gradientNormL2(box)).toBeCloseTo(1, 10);
  });

  it('painted lattice: sums the stored nodal gradients', () => {
    const field = new PotentialField({ cellSize: 0.04, cap: 5 });
    const p = new Potential(field);
    expect(p.gradientNormL2(box)).toBe(0); // nothing painted
    // A linear ramp Ψ = x/2 on a larger square: inside the box ∇Ψ = (½, 0), norm = ½·√4 = 1.
    field.addFunction(-3, -3, 3, 3, (x) => x / 2);
    expect(p.gradientNormL2(box)).toBeCloseTo(1, 6);
    // It matches a direct sum of |∇Ψ|² over the lattice nodes of the box.
    const g = new Float64Array(2);
    let sum = 0;
    for (let j = -25; j < 25; j++) {
      for (let i = -25; i < 25; i++) {
        field.gradient(i * 0.04, j * 0.04, g);
        sum += g[0] * g[0] + g[1] * g[1];
      }
    }
    expect(p.gradientNormL2(box)).toBeCloseTo(Math.sqrt(sum * 0.04 * 0.04), 10);
  });
});
