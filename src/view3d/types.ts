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
  resize(w: number, h: number, dpr: number): void;
  render(nowMs: number): void;
}
