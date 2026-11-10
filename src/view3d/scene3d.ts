/**
 * 3D view of the simulation, built with three.js: Ψ as a height field coloured with the app's
 * colour map (with the 2D grid lines and iso-lines on it), and the particles as spheres resting
 * on it at height Ψ(x, y). The tools work here as in 2D (the input controller asks `pick` where
 * the mouse points on the surface); the camera orbits with the middle mouse button or Alt +
 * left-drag, pans with Shift + middle, zooms with the wheel, and orbits with one finger on touch
 * screens (OrbitControls).
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
  LineDashedMaterial,
  LineLoop,
  LineSegments,
  Matrix4,
  Mesh,
  MeshLambertMaterial,
  MOUSE,
  PerspectiveCamera,
  Raycaster,
  Scene,
  SphereGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PALETTE } from '../config';
import type { PotentialField } from '../sim/field';
import { MAX_PARTICLES, type ParticleSystem } from '../sim/particles';
import { gridSpacing } from '../view/gridSpacing';
import { HeightField } from './heightField';
import type { CameraPose, Cursor3D, Formula3D, HeightSource, Rect, Scene3DView, WorldPick } from './types';

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
/** Brush cursor colours, as in 2D (overlay.ts): raising, lowering, idle. */
const RAISE = 0xea580c;
const LOWER = 0x2563eb;
const IDLE = 0x334155;
/** Points per cursor ring. */
const RING_POINTS = 96;
/** Ray marching steps across the surface's box when picking (then refined by bisection). */
const PICK_STEPS = 400;

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
  /** Cursor: 1σ ring (solid) and 2σ ring (dashed) of the brush, or the next particle's ring. */
  private readonly rings: [LineLoop, LineLoop];
  private readonly raycaster = new Raycaster();
  private readonly ndc = new Vector2();

  private region: Rect = { x0: 0, y0: 0, x1: 1, y1: 1 };
  /** World height per unit of Ψ (at full relief). */
  private heightScale = 1;
  private relief = 0;
  private particleRadius = 0.1;
  private cssWidth = 1;
  private cssHeight = 1;
  /** Ψ for particle heights and picking: the formula's exact values, or the drawn lattice. */
  private heights: HeightSource | null = null;
  private readonly scratch = { xs: new Float64Array(0), ys: new Float64Array(0), v: new Float64Array(0) };

  /** `getField` gives the lattice to show: the painted Ψ, or the one a formula is drawn into. */
  constructor(
    private readonly getField: () => PotentialField,
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
    // Left and right belong to the tools: orbit with the middle button (Shift + middle pans,
    // built into OrbitControls) or with Alt + left for trackpads; one finger orbits on touch.
    this.controls.mouseButtons = { LEFT: null, MIDDLE: MOUSE.ROTATE, RIGHT: null };
    this.canvas.addEventListener(
      'pointerdown',
      (e) => {
        this.controls.mouseButtons.LEFT = e.altKey ? MOUSE.ROTATE : null;
      },
      { capture: true }, // before OrbitControls reads it
    );

    this.scene.add(new AmbientLight(0xffffff, AMBIENT_PART * Math.PI));
    const sun = new DirectionalLight(0xffffff, SUN_PART * Math.PI);
    sun.position.copy(SUN);
    this.scene.add(sun);

    this.height = new HeightField(getField);

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

    const solid = new LineBasicMaterial({ color: IDLE, depthTest: false, transparent: true });
    const dashed = new LineDashedMaterial({
      color: IDLE,
      dashSize: 1,
      gapSize: 1,
      opacity: 0.6,
      transparent: true,
      depthTest: false,
    });
    this.height.apply(solid, { shade: false, colour: false });
    this.height.apply(dashed, { shade: false, colour: false });
    this.rings = [new LineLoop(new BufferGeometry(), solid), new LineLoop(new BufferGeometry(), dashed)];
    for (const ring of this.rings) {
      ring.geometry.setAttribute('position', new BufferAttribute(new Float32Array(RING_POINTS * 3), 3));
      ring.frustumCulled = false;
      ring.renderOrder = 10; // drawn last, on top of everything
      ring.visible = false;
      this.surface.add(ring);
    }

    this.dots = new InstancedMesh(new SphereGeometry(1, 20, 14), new MeshLambertMaterial(), MAX_PARTICLES);
    this.dots.instanceMatrix.setUsage(DynamicDrawUsage);
    this.dots.count = 0;
    this.dots.frustumCulled = false;
    this.dots.setColorAt(0, this.palette[0]); // allocates instanceColor
    this.scene.add(this.dots);
  }

  private get field(): PotentialField {
    return this.getField();
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
  setFormula(f: Formula3D | null): void {
    this.height.setFormula(f ? f.glsl : null);
    if (f) this.height.setTime(f.t, f.sigma);
    this.heights = f ? f.heights : null;
  }

  setContours(on: boolean): void {
    this.height.setContours(on);
  }

  /**
   * The point of the surface (as drawn: Ψ at the current relief) under the stage point (sx, sy),
   * found by marching along the camera ray through the surface's bounding box and refining the
   * first crossing by bisection. Null if the ray misses the surface.
   */
  pick(sx: number, sy: number): WorldPick | null {
    this.ndc.set((sx / this.cssWidth) * 2 - 1, 1 - (sy / this.cssHeight) * 2);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const o = this.raycaster.ray.origin;
    const d = this.raycaster.ray.direction;
    const lift = this.heightScale * Math.max(1e-4, this.relief);
    const zMax = this.field.cap * lift * 1.01 + 1e-6;
    const { x0, y0, x1, y1 } = this.region;
    // Slab test against the box [x0, x1] × [y0, y1] × [−zMax, zMax].
    let t0 = 0;
    let t1 = Infinity;
    const slab = (oc: number, dc: number, lo: number, hi: number): boolean => {
      if (Math.abs(dc) < 1e-12) return oc >= lo && oc <= hi;
      let a = (lo - oc) / dc;
      let b = (hi - oc) / dc;
      if (a > b) [a, b] = [b, a];
      t0 = Math.max(t0, a);
      t1 = Math.min(t1, b);
      return t0 <= t1;
    };
    if (!slab(o.x, d.x, x0, x1) || !slab(o.y, d.y, y0, y1) || !slab(o.z, d.z, -zMax, zMax)) return null;
    // Height of the ray above the surface at the parameters ts (all at once: a formula is
    // evaluated in one batch). The first parameter where it is ≤ 0 is the first crossing.
    const firstBelow = (ts: Float64Array): number => {
      const n = ts.length;
      const { xs, ys, v } = this.points(n);
      for (let k = 0; k < n; k++) {
        xs[k] = o.x + ts[k] * d.x;
        ys[k] = o.y + ts[k] * d.y;
      }
      this.surfaceHeights(xs, ys, n, v);
      for (let k = 0; k < n; k++) if (o.z + ts[k] * d.z - v[k] * lift <= 0) return k;
      return -1;
    };
    const steps = (a: number, b: number, n: number) => Float64Array.from({ length: n + 1 }, (_, k) => a + ((b - a) * k) / n);
    let ts = steps(t0, t1, PICK_STEPS);
    let k = firstBelow(ts);
    if (k < 0) return null;
    if (k === 0) return this.hit(t0); // starts below: the entry point is on the surface
    // Refine the crossing in [ts[k−1], ts[k]]: 32 sub-steps per round, four rounds (≈ 10⁻⁶·step).
    let lo = ts[k - 1];
    let hi = ts[k];
    for (let round = 0; round < 4; round++) {
      ts = steps(lo, hi, 32);
      k = firstBelow(ts);
      if (k <= 0) break; // (k = 0 cannot happen: lo is above the surface)
      lo = ts[k - 1];
      hi = ts[k];
    }
    return this.hit(hi);
  }

  /** Ψ as drawn (clamped to ±cap) at n points: the formula's exact values, or the lattice's. */
  private surfaceHeights(xs: Float64Array, ys: Float64Array, n: number, out: Float64Array): void {
    if (this.heights) this.heights.samplePoints(xs, ys, n, out);
    else this.field.samplePoints(xs, ys, n, out);
    const cap = this.field.cap;
    for (let i = 0; i < n; i++) {
      const v = out[i];
      out[i] = Number.isFinite(v) ? Math.min(cap, Math.max(-cap, v)) : 0;
    }
  }

  private points(n: number): { xs: Float64Array; ys: Float64Array; v: Float64Array } {
    const s = this.scratch;
    if (s.xs.length < n) {
      s.xs = new Float64Array(n);
      s.ys = new Float64Array(n);
      s.v = new Float64Array(n);
    }
    return { xs: s.xs.subarray(0, n), ys: s.ys.subarray(0, n), v: s.v.subarray(0, n) };
  }

  /** Shows the brush rings or the next particle's ring on the surface (null hides them). */
  setCursor(c: Cursor3D | null): void {
    const [solid, dashed] = this.rings;
    if (!c) {
      solid.visible = dashed.visible = false;
      return;
    }
    if (c.kind === 'brush') {
      const color = c.sign > 0 ? RAISE : c.sign < 0 ? LOWER : IDLE;
      this.placeRing(solid, c.x, c.y, c.radius, color);
      this.placeRing(dashed, c.x, c.y, 2 * c.radius, color);
      // Dashes of about 3 + 4 px, as in 2D, measured at the cursor.
      const mat = dashed.material as LineDashedMaterial;
      mat.dashSize = 3 * c.perPx;
      mat.gapSize = 4 * c.perPx;
      dashed.computeLineDistances();
    } else {
      this.placeRing(solid, c.x, c.y, this.particleRadius * 1.25, new Color(c.color).getHex());
      dashed.visible = false;
    }
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

  dispose(): void {
    this.controls.dispose();
    this.surface.geometry.dispose();
    this.outline.geometry.dispose();
    for (const l of this.gridLines) l.geometry.dispose();
    for (const r of this.rings) r.geometry.dispose();
    this.dots.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss(); // give the GPU context back now, not when collected
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

  private hit(t: number): WorldPick {
    const p = this.raycaster.ray.at(t, new Vector3());
    const distance = p.distanceTo(this.camera.position);
    const perPx = (2 * distance * Math.tan(((FOV / 2) * Math.PI) / 180)) / this.cssHeight;
    return { x: p.x, y: p.y, perPx };
  }

  /** A circle of radius r around (x, y), lying on the surface (lifted by the shader). */
  private placeRing(ring: LineLoop, x: number, y: number, r: number, color: number): void {
    const pos = ring.geometry.getAttribute('position') as BufferAttribute;
    const a = pos.array as Float32Array;
    for (let k = 0; k < RING_POINTS; k++) {
      const phi = (k / RING_POINTS) * Math.PI * 2;
      a[3 * k] = x + r * Math.cos(phi);
      a[3 * k + 1] = y + r * Math.sin(phi);
      a[3 * k + 2] = 0;
    }
    pos.needsUpdate = true;
    (ring.material as LineBasicMaterial).color.setHex(color);
    ring.visible = true;
  }

  // ---------------------------------------------------------------- particles

  /** Spheres at (x, y, Ψ(x, y)), resting on the (relief-scaled) surface. */
  private updateParticles(): void {
    const ps = this.particles;
    const r = this.particleRadius;
    const lift = this.heightScale * Math.max(1e-4, this.relief);
    const n = ps.count;
    const { xs, ys, v } = this.points(n);
    xs.set(ps.x.subarray(0, n));
    ys.set(ps.y.subarray(0, n));
    this.surfaceHeights(xs, ys, n, v); // one batch for all particles
    for (let i = 0; i < n; i++) {
      const x = ps.x[i];
      const y = ps.y[i];
      this.m.makeScale(r, r, r);
      this.m.setPosition(x, y, v[i] * lift + r);
      this.dots.setMatrixAt(i, this.m);
      this.dots.setColorAt(i, this.palette[ps.color[i]] ?? this.palette[0]);
    }
    this.dots.count = ps.count;
    this.dots.instanceMatrix.needsUpdate = true;
    if (this.dots.instanceColor) this.dots.instanceColor.needsUpdate = true;
  }
}
