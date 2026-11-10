import { PSI_COLOR_GLSL } from './shaders';

/** A formula Ψ(t, x, y) in GLSL, as compiled by the Compute Engine. */
export interface GlslFormula {
  code: string;
  preamble: string;
}

/**
 * GLSL that defines `float psiFormula(float x, float y, float t, float sigma)`: the engine's
 * helper functions, then the formula with r and θ derived from x and y. The parameters shadow
 * anything with the same name around it, so the snippet can be put into any shader.
 */
export function psiFormulaGlsl(f: GlslFormula): string {
  return `
${f.preamble}
float psiFormula(float x, float y, float t, float sigma) {
  float r = sqrt(x * x + y * y);
  float theta = atan(y, x);
  return (${f.code});
}
`;
}

/**
 * Heat map of a formula, evaluated per pixel: world position from the pixel, Ψ from the
 * formula, colour and iso-lines from the shared colour map. Undefined values are drawn white.
 */
export function formulaFieldFs(f: GlslFormula): string {
  return /* glsl */ `#version 300 es
precision highp float;
uniform vec2 u_res;
uniform float u_scale;    // device px per world unit
uniform vec2 u_center;    // camera centre (world)
uniform float u_t;
uniform float u_sigma;
uniform float u_cap;
uniform float u_contours;
out vec4 o_color;
${PSI_COLOR_GLSL}
${psiFormulaGlsl(f)}
void main() {
  vec2 p = u_center + (gl_FragCoord.xy - 0.5 * u_res) / u_scale;
  float v = psiFormula(p.x, p.y, u_t, u_sigma);
  bool bad = isnan(v) || isinf(v);
  vec3 c = psiColor(bad ? 0.0 : v, u_cap, u_contours > 0.5);
  o_color = vec4(bad ? vec3(1.0) : c, 1.0);
}`;
}

/** Check program: point k (at pixel k of a 1-pixel-high target) writes Ψ at a_xy into red. */
export const FORMULA_CHECK_VS = /* glsl */ `#version 300 es
in vec2 a_xy;
uniform float u_n;
flat out vec2 v_xy;
void main() {
  v_xy = a_xy;
  gl_Position = vec4((float(gl_VertexID) + 0.5) / u_n * 2.0 - 1.0, 0.0, 0.0, 1.0);
  gl_PointSize = 1.0;
}`;

export function formulaCheckFs(f: GlslFormula): string {
  return /* glsl */ `#version 300 es
precision highp float;
uniform float u_t;
uniform float u_sigma;
flat in vec2 v_xy;
out vec4 o_value;
${psiFormulaGlsl(f)}
void main() {
  o_value = vec4(psiFormula(v_xy.x, v_xy.y, u_t, u_sigma), 0.0, 0.0, 1.0);
}`;
}

/** Points (and a time and σ) at which the GPU formula is checked against the exact one. */
export const FORMULA_CHECK = {
  points: [
    [0.37, -0.61],
    [1.3, 0.8],
    [-0.9, 1.7],
    [-1.6, -0.45],
    [2.2, 0.15],
    [0.05, -1.25],
    [3.4, -2.7],
    [-2.9, 3.1],
  ] as const,
  t: 0.73,
  sigma: 0.6,
};
