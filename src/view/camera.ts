import { DEFAULTS, RANGES } from '../config';

/**
 * 2D camera mapping world coordinates (y up) to CSS pixels (y down).
 * `scale` is the number of CSS pixels per world unit.
 */
export class Camera {
  x = 0;
  y = 0;
  scale: number = DEFAULTS.scale;
  width = 1;
  height = 1;

  setViewport(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
  }

  toScreenX(wx: number): number {
    return (wx - this.x) * this.scale + this.width / 2;
  }

  toScreenY(wy: number): number {
    return this.height / 2 - (wy - this.y) * this.scale;
  }

  toWorldX(sx: number): number {
    return (sx - this.width / 2) / this.scale + this.x;
  }

  toWorldY(sy: number): number {
    return this.y - (sy - this.height / 2) / this.scale;
  }

  /** Moves the view so that content follows a pointer drag of (dsx, dsy) CSS pixels. */
  panBy(dsx: number, dsy: number): void {
    this.x -= dsx / this.scale;
    this.y += dsy / this.scale;
  }

  /** Zooms by `factor` keeping the world point under screen position (sx, sy) fixed. */
  zoomAt(sx: number, sy: number, factor: number): void {
    const wx = this.toWorldX(sx);
    const wy = this.toWorldY(sy);
    const [lo, hi] = RANGES.scale;
    this.scale = Math.min(hi, Math.max(lo, this.scale * factor));
    this.x = wx - (sx - this.width / 2) / this.scale;
    this.y = wy + (sy - this.height / 2) / this.scale;
  }

  reset(): void {
    this.x = 0;
    this.y = 0;
    this.scale = DEFAULTS.scale;
  }

  /** Visible world rectangle. */
  bounds(): { x0: number; y0: number; x1: number; y1: number } {
    const hw = this.width / 2 / this.scale;
    const hh = this.height / 2 / this.scale;
    return { x0: this.x - hw, y0: this.y - hh, x1: this.x + hw, y1: this.y + hh };
  }
}
