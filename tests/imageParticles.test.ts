import { describe, expect, it } from 'vitest';
import { sampleImagePoints } from '../src/sim/imageParticles';
import type { ImageSample } from '../src/sim/imagePotential';
import { Rng } from '../src/sim/rng';

function image(w: number, h: number, f: (i: number, j: number) => number, alpha = () => 1): ImageSample {
  const lightness = new Float32Array(w * h);
  const a = new Float32Array(w * h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      lightness[j * w + i] = f(i, j);
      a[j * w + i] = alpha();
    }
  }
  return { width: w, height: h, lightness, alpha: a };
}

const seeded = () => {
  const r = new Rng(1);
  return () => r.float();
};

describe('sampleImagePoints', () => {
  it("returns exactly the requested number of points", () => {
    const img = image(120, 80, (i, j) => (Math.sin(i / 7) * Math.cos(j / 5) + 1) / 2);
    const pts = sampleImagePoints(img, 2000, { invert: false, random: seeded() })!;
    const n = pts.length / 2;
    expect(n).toBeLessThanOrEqual(2000);
    expect(n).toBe(2000);
  });

  it('puts particles only where the image is dark', () => {
    // Black square in the middle of a white image.
    const img = image(60, 60, (i, j) => (i >= 20 && i < 40 && j >= 20 && j < 40 ? 0 : 1));
    const pts = sampleImagePoints(img, 500, { invert: false, random: seeded() })!;
    for (let p = 0; p < pts.length; p += 2) {
      expect(pts[p]).toBeGreaterThanOrEqual(19.5);
      expect(pts[p]).toBeLessThan(39.5);
      expect(pts[p + 1]).toBeGreaterThanOrEqual(19.5);
      expect(pts[p + 1]).toBeLessThan(39.5);
    }
  });

  it('distributes particles in proportion to darkness', () => {
    // Left half black (weight 1), right half mid-grey: after the contrast stretch the right
    // half has weight 0.5 relative to the left... with a white strip so the range is 0..1.
    const img = image(100, 50, (i) => (i < 45 ? 0 : i < 90 ? 0.5 : 1));
    const pts = sampleImagePoints(img, 3000, { invert: false, random: seeded() })!;
    let left = 0;
    let right = 0;
    let white = 0;
    for (let p = 0; p < pts.length; p += 2) {
      const u = pts[p];
      if (u < 44.5) left++;
      else if (u < 89.5) right++;
      else white++;
    }
    expect(white).toBe(0);
    // Equal areas, weights 1 : 0.5 → counts 2 : 1, to within a couple of particles.
    expect(left / right).toBeGreaterThan(1.95);
    expect(left / right).toBeLessThan(2.05);
  });

  it('spreads particles evenly (no clumping) in a uniform region', () => {
    // A uniformly dark region with ~1 particle per 4 pixels: error diffusion gives about one
    // particle in every 2×2 block, far more regular than independent random sampling.
    const img = image(80, 80, (i) => (i < 79 ? 0 : 1));
    const pts = sampleImagePoints(img, 79 * 80 / 4, { invert: false, random: seeded() })!;
    const counts = new Map<string, number>();
    for (let p = 0; p < pts.length; p += 2) {
      const key = `${Math.floor((pts[p] + 0.5) / 4)},${Math.floor((pts[p + 1] + 0.5) / 4)}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    // 4×4 blocks should hold 4 particles each; allow ±2.
    for (const [key, c] of counts) {
      if (key.startsWith('19,')) continue; // edge column next to the white strip
      expect(c).toBeGreaterThanOrEqual(2);
      expect(c).toBeLessThanOrEqual(6);
    }
  });

  it('honours invert, transparency and flat images', () => {
    const img = image(40, 40, (i) => (i < 20 ? 0 : 1));
    const inv = sampleImagePoints(img, 200, { invert: true, random: seeded() })!;
    for (let p = 0; p < inv.length; p += 2) expect(inv[p]).toBeGreaterThanOrEqual(19.5);

    const clear = image(40, 40, (i) => (i < 20 ? 0 : 1), () => 0);
    expect(sampleImagePoints(clear, 200, { invert: false, random: seeded() })).toBeNull();

    const flat = image(40, 40, () => 0.3);
    expect(sampleImagePoints(flat, 200, { invert: false, random: seeded() })).toBeNull();
  });
});
