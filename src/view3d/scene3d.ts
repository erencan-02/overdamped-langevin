/**
 * Read-only 3D view of the simulation, built with three.js: Ψ as a height field coloured with
 * the app's colour map, and the particles as spheres resting on it at height Ψ(x, y). The camera
 * orbits with the mouse (OrbitControls); nothing in the scene can be edited from here.
 *
 * World coordinates are the app's: x and y in the plane, z up (height = Ψ · heightScale).
 * At relief 0 and a camera straight above the view centre, the picture matches the 2D view
 * exactly (same region, scale and colours), which is what makes the 2D ↔ 3D transition seamless.
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
import { psiColor, srgbToLinear } from '../render/colormap';
import { gridSpacing } from '../view/gridSpacing';
import type { PotentialField } from '../sim/field';
import { MAX_PARTICLES, type ParticleSystem } from '../sim/particles';
import type { CameraPose, Rect, Scene3DView } from './types';

/** Vertical field of view of the 3D camera (degrees). */
const FOV = 40;
/** Ψ = cap is drawn this high, as a fraction of the width of the 2D view. */
const RELIEF = 0.16;
/** The surface covers the 2D view plus this fraction of its size on every side. */
const MARGIN = 0.35;
/** At most this many vertices along the longer side of the surface. */
const MAX_SIDE = 360;
/** While Ψ keeps changing, the surface is rebuilt at most this often. */
const REFRESH_MS = 120;
/** Radius of the particles in the 2D view (CSS px), see renderer.ts. */
const PARTICLE_PX = 5.5;
/**
 * Lights: an ambient part and a directional part from the upper left. For a flat surface seen
 * from above their sum is exactly 1, so colours match the 2D heat map; on slopes the
 * directional part shades the relief. (three.js divides Lambert lighting by π.)
 */
const SUN = new Vector3(-0.45, 0.65, 1).normalize();
/** Grid lines as in 2D (grid shader): slate ink at these opacities. */
const INK = 0x0f172a;
const MINOR_ALPHA = 0.06;
const MAJOR_ALPHA = 0.13;
const AXIS_ALPHA = 0.42;
/** More grid lines than this per direction and the minor ones are left out. */
const MAX_MINOR_LINES = 160;
const SUN_PART = 0.62;
const AMBIENT_PART = 1 - SUN_PART * SUN.z;

export class Scene3D implements Scene3DView {
  readonly canvas: HTMLCanvasElement;
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(FOV, 1, 0.01, 1000);
  private readonly controls: OrbitControls;
  private readonly target = new Vector3();

  private readonly surface: Mesh;
  private readonly outline: LineLoop;
  private readonly dots: InstancedMesh;
  /** Grid lines draped over the surface: minor, major and the two axes. */
  private readonly gridLines: LineSegments[];
  private spacing = { major: 1, minor: 0.2 };
  private readonly palette = PALETTE.map((hex) => new Color(hex));
  private readonly m = new Matrix4();

  private region: Rect & { nx: number; ny: number } = { x0: 0, y0: 0, x1: 1, y1: 1, nx: 2, ny: 2 };
  /** World height per unit of Ψ (at full relief). */
  private heightScale = 1;
  private relief = 0;
  private particleRadius = 0.1;
  private surfaceKey = '';
  private lastRefresh = -Infinity;
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

    const geometry = new BufferGeometry();
    this.surface = new Mesh(
      geometry,
      // Pushed back a little in depth, so the grid lines lying on it always win.
      new MeshLambertMaterial({
        vertexColors: true,
        side: DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      }),
    );
    this.scene.add(this.surface);

    this.outline = new LineLoop(new BufferGeometry(), new LineBasicMaterial({ color: 0xcbd5e1 }));
    this.surface.add(this.outline); // follows the relief scale of the surface

    this.gridLines = [MINOR_ALPHA, MAJOR_ALPHA, AXIS_ALPHA].map((opacity) => {
      const lines = new LineSegments(
        new BufferGeometry(),
        new LineBasicMaterial({ color: INK, transparent: true, opacity, depthWrite: false }),
      );
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
    const x0 = view.x0 - MARGIN * w;
    const x1 = view.x1 + MARGIN * w;
    const y0 = view.y0 - MARGIN * h;
    const y1 = view.y1 + MARGIN * h;
    const long = Math.max(x1 - x0, y1 - y0);
    // Never finer than the Ψ lattice: more vertices would add nothing.
    const step = Math.max(long / (MAX_SIDE - 1), this.field.h);
    const nx = Math.max(2, Math.round((x1 - x0) / step) + 1);
    const ny = Math.max(2, Math.round((y1 - y0) / step) + 1);
    this.region = { x0, y0, x1, y1, nx, ny };
    this.heightScale = (RELIEF * w) / this.field.cap;
    this.particleRadius = (PARTICLE_PX * w) / this.cssWidth;
    this.spacing = gridSpacing(this.cssWidth / w); // the 2D grid at the current zoom
    this.buildSurface();
    this.surfaceKey = '';
    this.refreshSurface(performance.now(), true);
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

  render(nowMs: number): void {
    this.refreshSurface(nowMs, false);
    this.updateParticles();
    if (this.controls.enabled) {
      this.controls.update();
      this.target.copy(this.controls.target);
    }
    this.renderer.render(this.scene, this.camera);
  }

  // ---------------------------------------------------------------- surface

  /** Allocates vertices, colours and triangles for the current region. */
  private buildSurface(): void {
    const { nx, ny } = this.region;
    const n = nx * ny;
    const g = this.surface.geometry;
    g.setAttribute('position', new BufferAttribute(new Float32Array(n * 3), 3).setUsage(DynamicDrawUsage));
    g.setAttribute('color', new BufferAttribute(new Float32Array(n * 3), 3).setUsage(DynamicDrawUsage));
    g.setAttribute('normal', new BufferAttribute(new Float32Array(n * 3), 3).setUsage(DynamicDrawUsage));
    const index = n > 65535 ? new Uint32Array((nx - 1) * (ny - 1) * 6) : new Uint16Array((nx - 1) * (ny - 1) * 6);
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
    g.setIndex(new BufferAttribute(index, 1));
    const border = 2 * (nx - 1) + 2 * (ny - 1);
    this.outline.geometry.setAttribute('position', new BufferAttribute(new Float32Array(border * 3), 3));
  }

  /** Samples Ψ at the vertices (when Ψ changed, at most every REFRESH_MS unless forced). */
  private refreshSurface(nowMs: number, force: boolean): void {
    const key = `${this.field.revision}|${this.field.epoch}`;
    if (key === this.surfaceKey) return;
    if (!force && nowMs - this.lastRefresh < REFRESH_MS) return;
    this.surfaceKey = key;
    this.lastRefresh = nowMs;

    const { x0, y0, x1, y1, nx, ny } = this.region;
    const g = this.surface.geometry;
    const pos = g.getAttribute('position') as BufferAttribute;
    const col = g.getAttribute('color') as BufferAttribute;
    const p = pos.array as Float32Array;
    const c = col.array as Float32Array;
    const cap = this.field.cap;
    const dx = (x1 - x0) / (nx - 1);
    const dy = (y1 - y0) / (ny - 1);
    for (let j = 0; j < ny; j++) {
      const y = y0 + j * dy;
      for (let i = 0; i < nx; i++) {
        const x = x0 + i * dx;
        const v = this.field.sample(x, y);
        const k = 3 * (j * nx + i);
        p[k] = x;
        p[k + 1] = y;
        p[k + 2] = v * this.heightScale;
        psiColor(v, cap, c, k);
        c[k] = srgbToLinear(c[k]);
        c[k + 1] = srgbToLinear(c[k + 1]);
        c[k + 2] = srgbToLinear(c[k + 2]);
      }
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
    this.computeNormals(p, nx, ny, dx, dy);

    // Outline along the border of the surface, at the surface height.
    const o = (this.outline.geometry.getAttribute('position') as BufferAttribute).array as Float32Array;
    let w = 0;
    const put = (i: number, j: number) => {
      const k = 3 * (j * nx + i);
      o[w++] = p[k];
      o[w++] = p[k + 1];
      o[w++] = p[k + 2];
    };
    for (let i = 0; i < nx - 1; i++) put(i, 0);
    for (let j = 0; j < ny - 1; j++) put(nx - 1, j);
    for (let i = nx - 1; i > 0; i--) put(i, ny - 1);
    for (let j = ny - 1; j > 0; j--) put(0, j);
    (this.outline.geometry.getAttribute('position') as BufferAttribute).needsUpdate = true;
    this.outline.geometry.computeBoundingSphere();
    g.computeBoundingSphere();
    this.drapeGrid(dx, dy);
  }

  /**
   * Grid lines at the 2D grid's positions, following the surface (sampled at the surface's
   * vertex spacing). Minor lines skip the positions of major lines and of the axes.
   */
  private drapeGrid(dx: number, dy: number): void {
    const { x0, y0, x1, y1 } = this.region;
    const { major, minor } = this.spacing;
    const ratio = Math.round(major / minor);
    const xs = { minor: [] as number[], major: [] as number[], axis: [] as number[] };
    const ys = { minor: [] as number[], major: [] as number[], axis: [] as number[] };
    const sort = (a: number, b: number, out: typeof xs) => {
      const count = Math.floor(b / minor) - Math.ceil(a / minor) + 1;
      for (let k = Math.ceil(a / minor); k <= Math.floor(b / minor); k++) {
        const v = k * minor;
        if (k === 0) out.axis.push(0);
        else if (k % ratio === 0) out.major.push(v);
        else if (count <= MAX_MINOR_LINES) out.minor.push(v);
      }
    };
    sort(x0, x1, xs);
    sort(y0, y1, ys);
    const sets = [
      [xs.minor, ys.minor],
      [xs.major, ys.major],
      [xs.axis, ys.axis],
    ] as const;
    const h = this.heightScale;
    sets.forEach(([vx, vy], k) => {
      const nx = Math.max(1, Math.ceil((x1 - x0) / dx));
      const ny = Math.max(1, Math.ceil((y1 - y0) / dy));
      const segs = vx.length * ny + vy.length * nx;
      const out = new Float32Array(segs * 6);
      let w = 0;
      const point = (x: number, y: number) => {
        out[w++] = x;
        out[w++] = y;
        out[w++] = this.field.sample(x, y) * h;
      };
      for (const x of vx) {
        for (let j = 0; j < ny; j++) {
          point(x, y0 + ((y1 - y0) * j) / ny);
          point(x, y0 + ((y1 - y0) * (j + 1)) / ny);
        }
      }
      for (const y of vy) {
        for (let i = 0; i < nx; i++) {
          point(x0 + ((x1 - x0) * i) / nx, y);
          point(x0 + ((x1 - x0) * (i + 1)) / nx, y);
        }
      }
      const geom = this.gridLines[k].geometry;
      geom.setAttribute('position', new BufferAttribute(out, 3));
      geom.computeBoundingSphere();
    });
  }

  /** Normals of the height field by central differences (exact for a regular grid, fast). */
  private computeNormals(p: Float32Array, nx: number, ny: number, dx: number, dy: number): void {
    const nAttr = this.surface.geometry.getAttribute('normal') as BufferAttribute;
    const n = nAttr.array as Float32Array;
    for (let j = 0; j < ny; j++) {
      const ja = j > 0 ? j - 1 : j;
      const jb = j < ny - 1 ? j + 1 : j;
      for (let i = 0; i < nx; i++) {
        const ia = i > 0 ? i - 1 : i;
        const ib = i < nx - 1 ? i + 1 : i;
        const hx = (p[3 * (j * nx + ib) + 2] - p[3 * (j * nx + ia) + 2]) / ((ib - ia) * dx);
        const hy = (p[3 * (jb * nx + i) + 2] - p[3 * (ja * nx + i) + 2]) / ((jb - ja) * dy);
        const inv = 1 / Math.sqrt(hx * hx + hy * hy + 1);
        const k = 3 * (j * nx + i);
        n[k] = -hx * inv;
        n[k + 1] = -hy * inv;
        n[k + 2] = inv;
      }
    }
    nAttr.needsUpdate = true;
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
