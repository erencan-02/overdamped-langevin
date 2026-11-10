import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { npyArray } from '../src/record/npz';
import { Recorder } from '../src/record/recorder';
import { PotentialField } from '../src/sim/field';
import { ParticleSystem } from '../src/sim/particles';
import { Rng } from '../src/sim/rng';

/** Parses a .npy buffer (format 1.0) into header text and raw data bytes. */
function parseNpy(bytes: Uint8Array) {
  expect(Array.from(bytes.slice(0, 6))).toEqual([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59]);
  expect(bytes[6]).toBe(1);
  const hlen = bytes[8] | (bytes[9] << 8);
  expect((10 + hlen) % 64).toBe(0);
  const header = new TextDecoder().decode(bytes.slice(10, 10 + hlen));
  expect(header.endsWith('\n')).toBe(true);
  return { header, data: bytes.slice(10 + hlen) };
}

describe('npy writer', () => {
  it('writes a valid header and the raw little-endian data', () => {
    const data = Float32Array.from([1, 2, 3, 4, 5, 6]);
    const { header, data: raw } = parseNpy(npyArray({ dtype: '<f4', shape: [2, 3], data }));
    expect(header).toContain("'descr': '<f4'");
    expect(header).toContain("'shape': (2, 3)");
    expect(header).toContain("'fortran_order': False");
    expect(Array.from(new Float32Array(raw.buffer, raw.byteOffset, 6))).toEqual([1, 2, 3, 4, 5, 6]);
    expect(parseNpy(npyArray({ dtype: '<f8', shape: [1], data: new Float64Array(1) })).header).toContain("'shape': (1,)");
  });

  it('rejects a shape that does not match the data', () => {
    expect(() => npyArray({ dtype: '<f4', shape: [3], data: new Float32Array(2) })).toThrow();
  });
});

describe('Recorder', () => {
  it('records frames, Psi snapshots and KL and exports a consistent .npz', async () => {
    const field = new PotentialField({ cellSize: 0.04, cap: 5 });
    field.applyBrush(0, 0, -3, 0.6);
    const ps = new ParticleSystem(new Rng(1));
    for (let i = 0; i < 5; i++) ps.add(i * 0.1, 0, i);
    const params = { sigma: 0.6, speed: 1, kernelVariance: 0.09, scheme: 'heun' as const, playing: true };
    const rec = new Recorder({ field, particles: ps, params: () => params });

    let now = 1000;
    rec.start(now, { x0: -2, y0: -1, x1: 2, y1: 1 });
    for (let k = 0; k < 5; k++) {
      ps.advance(field, 0.05, 0.6);
      now += 60;
      rec.tick(now);
    }
    ps.removeAt(1); // ids must survive the swap-remove
    ps.add(1, 1, 7);
    now += 60;
    rec.tick(now);
    field.applyBrush(1, 0, 1, 0.3);
    now += 300;
    rec.tick(now);
    rec.addKl(ps.time, { kl: 0.5, floor: 0.01, inside: 5, total: 5, kernelCells: 1.5, h: 0.3 }, {
      x0: -2,
      y0: -1,
      x1: 2,
      y1: 1,
    });
    const run = rec.stop(now + 10)!;

    expect(rec.recording).toBe(false);
    expect(rec.runs[0]).toBe(run);
    expect(run.frames).toBeGreaterThanOrEqual(7);
    expect(run.psi.length).toBe(2); // start + after the brush stroke
    expect(run.counts[run.counts.length - 1]).toBe(5);

    const files = unzipSync(await run.toNpz());
    const names = Object.keys(files).sort();
    for (const n of ['t', 'x', 'y', 'particle_id', 'frame_offsets', 'psi', 'kl', 'sigma', 'scheme']) {
      expect(names).toContain(`${n}.npy`);
    }
    expect(names).toContain('metadata.npy');
    const m = parseNpy(files['metadata.npy']);
    expect(m.header).toMatch(/'descr': '<U\d+'/);
    expect(m.header).toContain("'shape': ()");
    const codes = new Uint32Array(m.data.buffer.slice(m.data.byteOffset, m.data.byteOffset + m.data.byteLength));
    const meta = JSON.parse(String.fromCodePoint(...codes));
    expect(meta.format).toBe('potential-sde-run');

    // Particle ids: particle 1 was removed, id 4 moved into slot 1, id 5 was added.
    const off = parseNpy(files['frame_offsets.npy']);
    const offsets = new Int32Array(off.data.buffer.slice(off.data.byteOffset, off.data.byteOffset + off.data.byteLength));
    const pid = parseNpy(files['particle_id.npy']);
    const ids = new Uint32Array(pid.data.buffer.slice(pid.data.byteOffset, pid.data.byteOffset + pid.data.byteLength));
    const last = run.frames - 1;
    expect(Array.from(ids.slice(offsets[last], offsets[last + 1])).sort()).toEqual([0, 2, 3, 4, 5]);

  });
});
