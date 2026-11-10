/**
 * Ψ as a height field on the GPU, from one of two sources:
 *  - a formula Ψ(t, x, y) compiled to GLSL (`setFormula`): evaluated per vertex and per pixel,
 *    with time and σ as uniforms, so nothing is uploaded when Ψ moves on or the view changes;
 *  - otherwise the Ψ lattice, as described next.
 *
 * The Ψ lattice over the 3D region lives in a float texture
 * (one texel per lattice node, or per `stride` nodes when zoomed far out); vertex shaders read it
 * to raise vertices to height Ψ·heightScale and to compute normals, and the surface's fragment
 * shader colours every pixel from it with the same colour map and iso-lines as the 2D heat map.
 *
 * The CPU only copies lattice rows into the texture when Ψ changes (PotentialField.copyNodes),
 * which takes about a millisecond, so even the live camera (Ψ rewritten every video frame)
 * updates the relief smoothly. The materials are three.js's own, extended with
 * `onBeforeCompile`, so lighting and colour management stay three's.
 */
import {
  DataTexture,
  FloatType,
  type Material,
  NearestFilter,
  RedFormat,
  Vector2,
  type WebGLProgramParametersWithUniforms,
} from 'three';
import { psiFormulaGlsl, type GlslFormula } from '../render/formulaShader';
import { PSI_COLOR_GLSL } from '../render/shaders';
import type { PotentialField } from '../sim/field';
import type { Rect } from './types';

/** Largest texture side used (well within what every WebGL2 device supports). */
const MAX_TEXTURE = 2048;

/** Ψ of the lattice: bilinear between lattice nodes, exactly as Ψ is sampled on the CPU. */
const PSI_LATTICE_GLSL = /* glsl */ `
uniform highp sampler2D uPsi;
uniform vec2 uPsiOrigin;  // world position of texel (0, 0)
uniform float uPsiStep;   // world distance between texels
uniform vec2 uPsiSize;    // texels per side
uniform float uHeight;    // world height per unit of Ψ
uniform float uCap;       // heights are drawn up to |Ψ| = cap (like the painted lattice)
uniform float uPsiT;      // time and σ of a formula
uniform float uPsiSigma;
float psiLattice(vec2 p) {
  vec2 g = clamp((p - uPsiOrigin) / uPsiStep, vec2(0.0), uPsiSize - 1.0);
  vec2 f = min(floor(g), uPsiSize - 2.0);
  vec2 t = g - f;
  ivec2 i = ivec2(f);
  float a = texelFetch(uPsi, i, 0).r;
  float b = texelFetch(uPsi, i + ivec2(1, 0), 0).r;
  float c = texelFetch(uPsi, i + ivec2(0, 1), 0).r;
  float d = texelFetch(uPsi, i + ivec2(1, 1), 0).r;
  return mix(mix(a, b, t.x), mix(c, d, t.x), t.y);
}
`;

/** psiAt (Ψ, from the formula or the lattice) and psiHeight (the clamped height drawn). */
function psiGlsl(formula: GlslFormula | null): string {
  return `${PSI_LATTICE_GLSL}
${formula ? psiFormulaGlsl(formula) : ''}
float psiAt(vec2 p) {
  return ${formula ? 'psiFormula(p.x, p.y, uPsiT, uPsiSigma)' : 'psiLattice(p)'};
}
float psiHeight(vec2 p) {
  float v = psiAt(p);
  if (isnan(v) || isinf(v)) v = 0.0;
  return clamp(v, -uCap, uCap) * uHeight;
}
`;
}

const SRGB_TO_LINEAR_GLSL = /* glsl */ `
vec3 psiSrgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}
`;

export class HeightField {
  readonly uniforms = {
    uPsi: { value: new DataTexture(new Float32Array(4), 2, 2, RedFormat, FloatType) },
    uPsiOrigin: { value: new Vector2() },
    uPsiStep: { value: 1 },
    uPsiSize: { value: new Vector2(2, 2) },
    uHeight: { value: 1 },
    uCap: { value: 1 },
    uContours: { value: 0 },
    uPsiT: { value: 0 },
    uPsiSigma: { value: 0 },
  };
  /** The formula drawn instead of the lattice (null: the lattice). */
  private formula: GlslFormula | null = null;
  private formulaId = 0;
  /** Materials drawn at height Ψ (recompiled when the formula changes). */
  private readonly materials: Material[] = [];
  private data = new Float32Array(4);
  private i0 = 0;
  private j0 = 0;
  private stride = 1;
  private key = '';
  private source: PotentialField | null = null;

  /** `getField` gives the lattice to show (it changes between the painted one and a formula's). */
  constructor(private readonly getField: () => PotentialField) {
    this.uniforms.uCap.value = getField().cap;
  }

  private get field(): PotentialField {
    return this.getField();
  }

  /** Covers `region` (world) with texels; `heightScale` is the world height per unit of Ψ. */
  setRegion(region: Rect, heightScale: number): void {
    const h = this.field.h;
    const i0 = Math.floor(region.x0 / h);
    const j0 = Math.floor(region.y0 / h);
    const nodesX = Math.ceil(region.x1 / h) - i0 + 1;
    const nodesY = Math.ceil(region.y1 / h) - j0 + 1;
    const stride = Math.max(1, Math.ceil(Math.max(nodesX, nodesY) / (MAX_TEXTURE - 1)));
    const tx = Math.ceil((nodesX - 1) / stride) + 1;
    const ty = Math.ceil((nodesY - 1) / stride) + 1;
    this.i0 = i0;
    this.j0 = j0;
    this.stride = stride;
    this.data = new Float32Array(tx * ty);
    const tex = new DataTexture(this.data, tx, ty, RedFormat, FloatType);
    tex.minFilter = NearestFilter;
    tex.magFilter = NearestFilter;
    tex.generateMipmaps = false;
    this.uniforms.uPsi.value.dispose();
    this.uniforms.uPsi.value = tex;
    this.uniforms.uPsiOrigin.value.set(i0 * h, j0 * h);
    this.uniforms.uPsiStep.value = stride * h;
    this.uniforms.uPsiSize.value.set(tx, ty);
    this.uniforms.uHeight.value = heightScale;
    this.key = '';
    this.update();
  }

  /** Draws Ψ from this formula (GLSL) instead of the lattice; null: the lattice again. */
  setFormula(formula: GlslFormula | null): void {
    if (formula === this.formula) return;
    this.formula = formula;
    this.formulaId++;
    for (const m of this.materials) m.needsUpdate = true; // new shader code
    this.key = ''; // the lattice is uploaded again when it is shown again
  }

  /** Time and σ of the formula. */
  setTime(t: number, sigma: number): void {
    this.uniforms.uPsiT.value = t;
    this.uniforms.uPsiSigma.value = sigma;
  }

  /** Re-uploads Ψ if it changed since the last upload (nothing to do for a formula). */
  update(): boolean {
    if (this.formula) return false;
    const field = this.field;
    const key = `${field.revision}|${field.epoch}`;
    if (key === this.key && field === this.source) return false;
    this.key = key;
    this.source = field;
    const size = this.uniforms.uPsiSize.value;
    this.field.copyNodes(this.i0, this.j0, size.x, size.y, this.stride, this.data);
    this.uniforms.uPsi.value.needsUpdate = true;
    return true;
  }

  setContours(on: boolean): void {
    this.uniforms.uContours.value = on ? 1 : 0;
  }

  /**
   * Makes a three.js material draw at height Ψ: vertices at (x, y, Ψ(x, y)·heightScale).
   * With `shade`, also the normals of the height field; with `colour`, Ψ's colour map per pixel.
   */
  apply(material: Material, opts: { shade: boolean; colour: boolean }): void {
    const uniforms = this.uniforms;
    this.materials.push(material);
    material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
      Object.assign(shader.uniforms, uniforms);
      const psi = psiGlsl(this.formula);
      let vs = shader.vertexShader.replace('#include <common>', `#include <common>\n${psi}\nvarying vec2 vPsiXY;`);
      if (opts.shade) {
        vs = vs.replace(
          '#include <beginnormal_vertex>',
          /* glsl */ `
          float e = uPsiStep;
          float dhdx = (psiHeight(position.xy + vec2(e, 0.0)) - psiHeight(position.xy - vec2(e, 0.0))) / (2.0 * e);
          float dhdy = (psiHeight(position.xy + vec2(0.0, e)) - psiHeight(position.xy - vec2(0.0, e))) / (2.0 * e);
          vec3 objectNormal = normalize(vec3(-dhdx, -dhdy, 1.0));`,
        );
      }
      vs = vs.replace(
        '#include <begin_vertex>',
        /* glsl */ `
        vec3 transformed = vec3(position.xy, psiHeight(position.xy));
        vPsiXY = position.xy;`,
      );
      shader.vertexShader = vs;
      if (opts.colour) {
        shader.fragmentShader = shader.fragmentShader
          .replace(
            '#include <common>',
            `#include <common>\n${psi}\n${PSI_COLOR_GLSL}\n${SRGB_TO_LINEAR_GLSL}\nuniform float uContours;\nvarying vec2 vPsiXY;`,
          )
          .replace(
            '#include <color_fragment>',
            // Colours and iso-lines from Ψ itself (not clamped), as in the 2D heat map.
            `{ float v = psiAt(vPsiXY); bool bad = isnan(v) || isinf(v);
               vec3 c = psiColor(bad ? 0.0 : v, uCap, uContours > 0.5);
               diffuseColor.rgb = psiSrgbToLinear(bad ? vec3(1.0) : c); }`,
          );
      }
    };
    material.customProgramCacheKey = () => `psi-height-${opts.shade ? 1 : 0}${opts.colour ? 1 : 0}-${this.formulaId}`;
    material.needsUpdate = true;
  }
}
