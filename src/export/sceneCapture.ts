/**
 * The scene as one picture: the canvases of the stage (the 2D view, drawn by the GPU or the CPU,
 * the overlay with the cursor and boxes, and the 3D view on top while it is shown) composed in
 * the order the page stacks them. WebGL canvases keep their picture only until the frame is
 * shown, so capture right after drawing, in the same animation frame.
 */
export class SceneCapture {
  private readonly stage: HTMLElement;

  constructor() {
    const stage = document.getElementById('stage');
    if (!stage) throw new Error('Missing #stage');
    this.stage = stage;
  }

  /** Size of the scene in device pixels. */
  size(): { width: number; height: number } {
    const gl = this.stage.querySelector<HTMLCanvasElement>('#gl');
    const width = gl?.width ?? 0;
    const height = gl?.height ?? 0;
    return width > 0 && height > 0
      ? { width, height }
      : { width: Math.round(this.stage.clientWidth * devicePixelRatio), height: Math.round(this.stage.clientHeight * devicePixelRatio) };
  }

  /** Draws the scene scaled to (0, 0, width, height) of `ctx`, on white. */
  draw(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, width: number, height: number): void {
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    for (const c of this.stage.querySelectorAll<HTMLCanvasElement>('canvas')) {
      if (c.hidden || c.width === 0 || c.height === 0) continue;
      const opacity = c.style.opacity === '' ? 1 : Number(c.style.opacity);
      if (!(opacity > 0)) continue;
      ctx.globalAlpha = Math.min(1, opacity);
      ctx.drawImage(c, 0, 0, width, height);
    }
    ctx.restore();
  }

  /** The scene as a PNG at its full resolution. */
  async png(): Promise<Blob> {
    const { width, height } = this.size();
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D is not supported.');
    this.draw(ctx, width, height);
    return new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('The picture could not be made.'))), 'image/png'),
    );
  }
}
