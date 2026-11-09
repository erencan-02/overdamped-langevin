import { type ImageSample, importSize } from '../sim/imagePotential';
import { rgbaToSample } from './pixels';

/**
 * Turns a decoded image (ImageBitmap or <img>) into an `ImageSample` at the potential grid's
 * resolution. Runs in a Web Worker (with OffscreenCanvas) or on the main thread as a fallback.
 */

export interface DecodeRequest {
  /** Visible world size, used to choose how large the image becomes. */
  viewWidth: number;
  viewHeight: number;
  cellSize: number;
}

export interface DecodedImage extends ImageSample {
  sourceWidth: number;
  sourceHeight: number;
  worldWidth: number;
  worldHeight: number;
}

type Canvas2D = {
  width: number;
  height: number;
  getContext(id: '2d', opts?: object): unknown;
};
type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type Source = CanvasImageSource;

export function decodeSource(
  source: Source,
  sourceWidth: number,
  sourceHeight: number,
  req: DecodeRequest,
  makeCanvas: (w: number, h: number) => Canvas2D,
): DecodedImage {
  if (!(sourceWidth > 0 && sourceHeight > 0)) throw new Error('The image has no pixels.');
  const size = importSize(sourceWidth, sourceHeight, { width: req.viewWidth, height: req.viewHeight }, req.cellSize);
  const { width, height } = size;

  // Downscale in steps of at most 2× so that large photos are averaged instead of aliased.
  let src: Source = source;
  let sw = sourceWidth;
  let sh = sourceHeight;
  while (sw > 2 * width || sh > 2 * height) {
    const nw = Math.max(width, Math.ceil(sw / 2));
    const nh = Math.max(height, Math.ceil(sh / 2));
    const c = makeCanvas(nw, nh);
    const ctx = c.getContext('2d') as Ctx2D;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, nw, nh);
    src = c as unknown as Source;
    sw = nw;
    sh = nh;
  }
  const canvas = makeCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as Ctx2D;
  ctx.imageSmoothingQuality = 'high';
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(src, 0, 0, width, height);
  const { lightness, alpha } = rgbaToSample(ctx.getImageData(0, 0, width, height).data, width, height);
  return {
    width,
    height,
    lightness,
    alpha,
    sourceWidth,
    sourceHeight,
    worldWidth: size.worldWidth,
    worldHeight: size.worldHeight,
  };
}

export function isImageFile(file: File): boolean {
  if (file.type) return file.type.startsWith('image/');
  return /\.(png|jpe?g|gif|webp|avif|bmp|svg|ico)$/i.test(file.name);
}
