import { describe, expect, it } from 'vitest';
import { gridBounds, writePotential } from '../src/image/writePotential';
import { rgbaToSample } from '../src/image/pixels';
import { PotentialField } from '../src/sim/field';
import { darknessLevels, imageToPotential, type PotentialGrid } from '../src/sim/imagePotential';

describe('rgbaToSample', () => {
  it('maps black/white/grey to CIE lightness and keeps opacity', () => {
    const rgba = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255, 119, 119, 119, 128]);
    const s = rgbaToSample(rgba, 3, 1);
    expect(s.lightness[0]).toBeCloseTo(0, 6);
    expect(s.lightness[1]).toBeCloseTo(1, 4);
    expect(s.lightness[2]).toBeCloseTo(0.5, 1); // sRGB 119 ≈ L* 50
    expect(s.alpha[2]).toBeCloseTo(128 / 255, 6);
  });

  it('reuses the output arrays', () => {
    const rgba = new Uint8ClampedArray(4 * 4).fill(255);
    const a = rgbaToSample(rgba, 2, 2);
    const b = rgbaToSample(rgba, 2, 2, a);
    expect(b).toBe(a);
    expect(b.lightness).toBe(a.lightness);
  });
});

describe('contrast levels', () => {
  const sample = () => {
    const n = 100;
    const lightness = new Float32Array(n);
    for (let k = 0; k < n; k++) lightness[k] = k / (n - 1);
    return { width: 10, height: 10, lightness, alpha: new Float32Array(n).fill(1) };
  };

  it('are the 1st and 99th percentile of darkness', () => {
    const l = darknessLevels(sample())!;
    expect(l.lo).toBeLessThan(0.03);
    expect(l.hi).toBeGreaterThan(0.97);
  });

  it('can be supplied from outside (e.g. smoothed over video frames)', () => {
    const img = sample();
    const auto = imageToPotential(img, { depth: 5, invert: false, blur: 0 })!;
    const fixed = imageToPotential(img, { depth: 5, invert: false, blur: 0, levels: { lo: 0, hi: 0.5 } })!;
    // With the darkness range halved, mid-grey (darkness 0.5) already reaches the full depth.
    const k = 4 * 10 + 9; // lightness ≈ 0.5
    expect(fixed.values[k]).toBeLessThan(auto.values[k] - 1);
    expect(fixed.values[k]).toBeCloseTo(-5, 0);
    expect(imageToPotential(img, { depth: 5, invert: false, blur: 0, levels: { lo: 0.4, hi: 0.41 } })).toBeNull();
  });
});

describe('writePotential', () => {
  const grid = (): PotentialGrid => {
    // 4 × 3 grid with one sample of padding on each side, values −(i + j).
    const W = 6;
    const H = 5;
    const values = new Float32Array(W * H);
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) values[j * W + i] = -(i + j) * 0.25;
    return { width: W, height: H, pad: 1, values };
  };

  it('puts grid samples at their world positions (rows downwards)', () => {
    const field = new PotentialField({ cellSize: 0.04, cap: 5 });
    const g = grid();
    const at = { x0: 1, yTop: 2, cell: 0.2 };
    writePotential(field, g, at);
    // Unpadded sample (i, j) = padded (i + 1, j + 1) lies at (x0 + i·cell, yTop − j·cell).
    for (const [i, j] of [
      [0, 0],
      [2, 1],
      [3, 2],
    ]) {
      expect(field.sample(1 + i * 0.2, 2 - j * 0.2)).toBeCloseTo(g.values[(j + 1) * 6 + (i + 1)], 5);
    }
    const b = gridBounds(g, at);
    expect(b.x0).toBeCloseTo(0.8, 12);
    expect(b.y1).toBeCloseTo(2.2, 12);
  });

  it('overwrites only its own rectangle and is repeatable', () => {
    const field = new PotentialField({ cellSize: 0.04, cap: 5 });
    field.applyBrush(-3, -3, 2, 0.3); // something elsewhere on the plane
    const elsewhere = field.sample(-3, -3);
    const at = { x0: 1, yTop: 2, cell: 0.2 };
    writePotential(field, grid(), at);
    const once = field.sample(1.3, 1.7);
    writePotential(field, grid(), at);
    expect(field.sample(1.3, 1.7)).toBeCloseTo(once, 6); // overwrite, not accumulate
    expect(field.sample(-3, -3)).toBeCloseTo(elsewhere, 6); // untouched
  });
});
