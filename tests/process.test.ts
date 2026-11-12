import { beforeAll, describe, expect, it } from 'vitest';
import { loadTexParser, type TexParser } from '../src/analysis/latex';
import { readNpz } from '../src/record/npzRead';
import { Recorder } from '../src/record/recorder';
import { RecordingTimeline } from '../src/record/timeline';
import { PotentialField } from '../src/sim/field';
import { ParticleSystem } from '../src/sim/particles';
import { type Coefficient, langevin, type NormalSource, Sde } from '../src/sim/process';
import { Rng } from '../src/sim/rng';
import { type Ensemble, SCHEMES } from '../src/sim/schemes';

let parser: TexParser;
beforeAll(async () => {
  parser = await loadTexParser();
});

/** A coefficient c(x, y) = f(x, y) with gradient (fx, fy), written out by hand. */
function coef(
  variables: string[],
  f: (x: number, y: number) => number,
  fx: (x: number, y: number) => number = () => 0,
  fy: (x: number, y: number) => number = () => 0,
): Coefficient {
  return {
    variables: new Set(variables),
    timeDependent: false,
    usesSigma: false,
    value(xs, ys, n, _t, _s, out) {
      for (let i = 0; i < n; i++) out[i] = f(xs[i], ys[i]);
    },
    gradient(xs, ys, n, _t, _s, gx, gy) {
      for (let i = 0; i < n; i++) {
        gx[i] = fx(xs[i], ys[i]);
        gy[i] = fy(xs[i], ys[i]);
      }
    },
  };
}

/** Normals read from an array, in order. */
class Prescribed implements NormalSource {
  private k = 0;
  constructor(private readonly z: Float64Array) {}
  normal(): number {
    return this.z[this.k++];
  }
}

/** Geometric Brownian motion in each coordinate: dX = μX dt + sX dW (diagonal noise). */
function gbm(mu: number, s: number): Sde {
  const p = new Sde();
  p.extraDrift = [coef(['x'], (x) => mu * x), coef(['y'], (_x, y) => mu * y)];
  p.noise = [coef(['x'], (x) => s * x, () => s), coef(['y'], (_x, y) => s * y, undefined, () => s)];
  return p;
}

describe('the process interface', () => {
  it('declares what is known about the process', () => {
    const p = langevin(null, 0.5);
    expect(p.capabilities).toEqual({ gibbs: true, additiveNoise: true, diagonalNoise: true });
    expect(p.deterministic).toBe(false);
    expect(langevin(null, 0).deterministic).toBe(true);
    p.extraDrift = [coef(['y'], (_x, y) => -y), coef(['x'], (x) => x)];
    expect(p.capabilities.gibbs).toBe(false);
    p.extraDrift = null;
    p.noise = [coef([], () => 1), coef(['sigma'], () => 2)];
    expect(p.capabilities).toEqual({ gibbs: false, additiveNoise: true, diagonalNoise: true });
    p.noise = [coef(['x'], (x) => x), coef(['y'], (_x, y) => y)];
    expect(p.capabilities).toEqual({ gibbs: false, additiveNoise: false, diagonalNoise: true });
    p.noise = [coef(['y'], (_x, y) => y), coef(['y'], (_x, y) => y)];
    expect(p.capabilities.diagonalNoise).toBe(false);
    p.noise = [coef(['r'], (x, y) => Math.hypot(x, y)), coef([], () => 1)];
    expect(p.capabilities.diagonalNoise).toBe(false);
  });

  it('adds the extra drift to −∇Ψ and uses σ as the noise by default', () => {
    const field = { gradient: (x: number, y: number, out: Float64Array) => ((out[0] = 2 * x), (out[1] = 4 * y)) };
    const p = langevin(field, 0.7);
    p.extraDrift = [coef(['y'], (_x, y) => -y), coef(['x'], (x) => x)];
    const xs = Float64Array.of(1, -2);
    const ys = Float64Array.of(3, 0.5);
    const bx = new Float64Array(2);
    const by = new Float64Array(2);
    p.drift(xs, ys, 2, 0, bx, by);
    expect(Array.from(bx)).toEqual([-2 - 3, 4 - 0.5]);
    expect(Array.from(by)).toEqual([-12 + 1, -2 - 2]);
    const s1 = new Float64Array(2);
    const s2 = new Float64Array(2);
    const d1 = new Float64Array(2).fill(9);
    p.diffusion(xs, ys, 2, 0, s1, s2, d1, null);
    expect(Array.from(s1)).toEqual([0.7, 0.7]);
    expect(Array.from(d1)).toEqual([0, 0]);
  });

  it('Euler–Maruyama takes exactly the step it describes', () => {
    const p = gbm(0.3, 0.5);
    const e: Ensemble = { x: Float64Array.of(2), y: Float64Array.of(-1), count: 1 };
    const dt = 0.01;
    const z = Float64Array.of(0.4, -1.2);
    SCHEMES['euler-maruyama'].step(e, p, dt, new Prescribed(z));
    expect(e.x[0]).toBeCloseTo(2 + 0.3 * 2 * dt + 0.5 * 2 * Math.sqrt(dt) * 0.4, 14);
    expect(e.y[0]).toBeCloseTo(-1 - 0.3 * dt - 0.5 * Math.sqrt(dt) * -1.2, 14);
  });

  it('draws no random numbers for a deterministic process', () => {
    const rng = new Rng(4);
    const before = rng.getState();
    const e: Ensemble = { x: Float64Array.of(1), y: Float64Array.of(1), count: 1 };
    for (const s of Object.values(SCHEMES)) s.step(e, langevin(null, 0), 0.1, rng);
    expect(rng.getState()).toEqual(before);
  });
});

describe('convergence for multiplicative noise (geometric Brownian motion)', () => {
  const mu = 0.4;
  const s = 0.8;
  const T = 1;
  const M = 3000;

  /**
   * Strong error E|X_T − X(T)| against the exact solution X0·exp((μ − s²/2)T + s W_T), with the
   * same Brownian path for every step size (fine increments summed).
   */
  function strongErrors(id: keyof typeof SCHEMES, levels: number[]): number[] {
    const fine = 2 ** Math.max(...levels);
    const rng = new Rng(17);
    const z = new Float64Array(M * fine * 2);
    for (let k = 0; k < z.length; k++) z[k] = rng.normal();
    const W = new Float64Array(M);
    const sqf = Math.sqrt(T / fine);
    for (let m = 0; m < M; m++) for (let j = 0; j < fine; j++) W[m] += sqf * z[(j * M + m) * 2];
    return levels.map((level) => {
      const steps = 2 ** level;
      const k = fine / steps;
      const e: Ensemble = { x: new Float64Array(M).fill(1), y: new Float64Array(M).fill(1), count: M };
      const p = gbm(mu, s);
      const zc = new Float64Array(M * 2);
      for (let j = 0; j < steps; j++) {
        zc.fill(0);
        for (let q = 0; q < k; q++) {
          const f = (j * k + q) * M * 2;
          for (let c = 0; c < M * 2; c++) zc[c] += z[f + c];
        }
        for (let c = 0; c < M * 2; c++) zc[c] /= Math.sqrt(k);
        SCHEMES[id].step(e, p, T / steps, new Prescribed(zc), (j * T) / steps);
      }
      let err = 0;
      for (let m = 0; m < M; m++) err += Math.abs(e.x[m] - Math.exp((mu - (s * s) / 2) * T + s * W[m]));
      return err / M;
    });
  }

  /** Least-squares slope of log2(error) against log2(dt). */
  const order = (levels: number[], errors: number[]) => {
    const xs = levels.map((l) => -l);
    const ys = errors.map((e) => Math.log2(e));
    const mx = xs.reduce((a, b) => a + b) / xs.length;
    const my = ys.reduce((a, b) => a + b) / ys.length;
    let num = 0;
    let den = 0;
    for (let i = 0; i < xs.length; i++) {
      num += (xs[i] - mx) * (ys[i] - my);
      den += (xs[i] - mx) ** 2;
    }
    return num / den;
  };

  it('Milstein has strong order 1, Euler–Maruyama strong order ½', () => {
    const levels = [3, 4, 5, 6];
    const milstein = order(levels, strongErrors('milstein', levels));
    const em = order(levels, strongErrors('euler-maruyama', levels));
    expect(milstein).toBeGreaterThan(0.85);
    expect(milstein).toBeLessThan(1.2);
    expect(em).toBeGreaterThan(0.35);
    expect(em).toBeLessThan(0.7);
  });

  it('Heun converges to the Itô solution, not the Stratonovich one', () => {
    // E X_T = e^{μT} for Itô; a Stratonovich scheme would give e^{(μ + s²/2)T} ≈ 1.83 instead of 1.49.
    const ps = new ParticleSystem(new Rng(8), SCHEMES.heun);
    for (let i = 0; i < 2000; i++) ps.add(1, 1, 0);
    ps.advance(gbm(mu, s), T, 1 / 200);
    let mean = 0;
    for (let i = 0; i < ps.count; i++) mean += ps.x[i];
    mean /= ps.count;
    expect(Math.abs(mean - Math.exp(mu * T))).toBeLessThan(0.08);
  });
});

describe('coefficients typed in LaTeX', () => {
  it('compile with their gradient and report what they depend on', () => {
    const r = parser.parseCoefficient(String.raw`\sigma\sqrt{1 + \frac{x^2}{4}}`, 's_1');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect([...r.potential.variables].sort()).toEqual(['sigma', 'x']);
    const out = new Float64Array(1);
    const gx = new Float64Array(1);
    const gy = new Float64Array(1);
    r.potential.value(Float64Array.of(2), Float64Array.of(5), 1, 0, 0.5, out);
    r.potential.gradient(Float64Array.of(2), Float64Array.of(5), 1, 0, 0.5, gx, gy);
    expect(out[0]).toBeCloseTo(0.5 * Math.sqrt(2), 12);
    expect(gx[0]).toBeCloseTo((0.5 * 0.5) / Math.sqrt(2), 12); // σ x / (4 √(1 + x²/4))
    expect(gy[0]).toBe(0);
  });

  it('accept a "name(t, x, y) =" prefix and name themselves in messages', () => {
    const ok = parser.parseCoefficient('u_1(t, x, y) = -y', 'u_1');
    expect(ok.ok).toBe(true);
    const bad = parser.parseCoefficient('x + z', 'u_2');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.message).toContain('u_2');
    const psi = parser.parseCoefficient(String.raw`\Psi + x`, 's_2');
    expect(psi.ok).toBe(false);
  });
});

describe('recordings of a general process', () => {
  it('store the drift and noise per frame and restore them', async () => {
    const field = new PotentialField({ cellSize: 0.04, cap: 5 });
    const ps = new ParticleSystem(new Rng(2));
    ps.add(0, 0, 0);
    let proc: { drift: [string, string] | null; noise: [string, string] | null } | null = {
      drift: ['-y', 'x'],
      noise: null,
    };
    const rec = new Recorder({
      field,
      particles: ps,
      params: () => ({ sigma: 0.6, speed: 1, kernelVariance: 0.09, scheme: 'milstein', seed: 0, playing: true, process: proc }),
    });
    rec.start(0, { x0: -1, y0: -1, x1: 1, y1: 1 });
    ps.advance(langevin(field, 0.6), 0.1);
    rec.tick(100);
    proc = null; // back to the Langevin equation
    ps.advance(langevin(field, 0.6), 0.1);
    rec.tick(200);
    const run = rec.stop(300)!;
    const t = new RecordingTimeline(await readNpz(await run.toNpz()));
    const physics = (k: number) => t.frameSnapshot(k, -2, false).physics as Record<string, unknown>;
    expect(physics(0)).toMatchObject({ extraDrift: true, driftU1: '-y', driftU2: 'x', noiseFormula: false, scheme: 'milstein' });
    expect(physics(t.frames - 1)).toMatchObject({ extraDrift: false, noiseFormula: false });
  });
});
