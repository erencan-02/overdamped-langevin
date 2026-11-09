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
}

/** Potential on a grid that extends the image by `pad` samples on every side (rows top to bottom). */
export interface PotentialGrid {
  width: number;
  height: number;
  pad: number;
  values: Float32Array;
}

/** Fraction of opaque pixels ignored at either end when stretching the contrast. */
const CLIP = 0.01;
const BINS = 1024;

/**
 * Returns the blurred potential, or `null` if the image has no usable contrast (e.g. a single
 * flat colour, or fully transparent).
 */
export function imageToPotential(img: ImageSample, opts: ImagePotentialOptions): PotentialGrid | null {
  const { width: w, height: h, lightness, alpha } = img;
  const n = w * h;

  // Robust contrast stretch: map the 1st..99th percentile of darkness among opaque pixels to [0, 1].
  const hist = new Uint32Array(BINS);
  let opaque = 0;
  for (let k = 0; k < n; k++) {
    if (alpha[k] < 0.5) continue;
    const d = 1 - lightness[k];
    hist[Math.min(BINS - 1, Math.max(0, Math.floor(d * BINS)))]++;
    opaque++;
  }
  if (opaque === 0) return null;
  const lo = percentile(hist, opaque, CLIP);
  const hi = percentile(hist, opaque, 1 - CLIP);
  if (hi - lo < 0.02) return null;

  const pad = Math.ceil(3 * opts.blur);
  const W = w + 2 * pad;
  const H = h + 2 * pad;
  const values = new Float32Array(W * H);
  const scale = 1 / (hi - lo);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const k = j * w + i;
      let s = (1 - lightness[k] - lo) * scale;
      s = s < 0 ? 0 : s > 1 ? 1 : s;
      if (opts.invert) s = 1 - s;
      values[(j + pad) * W + (i + pad)] = -opts.depth * s * alpha[k];
    }
  }
  if (opts.blur > 0) gaussianBlur(values, W, H, opts.blur);
  return { width: W, height: H, pad, values };
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

/** In-place separable Gaussian blur with zero padding outside the grid. */
export function gaussianBlur(values: Float32Array, W: number, H: number, sigma: number): void {
  const r = Math.ceil(3 * sigma);
  const kernel = new Float32Array(2 * r + 1);
  let sum = 0;
  for (let t = -r; t <= r; t++) {
    const v = Math.exp(-(t * t) / (2 * sigma * sigma));
    kernel[t + r] = v;
    sum += v;
  }
  for (let t = 0; t < kernel.length; t++) kernel[t] /= sum;

  const tmp = new Float32Array(Math.max(W, H));
  // Rows
  for (let j = 0; j < H; j++) {
    const row = j * W;
    for (let i = 0; i < W; i++) {
      let acc = 0;
      const a = Math.max(0, i - r);
      const b = Math.min(W - 1, i + r);
      for (let x = a; x <= b; x++) acc += values[row + x] * kernel[x - i + r];
      tmp[i] = acc;
    }
    values.set(tmp.subarray(0, W), row);
  }
  // Columns
  for (let i = 0; i < W; i++) {
    for (let j = 0; j < H; j++) {
      let acc = 0;
      const a = Math.max(0, j - r);
      const b = Math.min(H - 1, j + r);
      for (let y = a; y <= b; y++) acc += values[y * W + i] * kernel[y - j + r];
      tmp[j] = acc;
    }
    for (let j = 0; j < H; j++) values[j * W + i] = tmp[j];
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
