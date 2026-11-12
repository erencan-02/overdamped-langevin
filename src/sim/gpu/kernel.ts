import { CHUNK } from '../field';
import type { FormulaWgsl } from '../process';
import type { SchemeId } from '../schemes';
import { WGSL_HELPERS } from './wgsl';

/**
 * The GPU integrator's compute shader (WGSL), built for the current process
 *
 *     dX = (−∇Ψ + u)(t, X) dt + diag(s₁, s₂)(t, X) dW,
 *
 * with Ψ the painted lattice (its nodal gradients, bilinearly interpolated exactly as on the CPU,
 * see field.ts) or a formula with its exact gradient, u and s formulas or absent. One thread
 * advances one particle through all steps of a batch with the chosen scheme, written as the CPU
 * schemes (schemes.ts), in single precision.
 *
 * Random numbers: a counter-based generator (PCG hash) of (seed, particle id, step number), so a
 * run depends on the seed but not on how the steps are split into batches; Box–Muller gives the
 * two normals of a step.
 *
 * Entry points: `advance` (a batch of steps) and `probe_points` (drift and diffusion at given
 * points, to check a kernel against the exact CPU values before it is used).
 */

/** What the kernel computes. */
export interface KernelSpec {
  /** ∇Ψ: the painted lattice, or a formula. */
  psi: { kind: 'lattice' } | { kind: 'formula'; f: FormulaWgsl };
  /** u = (u₁, u₂), or none. */
  drift: readonly [FormulaWgsl, FormulaWgsl] | null;
  /** s = (s₁, s₂), or none (s₁ = s₂ = σ). */
  noise: readonly [FormulaWgsl, FormulaWgsl] | null;
}

export const SCHEME_CODES: Record<SchemeId, number> = { heun: 0, 'euler-maruyama': 1, milstein: 2 };

/** Threads per workgroup. */
export const WORKGROUP = 64;
/** Floats per probe point: x, y in; bx, by, s1, s2, ∂s₁/∂x, ∂s₂/∂y out. */
export const PROBE_STRIDE = 8;

/**
 * Uniform parameters, in this order (all 4-byte scalars; see `paramsData`):
 * n, steps, seed, stepLo, stepHi, scheme, noisy, probeN (u32), t0, dt, sigma, invH (f32),
 * ix0, iy0, iw, ih (i32).
 */
export const PARAMS_BYTES = 64;

export interface StepParams {
  n: number;
  steps: number;
  seed: number;
  /** Number of the first step (since t = 0): the random numbers depend on it. */
  stepIndex: number;
  scheme: SchemeId;
  noisy: boolean;
  probeN: number;
  t0: number;
  dt: number;
  sigma: number;
  /** 1 / lattice spacing. */
  invH: number;
  /** The chunk index of the lattice: first chunk (x, y), width and height in chunks. */
  index: { x0: number; y0: number; w: number; h: number };
}

export function paramsData(p: StepParams): ArrayBuffer {
  const buf = new ArrayBuffer(PARAMS_BYTES);
  const u = new Uint32Array(buf);
  const f = new Float32Array(buf);
  const i = new Int32Array(buf);
  u[0] = p.n;
  u[1] = p.steps;
  u[2] = p.seed >>> 0;
  u[3] = p.stepIndex % 2 ** 32;
  u[4] = Math.floor(p.stepIndex / 2 ** 32) >>> 0;
  u[5] = SCHEME_CODES[p.scheme];
  u[6] = p.noisy ? 1 : 0;
  u[7] = p.probeN;
  f[8] = p.t0;
  f[9] = p.dt;
  f[10] = p.sigma;
  f[11] = p.invH;
  i[12] = p.index.x0;
  i[13] = p.index.y0;
  i[14] = p.index.w;
  i[15] = p.index.h;
  return buf;
}

/** A function of (x, y, t, sigma) with r and θ derived from x and y. */
function fn(name: string, result: string, body: string): string {
  return `fn ${name}(x: f32, y: f32, t: f32, sigma: f32) -> ${result} {
  let r = sqrt(x * x + y * y);
  let theta = atan2(y, x);
  ${body}
}
`;
}

/** The gradient of a formula: ∂/∂x, ∂/∂y plus the chain rule for r and θ (as latex.ts does on the CPU). */
function gradient(name: string, f: FormulaWgsl): string {
  return fn(
    name,
    'vec2<f32>',
    `var g = vec2<f32>(${f.dx}, ${f.dy});
  if (r > 0.0) {
    let dr = ${f.dr};
    let dth = ${f.dtheta};
    g = g + vec2<f32>(dr * x / r - dth * y / (r * r), dr * y / r + dth * x / (r * r));
  }
  return g;`,
  );
}

export function kernelSource(spec: KernelSpec): string {
  const parts: string[] = [WGSL_HELPERS];

  // ∇Ψ
  if (spec.psi.kind === 'formula') {
    parts.push(gradient('psi_grad', spec.psi.f));
    parts.push(`fn grad_psi(p: vec2<f32>, t: f32) -> vec2<f32> { return psi_grad(p.x, p.y, t, P.sigma); }\n`);
  } else {
    parts.push(LATTICE);
  }

  // b = −∇Ψ + u
  if (spec.drift) {
    parts.push(fn('u_1', 'f32', `return ${spec.drift[0].value};`));
    parts.push(fn('u_2', 'f32', `return ${spec.drift[1].value};`));
    parts.push(`fn drift(p: vec2<f32>, t: f32) -> vec2<f32> {
  return -grad_psi(p, t) + vec2<f32>(u_1(p.x, p.y, t, P.sigma), u_2(p.x, p.y, t, P.sigma));
}
`);
  } else {
    parts.push(`fn drift(p: vec2<f32>, t: f32) -> vec2<f32> { return -grad_psi(p, t); }\n`);
  }

  // (s₁, s₂, ∂s₁/∂x, ∂s₂/∂y)
  if (spec.noise) {
    parts.push(fn('s_1', 'f32', `return ${spec.noise[0].value};`));
    parts.push(fn('s_2', 'f32', `return ${spec.noise[1].value};`));
    parts.push(gradient('s_1_grad', spec.noise[0]));
    parts.push(gradient('s_2_grad', spec.noise[1]));
    parts.push(`fn diffusion(p: vec2<f32>, t: f32) -> vec4<f32> {
  let s = P.sigma;
  return vec4<f32>(s_1(p.x, p.y, t, s), s_2(p.x, p.y, t, s), s_1_grad(p.x, p.y, t, s).x, s_2_grad(p.x, p.y, t, s).y);
}
`);
  } else {
    parts.push(`fn diffusion(p: vec2<f32>, t: f32) -> vec4<f32> { return vec4<f32>(P.sigma, P.sigma, 0.0, 0.0); }\n`);
  }

  return `${HEADER}\n${parts.join('\n')}\n${MAIN}`;
}

const HEADER = /* wgsl */ `
struct Params {
  n: u32, steps: u32, seed: u32, stepLo: u32,
  stepHi: u32, scheme: u32, noisy: u32, probeN: u32,
  t0: f32, dt: f32, sigma: f32, invH: f32,
  ix0: i32, iy0: i32, iw: i32, ih: i32,
}
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read_write> pos: array<vec2<f32>>;
@group(0) @binding(2) var<storage, read> ids: array<u32>;
@group(0) @binding(3) var<storage, read> chunkIndex: array<i32>;
@group(0) @binding(4) var<storage, read> chunkGrad: array<vec2<f32>>;
@group(0) @binding(5) var<storage, read_write> probeBuf: array<f32>;
`;

/** ∇Ψ of the painted lattice: nodal gradients of the chunks, bilinearly interpolated. */
const LATTICE = /* wgsl */ `
fn node_grad(i: i32, j: i32) -> vec2<f32> {
  let cx = (i >> ${Math.log2(CHUNK)}u) - P.ix0;
  let cy = (j >> ${Math.log2(CHUNK)}u) - P.iy0;
  if (cx < 0 || cy < 0 || cx >= P.iw || cy >= P.ih) { return vec2<f32>(0.0, 0.0); }
  let slot = chunkIndex[cy * P.iw + cx];
  if (slot < 0) { return vec2<f32>(0.0, 0.0); }
  let li = i & ${CHUNK - 1};
  let lj = j & ${CHUNK - 1};
  return chunkGrad[u32(slot) * ${CHUNK * CHUNK}u + u32(lj * ${CHUNK} + li)];
}
fn grad_psi(p: vec2<f32>, t: f32) -> vec2<f32> {
  let u = p.x * P.invH;
  let v = p.y * P.invH;
  let fi = floor(u);
  let fj = floor(v);
  let i = i32(fi);
  let j = i32(fj);
  let fx = u - fi;
  let fy = v - fj;
  return node_grad(i, j) * ((1.0 - fx) * (1.0 - fy)) + node_grad(i + 1, j) * (fx * (1.0 - fy))
    + node_grad(i, j + 1) * ((1.0 - fx) * fy) + node_grad(i + 1, j + 1) * (fx * fy);
}
`;

const MAIN = /* wgsl */ `
fn finite(v: f32) -> bool { return (bitcast<u32>(v) & 0x7fffffffu) < 0x7f800000u; }

fn pcg(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}

/** Two standard normals for particle \`id\` at step (hi, lo). */
fn normals(id: u32, lo: u32, hi: u32) -> vec2<f32> {
  let h1 = pcg(pcg(pcg(P.seed ^ 0x9e3779b9u) ^ hi) ^ lo) ^ id;
  let a = pcg(h1);
  let b = pcg(a ^ 0x85ebca6bu);
  let u1 = (f32(a >> 8u) + 0.5) / 16777216.0;
  let u2 = f32(b >> 8u) / 16777216.0;
  let rad = sqrt(-2.0 * log(u1));
  let ang = 6.283185307179586 * u2;
  return vec2<f32>(rad * cos(ang), rad * sin(ang));
}

@compute @workgroup_size(${WORKGROUP})
fn advance(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= P.n) { return; }
  var p = pos[i];
  let id = ids[i];
  let dt = P.dt;
  let sq = sqrt(dt);
  for (var k = 0u; k < P.steps; k = k + 1u) {
    let t = P.t0 + f32(k) * dt;
    let lo = P.stepLo + k;
    let hi = P.stepHi + select(0u, 1u, lo < P.stepLo);
    let noisy = P.noisy == 1u;
    var w = vec2<f32>(0.0, 0.0);
    if (noisy) { w = normals(id, lo, hi); }
    let a = drift(p, t);
    var q: vec2<f32>;
    if (P.scheme == 0u) {
      // Stochastic Heun: predictor with Euler–Maruyama, corrector with the drift at t + dt;
      // the same increment, the noise at the start of the step (Itô).
      var dw = vec2<f32>(0.0, 0.0);
      if (noisy) { dw = diffusion(p, t).xy * sq * w; }
      let pred = p + a * dt + dw;
      let b = drift(pred, t + dt);
      q = p + (a + b) * (0.5 * dt) + dw;
    } else if (P.scheme == 1u) {
      // Euler–Maruyama.
      q = p + a * dt;
      if (noisy) { q = q + diffusion(p, t).xy * sq * w; }
    } else {
      // Milstein for diagonal noise.
      q = p + a * dt;
      if (noisy) {
        let s = diffusion(p, t);
        let w1 = sq * w.x;
        let w2 = sq * w.y;
        q = q + vec2<f32>(s.x * w1 + 0.5 * s.x * s.z * (w1 * w1 - dt), s.y * w2 + 0.5 * s.y * s.w * (w2 * w2 - dt));
      }
    }
    // A coefficient undefined somewhere: the particle stays (as on the CPU).
    if (finite(q.x) && finite(q.y)) { p = q; }
  }
  pos[i] = p;
}

@compute @workgroup_size(${WORKGROUP})
fn probe_points(@builtin(global_invocation_id) gid: vec3<u32>) {
  let k = gid.x;
  if (k >= P.probeN) { return; }
  let o = k * ${PROBE_STRIDE}u;
  let p = vec2<f32>(probeBuf[o], probeBuf[o + 1u]);
  let b = drift(p, P.t0);
  let s = diffusion(p, P.t0);
  probeBuf[o + 2u] = b.x;
  probeBuf[o + 3u] = b.y;
  probeBuf[o + 4u] = s.x;
  probeBuf[o + 5u] = s.y;
  probeBuf[o + 6u] = s.z;
  probeBuf[o + 7u] = s.w;
}
`;
