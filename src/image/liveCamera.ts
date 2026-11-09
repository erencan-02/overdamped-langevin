import { PSI_CAP } from '../config';
import type { PotentialField } from '../sim/field';
import {
  type DarknessLevels,
  darknessLevels,
  IMAGE_BLUR_WORLD,
  type ImageSample,
  imageToPotential,
  importSize,
} from '../sim/imagePotential';
import type { Camera } from '../view/camera';
import { rgbaToSample } from './pixels';
import { type GridPlacement, writePotential } from './writePotential';

/**
 * Sample spacing relative to the blur width. The potential is blurred with σ = IMAGE_BLUR_WORLD
 * anyway, so sampling at σ/1.5 loses nothing visible while keeping the per-frame work small.
 */
const SAMPLES_PER_SIGMA = 1.5;
/** Upper bound on samples along the longer side of the camera image. */
const MAX_SAMPLES = 160;
/** The camera region is at most this large (world units) so per-frame work stays bounded. */
const MAX_WORLD = 16;
/** Per-frame weight of new contrast levels (exposure changes fade in over ~0.3 s at 30 fps). */
const LEVELS_SMOOTHING = 0.12;
/**
 * The darkness range is never stretched to less than this, so a dark or flat scene does not
 * blow sensor noise up into deep valleys.
 */
const MIN_LEVEL_SPAN = 0.25;

export type CameraState = 'off' | 'starting' | 'live';

export interface LiveCameraHooks {
  onStateChange(state: CameraState): void;
  onError(message: string): void;
}

/**
 * Turns the front camera into a live potential: every new video frame goes through the same
 * pipeline as a dropped image (lightness → contrast stretch → blur → Ψ) and overwrites the
 * camera's region of the field.
 *
 * Latency: frames are processed in `requestVideoFrameCallback`, i.e. as soon as the browser has
 * a new frame, on the main thread (a worker round trip would add a frame of delay), and the new
 * Ψ is drawn in the very next animation frame. The work per frame is kept small: a ~160 × 120
 * readback, one pass for lightness and levels, a blur, and a write into a bounded region.
 */
export class LiveCamera {
  state: CameraState = 'off';
  /** Treat light areas as valleys instead of dark ones. */
  invert = false;
  /** Smoothed processing time per frame in ms (for diagnostics). */
  processMs = 0;

  private stream: MediaStream | null = null;
  private token = 0;
  private frameRequest = 0;
  private usesVideoFrameCallback = false;
  private lastMediaTime = -1;

  private readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  private sample: ImageSample | undefined;
  private levels: DarknessLevels | null = null;
  private placement: GridPlacement | null = null;
  private blur = 0;

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly field: PotentialField,
    private readonly camera: Camera,
    private readonly hooks: LiveCameraHooks,
  ) {
    const ctx = this.canvas.getContext('2d', { willReadFrequently: true, alpha: false });
    if (!ctx) throw new Error('Canvas 2D is not supported.');
    this.ctx = ctx;
    video.muted = true;
    video.playsInline = true;
  }

  get active(): boolean {
    return this.state !== 'off';
  }

  toggle(): void {
    if (this.active) this.stop();
    else void this.start();
  }

  async start(): Promise<void> {
    if (this.state !== 'off') return;
    if (!navigator.mediaDevices?.getUserMedia) {
      this.hooks.onError('Camera access needs a secure (https) page and a browser that supports it.');
      return;
    }
    const token = ++this.token;
    this.setState('starting');
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: 'user',
          // Small frames are plenty for a ~160-sample potential and cheaper to decode and read.
          width: { ideal: 640 },
          height: { ideal: 480 },
          frameRate: { ideal: 30 },
        },
      });
    } catch (err) {
      if (token === this.token) {
        this.setState('off');
        this.hooks.onError(cameraErrorMessage(err));
      }
      return;
    }
    if (token !== this.token) {
      // Stopped while the permission prompt was open.
      for (const t of stream.getTracks()) t.stop();
      return;
    }
    this.stream = stream;
    stream.getVideoTracks()[0]?.addEventListener('ended', () => {
      if (this.stream === stream) {
        this.stop();
        this.hooks.onError('The camera was disconnected.');
      }
    });

    try {
      this.video.srcObject = stream;
      await this.video.play();
      if (!this.video.videoWidth) {
        await new Promise<void>((resolve) =>
          this.video.addEventListener('loadedmetadata', () => resolve(), { once: true }),
        );
      }
    } catch (err) {
      if (token === this.token) {
        this.stop();
        this.hooks.onError(cameraErrorMessage(err));
      }
      return;
    }
    if (token !== this.token) return;

    this.layout(this.video.videoWidth, this.video.videoHeight);
    this.setState('live');
    this.usesVideoFrameCallback = 'requestVideoFrameCallback' in this.video;
    this.lastMediaTime = -1;
    this.process(); // first frame right away
    this.schedule();
  }

  /** Stops the camera. The last frame stays in Ψ. */
  stop(): void {
    this.token++;
    if (this.frameRequest) {
      if (this.usesVideoFrameCallback) this.video.cancelVideoFrameCallback(this.frameRequest);
      else cancelAnimationFrame(this.frameRequest);
      this.frameRequest = 0;
    }
    if (this.stream) for (const t of this.stream.getTracks()) t.stop();
    this.stream = null;
    this.video.pause();
    this.video.srcObject = null;
    this.levels = null;
    this.placement = null;
    if (this.state !== 'off') this.setState('off');
  }

  private setState(state: CameraState): void {
    this.state = state;
    this.hooks.onStateChange(state);
  }

  /** Chooses the camera's world rectangle (centred in the view) and the sampling resolution. */
  private layout(videoWidth: number, videoHeight: number): void {
    const h = this.field.h;
    const b = this.camera.bounds();
    const size = importSize(
      videoWidth,
      videoHeight,
      { width: b.x1 - b.x0, height: b.y1 - b.y0 },
      h,
      { maxWorld: MAX_WORLD },
    );
    const cell = Math.max(
      h,
      IMAGE_BLUR_WORLD / SAMPLES_PER_SIGMA,
      Math.max(size.worldWidth, size.worldHeight) / MAX_SAMPLES,
    );
    const w = Math.max(2, Math.round(size.worldWidth / cell));
    const hgt = Math.max(2, Math.round(size.worldHeight / cell));
    const worldW = w * cell;
    const worldH = hgt * cell;
    const x0 = Math.round((this.camera.x - worldW / 2) / h) * h;
    const yTop = Math.round((this.camera.y + worldH / 2) / h) * h;
    this.placement = { x0, yTop, cell };
    this.blur = IMAGE_BLUR_WORLD / cell;

    this.canvas.width = w;
    this.canvas.height = hgt;
    // Mirror horizontally: a front camera should behave like a mirror.
    this.ctx.setTransform(-1, 0, 0, 1, w, 0);
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.imageSmoothingQuality = 'low'; // bilinear is enough for ~4× downscaling, and fastest
    this.sample = undefined;

    this.field.clear();
    this.camera.showRect(x0, yTop - worldH, x0 + worldW, yTop);
  }

  private schedule(): void {
    if (this.state !== 'live') return;
    if (this.usesVideoFrameCallback) {
      this.frameRequest = this.video.requestVideoFrameCallback(this.onVideoFrame);
    } else {
      this.frameRequest = requestAnimationFrame(this.onAnimationFrame);
    }
  }

  private onVideoFrame = (): void => {
    this.frameRequest = 0;
    if (this.state !== 'live') return;
    this.process();
    this.schedule();
  };

  /** Fallback without requestVideoFrameCallback: process when the video time has advanced. */
  private onAnimationFrame = (): void => {
    this.frameRequest = 0;
    if (this.state !== 'live') return;
    if (this.video.currentTime !== this.lastMediaTime) {
      this.lastMediaTime = this.video.currentTime;
      this.process();
    }
    this.schedule();
  };

  /** One video frame → Ψ. */
  private process(): void {
    const at = this.placement;
    if (!at || this.video.readyState < 2) return;
    const t0 = performance.now();
    const { width: w, height: h } = this.canvas;
    this.ctx.drawImage(this.video, 0, 0, w, h);
    const rgba = this.ctx.getImageData(0, 0, w, h).data;
    const sample = (this.sample = rgbaToSample(rgba, w, h, this.sample));

    const measured = darknessLevels(sample);
    if (measured) this.levels = smoothLevels(this.levels, measured);
    if (!this.levels) return;
    const grid = imageToPotential(sample, {
      depth: PSI_CAP,
      invert: this.invert,
      blur: this.blur,
      levels: this.levels,
    });
    if (grid) writePotential(this.field, grid, at);
    this.processMs = 0.9 * this.processMs + 0.1 * (performance.now() - t0);
  }
}

/** Exponential smoothing of the contrast levels, with a minimum span against noise. */
export function smoothLevels(prev: DarknessLevels | null, next: DarknessLevels): DarknessLevels {
  let lo = prev ? prev.lo + (next.lo - prev.lo) * LEVELS_SMOOTHING : next.lo;
  let hi = prev ? prev.hi + (next.hi - prev.hi) * LEVELS_SMOOTHING : next.hi;
  if (hi - lo < MIN_LEVEL_SPAN) {
    const mid = (lo + hi) / 2;
    lo = mid - MIN_LEVEL_SPAN / 2;
    hi = mid + MIN_LEVEL_SPAN / 2;
  }
  return { lo, hi };
}

export function cameraErrorMessage(err: unknown): string {
  const name = err instanceof DOMException || err instanceof Error ? err.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Camera access was blocked. Allow the camera for this site in your browser settings.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No camera was found on this device.';
    case 'NotReadableError':
    case 'AbortError':
      return 'The camera could not be started. Is another app using it?';
    default:
      return 'The camera could not be started.';
  }
}
