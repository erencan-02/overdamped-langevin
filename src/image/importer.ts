import { PSI_CAP } from '../config';
import type { PotentialField } from '../sim/field';
import { IMAGE_BLUR_WORLD, imageToPotential } from '../sim/imagePotential';
import type { Camera } from '../view/camera';
import { type DecodedImage, decodeSource, isImageFile } from './decode';
import type { WorkerRequest } from './decode.worker';
import { writePotential } from './writePotential';

/** The loading overlay stays at least this long so it never just flashes. */
const MIN_BUSY_MS = 450;

export interface ImporterHooks {
  /** Called when an import starts (e.g. to cancel any tool that is in use). */
  onStart(): void;
  /** Called after Ψ was replaced by the image. */
  onImported(info: { name: string; inverted: boolean }): void;
  onError(message: string): void;
}

type WorkerReply =
  | { id: number; ok: true; image: DecodedImage }
  | { id: number; ok: false; error: string };

/**
 * Turns the whole window into a drop zone for images and converts a dropped (or picked) image
 * into Ψ. While an image is being processed, a dimmed overlay with a spinner blocks all input.
 */
export class ImageImporter {
  /** True while an image is being decoded and converted. */
  busy = false;

  private dragDepth = 0;
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, (r: WorkerReply) => void>();
  private last: { image: DecodedImage; cx: number; cy: number; name: string; inverted: boolean } | null =
    null;

  private readonly dropOverlay = el('drop-overlay');
  private readonly loadingOverlay = el('loading-overlay');
  private readonly loadingName = el('loading-name');
  private readonly fileInput = el('image-input') as HTMLInputElement;

  constructor(
    private readonly field: PotentialField,
    private readonly camera: Camera,
    private readonly hooks: ImporterHooks,
  ) {
    window.addEventListener('dragenter', this.onDragEnter);
    window.addEventListener('dragover', this.onDragOver);
    window.addEventListener('dragleave', this.onDragLeave);
    window.addEventListener('drop', this.onDrop);
    this.fileInput.addEventListener('change', () => {
      const file = this.fileInput.files?.[0];
      this.fileInput.value = '';
      if (file) void this.importFile(file);
    });
    // The loading overlay swallows every pointer, wheel and touch interaction.
    for (const type of ['pointerdown', 'wheel', 'contextmenu', 'touchstart'] as const) {
      this.loadingOverlay.addEventListener(type, (e) => e.preventDefault(), { passive: false });
    }
  }

  /** Opens the system file picker. */
  openPicker(): void {
    if (!this.busy) this.fileInput.click();
  }

  /** Re-applies the last imported image with dark and light swapped. */
  invertLast(): void {
    if (!this.last || this.busy) return;
    this.last.inverted = !this.last.inverted;
    if (this.apply(this.last.image, this.last.cx, this.last.cy, this.last.inverted)) {
      this.hooks.onImported({ name: this.last.name, inverted: this.last.inverted });
    }
  }

  // ---------------------------------------------------------------- drag & drop

  private hasFiles(e: DragEvent): boolean {
    return Array.from(e.dataTransfer?.types ?? []).includes('Files');
  }

  private onDragEnter = (e: DragEvent): void => {
    if (!this.hasFiles(e)) return;
    e.preventDefault();
    this.dragDepth++;
    if (!this.busy) this.dropOverlay.hidden = false;
  };

  private onDragOver = (e: DragEvent): void => {
    if (!this.hasFiles(e)) return;
    // Without preventDefault the browser would open the image in the tab.
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = this.busy ? 'none' : 'copy';
  };

  private onDragLeave = (e: DragEvent): void => {
    if (!this.hasFiles(e)) return;
    this.dragDepth = Math.max(0, this.dragDepth - 1);
    if (this.dragDepth === 0) this.dropOverlay.hidden = true;
  };

  private onDrop = (e: DragEvent): void => {
    if (!this.hasFiles(e)) return;
    e.preventDefault();
    this.dragDepth = 0;
    this.dropOverlay.hidden = true;
    if (this.busy) return;
    const files = Array.from(e.dataTransfer?.files ?? []);
    const file = files.find(isImageFile);
    if (file) void this.importFile(file);
    else if (files.length) this.hooks.onError('That file is not an image. Try a PNG, JPEG, WebP, GIF or SVG.');
  };

  // ---------------------------------------------------------------- import

  async importFile(file: File): Promise<void> {
    if (this.busy) return;
    if (!isImageFile(file)) {
      this.hooks.onError('That file is not an image. Try a PNG, JPEG, WebP, GIF or SVG.');
      return;
    }
    this.setBusy(true, file.name);
    this.hooks.onStart();
    const started = performance.now();
    // The image goes where the user is looking.
    const cx = this.camera.x;
    const cy = this.camera.y;
    const b = this.camera.bounds();
    const req = { viewWidth: b.x1 - b.x0, viewHeight: b.y1 - b.y0, cellSize: this.field.h };

    let error: string | null = null;
    try {
      const image = await this.decode(file, req);
      if (this.apply(image, cx, cy, false)) {
        this.last = { image, cx, cy, name: file.name, inverted: false };
      } else {
        error = 'This image has almost no contrast, so it would give a flat Ψ.';
      }
    } catch (err) {
      console.error(err);
      error = 'This image could not be read. Try a PNG, JPEG, WebP, GIF or SVG.';
    }

    const wait = MIN_BUSY_MS - (performance.now() - started);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.setBusy(false);
    if (error) this.hooks.onError(error);
    else this.hooks.onImported({ name: file.name, inverted: false });
  }

  private setBusy(busy: boolean, name = ''): void {
    this.busy = busy;
    this.loadingName.textContent = name;
    this.loadingOverlay.hidden = !busy;
    document.body.classList.toggle('is-busy', busy);
    if (busy) {
      this.dropOverlay.hidden = true;
      (document.activeElement as HTMLElement | null)?.blur?.();
    }
  }

  /** Decodes in a Web Worker when possible, otherwise (or if that fails) on the main thread. */
  private async decode(
    file: File,
    req: { viewWidth: number; viewHeight: number; cellSize: number },
  ): Promise<DecodedImage> {
    const worker = this.getWorker();
    if (worker) {
      const id = this.nextId++;
      const reply = await new Promise<WorkerReply>((resolve) => {
        this.pending.set(id, resolve);
        worker.postMessage({ id, file, ...req } satisfies WorkerRequest);
      });
      if (reply.ok) return reply.image;
      // Some formats (notably SVG) cannot be decoded in a worker; fall back to <img>.
    }
    return this.decodeOnMainThread(file, req);
  }

  private getWorker(): Worker | null {
    if (this.worker) return this.worker;
    if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') return null;
    try {
      this.worker = new Worker(new URL('./decode.worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e: MessageEvent<WorkerReply>) => {
        const resolve = this.pending.get(e.data.id);
        this.pending.delete(e.data.id);
        resolve?.(e.data);
      };
      this.worker.onerror = () => {
        // A broken worker: answer everything still pending with a failure (→ main-thread fallback).
        for (const [id, resolve] of this.pending) resolve({ id, ok: false, error: 'worker error' });
        this.pending.clear();
        this.worker?.terminate();
        this.worker = null;
      };
    } catch {
      this.worker = null;
    }
    return this.worker;
  }

  private async decodeOnMainThread(
    file: File,
    req: { viewWidth: number; viewHeight: number; cellSize: number },
  ): Promise<DecodedImage> {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.decoding = 'async';
      img.src = url;
      await img.decode();
      // SVGs without intrinsic size report 0×0; give them a sensible default.
      const w = img.naturalWidth || 1024;
      const h = img.naturalHeight || 1024;
      return decodeSource(img, w, h, req, (cw, ch) => {
        const c = document.createElement('canvas');
        c.width = cw;
        c.height = ch;
        return c;
      });
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /**
   * Replaces Ψ with the potential of `image`, centred at (cx, cy). Returns false if the image
   * has no usable contrast.
   */
  private apply(image: DecodedImage, cx: number, cy: number, inverted: boolean): boolean {
    const field = this.field;
    const h = field.h;
    const grid = imageToPotential(image, { depth: PSI_CAP, invert: inverted, blur: IMAGE_BLUR_WORLD / h });
    if (!grid) return false;

    // One sample per lattice node: pixel (i, j) (rows top to bottom) sits at (x0 + i·h, yTop − j·h).
    const x0 = Math.round((cx - image.worldWidth / 2) / h) * h;
    const yTop = Math.round((cy + image.worldHeight / 2) / h) * h;
    field.clear();
    writePotential(field, grid, { x0, yTop, cell: h });
    this.camera.showRect(x0, yTop - image.worldHeight, x0 + image.worldWidth, yTop);
    return true;
  }
}

function el(id: string): HTMLElement {
  const e = document.getElementById(id);
  if (!e) throw new Error(`Missing element #${id}`);
  return e;
}
