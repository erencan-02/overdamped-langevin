/**
 * Converts a decoded image into a potential Ψ.
 *
 * Dark pixels become valleys (Ψ < 0) and light pixels stay flat (Ψ ≈ 0), so particles collect on
 * the dark parts of the picture: the stationary density exp(−2Ψ/σ²) is highest where the image is
 * darkest, and the particle cloud ends up drawing the image. Transparent pixels are flat.
 *
 * The potential is Gaussian-blurred over a few grid cells. Without that, a hard edge would be a
 * jump of the full depth across a single cell, with forces and curvatures far too large for the
 * integrator's time step.
 */

/** A decoded image, one sample per potential grid node, rows top to bottom. */
export interface ImageSample {
  width: number;
  height: number;
  /** Perceptual lightness in [0, 1] (CIE L* / 100). */
  lightness: Float32Array;
  /** Opacity in [0, 1]. */
  alpha: Float32Array;
}

export interface ImagePotentialOptions {
  /** Ψ at the darkest pixel (a positive number; the potential is −depth there). */
  depth: number;
  /** Treat light pixels as valleys instead of dark ones (for light-on-dark images). */
  invert: boolean;
  /** Standard deviation of the smoothing blur, in samples. */
  blur: number;
  /**
   * Darkness range mapped to [0, 1]. Defaults to `darknessLevels(img)`; video passes a range
   * smoothed over frames so that the potential does not flicker with automatic exposure.
   */
  levels?: DarknessLevels;
}

/** Darkness (1 − lightness) values mapped to flat (`lo`) and to the full depth (`hi`). */
export interface DarknessLevels {
  lo: number;
  hi: number;
}

/** Potential on a grid that extends the image by `pad` samples on every side (rows top to bottom). */
export interface PotentialGrid {
  width: number;
  height: number;
  pad: number;
  values: Float32Array;
}

/**
 * Standard deviation of the smoothing blur in world units (≈ 3 grid cells). Shared by image
 * imports and the live camera so both give potentials of the same smoothness.
 */
export const IMAGE_BLUR_WORLD = 0.12;

/** Fraction of opaque pixels ignored at either end when stretching the contrast. */
const CLIP = 0.01;
const BINS = 1024;

/** Smallest usable contrast (difference of the darkness levels). */
export const MIN_CONTRAST = 0.02;

/**
 * Robust contrast range: the 1st and 99th percentile of darkness among opaque pixels, or `null`
 * if there are no opaque pixels.
 */
export function darknessLevels(img: ImageSample): DarknessLevels | null {
  const { lightness, alpha } = img;
  const n = img.width * img.height;
  const hist = new Uint32Array(BINS);
  let opaque = 0;
  for (let k = 0; k < n; k++) {
    if (alpha[k] < 0.5) continue;
    const d = 1 - lightness[k];
    hist[Math.min(BINS - 1, Math.max(0, Math.floor(d * BINS)))]++;
    opaque++;
  }
  if (opaque === 0) return null;
  return { lo: percentile(hist, opaque, CLIP), hi: percentile(hist, opaque, 1 - CLIP) };
}

/**
 * Returns the blurred potential, or `null` if the image has no usable contrast (e.g. a single
 * flat colour, or fully transparent).
 */
export function imageToPotential(img: ImageSample, opts: ImagePotentialOptions): PotentialGrid | null {
  const weights = darknessWeights(img, opts);
  if (!weights) return null;
  const { width: w, height: h } = img;
  const pad = Math.ceil(3 * opts.blur);
  const W = w + 2 * pad;
  const H = h + 2 * pad;
  const values = new Float32Array(W * H);
  for (let j = 0; j < h; j++) {
    const src = j * w;
    const dst = (j + pad) * W + pad;
    for (let i = 0; i < w; i++) values[dst + i] = -opts.depth * weights[src + i];
  }
  if (opts.blur > 0) gaussianBlur(values, W, H, opts.blur);
  return { width: W, height: H, pad, values };
}

/**
 * Per-pixel weight in [0, 1]: contrast-stretched darkness (lightness if `invert`) times
 * opacity. This is the common core of image → Ψ (depth) and image → particles (density).
 * Returns `null` if the image has no usable contrast.
 */
export function darknessWeights(
  img: ImageSample,
  opts: { invert: boolean; levels?: DarknessLevels },
): Float32Array | null {
  const { width: w, height: h, lightness, alpha } = img;
  const levels = opts.levels ?? darknessLevels(img);
  if (!levels || levels.hi - levels.lo < MIN_CONTRAST) return null;
  const { lo, hi } = levels;
  const scale = 1 / (hi - lo);
  const n = w * h;
  const out = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    let s = (1 - lightness[k] - lo) * scale;
    s = s < 0 ? 0 : s > 1 ? 1 : s;
    if (opts.invert) s = 1 - s;
    out[k] = s * alpha[k];
  }
  return out;
}

function percentile(hist: Uint32Array, total: number, q: number): number {
  const target = q * total;
  let acc = 0;
  for (let b = 0; b < hist.length; b++) {
    acc += hist[b];
    if (acc >= target) return (b + 0.5) / hist.length;
  }
  return 1;
}

let blurScratch = new Float32Array(0);

/**
 * In-place separable Gaussian blur with zero padding outside the grid.
 *
 * Both passes are written as "for each tap, add a shifted row", so every inner loop walks
 * memory contiguously (no strided column access) and contains no bounds checks.
 */
export function gaussianBlur(values: Float32Array, W: number, H: number, sigma: number): void {
  const r = Math.ceil(3 * sigma);
  const taps = 2 * r + 1;
  const kernel = new Float32Array(taps);
  let sum = 0;
  for (let t = -r; t <= r; t++) {
    const v = Math.exp(-(t * t) / (2 * sigma * sigma));
    kernel[t + r] = v;
    sum += v;
  }
  for (let t = 0; t < taps; t++) kernel[t] /= sum;

  const n = W * H;
  if (blurScratch.length < n) blurScratch = new Float32Array(n);
  const tmp = blurScratch;

  // Horizontal: values → tmp.
  tmp.fill(0, 0, n);
  for (let j = 0; j < H; j++) {
    const row = j * W;
    for (let t = 0; t < taps; t++) {
      const kt = kernel[t];
      const d = t - r; // tmp[i] += k · values[i + d]
      const iStart = Math.max(0, -d);
      const iEnd = Math.min(W, W - d);
      for (let i = iStart; i < iEnd; i++) tmp[row + i] += kt * values[row + i + d];
    }
  }
  // Vertical: tmp → values.
  values.fill(0, 0, n);
  for (let j = 0; j < H; j++) {
    const out = j * W;
    for (let t = 0; t < taps; t++) {
      const y = j + t - r;
      if (y < 0 || y >= H) continue;
      const kt = kernel[t];
      const src = y * W;
      for (let i = 0; i < W; i++) values[out + i] += kt * tmp[src + i];
    }
  }
}

/**
 * Size of the image on the potential grid, in samples (= grid nodes). The longer side covers
 * `fraction` of the visible view, clamped to [minWorld, maxWorld] world units so that very
 * zoomed-in views still give a usable resolution and zoomed-out views do not allocate huge grids.
 */
export function importSize(
  imageWidth: number,
  imageHeight: number,
  view: { width: number; height: number },
  cellSize: number,
  { fraction = 0.8, minWorld = 6, maxWorld = 40 } = {},
): { width: number; height: number; worldWidth: number; worldHeight: number } {
  const aspect = imageWidth / imageHeight;
  // Largest rectangle with the image's aspect ratio that fits in `fraction` of the view.
  let ww = fraction * view.width;
  let wh = ww / aspect;
  if (wh > fraction * view.height) {
    wh = fraction * view.height;
    ww = wh * aspect;
  }
  const long = Math.max(ww, wh);
  const clamped = Math.min(maxWorld, Math.max(minWorld, long));
  const k = clamped / long;
  ww *= k;
  wh *= k;
  const width = Math.max(2, Math.round(ww / cellSize));
  const height = Math.max(2, Math.round(wh / cellSize));
  return { width, height, worldWidth: width * cellSize, worldHeight: height * cellSize };
}
