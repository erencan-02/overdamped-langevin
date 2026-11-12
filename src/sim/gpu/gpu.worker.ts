/// <reference lib="webworker" />
import { CHUNK } from '../field';
import { PARAMS_BYTES, PROBE_STRIDE, WORKGROUP } from './kernel';
import type { GpuLost, GpuReply, GpuRequest } from './protocol';

/**
 * The GPU integrator's worker: it owns the WebGPU device, the particles and the painted lattice
 * on the GPU, and the compiled kernels. Requests are handled one after another, in order, and each
 * is answered once (see protocol.ts). Running here keeps the GPU's bookkeeping (and waiting for
 * results) off the page's thread.
 */

const scope = self as unknown as DedicatedWorkerGlobalScope;

/** Bytes of the nodal gradients of one chunk (gx, gy as f32). */
const CHUNK_BYTES = CHUNK * CHUNK * 8;
const MAX_PROBES = 256;

interface Gpu {
  device: GPUDevice;
  layout: GPUBindGroupLayout;
  pipelineLayout: GPUPipelineLayout;
  params: GPUBuffer;
  pos: GPUBuffer;
  ids: GPUBuffer;
  readback: GPUBuffer;
  probe: GPUBuffer;
  probeRead: GPUBuffer;
  index: GPUBuffer;
  grad: GPUBuffer;
  gradSlots: number;
  maxChunks: number;
  bindGroup: GPUBindGroup | null;
  kernels: Map<string, { advance: GPUComputePipeline; probe: GPUComputePipeline }>;
}

let gpu: Gpu | null = null;
let queue: Promise<void> = Promise.resolve();

scope.onmessage = (e: MessageEvent<{ id: number; request: GpuRequest }>) => {
  const { id, request } = e.data;
  // One request after another: the GPU's state changes in the order the page asked for.
  queue = queue.then(async () => {
    let reply: GpuReply;
    const transfer: Transferable[] = [];
    try {
      reply = await handle(request, transfer);
    } catch (err) {
      reply = { type: 'failed', message: err instanceof Error ? err.message : String(err) };
    }
    scope.postMessage({ id, reply }, transfer);
  });
};

async function handle(r: GpuRequest, transfer: Transferable[]): Promise<GpuReply> {
  if (r.type === 'init') return init(r.capacity);
  const g = gpu;
  if (!g) throw new Error('The GPU is not ready.');
  switch (r.type) {
    case 'kernel':
      await compile(g, r.key, r.code);
      return { type: 'done' };
    case 'particles':
      g.device.queue.writeBuffer(g.pos, 0, r.pos, 0, r.n * 2);
      g.device.queue.writeBuffer(g.ids, 0, r.ids, 0, r.n);
      return { type: 'done' };
    case 'field':
      writeField(g, r.slots, r.index, r.writes);
      return { type: 'done' };
    case 'step': {
      const pos = await step(g, r.key, r.params, r.n);
      transfer.push(pos.buffer);
      return { type: 'positions', pos };
    }
    case 'probe': {
      const values = await probe(g, r.key, r.params, r.points, r.count);
      transfer.push(values.buffer);
      return { type: 'probed', values };
    }
  }
}

async function init(capacity: number): Promise<GpuReply> {
  if (!navigator.gpu) throw new Error('This browser offers no WebGPU.');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('No GPU adapter for WebGPU.');
  const max = Math.min(adapter.limits.maxStorageBufferBindingSize, adapter.limits.maxBufferSize);
  const device = await adapter.requestDevice({
    requiredLimits: { maxStorageBufferBindingSize: max, maxBufferSize: max },
  });
  device.lost.then((info) => {
    gpu = null;
    const lost: GpuLost = { type: 'lost', message: info.message || 'The GPU device was lost.' };
    scope.postMessage(lost);
  });
  const storage = (binding: number, readOnly: boolean): GPUBindGroupLayoutEntry => ({
    binding,
    visibility: GPUShaderStage.COMPUTE,
    buffer: { type: readOnly ? 'read-only-storage' : 'storage' },
  });
  const layout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      storage(1, false),
      storage(2, true),
      storage(3, true),
      storage(4, true),
      storage(5, false),
    ],
  });
  const buffer = (size: number, usage: number) => device.createBuffer({ size: Math.max(16, size), usage });
  const S = GPUBufferUsage;
  gpu = {
    device,
    layout,
    pipelineLayout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    params: buffer(PARAMS_BYTES, S.UNIFORM | S.COPY_DST),
    pos: buffer(capacity * 8, S.STORAGE | S.COPY_DST | S.COPY_SRC),
    ids: buffer(capacity * 4, S.STORAGE | S.COPY_DST),
    readback: buffer(capacity * 8, S.MAP_READ | S.COPY_DST),
    probe: buffer(MAX_PROBES * PROBE_STRIDE * 4, S.STORAGE | S.COPY_DST | S.COPY_SRC),
    probeRead: buffer(MAX_PROBES * PROBE_STRIDE * 4, S.MAP_READ | S.COPY_DST),
    index: buffer(4, S.STORAGE | S.COPY_DST),
    grad: buffer(8, S.STORAGE | S.COPY_DST),
    gradSlots: 0,
    maxChunks: Math.floor(max / CHUNK_BYTES),
    bindGroup: null,
    kernels: new Map(),
  };
  return { type: 'ready', maxChunks: gpu.maxChunks };
}

async function compile(g: Gpu, key: string, code: string): Promise<void> {
  if (g.kernels.has(key)) return;
  const module = g.device.createShaderModule({ code });
  const info = await module.getCompilationInfo();
  const errors = info.messages.filter((m) => m.type === 'error');
  if (errors.length) throw new Error(`Kernel does not compile: ${errors[0].message} (line ${errors[0].lineNum})`);
  const pipeline = (entryPoint: string) =>
    g.device.createComputePipelineAsync({ layout: g.pipelineLayout, compute: { module, entryPoint } });
  const [advance, probe] = await Promise.all([pipeline('advance'), pipeline('probe_points')]);
  // Keep a few kernels (switching back and forth between processes is common).
  if (g.kernels.size >= 8) g.kernels.delete(g.kernels.keys().next().value!);
  g.kernels.set(key, { advance, probe });
}

function writeField(g: Gpu, slots: number, index: Int32Array<ArrayBuffer>, writes: { slot: number; grad: Float32Array<ArrayBuffer> }[]): void {
  const device = g.device;
  if (slots > g.maxChunks) throw new Error('The painted area is too large for the GPU.');
  if (slots > g.gradSlots) {
    g.grad.destroy();
    g.grad = device.createBuffer({ size: Math.max(8, slots * CHUNK_BYTES), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    g.gradSlots = slots;
    g.bindGroup = null;
  }
  if (index.byteLength > g.index.size) {
    g.index.destroy();
    g.index = device.createBuffer({ size: Math.max(16, index.byteLength * 2), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    g.bindGroup = null;
  }
  if (index.length) device.queue.writeBuffer(g.index, 0, index);
  for (const w of writes) device.queue.writeBuffer(g.grad, w.slot * CHUNK_BYTES, w.grad);
}

function bindGroup(g: Gpu): GPUBindGroup {
  g.bindGroup ??= g.device.createBindGroup({
    layout: g.layout,
    entries: [g.params, g.pos, g.ids, g.index, g.grad, g.probe].map((buffer, binding) => ({ binding, resource: { buffer } })),
  });
  return g.bindGroup;
}

function kernel(g: Gpu, key: string) {
  const k = g.kernels.get(key);
  if (!k) throw new Error('Unknown kernel.');
  return k;
}

async function step(g: Gpu, key: string, params: ArrayBuffer, n: number): Promise<Float32Array> {
  const k = kernel(g, key);
  const device = g.device;
  device.queue.writeBuffer(g.params, 0, params);
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(k.advance);
  pass.setBindGroup(0, bindGroup(g));
  pass.dispatchWorkgroups(Math.ceil(n / WORKGROUP));
  pass.end();
  encoder.copyBufferToBuffer(g.pos, 0, g.readback, 0, n * 8);
  device.queue.submit([encoder.finish()]);
  await g.readback.mapAsync(GPUMapMode.READ, 0, n * 8);
  const out = new Float32Array(g.readback.getMappedRange(0, n * 8).slice(0));
  g.readback.unmap();
  return out;
}

async function probe(g: Gpu, key: string, params: ArrayBuffer, points: Float32Array<ArrayBuffer>, count: number): Promise<Float32Array> {
  if (count > MAX_PROBES) throw new Error('Too many probe points.');
  const k = kernel(g, key);
  const device = g.device;
  const bytes = count * PROBE_STRIDE * 4;
  device.queue.writeBuffer(g.params, 0, params);
  device.queue.writeBuffer(g.probe, 0, points, 0, count * PROBE_STRIDE);
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(k.probe);
  pass.setBindGroup(0, bindGroup(g));
  pass.dispatchWorkgroups(Math.ceil(count / WORKGROUP));
  pass.end();
  encoder.copyBufferToBuffer(g.probe, 0, g.probeRead, 0, bytes);
  device.queue.submit([encoder.finish()]);
  await g.probeRead.mapAsync(GPUMapMode.READ, 0, bytes);
  const out = new Float32Array(g.probeRead.getMappedRange(0, bytes).slice(0));
  g.probeRead.unmap();
  return out;
}
