import { describe, expect, it } from 'vitest';
import { npyArray, npyString } from '../src/record/npz';
import { parseNpy, readNpz } from '../src/record/npzRead';
import { Recorder } from '../src/record/recorder';
import { RecordingError, RecordingTimeline } from '../src/record/timeline';
import { ParticlesComponent, PotentialComponent } from '../src/session/components';
import { Session } from '../src/session/session';
import { AnalysisSettings, PhysicsSettings } from '../src/session/settings';
import { PotentialField } from '../src/sim/field';
import { ParticleSystem } from '../src/sim/particles';
import { RandomStreams } from '../src/sim/random';
import { initialState } from '../src/state';

function app(seed = 0) {
  const state = initialState();
  state.seed = seed;
  const random = new RandomStreams(seed);
  const field = new PotentialField({ cellSize: 0.04, cap: 5 });
  const ps = new ParticleSystem(random.get('dynamics'));
  const session = new Session()
    .register(new PhysicsSettings(state, () => {}, ps, random))
    .register(new AnalysisSettings(state, () => {}))
    .register(new PotentialComponent(field))
    .register(new ParticlesComponent(ps));
  return { state, random, field, ps, session };
}

describe('npy reader', () => {
  it('reads what the writer writes, including strings', () => {
    const a = parseNpy(npyArray({ dtype: '<f8', shape: [2, 2], data: Float64Array.from([1, 2, 3, 4]) }));
    expect(a.shape).toEqual([2, 2]);
    expect(Array.from(a.data!)).toEqual([1, 2, 3, 4]);
    const s = parseNpy(npyArray(npyString('{"a": "Ψ"}')));
    expect(s.strings).toEqual(['{"a": "Ψ"}']);
  });

  it('handles int64 and big-endian data as written by other tools', () => {
    /** Builds a raw .npy (version 1.0) with an arbitrary descriptor and payload. */
    const npy = (descr: string, shape: string, payload: Uint8Array) => {
      let header = `{'descr': '${descr}', 'fortran_order': False, 'shape': ${shape}, }`;
      const total = Math.ceil((10 + header.length + 1) / 64) * 64;
      header = `${header.padEnd(total - 11, ' ')}\n`;
      const h = new TextEncoder().encode(header);
      const out = new Uint8Array(10 + h.length + payload.length);
      out.set([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 1, 0, h.length & 0xff, h.length >> 8]);
      out.set(h, 10);
      out.set(payload, 10 + h.length);
      return out;
    };
    const i8 = new Uint8Array(new BigInt64Array([5n, -3n]).buffer);
    expect(Array.from(parseNpy(npy('<i8', '(2,)', i8)).data!)).toEqual([5, -3]);

    const be = new Uint8Array(4);
    new DataView(be.buffer).setFloat32(0, 1.5, false); // big-endian bytes
    expect(parseNpy(npy('>f4', '(1,)', be)).data![0]).toBe(1.5);
  });
});

describe('recording → file → playback', () => {
  it('restores every frame and continues bit-identically from it', async () => {
    const a = app(3);
    a.field.applyBrush(0, 0, -3, 0.7);
    for (let i = 0; i < 30; i++) a.ps.add((i % 6) * 0.3 - 0.8, Math.floor(i / 6) * 0.3 - 0.6, i % 12);
    a.state.sigma = 0.8;
    const rec = new Recorder({
      field: a.field,
      particles: a.ps,
      params: () => ({ ...a.state, playing: true }),
      settings: () => a.session.capture(['analysis']),
    });
    let now = 0;
    rec.start(now, { x0: -2, y0: -2, x1: 2, y1: 2 });
    for (let k = 0; k < 8; k++) {
      a.ps.advance(a.field, 1 / 30, a.state.sigma);
      now += 60;
      rec.tick(now);
    }
    a.ps.removeAt(4); // ids and counts change mid-run
    now += 60;
    rec.tick(now);
    const run = rec.stop(now + 1)!;

    const timeline = new RecordingTimeline(await readNpz(await run.toNpz()));
    expect(timeline.version).toBe(2);
    expect(timeline.frames).toBe(run.frames);

    // Restore the last frame into a fresh app with a different seed.
    const b = app(99);
    b.session.apply(timeline.initialSnapshot());
    const k = timeline.frames - 1;
    b.session.apply(timeline.frameSnapshot(k, -2, false));
    expect(b.state.seed).toBe(3);
    expect(b.state.sigma).toBe(0.8);
    expect(b.ps.count).toBe(29);
    expect(b.ps.time).toBe(a.ps.time);
    expect(b.field.sample(0.1, 0.1)).toBeCloseTo(a.field.sample(0.1, 0.1), 5);
    for (let i = 0; i < 29; i++) {
      expect(b.ps.id[i]).toBe(a.ps.id[i]);
      expect(b.ps.x[i]).toBe(a.ps.x[i]);
    }

    // Continue both: the played-back state is the exact state of the original run.
    a.ps.advance(a.field, 0.5, 0.8);
    b.ps.advance(b.field, 0.5, 0.8);
    for (let i = 0; i < 29; i++) {
      expect(b.ps.x[i]).toBe(a.ps.x[i]);
      expect(b.ps.y[i]).toBe(a.ps.y[i]);
    }
  });

  it('rejects files that are not recordings', async () => {
    const { npzArchive } = await import('../src/record/npz');
    const other = await npzArchive({ weights: { dtype: '<f4', shape: [2], data: new Float32Array(2) } });
    expect(() => new RecordingTimeline(new Map())).toThrow(RecordingError);
    await expect(readNpz(Uint8Array.from([1, 2, 3]))).rejects.toThrow();
    expect(() => new RecordingTimeline(new Map())).toThrow(/not a recording/);
    const arrays = await readNpz(other);
    expect(() => new RecordingTimeline(arrays)).toThrow(RecordingError);
  });
});
