/**
 * Ψ as a height field on the GPU. The Ψ lattice over the 3D region lives in a float texture
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
import { PSI_COLOR_GLSL } from '../render/shaders';
import type { PotentialField } from '../sim/field';
import type { Rect } from './types';

/** Largest texture side used (well within what every WebGL2 device supports). */
const MAX_TEXTURE = 2048;

/** Ψ at any point of the region: bilinear between lattice nodes, exactly as Ψ is sampled on the CPU. */
const PSI_AT_GLSL = /* glsl */ `
uniform highp sampler2D uPsi;
uniform vec2 uPsiOrigin;  // world position of texel (0, 0)
uniform float uPsiStep;   // world distance between texels
uniform vec2 uPsiSize;    // texels per side
uniform float uHeight;    // world height per unit of Ψ
float psiAt(vec2 p) {
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
  };
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

  /** Re-uploads Ψ if it changed since the last upload. Returns true if it did. */
  update(): boolean {
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
    material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
      Object.assign(shader.uniforms, uniforms);
      let vs = shader.vertexShader.replace(
        '#include <common>',
        `#include <common>\n${PSI_AT_GLSL}\nvarying vec2 vPsiXY;`,
      );
      if (opts.shade) {
        vs = vs.replace(
          '#include <beginnormal_vertex>',
          /* glsl */ `
          float e = uPsiStep;
          float dhdx = (psiAt(position.xy + vec2(e, 0.0)) - psiAt(position.xy - vec2(e, 0.0))) * uHeight / (2.0 * e);
          float dhdy = (psiAt(position.xy + vec2(0.0, e)) - psiAt(position.xy - vec2(0.0, e))) * uHeight / (2.0 * e);
          vec3 objectNormal = normalize(vec3(-dhdx, -dhdy, 1.0));`,
        );
      }
      vs = vs.replace(
        '#include <begin_vertex>',
        /* glsl */ `
        vec3 transformed = vec3(position.xy, psiAt(position.xy) * uHeight);
        vPsiXY = position.xy;`,
      );
      shader.vertexShader = vs;
      if (opts.colour) {
        shader.fragmentShader = shader.fragmentShader
          .replace(
            '#include <common>',
            `#include <common>\n${PSI_AT_GLSL}\n${PSI_COLOR_GLSL}\n${SRGB_TO_LINEAR_GLSL}\nuniform float uCap;\nuniform float uContours;\nvarying vec2 vPsiXY;`,
          )
          .replace(
            '#include <color_fragment>',
            'diffuseColor.rgb = psiSrgbToLinear(psiColor(psiAt(vPsiXY), uCap, uContours > 0.5));',
          );
      }
    };
    material.customProgramCacheKey = () => `psi-height-${opts.shade ? 1 : 0}${opts.colour ? 1 : 0}`;
    material.needsUpdate = true;
  }
}
