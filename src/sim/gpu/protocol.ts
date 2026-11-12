/**
 * Messages between the page (gpuIntegrator.ts) and the GPU worker (gpu.worker.ts). Every request
 * carries an id and is answered once, with the same id, in the order of the requests. (The page
 * gives the GPU back by terminating the worker.)
 */

export type GpuRequest =
  /** Gets a GPU device and allocates room for `capacity` particles. */
  | { type: 'init'; capacity: number }
  /** Compiles a kernel (WGSL source, see kernel.ts) under `key`. */
  | { type: 'kernel'; key: string; code: string }
  /** Replaces the particles on the GPU: interleaved positions (x, y) and ids. */
  | { type: 'particles'; n: number; pos: Float32Array<ArrayBuffer>; ids: Uint32Array<ArrayBuffer> }
  /**
   * The painted lattice: the chunk index (slot per chunk, −1 for none) and the nodal gradients
   * (gx, gy interleaved) of changed chunks. With `slots` larger than before, the buffer grows and
   * every chunk must be sent again.
   */
  | { type: 'field'; slots: number; index: Int32Array<ArrayBuffer>; writes: { slot: number; grad: Float32Array<ArrayBuffer> }[] }
  /** Runs a batch of steps with kernel `key` and returns the positions. */
  | { type: 'step'; key: string; params: ArrayBuffer; n: number }
  /** Evaluates drift and diffusion at points with kernel `key` (see PROBE_STRIDE). */
  | { type: 'probe'; key: string; params: ArrayBuffer; points: Float32Array<ArrayBuffer>; count: number };

export type GpuReply =
  | { type: 'ready'; maxChunks: number }
  | { type: 'done' }
  | { type: 'positions'; pos: Float32Array }
  | { type: 'probed'; values: Float32Array }
  | { type: 'failed'; message: string };

/** Sent by the worker on its own when the device is lost (driver reset, …). */
export interface GpuLost {
  type: 'lost';
  message: string;
}
