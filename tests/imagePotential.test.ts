import { describe, expect, it } from 'vitest';
import { gaussianBlur, imageToPotential, importSize, type ImageSample } from '../src/sim/imagePotential';

/** Synthetic image: white background with a black square in the middle. */
function squareImage(size = 60, opts: { blackOnWhite?: boolean; transparentBg?: boolean } = {}): ImageSample {
  const { blackOnWhite = true, transparentBg = false } = opts;
  const lightness = new Float32Array(size * size);
  const alpha = new Float32Array(size * size).fill(1);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const inside = i >= size / 3 && i < (2 * size) / 3 && j >= size / 3 && j < (2 * size) / 3;
      const dark = inside === blackOnWhite;
      lightness[j * size + i] = dark ? 0 : 1;
      if (transparentBg && !inside) alpha[j * size + i] = 0;
    }
  }
  return { width: size, height: size, lightness, alpha };
}

const at = (g: { width: number; pad: number; values: Float32Array }, i: number, j: number) =>
  g.values[(j + g.pad) * g.width + (i + g.pad)];

describe('imageToPotential', () => {
  it('turns dark areas into valleys and keeps light areas flat', () => {
    const g = imageToPotential(squareImage(), { depth: 5, invert: false, blur: 2 })!;
    expect(at(g, 30, 30)).toBeCloseTo(-5, 3); // centre of the black square
    expect(Math.abs(at(g, 3, 3))).toBeLessThan(1e-6); // white corner
    // Smooth transition across the edge (no single-cell jump of the full depth).
    let maxStep = 0;
    for (let i = 0; i < 59; i++) maxStep = Math.max(maxStep, Math.abs(at(g, i + 1, 30) - at(g, i, 30)));
    expect(maxStep).toBeLessThan(5 / 3);
  });

  it('inverts for light-on-dark images', () => {
    const img = squareImage(60, { blackOnWhite: false }); // white square on black
    const plain = imageToPotential(img, { depth: 5, invert: false, blur: 2 })!;
    const inv = imageToPotential(img, { depth: 5, invert: true, blur: 2 })!;
    // (10, 10) is background, away from both the square and the faded image border.
    expect(at(plain, 10, 10)).toBeCloseTo(-5, 3); // dark background would be a valley…
    expect(at(inv, 30, 30)).toBeCloseTo(-5, 3); // …inverted, the white square is
    expect(Math.abs(at(inv, 10, 10))).toBeLessThan(0.01);
  });

  it('leaves transparent pixels flat', () => {
    // Black square on a transparent (but "black") background.
    const img = squareImage(60, { transparentBg: true });
    img.lightness.fill(0);
    // Give the opaque square some contrast so the image is usable.
    for (let j = 25; j < 35; j++) for (let i = 25; i < 35; i++) img.lightness[j * 60 + i] = 1;
    const g = imageToPotential(img, { depth: 5, invert: false, blur: 1 })!;
    expect(Math.abs(at(g, 2, 2))).toBeLessThan(1e-6);
    expect(at(g, 22, 22)).toBeLessThan(-4);
  });

  it('rejects images without contrast', () => {
    const flat: ImageSample = {
      width: 10,
      height: 10,
      lightness: new Float32Array(100).fill(0.4),
      alpha: new Float32Array(100).fill(1),
    };
    expect(imageToPotential(flat, { depth: 5, invert: false, blur: 1 })).toBeNull();
    const clear: ImageSample = { ...flat, alpha: new Float32Array(100) };
    expect(imageToPotential(clear, { depth: 5, invert: false, blur: 1 })).toBeNull();
  });

  it('pads the grid so the blur can fade out beyond the image', () => {
    const g = imageToPotential(squareImage(30), { depth: 5, invert: true, blur: 2 })!;
    expect(g.pad).toBe(6);
    expect(g.width).toBe(30 + 12);
    expect(g.values[0]).toBeGreaterThan(-0.05); // outer corner of the padding ≈ 0
  });
});

describe('gaussianBlur', () => {
  it('preserves the total away from the borders', () => {
    const W = 41;
    const v = new Float32Array(W * W);
    v[20 * W + 20] = 1;
    gaussianBlur(v, W, W, 2);
    let sum = 0;
    for (const x of v) sum += x;
    expect(sum).toBeCloseTo(1, 4);
    expect(v[20 * W + 20]).toBeCloseTo(1 / (2 * Math.PI * 4), 2);
  });
});

describe('importSize', () => {
  it('keeps the aspect ratio and fits 80 % of the view', () => {
    const s = importSize(1600, 900, { width: 20, height: 12 }, 0.04);
    expect(s.worldWidth / s.worldHeight).toBeCloseTo(16 / 9, 1);
    expect(s.worldWidth).toBeLessThanOrEqual(16 + 0.04);
    expect(s.worldHeight).toBeLessThanOrEqual(9.6 + 0.04);
  });

  it('clamps very small and very large views', () => {
    expect(importSize(100, 100, { width: 1, height: 1 }, 0.04).worldWidth).toBeCloseTo(6, 1);
    const big = importSize(100, 100, { width: 500, height: 400 }, 0.04);
    expect(big.width).toBe(1000);
    expect(big.height).toBe(1000);
  });
});
