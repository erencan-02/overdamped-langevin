import { PALETTE, PSI_CAP } from '../config';
import type { PotentialField } from '../sim/field';
import { sampleImagePoints } from '../sim/imageParticles';
import { IMAGE_BLUR_WORLD, imageToPotential } from '../sim/imagePotential';
import { MAX_PARTICLES, type ParticleSystem } from '../sim/particles';
import type { RandomStreams } from '../sim/random';
import type { BusyOverlay } from '../ui/busyOverlay';
import type { DropHandler } from '../ui/dropzone';
import type { Camera } from '../view/camera';
import { type DecodedImage, decodeSource, isImageFile } from './decode';
import type { WorkerRequest } from './decode.worker';
import { writePotential } from './writePotential';

/** What a dropped image turns into. */
export type ImportTarget = 'potential' | 'particles';

export interface ImporterHooks {
  /** Called when an import starts (e.g. to cancel any tool that is in use). */
  onStart(target: ImportTarget): void;
  /** Called after Ψ (or the particles) were replaced by the image. */
  onImported(info: { name: string; inverted: boolean; target: ImportTarget; count: number }): void;
  onError(message: string): void;
  /** Wraps each change of Ψ or of the particles (e.g. to make it one undo step). */
  edit?<T>(label: string, change: () => T): T;
  /** How many particles an image becomes (default MAX_PARTICLES). */
  particleCount?(): number;
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
 * Converts images into Ψ or into particles. Dropping is handled by ImageDropHandler (below), which
 * shows two zones: the left half of the window for Ψ, the right half for particles. While an image
 * is being processed, the shared busy overlay blocks all input.
 */
export class ImageImporter {
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
  /** Target of the file picker that is currently open. */
  private pickerTarget: ImportTarget = 'potential';

  private readonly fileInput = el('image-input') as HTMLInputElement;

  constructor(
    private readonly field: PotentialField,
    private readonly particles: ParticleSystem,
    private readonly camera: Camera,
    private readonly random: RandomStreams,
    private readonly busy: BusyOverlay,
    private readonly hooks: ImporterHooks,
  ) {
    this.fileInput.addEventListener('change', () => {
      const file = this.fileInput.files?.[0];
      this.fileInput.value = '';
      if (file) void this.importFile(file, this.pickerTarget);
    });
  }

  /** Opens the system file picker; the chosen image goes to `target`. */
  openPicker(target: ImportTarget = 'potential'): void {
    if (this.busy.active) return;
    this.pickerTarget = target;
    this.fileInput.click();
  }

  /** Re-applies the last imported image with dark and light swapped. */
  invertLast(): void {
    const last = this.last;
    if (!last || this.busy.active) return;
    last.inverted = !last.inverted;
    const count = this.apply(last.image, last.cx, last.cy, last.inverted, last.target);
    if (count > 0) {
      this.hooks.onImported({ name: last.name, inverted: last.inverted, target: last.target, count });
    }
  }

  // ---------------------------------------------------------------- import

  async importFile(file: File, target: ImportTarget = 'potential'): Promise<void> {
    if (this.busy.active) return;
    if (!isImageFile(file)) {
      this.hooks.onError('That file is not an image. Try a PNG, JPEG, WebP, GIF or SVG.');
      return;
    }
    this.hooks.onStart(target);
    // The image goes where the user is looking.
    const cx = this.camera.x;
    const cy = this.camera.y;
    const b = this.camera.bounds();
    const req = { viewWidth: b.x1 - b.x0, viewHeight: b.y1 - b.y0, cellSize: this.field.h };

    let error: string | null = null;
    let count = 0;
    await this.busy.run(LOADING_TITLE[target], file.name, async () => {
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
    });
    if (error) this.hooks.onError(error);
    else this.hooks.onImported({ name: file.name, inverted: false, target, count });
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
    const change = () =>
      target === 'potential' ? this.applyPotential(image, x0, yTop, inverted) : this.applyParticles(image, x0, yTop, inverted);
    const label = `${inverted ? 'Inverted image' : 'Image'} → ${target === 'potential' ? 'Ψ' : 'particles'}`;
    const count = this.hooks.edit ? this.hooks.edit(label, change) : change();
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
   * Replaces all particles with new ones (see `particleCount`) whose density follows the image
   * darkness. Ψ is left as it is.
   */
  private applyParticles(image: DecodedImage, x0: number, yTop: number, inverted: boolean): number {
    const h = this.field.h;
    const count = Math.min(MAX_PARTICLES, this.hooks.particleCount?.() ?? MAX_PARTICLES);
    const pts = sampleImagePoints(image, count, {
      invert: inverted,
      random: this.random.uniform('images'),
    });
    const colors = this.random.get('colors');
    if (!pts) return 0;
    const ps = this.particles;
    ps.clear();
    for (let p = 0; p < pts.length; p += 2) {
      ps.add(x0 + pts[p] * h, yTop - pts[p + 1] * h, colors.int(PALETTE.length));
    }
    return ps.count;
  }
}

/**
 * Drop handler for images: two zones, the left half of the window for Ψ, the right half for
 * particles.
 */
export class ImageDropHandler implements DropHandler {
  readonly id = 'image';

  constructor(private readonly importer: ImageImporter) {}

  acceptsDrag(items: readonly DataTransferItem[]): boolean {
    return items.length > 0 && items.every((i) => i.type.startsWith('image/'));
  }

  acceptsFile(file: File): boolean {
    return isImageFile(file);
  }

  private targetAt(clientX: number): ImportTarget {
    return clientX < window.innerWidth / 2 ? 'potential' : 'particles';
  }

  hover(clientX: number, _clientY: number, layout: HTMLElement): void {
    const target = this.targetAt(clientX);
    for (const z of layout.querySelectorAll<HTMLElement>('.drop-zone')) {
      z.classList.toggle('active', z.dataset.target === target);
    }
  }

  drop(file: File, clientX: number): void {
    void this.importer.importFile(file, this.targetAt(clientX));
  }
}

function el(id: string): HTMLElement {
  const e = document.getElementById(id);
  if (!e) throw new Error(`Missing element #${id}`);
  return e;
}
