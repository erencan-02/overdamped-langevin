/** World rectangle. */
export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Camera on a sphere around a target point (z up): `polar` is the angle from straight above,
 * `azimuth` the direction of the camera seen from the target, measured from +x towards +y.
 */
export interface CameraPose {
  target: [number, number, number];
  distance: number;
  polar: number;
  azimuth: number;
}

/** The world point under a screen point, and how many world units one CSS pixel spans there. */
export interface WorldPick {
  x: number;
  y: number;
  perPx: number;
}

/** What the 3D view shows under the mouse: the brush rings, or the next particle. */
export type Cursor3D =
  | { kind: 'brush'; x: number; y: number; radius: number; sign: number; perPx: number }
  | { kind: 'particle'; x: number; y: number; color: string };

/** What the transition controller needs from the 3D scene (implemented by Scene3D). */
export interface Scene3DView {
  readonly canvas: HTMLCanvasElement;
  prepare(view: Rect): void;
  homePose(view: Rect): CameraPose;
  getPose(): CameraPose;
  setPose(p: CameraPose): void;
  setRelief(r: number): void;
  setControlsEnabled(on: boolean): void;
  setGrid(on: boolean): void;
  setContours(on: boolean): void;
  /** The point of the surface under a stage point (CSS px), or null if the ray misses it. */
  pick(sx: number, sy: number): WorldPick | null;
  setCursor(c: Cursor3D | null): void;
  resize(w: number, h: number, dpr: number): void;
  render(nowMs: number): void;
}
