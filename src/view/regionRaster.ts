/**
 * A set {(x, y) : g(x, y) > 0} drawn as a transparent tint: g is evaluated on a coarse grid (one
 * batch) over the view plus a margin, written into a small image, and the overlay draws that
 * image stretched over its world rectangle (smoothed, so the edge looks soft rather than blocky).
 *
 * The image is only rebuilt when the set may have changed (`key`), when the view leaves the
 * covered area, or after a zoom that changes the grid noticeably. Panning within the margin costs
 * nothing.
 */

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** What the overlay draws: an image stretched over a world rectangle. */
export interface RegionImage extends Rect {
  image: CanvasImageSource;
}

/** Grid cells are about this many screen pixels wide. */
const CELL_PX = 5;
/** The area covered is the view plus this fraction of its size on each side. */
const MARGIN = 0.5;
/** Tint of the set: teal, about a quarter opaque. */
const TINT = [13, 148, 136, 64] as const;

export class RegionRaster {
  private canvas: HTMLCanvasElement | null = null;
  private region: RegionImage | null = null;
  private key = '';
  private scale = 0;

  /**
   * The tinted set for this view (world rectangle and pixels per world unit), rebuilt only when
   * needed. `evaluate` gives g at n points; `key` changes whenever g may have changed.
   */
  image(
    view: Rect,
    pxPerUnit: number,
    key: string,
    evaluate: (xs: Float64Array, ys: Float64Array, n: number) => ArrayLike<number>,
  ): RegionImage | null {
    const r = this.region;
    const covered =
      r !== null && view.x0 >= r.x0 && view.x1 <= r.x1 && view.y0 >= r.y0 && view.y1 <= r.y1 && Math.abs(Math.log(pxPerUnit / this.scale)) < 0.4;
    if (covered && key === this.key) return r;

    const w = view.x1 - view.x0;
    const h = view.y1 - view.y0;
    if (!(w > 0 && h > 0 && pxPerUnit > 0)) return null;
    const area = { x0: view.x0 - MARGIN * w, y0: view.y0 - MARGIN * h, x1: view.x1 + MARGIN * w, y1: view.y1 + MARGIN * h };
    const cell = CELL_PX / pxPerUnit;
    const nx = Math.max(2, Math.min(1024, Math.ceil((area.x1 - area.x0) / cell)));
    const ny = Math.max(2, Math.min(1024, Math.ceil((area.y1 - area.y0) / cell)));
    const n = nx * ny;
    const xs = new Float64Array(n);
    const ys = new Float64Array(n);
    const dx = (area.x1 - area.x0) / nx;
    const dy = (area.y1 - area.y0) / ny;
    for (let j = 0; j < ny; j++) {
      const y = area.y1 - (j + 0.5) * dy; // row 0 is the top of the image
      for (let i = 0; i < nx; i++) {
        xs[j * nx + i] = area.x0 + (i + 0.5) * dx;
        ys[j * nx + i] = y;
      }
    }
    const g = evaluate(xs, ys, n);
    const canvas = (this.canvas ??= document.createElement('canvas'));
    canvas.width = nx;
    canvas.height = ny;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const img = ctx.createImageData(nx, ny);
    const px = img.data;
    for (let k = 0; k < n; k++) {
      if (!(g[k] > 0)) continue;
      px[4 * k] = TINT[0];
      px[4 * k + 1] = TINT[1];
      px[4 * k + 2] = TINT[2];
      px[4 * k + 3] = TINT[3];
    }
    ctx.putImageData(img, 0, 0);
    this.region = { ...area, image: canvas };
    this.key = key;
    this.scale = pxPerUnit;
    return this.region;
  }
}
