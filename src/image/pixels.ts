import type { ImageSample } from '../sim/imagePotential';

/**
 * RGBA pixels → perceptual lightness (CIE L* / 100) and opacity. Shared by the image importer
 * and the live camera.
 */

/** sRGB channel value (0–255) → linear light. */
const LINEAR = new Float32Array(256);
for (let v = 0; v < 256; v++) {
  const c = v / 255;
  LINEAR[v] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** CIE L* / 100 from linear relative luminance Y. */
export function lightnessOf(Y: number): number {
  const L = Y > 216 / 24389 ? 116 * Math.cbrt(Y) - 16 : (24389 / 27) * Y;
  return L / 100;
}

/**
 * lightnessOf() tabulated over Y ∈ [0, 1] and linearly interpolated: avoids a cube root per
 * pixel (the hot spot for video frames) with an error far below one grey level.
 */
const LUT_SIZE = 4096;
const LIGHTNESS = new Float32Array(LUT_SIZE + 2);
for (let i = 0; i <= LUT_SIZE + 1; i++) LIGHTNESS[i] = lightnessOf(Math.min(1, i / LUT_SIZE));

/**
 * Converts `width × height` RGBA pixels into an ImageSample. Pass `out` to reuse its arrays
 * (they must have width·height entries), which avoids allocations for video frames.
 */
export function rgbaToSample(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  out?: ImageSample,
): ImageSample {
  const n = width * height;
  const sample: ImageSample =
    out && out.lightness.length === n
      ? out
      : { width, height, lightness: new Float32Array(n), alpha: new Float32Array(n) };
  sample.width = width;
  sample.height = height;
  const { lightness, alpha } = sample;
  for (let k = 0, p = 0; k < n; k++, p += 4) {
    const Y = 0.2126 * LINEAR[rgba[p]] + 0.7152 * LINEAR[rgba[p + 1]] + 0.0722 * LINEAR[rgba[p + 2]];
    const x = Y * LUT_SIZE;
    const i = x | 0;
    lightness[k] = LIGHTNESS[i] + (LIGHTNESS[i + 1] - LIGHTNESS[i]) * (x - i);
    alpha[k] = rgba[p + 3] * (1 / 255);
  }
  return sample;
}
