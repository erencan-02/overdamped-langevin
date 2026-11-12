import { beforeAll, describe, expect, it } from 'vitest';
import { loadTexParser, type TexParser } from '../src/analysis/latex';
import { decodeScenario, encodeScenario, readHash, scenarioKey, toBase64Url } from '../src/scenario/codec';
import { parseScenario, SCENARIO_FORMAT, type Scenario } from '../src/scenario/schema';
import {
  applyScenario,
  captureScenario,
  checkAnswer,
  parseQuestionLines,
  questionLines,
  sampleParticles,
  type ScenarioHost,
} from '../src/scenario/setup';
import { AnalysisBoxComponent, ParticlesComponent, PotentialComponent, ViewComponent } from '../src/session/components';
import { Session } from '../src/session/session';
import { AnalysisSettings, DisplaySettings, PhysicsSettings, ToolSettings } from '../src/session/settings';
import { PotentialField } from '../src/sim/field';
import { ParticleSystem } from '../src/sim/particles';
import { RandomStreams } from '../src/sim/random';
import { Rng } from '../src/sim/rng';
import { initialState } from '../src/state';
import { Camera } from '../src/view/camera';
import { EquilibriumMonitor } from '../src/analysis/equilibrium';
import { deflateSync, strToU8 } from 'fflate';

// The files as served (public/scenarios), read by Vite.
const RAW = import.meta.glob('../public/scenarios/*.json', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>;
const byName = new Map(Object.entries(RAW).map(([path, text]) => [path.split('/').pop()!, text]));
const FILES = [...byName.keys()].filter((f) => f !== 'index.json');
const read = (f: string) => JSON.parse(byName.get(f)!) as unknown;

let parser: TexParser;
beforeAll(async () => {
  parser = await loadTexParser();
});

describe('the course scenarios', () => {
  it('are listed in the index, one file each', () => {
    const index = read('index.json') as { id: string; title: string }[];
    expect(index.map((e) => `${e.id}.json`).sort()).toEqual([...FILES].sort());
    expect(index).toHaveLength(8);
  });

  it.each(FILES)('%s is valid and all its formulas compile', (file) => {
    const r = parseScenario(read(file));
    if (!r.ok) throw new Error(r.message);
    const s = r.scenario;
    const physics = (s.settings?.physics ?? {}) as Record<string, string>;
    const analysis = (s.settings?.analysis ?? {}) as Record<string, string>;
    if (physics.potentialTex) expect(parser.parsePotential(physics.potentialTex)).toMatchObject({ ok: true });
    for (const [key, name] of [
      ['driftU1', 'u_1'],
      ['driftU2', 'u_2'],
      ['noiseS1', 's_1'],
      ['noiseS2', 's_2'],
    ] as const) {
      if (physics[key]) expect(parser.parseCoefficient(physics[key], name)).toMatchObject({ ok: true });
    }
    for (const key of ['observable', 'ergodicF', 'passageTarget']) {
      if (analysis[key]) expect(parser.parse(analysis[key])).toMatchObject({ ok: true });
    }
    // Every window it opens exists, and every readout it checks against is one the app reports.
    const known = ['potential', 'process', 'population', 'observable', 'ergodicity', 'firstPassage', 'sweep', 'kl', 'settings'];
    for (const p of s.panels ?? []) expect(known).toContain(p);
    for (const q of s.questions ?? []) {
      if (q.readout) expect(['firstPassage.meanTau', 'ergodicity.timeAverage', 'sweep.strongOrder.milstein']).toContain(q.readout);
      if (q.kind === 'choice') expect(q.choices).toContain(q.answer);
    }
  });
});

describe('the scenario schema', () => {
  const minimal = { format: SCENARIO_FORMAT, version: 1, title: 'T' };

  it('accepts a minimal scenario and drops unknown keys', () => {
    const r = parseScenario({ ...minimal, extra: '<script>' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.scenario).toEqual(minimal);
  });

  it('refuses malformed and oversized input with a message', () => {
    for (const bad of [
      null,
      [],
      'text',
      { format: 'other' },
      { ...minimal, version: 'one' },
      { ...minimal, title: '' },
      { ...minimal, particles: [{ kind: 'point', x: 0, y: 0, n: 5000 }] },
      { ...minimal, particles: [{ kind: 'point', x: 0, y: 0, n: 1500 }, { kind: 'point', x: 0, y: 0, n: 1500 }] },
      { ...minimal, particles: [{ kind: 'points', xs: [1, 2], ys: [1] }] },
      { ...minimal, particles: [{ kind: 'laser', n: 1 }] },
      { ...minimal, box: { x0: 1, y0: 0, x1: 0, y1: 1 } },
      { ...minimal, settings: { physics: { sigma: { nested: true } } } },
      { ...minimal, view: { x: 0, y: 0, scale: Number.NaN } },
      { ...minimal, questions: [{ text: 'q', readout: 'x; alert(1)' }] },
    ]) {
      const r = parseScenario(bad);
      expect(r.ok, JSON.stringify(bad)).toBe(false);
      if (!r.ok) expect(r.message.length).toBeGreaterThan(5);
    }
  });

  it('refuses newer versions and migrates version 0 (a settings snapshot)', () => {
    const newer = parseScenario({ ...minimal, version: 2 });
    expect(newer.ok).toBe(false);
    if (!newer.ok) expect(newer.message).toContain('newer version');
    const old = parseScenario({ physics: { sigma: 0.4 }, view: { x: 1, y: 2, scale: 30 }, analysisBox: { x0: 0, y0: 0, x1: 2, y1: 1 } });
    expect(old).toMatchObject({
      ok: true,
      scenario: { version: 1, settings: { physics: { sigma: 0.4 } }, view: { x: 1, y: 2, scale: 30 }, box: { x0: 0, y0: 0, x1: 2, y1: 1 } },
    });
  });
});

describe('scenario links', () => {
  it('round-trip through the URL hash', () => {
    const s = read('metastability.json');
    const encoded = encodeScenario(s);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeScenario(encoded)).toEqual(s);
    expect(readHash(`#s=${encoded}`)).toEqual({ kind: 'link', data: encoded });
    expect(readHash('#scenario=ergodicity')).toEqual({ kind: 'builtin', name: 'ergodicity' });
    expect(readHash('#scenario=../secret')).toBeNull();
    expect(readHash('#gist=0123456789abcdef0123')).toEqual({ kind: 'gist', id: '0123456789abcdef0123' });
    expect(readHash('#gist=https://evil.example')).toBeNull();
    expect(readHash('')).toBeNull();
  });

  it('reject damaged links and decompression bombs', () => {
    expect(() => decodeScenario('not base64!')).toThrow();
    expect(() => decodeScenario('AAAA')).toThrow();
    const bomb = toBase64Url(deflateSync(strToU8('x'.repeat(5 * 1024 * 1024))));
    expect(bomb.length).toBeLessThan(20_000);
    expect(() => decodeScenario(bomb)).toThrow(/too large/);
  });

  it('give every scenario a stable key', () => {
    expect(scenarioKey({ a: 1 })).toBe(scenarioKey({ a: 1 }));
    expect(scenarioKey({ a: 1 })).not.toBe(scenarioKey({ a: 2 }));
  });
});

/** A small app: state, session with all settings and components, and the scenario host. */
function app() {
  const state = initialState();
  const random = new RandomStreams(state.seed);
  const field = new PotentialField({ cellSize: 0.04, cap: 5 });
  const ps = new ParticleSystem(random.get('dynamics'));
  const camera = new Camera();
  camera.setViewport(800, 600);
  const monitor = new EquilibriumMonitor(field, ps);
  const noop = () => {};
  const session = new Session()
    .register(new PhysicsSettings(state, noop, ps, random))
    .register(new AnalysisSettings(state, noop))
    .register(new DisplaySettings(state, noop))
    .register(new ToolSettings(state, noop))
    .register(new PotentialComponent(field))
    .register(new ParticlesComponent(ps))
    .register(new AnalysisBoxComponent(monitor))
    .register(new ViewComponent(camera));
  const fresh = initialState();
  const defaults = new Session()
    .register(new PhysicsSettings(fresh, noop, ps, random))
    .register(new AnalysisSettings(fresh, noop))
    .register(new DisplaySettings(fresh, noop))
    .register(new ToolSettings(fresh, noop))
    .capture();
  let open: string[] = [];
  const host: ScenarioHost = {
    session,
    defaults,
    field,
    rng: { presets: random.get('presets'), positions: random.get('scenario'), colors: random.get('colors') },
    reseed: () => random.reseed(state.seed),
    prepare: noop,
    showRect: (b) => camera.showRect(b.x0, b.y0, b.x1, b.y1),
    viewBounds: () => camera.bounds(),
    openPanels: (ids) => (open = [...ids]),
    openPanelIds: () => open,
    resetInstruments: noop,
    setPlaying: (p) => (state.playing = p),
  };
  return { state, ps, field, monitor, camera, host };
}

describe('applying and capturing scenarios', () => {
  it('sets everything up, reproducibly, and resets what it does not mention', () => {
    const a = app();
    a.state.speed = 3; // changed before: the scenario resets it
    const s = parseScenario(read('ergodicity.json'));
    if (!s.ok) throw new Error(s.message);
    applyScenario(s.scenario, a.host);
    expect(a.state).toMatchObject({ sigma: 1.1, speed: 4, potentialMode: 'formula', ergodicF: 'x', scheme: 'heun', playing: false });
    expect(a.ps.count).toBe(400);
    expect(a.ps.time).toBe(0);
    expect(a.monitor.box).toEqual(s.scenario.box);
    const b = app();
    applyScenario(s.scenario, b.host);
    expect(Array.from(b.ps.x.subarray(0, 400))).toEqual(Array.from(a.ps.x.subarray(0, 400)));
    expect(b.ps.rng.getState()).toEqual(a.ps.rng.getState());

    const c = app();
    c.state.speed = 3;
    applyScenario({ format: SCENARIO_FORMAT, version: 1, title: 'x' }, c.host);
    expect(c.state.speed).toBe(1);
  });

  it('captures the current set-up so that applying it gives the same', () => {
    const a = app();
    const s = parseScenario(read('birth-death.json'));
    if (!s.ok) throw new Error(s.message);
    applyScenario(s.scenario, a.host);
    a.host.session.apply({ physics: { potentialMode: 'painted' } }); // a painted Ψ is captured as a lattice
    a.field.addFunction(-1, -1, 1, 1, (x, y) => x * y);
    const captured = captureScenario(a.host, {
      title: ' Copy ',
      questions: parseQuestionLines('Variance? = 2.5 ± 10%'),
      includeParticles: true,
      includePotential: true,
      play: true,
    });
    const r = parseScenario(JSON.parse(JSON.stringify(captured)));
    if (!r.ok) throw new Error(r.message);
    expect(r.scenario.title).toBe('Copy');
    expect(r.scenario.settings?.physics).toMatchObject({ birthDeath: true, birthRate: 0.6, deathRate: 0.4, sigma: 0.8 });
    expect(r.scenario.settings?.physics).not.toHaveProperty('seed'); // equal to a fresh app's: left out

    const b = app();
    applyScenario(r.scenario, b.host);
    expect(b.state).toMatchObject({ birthDeath: true, birthRate: 0.6, sigma: 0.8, playing: true, potentialMode: 'painted' });
    expect(b.ps.count).toBe(a.ps.count);
    for (let i = 0; i < a.ps.count; i++) expect(b.ps.x[i]).toBeCloseTo(a.ps.x[i], 3);
    expect(b.field.sample(0.5, 0.5)).toBeCloseTo(a.field.sample(0.5, 0.5), 5);
    expect(b.monitor.box).toEqual(a.monitor.box);
  });

  it('samples particle specifications', () => {
    const { x, y } = sampleParticles(
      [
        { kind: 'point', x: 1, y: 2, n: 3 },
        { kind: 'uniform', x0: 0, y0: 0, x1: 1, y1: 1, n: 500 },
        { kind: 'gaussian', x: 5, y: 5, sx: 0.1, n: 2000 },
        { kind: 'points', xs: [7], ys: [8] },
      ],
      new Rng(1),
    );
    expect(x.length).toBe(2504);
    expect([x[0], y[2]]).toEqual([1, 2]);
    expect(x.slice(3, 503).every((v) => v >= 0 && v < 1)).toBe(true);
    const g = x.slice(503, 2503);
    const mean = g.reduce((a, b) => a + b) / g.length;
    expect(mean).toBeCloseTo(5, 1);
    expect([x[2503], y[2503]]).toEqual([7, 8]);
  });
});

describe('worksheets', () => {
  it('read questions written one per line, and write them back', () => {
    const text = 'Describe it.\nVariance? = 0.25 ± 0.02\n# a comment\nMean exit time = @firstPassage.meanTau ± 10%\nSlope = 2';
    const qs = parseQuestionLines(text);
    expect(qs).toEqual([
      { text: 'Describe it.' },
      { text: 'Variance?', kind: 'number', answer: 0.25, tolerance: 0.02 },
      { text: 'Mean exit time', kind: 'number', readout: 'firstPassage.meanTau', tolerance: 0.1, relative: true },
      { text: 'Slope', kind: 'number', answer: 2 },
    ]);
    expect(parseQuestionLines(questionLines(qs))).toEqual(qs);
  });

  it('check answers against values and measurements', () => {
    const q = (o: Partial<Scenario['questions'] extends (infer T)[] | undefined ? T : never>) => ({ text: 'q', ...o });
    expect(checkAnswer(q({ answer: 0.25, tolerance: 0.02 }), '0.26', {})).toBe(true);
    expect(checkAnswer(q({ answer: 0.25, tolerance: 0.02 }), '0,3', {})).toBe(false);
    expect(checkAnswer(q({ answer: 2 }), '2.05', {})).toBe(true); // default: 5 %
    expect(checkAnswer(q({ answer: 2 }), 'two', {})).toBe(false);
    expect(checkAnswer(q({ readout: 'firstPassage.meanTau', tolerance: 0.1, relative: true }), '10.5', { 'firstPassage.meanTau': 10 })).toBe(true);
    expect(checkAnswer(q({ readout: 'firstPassage.meanTau' }), '10', { 'firstPassage.meanTau': Number.NaN })).toBeNull();
    expect(checkAnswer(q({ kind: 'choice', choices: ['a', 'b'], answer: 'b' }), 'b', {})).toBe(true);
    expect(checkAnswer(q({}), 'anything', {})).toBeNull();
    expect(checkAnswer(q({ answer: 1 }), '  ', {})).toBeNull();
  });
});
