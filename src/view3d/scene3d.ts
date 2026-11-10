/**
 * 3D view of the simulation, built with three.js: Ψ as a height field coloured with the app's
 * colour map (with the 2D grid lines and iso-lines on it), and the particles as spheres resting
 * on it at height Ψ(x, y). The camera orbits with the mouse (OrbitControls).
 *
 * World coordinates are the app's: x and y in the plane, z up (height = Ψ · heightScale).
 * At relief 0 and a camera straight above the view centre, the picture matches the 2D view
 * exactly (same region, scale and colours), which is what makes the 2D ↔ 3D transition seamless.
 *
 * Heights, normals and colours are computed on the GPU from a texture of the Ψ lattice
 * (heightField.ts); only the particle heights are computed here.
 *
 * This module pulls in three.js and is loaded on demand (see viewSwitch.ts).
 */
import {
  AmbientLight,
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  DynamicDrawUsage,
  InstancedMesh,
  LineBasicMaterial,
  LineLoop,
  LineSegments,
  Matrix4,
  Mesh,
  MeshLambertMaterial,
  PerspectiveCamera,
  Scene,
  SphereGeometry,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PALETTE } from '../config';
import type { PotentialField } from '../sim/field';
import { MAX_PARTICLES, type ParticleSystem } from '../sim/particles';
import { gridSpacing } from '../view/gridSpacing';
import { HeightField } from './heightField';
import type { CameraPose, Rect, Scene3DView } from './types';

/** Vertical field of view of the 3D camera (degrees). */
const FOV = 40;
/** Ψ = cap is drawn this high, as a fraction of the width of the 2D view. */
const RELIEF = 0.16;
/** The surface covers the 2D view plus this fraction of its size on every side. */
const MARGIN = 0.35;
/** At most this many vertices along the longer side of the surface. */
const MAX_SIDE = 400;
/** Radius of the particles in the 2D view (CSS px), see renderer.ts. */
const PARTICLE_PX = 5.5;
/**
 * Lights: an ambient part and a directional part from the upper left. For a flat surface seen
 * from above their sum is exactly 1, so colours match the 2D heat map; on slopes the
 * directional part shades the relief. (three.js divides Lambert lighting by π.)
 */
const SUN = new Vector3(-0.45, 0.65, 1).normalize();
const SUN_PART = 0.62;
const AMBIENT_PART = 1 - SUN_PART * SUN.z;
/** Grid lines as in 2D (grid shader): slate ink at these opacities. */
const INK = 0x0f172a;
const MINOR_ALPHA = 0.06;
const MAJOR_ALPHA = 0.13;
const AXIS_ALPHA = 0.42;
/** More grid lines than this per direction and the minor ones are left out. */
const MAX_MINOR_LINES = 160;

export class Scene3D implements Scene3DView {
  readonly canvas: HTMLCanvasElement;
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(FOV, 1, 0.01, 1000);
  private readonly controls: OrbitControls;
  private readonly target = new Vector3();
  private readonly height: HeightField;

  private readonly surface: Mesh;
  private readonly outline: LineLoop;
  /** Grid lines lying on the surface: minor, major and the two axes. */
  private readonly gridLines: LineSegments[];
  private readonly dots: InstancedMesh;
  private readonly palette = PALETTE.map((hex) => new Color(hex));
  private readonly m = new Matrix4();

  private region: Rect = { x0: 0, y0: 0, x1: 1, y1: 1 };
  /** World height per unit of Ψ (at full relief). */
  private heightScale = 1;
  private relief = 0;
  private particleRadius = 0.1;
  private cssWidth = 1;
  private cssHeight = 1;

  constructor(
    private readonly field: PotentialField,
    private readonly particles: ParticleSystem,
  ) {
    this.renderer = new WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setClearColor(0xffffff, 1);
    this.canvas = this.renderer.domElement;

    this.camera.up.set(0, 0, 1); // z is up; OrbitControls takes its orbit axis from this
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.maxPolarAngle = (86 * Math.PI) / 180; // never below the ground
    this.controls.screenSpacePanning = false; // pan along the ground
    this.controls.enabled = false;

    this.scene.add(new AmbientLight(0xffffff, AMBIENT_PART * Math.PI));
    const sun = new DirectionalLight(0xffffff, SUN_PART * Math.PI);
    sun.position.copy(SUN);
    this.scene.add(sun);

    this.height = new HeightField(field);

    // The surface: a flat grid of vertices that the GPU raises to Ψ and colours.
    const surfaceMaterial = new MeshLambertMaterial({
      side: DoubleSide,
      // Pushed back a little in depth, so the lines lying on it always win.
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
    this.height.apply(surfaceMaterial, { shade: true, colour: true });
    this.surface = new Mesh(new BufferGeometry(), surfaceMaterial);
    this.surface.frustumCulled = false; // its true shape is only known on the GPU
    this.scene.add(this.surface);

    const outlineMaterial = new LineBasicMaterial({ color: 0xcbd5e1 });
    this.height.apply(outlineMaterial, { shade: false, colour: false });
    this.outline = new LineLoop(new BufferGeometry(), outlineMaterial);
    this.outline.frustumCulled = false;
    this.surface.add(this.outline); // children follow the relief scale of the surface

    this.gridLines = [MINOR_ALPHA, MAJOR_ALPHA, AXIS_ALPHA].map((opacity) => {
      const material = new LineBasicMaterial({ color: INK, transparent: true, opacity, depthWrite: false });
      this.height.apply(material, { shade: false, colour: false });
      const lines = new LineSegments(new BufferGeometry(), material);
      lines.frustumCulled = false;
      this.surface.add(lines);
      return lines;
    });

    this.dots = new InstancedMesh(new SphereGeometry(1, 20, 14), new MeshLambertMaterial(), MAX_PARTICLES);
    this.dots.instanceMatrix.setUsage(DynamicDrawUsage);
    this.dots.count = 0;
    this.dots.frustumCulled = false;
    this.dots.setColorAt(0, this.palette[0]); // allocates instanceColor
    this.scene.add(this.dots);
  }

  /**
   * Builds the surface around the 2D view `view` (world rectangle shown in 2D), sets the scale
   * of heights and particles from it, and puts the camera straight above it (relief 0).
   */
  prepare(view: Rect): void {
    const w = view.x1 - view.x0;
    const h = view.y1 - view.y0;
    this.region = {
      x0: view.x0 - MARGIN * w,
      x1: view.x1 + MARGIN * w,
      y0: view.y0 - MARGIN * h,
      y1: view.y1 + MARGIN * h,
    };
    this.heightScale = (RELIEF * w) / this.field.cap;
    this.particleRadius = (PARTICLE_PX * w) / this.cssWidth;
    this.height.setRegion(this.region, this.heightScale);
    this.buildGeometry(gridSpacing(this.cssWidth / w)); // the 2D grid at the current zoom
    this.setRelief(0);
    this.setPose(this.homePose(view));
  }

  /** The pose straight above the centre of `view` that shows exactly that rectangle. */
  homePose(view: Rect): CameraPose {
    const h = view.y1 - view.y0;
    const distance = h / 2 / Math.tan(((FOV / 2) * Math.PI) / 180);
    return {
      target: [(view.x0 + view.x1) / 2, (view.y0 + view.y1) / 2, 0],
      distance,
      polar: 0,
      azimuth: -Math.PI / 2,
    };
  }

  /** The camera pose now (target, distance, angles), e.g. to start a transition from. */
  getPose(): CameraPose {
    const offset = this.camera.position.clone().sub(this.target);
    const distance = offset.length();
    return {
      target: [this.target.x, this.target.y, this.target.z],
      distance,
      polar: Math.acos(Math.min(1, Math.max(-1, offset.z / distance))),
      azimuth: Math.atan2(offset.y, offset.x),
    };
  }

  setPose(p: CameraPose): void {
    // A camera exactly above its target has no defined "up" with z-up; a tiny tilt keeps +y up.
    const polar = Math.max(1e-4, p.polar);
    this.target.set(p.target[0], p.target[1], p.target[2]);
    this.camera.position.set(
      this.target.x + p.distance * Math.sin(polar) * Math.cos(p.azimuth),
      this.target.y + p.distance * Math.sin(polar) * Math.sin(p.azimuth),
      this.target.z + p.distance * Math.cos(polar),
    );
    this.camera.lookAt(this.target);
    this.controls.target.copy(this.target);
    // Near/far planes that keep the depth precision good at any zoom.
    this.camera.near = Math.max(1e-3, p.distance / 500);
    this.camera.far = p.distance * 50 + 100;
    this.camera.updateProjectionMatrix();
  }

  /** 0 = flat (as in 2D), 1 = full height. */
  setRelief(r: number): void {
    this.relief = r;
    // Not exactly 0: the normal matrix of a zero scale is undefined.
    this.surface.scale.set(1, 1, Math.max(1e-4, r));
  }

  /** Shows or hides the grid lines (the Grid toggle). */
  setGrid(on: boolean): void {
    for (const l of this.gridLines) l.visible = on;
  }

  /** Shows or hides the iso-lines of Ψ (the Contours toggle). */
  setContours(on: boolean): void {
    this.height.setContours(on);
  }

  setControlsEnabled(on: boolean): void {
    this.controls.enabled = on;
    if (on) this.controls.update();
  }

  resize(w: number, h: number, dpr: number): void {
    this.cssWidth = Math.max(1, w);
    this.cssHeight = Math.max(1, h);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(this.cssWidth, this.cssHeight, false);
    this.camera.aspect = this.cssWidth / this.cssHeight;
    this.camera.updateProjectionMatrix();
  }

  render(_nowMs: number): void {
    this.height.update(); // uploads Ψ only when it changed
    this.updateParticles();
    if (this.controls.enabled) {
      this.controls.update();
      this.target.copy(this.controls.target);
    }
    this.renderer.render(this.scene, this.camera);
  }

  // ---------------------------------------------------------------- geometry

  /**
   * The flat vertex grids of the surface, its outline and the grid lines. They never change
   * while the view is shown: the GPU lifts them to Ψ.
   */
  private buildGeometry(spacing: { major: number; minor: number }): void {
    const { x0, y0, x1, y1 } = this.region;
    // Vertices about as dense as the Ψ lattice, at most MAX_SIDE along the longer side.
    const long = Math.max(x1 - x0, y1 - y0);
    const step = Math.max(long / (MAX_SIDE - 1), this.field.h);
    const nx = Math.max(2, Math.round((x1 - x0) / step) + 1);
    const ny = Math.max(2, Math.round((y1 - y0) / step) + 1);
    const dx = (x1 - x0) / (nx - 1);
    const dy = (y1 - y0) / (ny - 1);

    const pos = new Float32Array(nx * ny * 3);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const k = 3 * (j * nx + i);
        pos[k] = x0 + i * dx;
        pos[k + 1] = y0 + j * dy;
      }
    }
    const index = nx * ny > 65535 ? new Uint32Array((nx - 1) * (ny - 1) * 6) : new Uint16Array((nx - 1) * (ny - 1) * 6);
    let k = 0;
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const a = j * nx + i;
        index[k++] = a;
        index[k++] = a + 1;
        index[k++] = a + nx;
        index[k++] = a + 1;
        index[k++] = a + nx + 1;
        index[k++] = a + nx;
      }
    }
    const surface = this.surface.geometry;
    surface.dispose();
    surface.setAttribute('position', new BufferAttribute(pos, 3));
    // Normals are computed in the vertex shader; three still expects the attribute.
    surface.setAttribute('normal', new BufferAttribute(new Float32Array(nx * ny * 3), 3));
    surface.setIndex(new BufferAttribute(index, 1));

    // Outline along the border, sampled like the surface.
    const border: number[] = [];
    for (let i = 0; i < nx - 1; i++) border.push(x0 + i * dx, y0, 0);
    for (let j = 0; j < ny - 1; j++) border.push(x1, y0 + j * dy, 0);
    for (let i = nx - 1; i > 0; i--) border.push(x0 + i * dx, y1, 0);
    for (let j = ny - 1; j > 0; j--) border.push(x0, y0 + j * dy, 0);
    this.outline.geometry.dispose();
    this.outline.geometry.setAttribute('position', new BufferAttribute(new Float32Array(border), 3));

    // Grid lines at the 2D grid's positions, split into short segments so they follow the relief.
    const { major, minor } = spacing;
    const ratio = Math.round(major / minor);
    const lines = { minor: [[], []] as number[][], major: [[], []] as number[][], axis: [[], []] as number[][] };
    const sort = (a: number, b: number, axis: 0 | 1) => {
      const k0 = Math.ceil(a / minor);
      const k1 = Math.floor(b / minor);
      for (let q = k0; q <= k1; q++) {
        if (q === 0) lines.axis[axis].push(0);
        else if (q % ratio === 0) lines.major[axis].push(q * minor);
        else if (k1 - k0 + 1 <= MAX_MINOR_LINES) lines.minor[axis].push(q * minor);
      }
    };
    sort(x0, x1, 0);
    sort(y0, y1, 1);
    [lines.minor, lines.major, lines.axis].forEach(([xs, ys], n) => {
      const out = new Float32Array((xs.length * (ny - 1) + ys.length * (nx - 1)) * 6);
      let w = 0;
      const seg = (ax: number, ay: number, bx: number, by: number) => {
        out[w++] = ax;
        out[w++] = ay;
        out[w++] = 0;
        out[w++] = bx;
        out[w++] = by;
        out[w++] = 0;
      };
      for (const x of xs) for (let j = 0; j < ny - 1; j++) seg(x, y0 + j * dy, x, y0 + (j + 1) * dy);
      for (const y of ys) for (let i = 0; i < nx - 1; i++) seg(x0 + i * dx, y, x0 + (i + 1) * dx, y);
      const g = this.gridLines[n].geometry;
      g.dispose();
      g.setAttribute('position', new BufferAttribute(out, 3));
    });
  }

  // ---------------------------------------------------------------- particles

  /** Spheres at (x, y, Ψ(x, y)), resting on the (relief-scaled) surface. */
  private updateParticles(): void {
    const ps = this.particles;
    const r = this.particleRadius;
    const lift = this.heightScale * Math.max(1e-4, this.relief);
    for (let i = 0; i < ps.count; i++) {
      const x = ps.x[i];
      const y = ps.y[i];
      this.m.makeScale(r, r, r);
      this.m.setPosition(x, y, this.field.sample(x, y) * lift + r);
      this.dots.setMatrixAt(i, this.m);
      this.dots.setColorAt(i, this.palette[ps.color[i]] ?? this.palette[0]);
    }
    this.dots.count = ps.count;
    this.dots.instanceMatrix.needsUpdate = true;
    if (this.dots.instanceColor) this.dots.instanceColor.needsUpdate = true;
  }
}
