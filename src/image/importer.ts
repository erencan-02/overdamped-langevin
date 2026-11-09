import { PALETTE, PSI_CAP } from '../config';
import type { PotentialField } from '../sim/field';
import { sampleImagePoints } from '../sim/imageParticles';
import { IMAGE_BLUR_WORLD, imageToPotential } from '../sim/imagePotential';
import { MAX_PARTICLES, type ParticleSystem } from '../sim/particles';
import type { Camera } from '../view/camera';
import { type DecodedImage, decodeSource, isImageFile } from './decode';
import type { WorkerRequest } from './decode.worker';
import { writePotential } from './writePotential';

/** The loading overlay stays at least this long so it never just flashes. */
const MIN_BUSY_MS = 450;

/** What a dropped image turns into. */
export type ImportTarget = 'potential' | 'particles';

export interface ImporterHooks {
  /** Called when an import starts (e.g. to cancel any tool that is in use). */
  onStart(target: ImportTarget): void;
  /** Called after Ψ (or the particles) were replaced by the image. */
  onImported(info: { name: string; inverted: boolean; target: ImportTarget; count: number }): void;
  onError(message: string): void;
}

const LOADING_TITLE: Record<ImportTarget, string> = {
  potential: 'Converting image to Ψ…',
  particles: 'Placing particles…',
};
const NO_CONTRAST: Record<ImportTarget, string> = {
  potential: 'This image has almost no contrast, so it would give a flat Ψ.',
  particles: 'This image has almost no contrast, so there is nothing to place particles on.',
};

type WorkerReply =
  | { id: number; ok: true; image: DecodedImage }
  | { id: number; ok: false; error: string };

/**
 * Turns the window into two drop zones for images: the left half converts a dropped image into
 * Ψ, the right half into particles whose density follows the image. While an image is being
 * processed, a dimmed overlay with a spinner blocks all input.
 */
export class ImageImporter {
  /** True while an image is being decoded and converted. */
  busy = false;

  private dragDepth = 0;
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, (r: WorkerReply) => void>();
  private last: {
    image: DecodedImage;
    cx: number;
    cy: number;
    name: string;
    inverted: boolean;
    target: ImportTarget;
  } | null = null;
  /** Drop zone under the cursor while dragging. */
  private dragTarget: ImportTarget = 'potential';
  /** Target of the file picker that is currently open. */
  private pickerTarget: ImportTarget = 'potential';

  private readonly dropOverlay = el('drop-overlay');
  private readonly dropZones = Array.from(this.dropOverlay.querySelectorAll<HTMLElement>('.drop-zone'));
  private readonly loadingOverlay = el('loading-overlay');
  private readonly loadingTitle = el('loading-title');
  private readonly loadingName = el('loading-name');
  private readonly fileInput = el('image-input') as HTMLInputElement;

  constructor(
    private readonly field: PotentialField,
    private readonly particles: ParticleSystem,
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
      if (file) void this.importFile(file, this.pickerTarget);
    });
    // The loading overlay swallows every pointer, wheel and touch interaction.
    for (const type of ['pointerdown', 'wheel', 'contextmenu', 'touchstart'] as const) {
      this.loadingOverlay.addEventListener(type, (e) => e.preventDefault(), { passive: false });
    }
  }

  /** Opens the system file picker; the chosen image goes to `target`. */
  openPicker(target: ImportTarget = 'potential'): void {
    if (this.busy) return;
    this.pickerTarget = target;
    this.fileInput.click();
  }

  /** Re-applies the last imported image with dark and light swapped. */
  invertLast(): void {
    const last = this.last;
    if (!last || this.busy) return;
    last.inverted = !last.inverted;
    const count = this.apply(last.image, last.cx, last.cy, last.inverted, last.target);
    if (count > 0) {
      this.hooks.onImported({ name: last.name, inverted: last.inverted, target: last.target, count });
    }
  }

  // ---------------------------------------------------------------- drag & drop

  private hasFiles(e: DragEvent): boolean {
    return Array.from(e.dataTransfer?.types ?? []).includes('Files');
  }

  /** Left half of the window: Ψ; right half: particles. */
  private targetAt(clientX: number): ImportTarget {
    return clientX < window.innerWidth / 2 ? 'potential' : 'particles';
  }

  private highlight(target: ImportTarget): void {
    this.dragTarget = target;
    for (const z of this.dropZones) z.classList.toggle('active', z.dataset.target === target);
  }

  private onDragEnter = (e: DragEvent): void => {
    if (!this.hasFiles(e)) return;
    e.preventDefault();
    this.dragDepth++;
    if (!this.busy) {
      this.highlight(this.targetAt(e.clientX));
      this.dropOverlay.hidden = false;
    }
  };

  private onDragOver = (e: DragEvent): void => {
    if (!this.hasFiles(e)) return;
    // Without preventDefault the browser would open the image in the tab.
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = this.busy ? 'none' : 'copy';
    if (!this.busy) {
      const target = this.targetAt(e.clientX);
      if (target !== this.dragTarget) this.highlight(target);
    }
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
    if (file) void this.importFile(file, this.targetAt(e.clientX));
    else if (files.length) this.hooks.onError('That file is not an image. Try a PNG, JPEG, WebP, GIF or SVG.');
  };

  // ---------------------------------------------------------------- import

  async importFile(file: File, target: ImportTarget = 'potential'): Promise<void> {
    if (this.busy) return;
    if (!isImageFile(file)) {
      this.hooks.onError('That file is not an image. Try a PNG, JPEG, WebP, GIF or SVG.');
      return;
    }
    this.setBusy(true, file.name, target);
    this.hooks.onStart(target);
    const started = performance.now();
    // The image goes where the user is looking.
    const cx = this.camera.x;
    const cy = this.camera.y;
    const b = this.camera.bounds();
    const req = { viewWidth: b.x1 - b.x0, viewHeight: b.y1 - b.y0, cellSize: this.field.h };

    let error: string | null = null;
    let count = 0;
    try {
      const image = await this.decode(file, req);
      count = this.apply(image, cx, cy, false, target);
      if (count > 0) {
        this.last = { image, cx, cy, name: file.name, inverted: false, target };
      } else {
        error = NO_CONTRAST[target];
      }
    } catch (err) {
      console.error(err);
      error = 'This image could not be read. Try a PNG, JPEG, WebP, GIF or SVG.';
    }

    const wait = MIN_BUSY_MS - (performance.now() - started);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.setBusy(false);
    if (error) this.hooks.onError(error);
    else this.hooks.onImported({ name: file.name, inverted: false, target, count });
  }

  private setBusy(busy: boolean, name = '', target: ImportTarget = 'potential'): void {
    this.busy = busy;
    this.loadingTitle.textContent = LOADING_TITLE[target];
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
   * Applies `image`, centred at (cx, cy), to `target`. Returns how many things changed: 1 for Ψ,
   * the number of particles placed for particles, 0 if the image has no usable contrast.
   */
  private apply(
    image: DecodedImage,
    cx: number,
    cy: number,
    inverted: boolean,
    target: ImportTarget,
  ): number {
    const h = this.field.h;
    // One sample per lattice node: pixel (i, j) (rows top to bottom) sits at (x0 + i·h, yTop − j·h).
    const x0 = Math.round((cx - image.worldWidth / 2) / h) * h;
    const yTop = Math.round((cy + image.worldHeight / 2) / h) * h;
    const count = target === 'potential' ? this.applyPotential(image, x0, yTop, inverted) : this.applyParticles(image, x0, yTop, inverted);
    if (count > 0) this.camera.showRect(x0, yTop - image.worldHeight, x0 + image.worldWidth, yTop);
    return count;
  }

  /** Replaces Ψ with the image's potential. */
  private applyPotential(image: DecodedImage, x0: number, yTop: number, inverted: boolean): number {
    const h = this.field.h;
    const grid = imageToPotential(image, { depth: PSI_CAP, invert: inverted, blur: IMAGE_BLUR_WORLD / h });
    if (!grid) return 0;
    this.field.clear();
    writePotential(this.field, grid, { x0, yTop, cell: h });
    return 1;
  }

  /**
   * Replaces all particles with MAX_PARTICLES new ones whose density follows the image
   * darkness. Ψ is left as it is.
   */
  private applyParticles(image: DecodedImage, x0: number, yTop: number, inverted: boolean): number {
    const h = this.field.h;
    const pts = sampleImagePoints(image, MAX_PARTICLES, { invert: inverted });
    if (!pts) return 0;
    const ps = this.particles;
    ps.clear();
    for (let p = 0; p < pts.length; p += 2) {
      ps.add(x0 + pts[p] * h, yTop - pts[p + 1] * h, Math.floor(Math.random() * PALETTE.length));
    }
    return ps.count;
  }
}

function el(id: string): HTMLElement {
  const e = document.getElementById(id);
  if (!e) throw new Error(`Missing element #${id}`);
  return e;
}
