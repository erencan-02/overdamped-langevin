/// <reference lib="webworker" />
import { type DecodeRequest, decodeSource } from './decode';

/** Decodes a dropped image off the main thread so the loading spinner keeps animating. */

export interface WorkerRequest extends DecodeRequest {
  id: number;
  file: Blob;
}

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const { id, file, ...req } = e.data;
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const out = decodeSource(bitmap, bitmap.width, bitmap.height, req, (w, h) => new OffscreenCanvas(w, h));
    bitmap.close();
    scope.postMessage({ id, ok: true, image: out }, [out.lightness.buffer, out.alpha.buffer]);
  } catch (err) {
    scope.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
