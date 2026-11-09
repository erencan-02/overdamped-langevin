import { type DarknessLevels, darknessWeights, type ImageSample } from './imagePotential';

/**
 * Places particles so that their density resembles an image: dark pixels get many particles,
 * light pixels few or none, transparent pixels none.
 *
 * Instead of drawing positions at random (which looks grainy with a couple of thousand
 * particles), the per-pixel expected counts are quantised with Floyd–Steinberg error diffusion,
 * as in halftone printing: every region receives its share of particles to within one particle,
 * and the particles are spread evenly instead of clumping. Each particle is then jittered
 * uniformly within its pixel.
 */

export interface ImagePointsOptions {
  /** Swap light and dark. */
  invert: boolean;
  levels?: DarknessLevels;
  /** Uniform random numbers in [0, 1) for the jitter (defaults to Math.random). */
  random?: () => number;
}

/**
 * Returns about `count` points as (u, v) pairs in pixel units, u to the right and v downwards,
 * pixel (i, j) covering [i − ½, i + ½) × [j − ½, j + ½). Never returns more than `count` points.
 * Returns `null` if the image has no usable contrast.
 */
export function sampleImagePoints(
  img: ImageSample,
  count: number,
  opts: ImagePointsOptions,
): Float64Array | null {
  const weights = darknessWeights(img, opts);
  if (!weights || count <= 0) return null;
  const { width: w, height: h } = img;
  let total = 0;
  for (let k = 0; k < weights.length; k++) total += weights[k];
  if (!(total > 0)) return null;

  // Expected particles per pixel; the sum is `count`.
  const scale = count / total;
  const e = new Float32Array(w * h);
  for (let k = 0; k < e.length; k++) e[k] = weights[k] * scale;

  // Integer Floyd–Steinberg error diffusion, serpentine scan to avoid directional artefacts.
  const hits = new Uint16Array(w * h);
  let emitted = 0;
  for (let j = 0; j < h; j++) {
    const ltr = (j & 1) === 0;
    const dir = ltr ? 1 : -1;
    for (let t = 0; t < w; t++) {
      const i = ltr ? t : w - 1 - t;
      const k = j * w + i;
      const v = e[k];
      const q = Math.max(0, Math.round(v));
      hits[k] = q;
      emitted += q;
      const err = v - q;
      if (err === 0) continue;
      const iNext = i + dir;
      if (iNext >= 0 && iNext < w) e[k + dir] += err * (7 / 16);
      if (j + 1 < h) {
        const below = k + w;
        if (i - dir >= 0 && i - dir < w) e[below - dir] += err * (3 / 16);
        e[below] += err * (5 / 16);
        if (iNext >= 0 && iNext < w) e[below + dir] += err * (1 / 16);
      }
    }
  }

  const random = opts.random ?? Math.random;

  // Error pushed past the image border is lost, so the total can fall a little short (≈1 %).
  // Top up by drawing the missing particles with probability proportional to the weights.
  if (emitted < count) {
    const cdf = new Float64Array(weights.length);
    let acc = 0;
    for (let k = 0; k < weights.length; k++) cdf[k] = acc += weights[k];
    for (let m = emitted; m < count; m++) {
      const r = random() * acc;
      let lo = 0;
      let hi = cdf.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cdf[mid] > r) hi = mid;
        else lo = mid + 1;
      }
      hits[lo]++;
    }
    emitted = count;
  }

  const pts = new Float64Array(2 * emitted);
  let p = 0;
  for (let k = 0; k < hits.length; k++) {
    const q = hits[k];
    if (q === 0) continue;
    const i = k % w;
    const j = (k - i) / w;
    for (let r = 0; r < q; r++) {
      pts[p++] = i + random() - 0.5;
      pts[p++] = j + random() - 0.5;
    }
  }
  if (emitted <= count) return pts;

  // Rounding can overshoot by a few: drop a random subset (partial Fisher–Yates on pairs).
  for (let a = 0; a < count; a++) {
    const b = a + Math.floor(random() * (emitted - a));
    const ax = pts[2 * a];
    const ay = pts[2 * a + 1];
    pts[2 * a] = pts[2 * b];
    pts[2 * a + 1] = pts[2 * b + 1];
    pts[2 * b] = ax;
    pts[2 * b + 1] = ay;
  }
  return pts.slice(0, 2 * count);
}
