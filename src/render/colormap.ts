import { COLORMAP, hexToRgb } from '../config';

const STOPS: readonly number[] = COLORMAP.stops;
const HOT = COLORMAP.hot.map(hexToRgb);
const COLD = COLORMAP.cold.map(hexToRgb);

/**
 * Colour of Ψ = v (sRGB components in [0, 1]) written to out[o..o+2]. The same diverging ramp
 * as the heat-map shader (`ramp` in shaders.ts): white at 0, warm for Ψ > 0, cool for Ψ < 0,
 * saturating at ±cap.
 */
export function psiColor(v: number, cap: number, out: Float32Array | number[], o = 0): void {
  const t = Math.min(1, Math.max(-1, v / cap));
  const a = Math.abs(t);
  const ramp = t >= 0 ? HOT : COLD;
  let r = 1;
  let g = 1;
  let b = 1;
  for (let i = 0; i < STOPS.length - 1; i++) {
    if (a >= STOPS[i]) {
      const s = Math.min(1, Math.max(0, (a - STOPS[i]) / (STOPS[i + 1] - STOPS[i])));
      const c0 = ramp[i];
      const c1 = ramp[i + 1];
      r = c0[0] + (c1[0] - c0[0]) * s;
      g = c0[1] + (c1[1] - c0[1]) * s;
      b = c0[2] + (c1[2] - c0[2]) * s;
    }
  }
  out[o] = r;
  out[o + 1] = g;
  out[o + 2] = b;
}

/** sRGB component → linear (for renderers that work in linear colour, like three.js). */
export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
