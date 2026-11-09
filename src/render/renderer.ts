import { PALETTE_RGB } from '../config';
import { CHUNK, type Chunk, chunkKey, type PotentialField } from '../sim/field';
import { type ParticleSystem, TRAIL_LEN } from '../sim/particles';
import type { Camera } from '../view/camera';
import { gridSpacing } from '../view/gridSpacing';
import { createBuffer, createProgram, type Program } from './gl';
import {
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
const POINT_FLOATS = 4; // trail point: x, y, age, colour

export interface RenderOptions {
  grid: boolean;
  trails: boolean;
  contours: boolean;
}

/**
 * WebGL2 renderer: potential heat map (one R16F texture per chunk), procedural grid,
 * particle trails (instanced quads) and particles (instanced point sprites).
 */
export class Renderer {
  readonly gl: WebGL2RenderingContext;
  private readonly fieldProg: Program;
  private readonly gridProg: Program;
  private readonly trailProg: Program;
  private readonly particleProg: Program;

  private readonly fieldVao: WebGLVertexArrayObject;
  private readonly gridVao: WebGLVertexArrayObject;
  private readonly trailVao: WebGLVertexArrayObject;
  private readonly particleVao: WebGLVertexArrayObject;

  private readonly trailBuffer: WebGLBuffer;
  private readonly particleBuffer: WebGLBuffer;
  private trailCapacity = 0; // in points
  private particleCapacity = 0; // in particles
  private trailData = new Float32Array(0);
  private particleData = new Float32Array(0);
  private trailInstances = 0;
  private particleInstances = 0;
  private uploadedVersion = -1;
  private uploadedTrails = false;

  private readonly textures = new Map<number, WebGLTexture>();
  private fieldEpoch = -1;
  private readonly scratch = new Float32Array(TEX_N * TEX_N);

  private dpr = 1;

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

    // Field: unit quad as a triangle strip.
    this.fieldVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.fieldVao);
    createBuffer(gl, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]));
    this.enableAttrib(this.fieldProg, 'a_pos', 2, 0, 0, 0);

    // Grid: full-screen triangle generated from gl_VertexID.
    this.gridVao = gl.createVertexArray()!;

    // Trails: per-vertex corner + per-instance (p_i, p_{i+1}) read from one buffer with an
    // offset of one point, so N points give N − 1 segments without duplicating data.
    this.trailVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.trailVao);
    createBuffer(gl, new Float32Array([0, -1, 1, -1, 0, 1, 1, 1]));
    this.enableAttrib(this.trailProg, 'a_corner', 2, 0, 0, 0);
    this.trailBuffer = createBuffer(gl, 16, gl.DYNAMIC_DRAW);
    this.enableAttrib(this.trailProg, 'a_p0', 4, POINT_FLOATS * 4, 0, 1);
    this.enableAttrib(this.trailProg, 'a_p1', 4, POINT_FLOATS * 4, POINT_FLOATS * 4, 1);

    // Particles: per-vertex corner + per-instance (x, y, colour).
    this.particleVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.particleVao);
    createBuffer(gl, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]));
    this.enableAttrib(this.particleProg, 'a_corner', 2, 0, 0, 0);
    this.particleBuffer = createBuffer(gl, 16, gl.DYNAMIC_DRAW);
    this.enableAttrib(this.particleProg, 'a_inst', 3, 12, 0, 1);

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

  dispose(): void {
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

    this.syncTextures(field);
    this.drawField(cam, field, scale, W, H, opts.contours);

    gl.enable(gl.BLEND);
    if (opts.grid) this.drawGrid(cam, scale, W, H);
    this.uploadParticles(ps, opts.trails);
    if (opts.trails && this.trailInstances > 0) this.drawTrails(cam, scale, W, H);
    if (this.particleInstances > 0) this.drawParticles(cam, scale, W, H);
    gl.disable(gl.BLEND);
  }

  // ---------------------------------------------------------------- field

  private syncTextures(field: PotentialField): void {
    const gl = this.gl;
    if (field.epoch !== this.fieldEpoch) {
      this.dispose();
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

  // ---------------------------------------------------------------- particles & trails

  private uploadParticles(ps: ParticleSystem, trails: boolean): void {
    if (ps.version === this.uploadedVersion && trails === this.uploadedTrails) return;
    this.uploadedVersion = ps.version;
    this.uploadedTrails = trails;
    const gl = this.gl;
    const n = ps.count;

    // Particles
    if (this.particleData.length < n * 3) this.particleData = new Float32Array(Math.max(64, n * 3 * 2));
    const pd = this.particleData;
    for (let i = 0; i < n; i++) {
      pd[i * 3] = ps.x[i];
      pd[i * 3 + 1] = ps.y[i];
      pd[i * 3 + 2] = ps.color[i];
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.particleBuffer);
    if (n > this.particleCapacity) {
      this.particleCapacity = Math.max(64, n * 2);
      gl.bufferData(gl.ARRAY_BUFFER, this.particleCapacity * 12, gl.DYNAMIC_DRAW);
    }
    if (n > 0) gl.bufferSubData(gl.ARRAY_BUFFER, 0, pd, 0, n * 3);
    this.particleInstances = n;

    // Trails: per particle the current position (age 0) followed by its history (ages 1..k).
    if (!trails) {
      this.trailInstances = 0;
      return;
    }
    const maxPoints = n * (TRAIL_LEN + 1);
    if (this.trailData.length < maxPoints * POINT_FLOATS) {
      this.trailData = new Float32Array(Math.max(256, maxPoints * POINT_FLOATS * 2));
    }
    const td = this.trailData;
    const { trail, trailCount, trailHead } = ps;
    let w = 0;
    for (let i = 0; i < n; i++) {
      const k = trailCount[i];
      if (k === 0) continue;
      const col = ps.color[i];
      td[w++] = ps.x[i];
      td[w++] = ps.y[i];
      td[w++] = 0;
      td[w++] = col;
      const base = i * TRAIL_LEN;
      for (let a = 0; a < k; a++) {
        const slot = (trailHead - a + TRAIL_LEN) % TRAIL_LEN;
        const s = (base + slot) * 2;
        td[w++] = trail[s];
        td[w++] = trail[s + 1];
        td[w++] = a + 1;
        td[w++] = col;
      }
    }
    const points = w / POINT_FLOATS;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.trailBuffer);
    if (points > this.trailCapacity) {
      this.trailCapacity = Math.max(256, points * 2);
      gl.bufferData(gl.ARRAY_BUFFER, this.trailCapacity * POINT_FLOATS * 4, gl.DYNAMIC_DRAW);
    }
    if (w > 0) gl.bufferSubData(gl.ARRAY_BUFFER, 0, td, 0, w);
    this.trailInstances = Math.max(0, points - 1);
  }

  private setView(p: Program, cam: Camera, scale: number, W: number, H: number): void {
    const gl = this.gl;
    gl.uniform2f(p.uniforms.u_res, W, H);
    gl.uniform1f(p.uniforms.u_scale, scale);
    gl.uniform2f(p.uniforms.u_center, cam.x, cam.y);
    gl.uniform3fv(p.uniforms.u_palette, PALETTE_RGB);
  }

  private drawTrails(cam: Camera, scale: number, W: number, H: number): void {
    const gl = this.gl;
    const p = this.trailProg;
    gl.useProgram(p.program);
    gl.bindVertexArray(this.trailVao);
    this.setView(p, cam, scale, W, H);
    gl.uniform1f(p.uniforms.u_width, 2.2 * this.dpr);
    gl.uniform1f(p.uniforms.u_maxAge, TRAIL_LEN + 1);
    gl.uniform1f(p.uniforms.u_alpha, 0.6);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.trailInstances);
  }

  private drawParticles(cam: Camera, scale: number, W: number, H: number): void {
    const gl = this.gl;
    const p = this.particleProg;
    const dpr = this.dpr;
    const radius = 5 * dpr;
    const ring = 1.6 * dpr;
    const halo = 2 * dpr;
    gl.useProgram(p.program);
    gl.bindVertexArray(this.particleVao);
    this.setView(p, cam, scale, W, H);
    gl.uniform1f(p.uniforms.u_radius, radius);
    gl.uniform1f(p.uniforms.u_ring, ring);
    gl.uniform1f(p.uniforms.u_halo, halo);
    gl.uniform1f(p.uniforms.u_extent, radius + ring + halo + 1);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.particleInstances);
  }
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
