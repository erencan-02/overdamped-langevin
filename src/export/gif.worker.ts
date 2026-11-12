/// <reference lib="webworker" />
import { applyPalette, GIFEncoder, quantize } from 'gifenc';

/**
 * Encodes an animated GIF frame by frame, away from the page: each frame gets its own palette of
 * up to 256 colours. Messages: { frame: rgba, width, height, delay } adds a frame (delay in ms)
 * and is answered with { done: true }; { finish: true } is answered with { gif: bytes }, and the
 * worker starts afresh.
 */

export type GifWorkerMessage =
  | { frame: Uint8ClampedArray; width: number; height: number; delay: number }
  | { finish: true };

const scope = self as unknown as DedicatedWorkerGlobalScope;
let gif = GIFEncoder();

scope.onmessage = (e: MessageEvent<GifWorkerMessage>) => {
  const m = e.data;
  if ('finish' in m) {
    gif.finish();
    const bytes = gif.bytes();
    gif = GIFEncoder();
    scope.postMessage({ gif: bytes }, [bytes.buffer]);
    return;
  }
  const palette = quantize(m.frame, 256);
  const index = applyPalette(m.frame, palette);
  gif.writeFrame(index, m.width, m.height, { palette, delay: m.delay });
  scope.postMessage({ done: true });
};
