import { PALETTE_RGB } from '../config';
import { CHUNK, type Chunk, chunkKey, type PotentialField } from '../sim/field';
import { MAX_PARTICLES, type ParticleSystem, TRAIL_LEN } from '../sim/particles';
import type { Camera } from '../view/camera';
import type { DriftField } from '../sim/process';
import {
  FORMULA_CHECK,
  FORMULA_CHECK_VS,
  formulaCheckFs,
  formulaFieldFs,
  type GlslFormula,
} from './formulaShader';
import { ARROW_FLOATS, arrowSpacing, buildArrows } from '../view/forceField';
import { gridSpacing } from '../view/gridSpacing';
import { createBuffer, createProgram, type Program } from './gl';
import type { DensityImage } from '../analysis/equilibrium';
import {
  ARROW_FS,
  ARROW_VS,
  DENSITY_FS,
  DENSITY_VS,
  FIELD_FS,
  FIELD_VS,
  FULLSCREEN_VS,
  GRID_FS,
  PARTICLE_FS,
  PARTICLE_VS,
  TRAIL_FS,
  TRAIL_VS,
} from './shaders';

/** Nodes per texture side: a chunk's own nodes plus the first row/column of its neighbours. */
const TEX_N = CHUNK + 1;
const INST_FLOATS = 4; // particle instance: x, y, colour, stored trail points

/** While only Ψ's values change, force arrows are rebuilt at most this often (real time). */
const ARROW_REFRESH_MS = 33;

export interface RenderOptions {
  grid: boolean;
  trails: boolean;
  contours: boolean;
  /** Show the force field −∇Ψ as arrows. */
  forceField: boolean;
  /**
   * Where the arrows take −∇Ψ from (default: the drawn field), with counters that change with
   * it. With a formula potential this is its exact gradient.
   */
  arrows?: DriftField & { readonly revision: number; readonly epoch: number };
  /**
   * Draw Ψ from the formula given to `setFormula` (on the GPU, per pixel) at this time and σ,
   * instead of the field's lattice.
   */
  formula?: { t: number; sigma: number };
  /** Smoothed empirical measure to draw, or null. */
  density: DensityImage | null;
}

/**
 * WebGL2 renderer: potential heat map (one R16F texture per chunk), procedural grid,
 * particle trails (ring buffer kept on the GPU) and particles (instanced point sprites).
 */
export class Renderer {
  readonly gl: WebGL2RenderingContext;
  private readonly fieldProg: Program;
  private readonly gridProg: Program;
  private readonly trailProg: Program;
  private readonly particleProg: Program;
  private readonly arrowProg: Program;
  private readonly densityProg: Program;
  private densityTex: WebGLTexture | null = null;
  private densitySize = '';
  private densityVersion = -1;
  private densityScratch = new Float32Array(0);

  private readonly fieldVao: WebGLVertexArrayObject;
  private readonly gridVao: WebGLVertexArrayObject;
  private readonly trailVao: WebGLVertexArrayObject;
  private readonly particleVao: WebGLVertexArrayObject;
  private readonly arrowVao: WebGLVertexArrayObject;

  /** Force-field arrows, rebuilt only when the view or Ψ changes. */
  private readonly arrowBuffer: WebGLBuffer;
  private arrowData: Float32Array = new Float32Array(0);
  private arrowCapacity = 0; // floats
  private arrowCount = 0;
  private arrowKey = '';
  private arrowArea: { x0: number; y0: number; x1: number; y1: number } | null = null;

  private readonly particleBuffer: WebGLBuffer;
  private readonly particleData = new Float32Array(MAX_PARTICLES * INST_FLOATS);
  private particleInstances = 0;
  private uploadedVersion = -1;

  /** Trail ring buffer: RG32F texture, one row per particle, one column per ring slot. */
  private readonly ringTex: WebGLTexture;
  private readonly column = new Float32Array(MAX_PARTICLES * 2);
  private uploadedWrites = -1;
  private uploadedLayout = -1;
  private headSlot = 0;

  private readonly textures = new Map<number, WebGLTexture>();
  private fieldEpoch = -1;
  private fieldRef: PotentialField | null = null;
  private readonly scratch = new Float32Array(TEX_N * TEX_N);

  private dpr = 1;
  private arrowBuiltAt = -Infinity;
  /** Heat map of the formula set by `setFormula` (null: none, or it did not pass the check). */
  private formulaProg: Program | null = null;

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: true,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 is not supported by this browser.');
    this.gl = gl;

    this.fieldProg = createProgram(gl, FIELD_VS, FIELD_FS);
    this.gridProg = createProgram(gl, FULLSCREEN_VS, GRID_FS);
    this.trailProg = createProgram(gl, TRAIL_VS, TRAIL_FS);
    this.particleProg = createProgram(gl, PARTICLE_VS, PARTICLE_FS);
    this.arrowProg = createProgram(gl, ARROW_VS, ARROW_FS);
    this.densityProg = createProgram(gl, DENSITY_VS, DENSITY_FS);

    // Field: unit quad as a triangle strip.
    this.fieldVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.fieldVao);
    createBuffer(gl, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]));
    this.enableAttrib(this.fieldProg, 'a_pos', 2, 0, 0, 0);

    // Grid: full-screen triangle generated from gl_VertexID.
    this.gridVao = gl.createVertexArray()!;

    // Particles: per-vertex corner + per-instance (x, y, colour, trail length).
    this.particleVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.particleVao);
    createBuffer(gl, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]));
    this.enableAttrib(this.particleProg, 'a_corner', 2, 0, 0, 0);
    this.particleBuffer = createBuffer(gl, this.particleData.byteLength, gl.DYNAMIC_DRAW);
    this.enableAttrib(this.particleProg, 'a_inst', 3, INST_FLOATS * 4, 0, 1);

    // Trails: no per-vertex data (gl_VertexID), the same per-instance particle data.
    this.trailVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.trailVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.particleBuffer);
    this.enableAttrib(this.trailProg, 'a_inst', 4, INST_FLOATS * 4, 0, 1);

    this.ringTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.ringTex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RG32F, TRAIL_LEN, MAX_PARTICLES);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);

    // Arrows: per-vertex corner + per-instance (x, y, ux, uy) and (length, opacity).
    this.arrowVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.arrowVao);
    createBuffer(gl, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]));
    this.enableAttrib(this.arrowProg, 'a_corner', 2, 0, 0, 0);
    this.arrowBuffer = createBuffer(gl, 16, gl.DYNAMIC_DRAW);
    this.enableAttrib(this.arrowProg, 'a_arrow', 4, ARROW_FLOATS * 4, 0, 1);
    this.enableAttrib(this.arrowProg, 'a_meta', 2, ARROW_FLOATS * 4, 16, 1);

    gl.bindVertexArray(null);
    gl.disable(gl.DEPTH_TEST);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  private enableAttrib(
    prog: Program,
    name: string,
    size: number,
    stride: number,
    offset: number,
    divisor: number,
  ): void {
    const gl = this.gl;
    const loc = prog.attribs[name];
    if (loc === undefined || loc < 0) return;
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset);
    gl.vertexAttribDivisor(loc, divisor);
  }

  /** Resizes the drawing buffer to match the CSS size × devicePixelRatio. */
  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    this.dpr = dpr;
    const w = Math.max(1, Math.round(cssWidth * dpr));
    const h = Math.max(1, Math.round(cssHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  /** Releases the field textures (they are re-created on demand). */
  private dropFieldTextures(): void {
    for (const t of this.textures.values()) this.gl.deleteTexture(t);
    this.textures.clear();
  }

  // ---------------------------------------------------------------- frame

  render(cam: Camera, field: PotentialField, ps: ParticleSystem, opts: RenderOptions): void {
    const gl = this.gl;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const scale = cam.scale * this.dpr; // device px per world unit
    gl.viewport(0, 0, W, H);
    gl.clearColor(1, 1, 1, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    if (opts.formula && this.formulaProg) {
      this.drawFormula(cam, field.cap, opts.formula, scale, W, H, opts.contours);
    } else {
      this.syncTextures(field);
      this.drawField(cam, field, scale, W, H, opts.contours);
    }

    gl.enable(gl.BLEND);
    if (opts.grid) this.drawGrid(cam, scale, W, H);
    if (opts.density) this.drawDensity(cam, opts.density, scale, W, H);
    if (opts.forceField) this.drawArrows(cam, opts.arrows ?? field, scale, W, H, opts.formula?.t ?? 0);
    this.uploadParticles(ps);
    // While the smoothed density is shown, particles and trails are faded so it reads through.
    const fade = opts.density ? 0.35 : 1;
    if (opts.trails && this.particleInstances > 0) {
      this.uploadTrails(ps);
      this.drawTrails(cam, scale, W, H, fade);
    }
    if (this.particleInstances > 0) this.drawParticles(cam, scale, W, H, fade);
    gl.disable(gl.BLEND);
  }

  // ---------------------------------------------------------------- field

  private syncTextures(field: PotentialField): void {
    const gl = this.gl;
    // A different field (painted ↔ formula) or a cleared one: all chunk textures are stale.
    if (field !== this.fieldRef || field.epoch !== this.fieldEpoch) {
      this.dropFieldTextures();
      this.fieldRef = field;
      this.fieldEpoch = field.epoch;
    }
    for (const c of field.chunks.values()) {
      if (!this.textures.has(c.key)) this.upload(field, c);
    }
    for (const key of field.dirty) {
      const c = field.chunks.get(key);
      if (c) this.upload(field, c);
    }
    field.dirty.clear();
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  private upload(field: PotentialField, c: Chunk): void {
    const gl = this.gl;
    let tex = this.textures.get(c.key);
    const fresh = !tex;
    if (!tex) {
      tex = gl.createTexture()!;
      this.textures.set(c.key, tex);
    }
    // Pack own nodes plus the shared border (first column of +x, first row of +y neighbour).
    const d = this.scratch;
    const own = c.psi;
    for (let m = 0; m < CHUNK; m++) {
      d.set(own.subarray(m * CHUNK, m * CHUNK + CHUNK), m * TEX_N);
    }
    const right = field.chunks.get(chunkKey(c.cx + 1, c.cy));
    const top = field.chunks.get(chunkKey(c.cx, c.cy + 1));
    const corner = field.chunks.get(chunkKey(c.cx + 1, c.cy + 1));
    for (let m = 0; m < CHUNK; m++) d[m * TEX_N + CHUNK] = right ? right.psi[m * CHUNK] : 0;
    const topRow = CHUNK * TEX_N;
    if (top) d.set(top.psi.subarray(0, CHUNK), topRow);
    else d.fill(0, topRow, topRow + CHUNK);
    d[topRow + CHUNK] = corner ? corner.psi[0] : 0;

    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (fresh) {
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R16F, TEX_N, TEX_N);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, TEX_N, TEX_N, gl.RED, gl.FLOAT, d);
  }

  private drawField(
    cam: Camera,
    field: PotentialField,
    scale: number,
    W: number,
    H: number,
    contours: boolean,
  ): void {
    if (field.chunks.size === 0) return;
    const gl = this.gl;
    const p = this.fieldProg;
    gl.useProgram(p.program);
    gl.bindVertexArray(this.fieldVao);
    gl.uniform2f(p.uniforms.u_res, W, H);
    gl.uniform1f(p.uniforms.u_scale, scale);
    gl.uniform2f(p.uniforms.u_center, 0, 0); // rects are already camera-relative
    gl.uniform1f(p.uniforms.u_texN, TEX_N);
    gl.uniform1f(p.uniforms.u_cap, field.cap);
    gl.uniform1f(p.uniforms.u_contours, contours ? 1 : 0);
    gl.uniform1i(p.uniforms.u_tex, 0);
    gl.activeTexture(gl.TEXTURE0);

    const span = CHUNK * field.h;
    const b = cam.bounds();
    for (const c of field.chunks.values()) {
      // Chunk c spans nodes [cx·CHUNK, (cx+1)·CHUNK] (the last one shared with its neighbour).
      const x0 = c.cx * span;
      const y0 = c.cy * span;
      const x1 = (c.cx + 1) * span;
      const y1 = (c.cy + 1) * span;
      if (x1 < b.x0 || x0 > b.x1 || y1 < b.y0 || y0 > b.y1) continue;
      const tex = this.textures.get(c.key);
      if (!tex) continue;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      // Computing both edges with the same float64 expression makes shared edges of
      // neighbouring chunks bit-identical, so the rasteriser leaves no seams.
      gl.uniform4f(p.uniforms.u_rect, x0 - cam.x, y0 - cam.y, x1 - cam.x, y1 - cam.y);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  // ---------------------------------------------------------------- formula on the GPU

  /**
   * Draws Ψ from a formula on the GPU from now on (null: from the field's lattice again). The
   * shader is first evaluated at FORMULA_CHECK's points and compared with the exact values from
   * `exact`; only if every value agrees (to float32 accuracy) is it used. Returns whether it is.
   */
  setFormula(
    formula: {
      glsl: GlslFormula;
      exact(xs: Float64Array, ys: Float64Array, n: number, t: number, sigma: number, out: Float64Array): void;
    } | null,
  ): boolean {
    const gl = this.gl;
    if (this.formulaProg) gl.deleteProgram(this.formulaProg.program);
    this.formulaProg = null;
    if (!formula) return false;
    try {
      if (!this.checkFormula(formula.glsl, formula.exact)) return false;
      this.formulaProg = createProgram(gl, FULLSCREEN_VS, formulaFieldFs(formula.glsl));
      return true;
    } catch (err) {
      console.warn('The formula is drawn from the CPU: its GLSL could not be used.', err);
      return false;
    }
  }

  /** Evaluates the GLSL formula at the check points (float render target) and compares. */
  private checkFormula(
    glsl: GlslFormula,
    exact: (xs: Float64Array, ys: Float64Array, n: number, t: number, sigma: number, out: Float64Array) => void,
  ): boolean {
    const gl = this.gl;
    if (!gl.getExtension('EXT_color_buffer_float')) return false; // cannot read floats back: no check, no GPU
    const pts = FORMULA_CHECK.points;
    const n = pts.length;
    const xs = Float64Array.from(pts, (p) => p[0]);
    const ys = Float64Array.from(pts, (p) => p[1]);
    const want = new Float64Array(n);
    exact(xs, ys, n, FORMULA_CHECK.t, FORMULA_CHECK.sigma, want);

    const prog = createProgram(gl, FORMULA_CHECK_VS, formulaCheckFs(glsl));
    const tex = gl.createTexture()!;
    const fbo = gl.createFramebuffer()!;
    const vao = gl.createVertexArray()!;
    const buf = gl.createBuffer()!;
    const got = new Float32Array(4 * n);
    try {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, n, 1);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) return false;
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(pts.flat()), gl.STATIC_DRAW);
      const loc = prog.attribs.a_xy;
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      gl.useProgram(prog.program);
      gl.uniform1f(prog.uniforms.u_n, n);
      gl.uniform1f(prog.uniforms.u_t, FORMULA_CHECK.t);
      gl.uniform1f(prog.uniforms.u_sigma, FORMULA_CHECK.sigma);
      gl.viewport(0, 0, n, 1);
      gl.disable(gl.BLEND);
      gl.drawArrays(gl.POINTS, 0, n);
      gl.readPixels(0, 0, n, 1, gl.RGBA, gl.FLOAT, got);
    } finally {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.deleteFramebuffer(fbo);
      gl.deleteTexture(tex);
      gl.deleteBuffer(buf);
      gl.deleteVertexArray(vao);
      gl.deleteProgram(prog.program);
    }
    for (let k = 0; k < n; k++) {
      const w = want[k];
      const g = got[4 * k];
      if (!Number.isFinite(w)) continue; // undefined there: nothing to compare
      // float32 on the GPU: a relative accuracy of 1e-4 leaves room for transcendental functions.
      if (!(Math.abs(g - w) <= 1e-4 * Math.max(1, Math.abs(w)))) {
        console.warn(`The GPU evaluates the formula differently at (${xs[k]}, ${ys[k]}): ${g} instead of ${w}.`);
        return false;
      }
    }
    return true;
  }

  private drawFormula(
    cam: Camera,
    cap: number,
    f: { t: number; sigma: number },
    scale: number,
    W: number,
    H: number,
    contours: boolean,
  ): void {
    const gl = this.gl;
    const p = this.formulaProg!;
    gl.useProgram(p.program);
    gl.bindVertexArray(this.gridVao); // full-screen triangle from gl_VertexID
    gl.uniform2f(p.uniforms.u_res, W, H);
    gl.uniform1f(p.uniforms.u_scale, scale);
    gl.uniform2f(p.uniforms.u_center, cam.x, cam.y);
    gl.uniform1f(p.uniforms.u_t, f.t);
    gl.uniform1f(p.uniforms.u_sigma, f.sigma);
    gl.uniform1f(p.uniforms.u_cap, cap);
    gl.uniform1f(p.uniforms.u_contours, contours ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // ---------------------------------------------------------------- grid

  private drawGrid(cam: Camera, scale: number, W: number, H: number): void {
    const gl = this.gl;
    const p = this.gridProg;
    const { major, minor } = gridSpacing(cam.scale);
    const minorPx = minor * cam.scale;
    gl.useProgram(p.program);
    gl.bindVertexArray(this.gridVao);
    gl.uniform2f(p.uniforms.u_res, W, H);
    gl.uniform1f(p.uniforms.u_scale, scale);
    // Camera centre reduced modulo the major spacing keeps float32 precision far from 0.
    const ox = cam.x - Math.floor(cam.x / major) * major;
    const oy = cam.y - Math.floor(cam.y / major) * major;
    gl.uniform2f(p.uniforms.u_offset, ox, oy);
    gl.uniform2f(p.uniforms.u_axisPx, W / 2 - cam.x * scale, H / 2 - cam.y * scale);
    gl.uniform1f(p.uniforms.u_minor, minor);
    gl.uniform1f(p.uniforms.u_major, major);
    gl.uniform1f(p.uniforms.u_minorAlpha, smoothstep(5, 14, minorPx));
    gl.uniform1f(p.uniforms.u_dpr, this.dpr);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // ---------------------------------------------------------------- smoothed empirical measure

  private drawDensity(cam: Camera, d: DensityImage, scale: number, W: number, H: number): void {
    const gl = this.gl;
    const n = d.nx * d.ny;
    const size = `${d.nx}x${d.ny}`;
    if (size !== this.densitySize || !this.densityTex) {
      if (this.densityTex) gl.deleteTexture(this.densityTex);
      this.densityTex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, this.densityTex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R16F, d.nx, d.ny);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.densitySize = size;
      this.densityVersion = -1;
    }
    if (d.version !== this.densityVersion) {
      // Normalise to the maximum, so half floats keep full precision and the colours use the
      // whole ramp whatever N, h or the box size are.
      let max = 0;
      for (let c = 0; c < n; c++) if (d.values[c] > max) max = d.values[c];
      if (this.densityScratch.length < n) this.densityScratch = new Float32Array(n);
      const out = this.densityScratch;
      const inv = max > 0 ? 1 / max : 0;
      for (let c = 0; c < n; c++) out[c] = d.values[c] * inv;
      gl.bindTexture(gl.TEXTURE_2D, this.densityTex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, d.nx, d.ny, gl.RED, gl.FLOAT, out, 0);
      this.densityVersion = d.version;
    }
    const p = this.densityProg;
    gl.useProgram(p.program);
    gl.bindVertexArray(this.fieldVao); // unit quad
    gl.uniform2f(p.uniforms.u_res, W, H);
    gl.uniform1f(p.uniforms.u_scale, scale);
    gl.uniform2f(p.uniforms.u_center, 0, 0);
    gl.uniform4f(p.uniforms.u_rect, d.x0 - cam.x, d.y0 - cam.y, d.x1 - cam.x, d.y1 - cam.y);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.densityTex);
    gl.uniform1i(p.uniforms.u_tex, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  // ---------------------------------------------------------------- force field

  private drawArrows(
    cam: Camera,
    field: DriftField & { readonly revision: number; readonly epoch: number },
    scale: number,
    W: number,
    H: number,
    t: number,
  ): void {
    const gl = this.gl;
    // Arrows live in world space, so they are built for a padded area around the view and only
    // rebuilt when the view leaves it, the lattice spacing changes (zoom) or Ψ changes.
    const b = cam.bounds();
    const spacing = arrowSpacing(cam.scale);
    const key = `${spacing},${field.revision},${field.epoch}`;
    const a = this.arrowArea;
    const inside = a && b.x0 >= a.x0 && b.x1 <= a.x1 && b.y0 >= a.y0 && b.y1 <= a.y1;
    // When only Ψ's values changed (e.g. a time-dependent formula moving on), arrows are rebuilt
    // at most every ARROW_REFRESH_MS: their motion stays smooth and the frame stays cheap.
    const now = performance.now();
    const viewChanged = !inside || !this.arrowKey.startsWith(`${spacing},`) || !this.arrowKey.endsWith(`,${field.epoch}`);
    if (key !== this.arrowKey && (viewChanged || now - this.arrowBuiltAt >= ARROW_REFRESH_MS)) {
      this.arrowBuiltAt = now;
      this.arrowKey = key;
      const padX = 0.5 * (b.x1 - b.x0);
      const padY = 0.5 * (b.y1 - b.y0);
      const area = { x0: b.x0 - padX, y0: b.y0 - padY, x1: b.x1 + padX, y1: b.y1 + padY };
      this.arrowArea = area;
      const { data, count } = buildArrows(field, area, cam.scale, this.arrowData, t);
      this.arrowData = data;
      this.arrowCount = count;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.arrowBuffer);
      const floats = count * ARROW_FLOATS;
      if (floats > this.arrowCapacity) {
        this.arrowCapacity = Math.max(1024, Math.ceil(floats * 1.5));
      }
      // Re-specifying the storage ("orphaning") lets the driver hand out a fresh buffer instead
      // of waiting for the GPU to finish reading the previous contents.
      gl.bufferData(gl.ARRAY_BUFFER, this.arrowCapacity * 4, gl.DYNAMIC_DRAW);
      if (floats > 0) gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, floats);
    }
    if (this.arrowCount === 0) return;

    const p = this.arrowProg;
    const dpr = this.dpr;
    const halo = 1.3 * dpr;
    gl.useProgram(p.program);
    gl.bindVertexArray(this.arrowVao);
    gl.uniform2f(p.uniforms.u_res, W, H);
    gl.uniform1f(p.uniforms.u_scale, scale);
    gl.uniform2f(p.uniforms.u_center, cam.x, cam.y);
    gl.uniform1f(p.uniforms.u_dpr, dpr);
    gl.uniform1f(p.uniforms.u_spacingPx, spacing * scale);
    gl.uniform1f(p.uniforms.u_headHalfWidth, 3.4 * dpr);
    gl.uniform1f(p.uniforms.u_halo, halo);
    gl.uniform1f(p.uniforms.u_pad, halo + 1.5);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.arrowCount);
  }

  // ---------------------------------------------------------------- particles & trails

  private uploadParticles(ps: ParticleSystem): void {
    if (ps.version === this.uploadedVersion) return;
    this.uploadedVersion = ps.version;
    const n = ps.count;
    const d = this.particleData;
    for (let i = 0, k = 0; i < n; i++, k += INST_FLOATS) {
      d[k] = ps.x[i];
      d[k + 1] = ps.y[i];
      d[k + 2] = ps.color[i];
      d[k + 3] = ps.trailCount[i];
    }
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.particleBuffer);
    if (n > 0) gl.bufferSubData(gl.ARRAY_BUFFER, 0, d, 0, n * INST_FLOATS);
    this.particleInstances = n;
  }

  /**
   * Brings the GPU copy of the trail ring buffer up to date. Normally only the columns written
   * since the last frame are uploaded (one float pair per particle and recording); after a
   * removal or reset the whole buffer is sent once.
   */
  private uploadTrails(ps: ParticleSystem): void {
    const n = ps.count;
    const pending = ps.trailWrites - this.uploadedWrites;
    this.headSlot = ps.trailHead;
    if (pending === 0 && ps.trailLayout === this.uploadedLayout) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.ringTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    if (ps.trailLayout !== this.uploadedLayout || pending >= TRAIL_LEN || pending < 0) {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, TRAIL_LEN, n, gl.RG, gl.FLOAT, ps.trail, 0);
    } else {
      const col = this.column;
      for (let w = pending - 1; w >= 0; w--) {
        const slot = (ps.trailHead - w + TRAIL_LEN) % TRAIL_LEN;
        for (let i = 0; i < n; i++) {
          const k = (i * TRAIL_LEN + slot) * 2;
          col[i * 2] = ps.trail[k];
          col[i * 2 + 1] = ps.trail[k + 1];
        }
        gl.texSubImage2D(gl.TEXTURE_2D, 0, slot, 0, 1, n, gl.RG, gl.FLOAT, col, 0);
      }
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
    this.uploadedWrites = ps.trailWrites;
    this.uploadedLayout = ps.trailLayout;
  }

  private setView(p: Program, cam: Camera, scale: number, W: number, H: number): void {
    const gl = this.gl;
    gl.uniform2f(p.uniforms.u_res, W, H);
    gl.uniform1f(p.uniforms.u_scale, scale);
    gl.uniform2f(p.uniforms.u_center, cam.x, cam.y);
    gl.uniform3fv(p.uniforms.u_palette, PALETTE_RGB);
  }

  private drawTrails(cam: Camera, scale: number, W: number, H: number, fade: number): void {
    const gl = this.gl;
    const p = this.trailProg;
    gl.useProgram(p.program);
    gl.bindVertexArray(this.trailVao);
    this.setView(p, cam, scale, W, H);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.ringTex);
    gl.uniform1i(p.uniforms.u_ring, 0);
    gl.uniform1i(p.uniforms.u_head, this.headSlot);
    gl.uniform1i(p.uniforms.u_len, TRAIL_LEN);
    gl.uniform1f(p.uniforms.u_width, 2.2 * this.dpr);
    gl.uniform1f(p.uniforms.u_alpha, 0.6 * fade);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, TRAIL_LEN * 6, this.particleInstances);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  private drawParticles(cam: Camera, scale: number, W: number, H: number, fade: number): void {
    const gl = this.gl;
    const p = this.particleProg;
    const dpr = this.dpr;
    const radius = 5.5 * dpr;
    const ring = 1.8 * dpr;
    const halo = 3 * dpr;
    gl.useProgram(p.program);
    gl.bindVertexArray(this.particleVao);
    this.setView(p, cam, scale, W, H);
    gl.uniform1f(p.uniforms.u_radius, radius);
    gl.uniform1f(p.uniforms.u_ring, ring);
    gl.uniform1f(p.uniforms.u_halo, halo);
    gl.uniform1f(p.uniforms.u_extent, radius + ring + halo + 1);
    gl.uniform1f(p.uniforms.u_opacity, fade);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.particleInstances);
  }
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
