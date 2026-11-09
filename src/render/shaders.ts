import { COLORMAP, hexToRgb } from '../config';

const N = COLORMAP.stops.length;
const f = (v: number) => (Number.isInteger(v) ? v.toFixed(1) : String(v));
const glslFloats = (v: readonly number[]) => v.map(f).join(', ');
const glslColors = (v: readonly string[]) =>
  v.map((h) => `vec3(${hexToRgb(h).map((c) => c.toFixed(4)).join(', ')})`).join(', ');

/**
 * GLSL ES 3.0 shaders. All fragment shaders output premultiplied alpha
 * (blendFunc(ONE, ONE_MINUS_SRC_ALPHA)).
 */

/** Shared world → clip transform. Positions are relative to the camera centre. */
const VIEW = /* glsl */ `
uniform vec2 u_center;   // camera centre (world)
uniform float u_scale;   // device pixels per world unit
uniform vec2 u_res;      // framebuffer size in device pixels
vec2 worldToClip(vec2 relWorld) { return relWorld * u_scale * 2.0 / u_res; }
`;

// ------------------------------------------------------------------ potential field

export const FIELD_VS = /* glsl */ `#version 300 es
in vec2 a_pos;            // unit quad corner in [0,1]^2
uniform vec4 u_rect;      // chunk rectangle relative to the camera centre (x0, y0, x1, y1)
uniform float u_texN;     // texture size (nodes per side incl. the shared border)
${VIEW}
out vec2 v_uv;
void main() {
  vec2 p = mix(u_rect.xy, u_rect.zw, a_pos);
  // Node k sits at texel centre (k + 0.5) / N, so bilinear filtering reproduces the
  // bilinear interpolation between lattice nodes exactly.
  v_uv = (0.5 + a_pos * (u_texN - 1.0)) / u_texN;
  gl_Position = vec4(worldToClip(p), 0.0, 1.0);
}`;

export const FIELD_FS = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D u_tex;
uniform float u_cap;
uniform float u_contours;   // 0 or 1
in vec2 v_uv;
out vec4 o_color;

// Diverging colour map: white at 0, warm (yellow → orange → red) for Ψ > 0,
// cool (mint → teal → blue → indigo → purple) for Ψ < 0.
const float P[${N}] = float[${N}](${glslFloats(COLORMAP.stops)});
const vec3 HOT[${N}] = vec3[${N}](${glslColors(COLORMAP.hot)});
const vec3 COLD[${N}] = vec3[${N}](${glslColors(COLORMAP.cold)});

vec3 ramp(float t, bool hot) {
  vec3 c = vec3(1.0);
  for (int i = 0; i < ${N - 1}; i++) {
    float a = P[i];
    float b = P[i + 1];
    if (t >= a) {
      float s = clamp((t - a) / (b - a), 0.0, 1.0);
      c = hot ? mix(HOT[i], HOT[i + 1], s) : mix(COLD[i], COLD[i + 1], s);
    }
  }
  return c;
}

void main() {
  float v = texture(u_tex, v_uv).r;
  float t = clamp(v / u_cap, -1.0, 1.0);
  vec3 c = ramp(abs(t), t >= 0.0);

  if (u_contours > 0.5) {
    // Iso-lines at Ψ = (k + 1/2)·cap/10, so neither Ψ = 0 nor the capped plateau is a level.
    float lv = v * 10.0 / u_cap;
    float fw = fwidth(lv);
    float d = abs(fract(lv) - 0.5) / max(fw, 1e-6);
    float line = (1.0 - smoothstep(0.5, 1.5, d)) * (1.0 - smoothstep(0.15, 0.45, fw));
    c = mix(c, c * 0.78, line * 0.55);
  }
  o_color = vec4(c, 1.0);
}`;

// ------------------------------------------------------------------ grid

export const FULLSCREEN_VS = /* glsl */ `#version 300 es
const vec2 P[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
void main() { gl_Position = vec4(P[gl_VertexID], 0.0, 1.0); }`;

export const GRID_FS = /* glsl */ `#version 300 es
precision highp float;
uniform vec2 u_res;
uniform float u_scale;     // device px per world unit
uniform vec2 u_offset;     // camera centre modulo the major spacing (world)
uniform vec2 u_axisPx;     // device-pixel position of the world origin (gl_FragCoord space)
uniform float u_minor;     // minor spacing (world)
uniform float u_major;     // major spacing (world)
uniform float u_minorAlpha;
uniform float u_dpr;
out vec4 o_color;

float lineMask(vec2 p, float spacing, float halfWidthPx) {
  vec2 q = p / spacing;
  vec2 distPx = abs(fract(q + 0.5) - 0.5) * spacing * u_scale;
  vec2 m = 1.0 - smoothstep(halfWidthPx - 0.5, halfWidthPx + 0.5, distPx);
  return max(m.x, m.y);
}

void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * u_res) / u_scale + u_offset;
  float hw = 0.5 * u_dpr;
  float minor = lineMask(p, u_minor, hw) * u_minorAlpha;
  float major = lineMask(p, u_major, hw);
  vec2 ad = abs(gl_FragCoord.xy - u_axisPx);
  vec2 am = 1.0 - smoothstep(0.75 * u_dpr - 0.5, 0.75 * u_dpr + 0.5, ad);
  float axis = max(am.x, am.y);
  float a = max(max(minor * 0.06, major * 0.13), axis * 0.42);
  vec3 ink = vec3(0.059, 0.090, 0.165);  // slate-900
  o_color = vec4(ink * a, a);
}`;

// ------------------------------------------------------------------ trails

export const TRAIL_VS = /* glsl */ `#version 300 es
// One instance per particle, 6 vertices (two triangles) per trail segment. Segment k joins
// trail point k and k + 1, where point 0 is the particle's current position and point j >= 1
// is the j-th most recent entry of its ring buffer, stored in row gl_InstanceID of u_ring.
in vec4 a_inst;            // (x, y, colour index, number of stored trail points)
uniform highp sampler2D u_ring;
uniform int u_head;        // ring slot of the most recent entry
uniform int u_len;         // ring length
uniform float u_width;     // device px
uniform float u_alpha;
uniform vec3 u_palette[12];
${VIEW}
out vec4 v_color;
out float v_across;
out float v_halfWidth;

const float T[6] = float[6](0.0, 1.0, 0.0, 0.0, 1.0, 1.0);
const float S[6] = float[6](-1.0, -1.0, 1.0, 1.0, -1.0, 1.0);

vec2 trailPoint(int k) {
  if (k == 0) return a_inst.xy;
  int slot = (u_head - (k - 1) + u_len) % u_len;
  return texelFetch(u_ring, ivec2(slot, gl_InstanceID), 0).xy;
}

void main() {
  int seg = gl_VertexID / 6;
  int corner = gl_VertexID - seg * 6;
  int stored = int(a_inst.w + 0.5);
  if (seg >= stored) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float t = T[corner];
  float side = S[corner];
  vec2 s0 = (trailPoint(seg) - u_center) * u_scale;
  vec2 s1 = (trailPoint(seg + 1) - u_center) * u_scale;
  vec2 dir = s1 - s0;
  float len = length(dir);
  vec2 n = len > 1e-4 ? vec2(-dir.y, dir.x) / len : vec2(0.0);
  float age = float(seg) + t;
  float life = clamp(1.0 - age / float(u_len + 1), 0.0, 1.0);
  float hw = 0.5 * u_width * (0.35 + 0.65 * life);
  vec2 s = mix(s0, s1, t) + n * side * (hw + 1.0);
  gl_Position = vec4(s * 2.0 / u_res, 0.0, 1.0);
  v_color = vec4(u_palette[int(a_inst.z + 0.5)], u_alpha * life * life);
  v_across = side * (hw + 1.0);
  v_halfWidth = hw;
}`;

export const TRAIL_FS = /* glsl */ `#version 300 es
precision highp float;
in vec4 v_color;
in float v_across;
in float v_halfWidth;
out vec4 o_color;
void main() {
  float cov = 1.0 - smoothstep(v_halfWidth - 0.5, v_halfWidth + 0.5, abs(v_across));
  float a = v_color.a * cov;
  o_color = vec4(v_color.rgb * a, a);
}`;

// ------------------------------------------------------------------ particles

export const PARTICLE_VS = /* glsl */ `#version 300 es
in vec2 a_corner;    // [-1, 1]^2
in vec3 a_inst;      // (x, y, colour index); the 4th component is unused here
uniform float u_extent;    // half size of the quad in device px
uniform vec3 u_palette[12];
${VIEW}
out vec2 v_px;
out vec3 v_color;
void main() {
  vec2 c = worldToClip(a_inst.xy - u_center);
  gl_Position = vec4(c + a_corner * u_extent * 2.0 / u_res, 0.0, 1.0);
  v_px = a_corner * u_extent;
  v_color = u_palette[int(a_inst.z + 0.5)];
}`;

export const PARTICLE_FS = /* glsl */ `#version 300 es
precision highp float;
uniform float u_radius;   // device px
uniform float u_ring;     // device px
uniform float u_halo;     // device px
in vec2 v_px;
in vec3 v_color;
out vec4 o_color;
void main() {
  float d = length(v_px);
  float fill = 1.0 - smoothstep(u_radius - 0.75, u_radius + 0.75, d);
  float ring = 1.0 - smoothstep(u_radius + u_ring - 0.75, u_radius + u_ring + 0.75, d);
  // A thin dark outline outside the white ring keeps particles visible on any background.
  float edge = u_radius + u_ring;
  float outline = 1.0 - smoothstep(edge + 0.6, edge + 1.6, d);
  float halo = 1.0 - smoothstep(edge, edge + u_halo, d);
  vec3 body = mix(vec3(1.0), v_color, fill);
  float bodyA = ring;
  float shadowA = max(0.75 * outline, 0.18 * halo);
  // body over the dark outline/halo (premultiplied, the shadow is black)
  vec3 rgb = body * bodyA;
  float a = bodyA + shadowA * (1.0 - bodyA);
  o_color = vec4(rgb, a);
}`;
