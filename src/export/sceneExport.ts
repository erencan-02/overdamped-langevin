import type { VideoCodec } from 'mediabunny';
import { downloadBlob, timestamp } from '../ui/download';
import type { GifWorkerMessage } from './gif.worker';
import { SceneCapture } from './sceneCapture';

/** Largest video: long side × short side (the scene is scaled down to fit, never up). */
const VIDEO_MAX: readonly [number, number] = [1920, 1080];
const VIDEO_FPS = 30;
/** A video recording stops by itself after this long (it is kept in memory until saved). */
const VIDEO_MAX_SECONDS = 180;
const GIF_MAX_WIDTH = 640;
const GIF_FPS = 12;
const GIF_MAX_SECONDS = 30;
/** Frames waiting to be encoded at most; further frames are skipped (the video stays real-time). */
const MAX_PENDING = 4;

export type VideoFormat = 'mp4' | 'gif';

interface Recording {
  format: VideoFormat;
  /** File extension and type of the result. */
  ext: string;
  type: string;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  fps: number;
  maxSeconds: number;
  start: number;
  /** Index of the next frame on the frame grid (frame k is shown at k / fps). */
  next: number;
  pending: number;
  /** Encodes the frame now on `canvas` at time `t` (s); resolves when the encoder took it. */
  add(t: number): Promise<void>;
  /** Finishes the file. */
  finish(): Promise<Blob>;
  cancel(): void;
}

/**
 * Pictures and videos of the scene for slides: "Save picture" (PNG at the screen's resolution)
 * and video recordings, MP4 (H.264 via WebCodecs; WebM/VP9 where H.264 cannot be encoded) or an
 * animated GIF. Frames are taken from the frame loop right after drawing (`frame`), on a fixed
 * frame grid in real time; a frame the encoder cannot take in time is skipped, so the video
 * always plays at the speed it was recorded. While recording, a chip at the top shows the time
 * and a Stop button.
 */
export class SceneExport {
  private readonly capture = new SceneCapture();
  private rec: Recording | null = null;
  private finishing = false;
  private pictureWanted = false;
  private readonly chip: HTMLElement;
  private readonly chipTime: HTMLElement;
  private chipSeconds = -1;

  constructor(
    private readonly hooks: {
      toast(text: string): void;
      /** Recording started or stopped (e.g. to update the menu). */
      changed?(recording: boolean): void;
    },
  ) {
    this.chip = document.createElement('div');
    this.chip.className = 'video-chip card';
    this.chip.hidden = true;
    this.chip.setAttribute('role', 'status');
    const dot = document.createElement('span');
    dot.className = 'video-dot';
    dot.setAttribute('aria-hidden', 'true');
    this.chipTime = document.createElement('span');
    this.chipTime.className = 'video-time';
    const stop = document.createElement('button');
    stop.type = 'button';
    stop.textContent = 'Stop';
    stop.addEventListener('click', () => void this.stop());
    this.chip.append(dot, this.chipTime, stop);
    document.body.append(this.chip);
  }

  get recording(): boolean {
    return this.rec !== null || this.finishing;
  }

  /** Saves the scene as a PNG with the next frame. */
  savePicture(): void {
    this.pictureWanted = true;
  }

  /** Starts recording a video (or stops the one being recorded). */
  async toggle(format: VideoFormat): Promise<void> {
    if (this.recording) return this.stop();
    try {
      this.rec = format === 'mp4' ? await this.startVideo() : this.startGif();
    } catch (err) {
      console.error(err);
      this.rec = null;
      this.hooks.toast(err instanceof Error && err.message ? err.message : 'The recording could not be started.');
      return;
    }
    this.chip.hidden = false;
    this.chipSeconds = -1;
    this.chip.classList.toggle('gif', format === 'gif');
    this.hooks.changed?.(true);
  }

  /** Call once per animation frame, right after the scene was drawn. */
  frame(now: number): void {
    if (this.pictureWanted) {
      this.pictureWanted = false;
      let picture: Promise<Blob>;
      try {
        picture = this.capture.png();
      } catch (err) {
        picture = Promise.reject(err);
      }
      picture
        .then((blob) => downloadBlob(blob, `langevin-dynamics-${timestamp()}.png`))
        .catch((err) => {
          console.error(err);
          this.hooks.toast('The picture could not be saved.');
        });
    }
    const rec = this.rec;
    if (!rec) return;
    const t = (now - rec.start) / 1000;
    const seconds = Math.floor(t);
    if (seconds !== this.chipSeconds) {
      this.chipSeconds = seconds;
      const left = rec.maxSeconds - seconds;
      this.chipTime.textContent = `${rec.format === 'gif' ? 'GIF' : 'Video'} ${clock(seconds)}${left <= 10 ? ` · stops in ${left} s` : ''}`;
    }
    if (t >= rec.maxSeconds) {
      void this.stop(`Recording stopped after ${rec.maxSeconds} s (the limit)`);
      return;
    }
    if (t * rec.fps < rec.next) return; // not yet time for the next frame
    const k = Math.floor(t * rec.fps);
    if (rec.pending >= MAX_PENDING) {
      rec.next = k + 1; // the encoder is behind: skip this frame
      return;
    }
    // A failure here must not stop the app's frame loop: it ends the recording instead.
    let added: Promise<void>;
    try {
      this.capture.draw(rec.ctx, rec.canvas.width, rec.canvas.height);
      added = rec.add(k / rec.fps);
    } catch (err) {
      added = Promise.reject(err);
    }
    rec.pending++;
    rec.next = k + 1;
    added.then(
      () => rec.pending--,
      (err) => {
        rec.pending--;
        console.error(err);
        if (this.rec === rec) {
          this.rec = null;
          rec.cancel();
          this.done();
          this.hooks.toast('The recording failed and was stopped.');
        }
      },
    );
  }

  /** Stops the recording and downloads the file. */
  async stop(message?: string): Promise<void> {
    const rec = this.rec;
    if (!rec || this.finishing) return;
    this.rec = null;
    this.finishing = true;
    this.chipTime.textContent = 'Saving…';
    try {
      const blob = await rec.finish();
      downloadBlob(blob, `langevin-dynamics-${timestamp()}.${rec.ext}`);
      this.hooks.toast(message ?? `Saved the ${rec.format === 'gif' ? 'GIF' : 'video'} (${(blob.size / 2 ** 20).toFixed(1)} MB)`);
    } catch (err) {
      console.error(err);
      this.hooks.toast('The recording could not be saved.');
    } finally {
      this.finishing = false;
      this.done();
    }
  }

  private done(): void {
    this.chip.hidden = true;
    this.hooks.changed?.(false);
  }

  /** The canvas frames are composed on: the scene scaled to fit `max`, even dimensions. */
  private frameCanvas(maxLong: number, maxShort: number, readBack: boolean): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
    const { width, height } = this.capture.size();
    const long = Math.max(width, height);
    const short = Math.min(width, height);
    const k = Math.min(1, maxLong / long, maxShort / short);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(2, Math.floor((width * k) / 2) * 2);
    canvas.height = Math.max(2, Math.floor((height * k) / 2) * 2);
    const ctx = canvas.getContext('2d', { willReadFrequently: readBack });
    if (!ctx) throw new Error('Canvas 2D is not supported.');
    return { canvas, ctx };
  }

  /** MP4 (H.264), or WebM (VP9) where the browser cannot encode H.264. */
  private async startVideo(): Promise<Recording> {
    if (typeof VideoEncoder === 'undefined') {
      throw new Error('This browser cannot record videos (no WebCodecs). Record a GIF instead.');
    }
    // The encoder library is loaded on first use.
    const { BufferTarget, CanvasSource, canEncodeVideo, Mp4OutputFormat, Output, QUALITY_HIGH, WebMOutputFormat } = await import('mediabunny');
    const { canvas, ctx } = this.frameCanvas(VIDEO_MAX[0], VIDEO_MAX[1], false);
    const size = { width: canvas.width, height: canvas.height };
    const choices: { codec: VideoCodec; mp4: boolean }[] = [
      { codec: 'avc', mp4: true },
      { codec: 'vp9', mp4: false },
    ];
    let choice: (typeof choices)[number] | null = null;
    for (const c of choices) {
      if (await canEncodeVideo(c.codec, { ...size, quality: QUALITY_HIGH })) {
        choice = c;
        break;
      }
    }
    if (!choice) throw new Error('This browser cannot encode videos of this size. Record a GIF instead.');
    const target = new BufferTarget();
    const output = new Output({
      format: choice.mp4 ? new Mp4OutputFormat({ fastStart: 'in-memory' }) : new WebMOutputFormat(),
      target,
    });
    const source = new CanvasSource(canvas, { codec: choice.codec, quality: QUALITY_HIGH, keyFrameInterval: 2 });
    output.addVideoTrack(source, { frameRate: VIDEO_FPS });
    await output.start();
    const rec: Recording = {
      format: 'mp4',
      ext: choice.mp4 ? 'mp4' : 'webm',
      type: choice.mp4 ? 'video/mp4' : 'video/webm',
      canvas,
      ctx,
      fps: VIDEO_FPS,
      maxSeconds: VIDEO_MAX_SECONDS,
      start: performance.now(),
      next: 0,
      pending: 0,
      add: (t) => source.add(t, 1 / VIDEO_FPS),
      finish: async () => {
        await waitFor(() => rec.pending === 0);
        await output.finalize();
        return new Blob([target.buffer!], { type: rec.type });
      },
      cancel: () => void output.cancel().catch(() => {}),
    };
    return rec;
  }

  /** An animated GIF, encoded frame by frame in a worker. */
  private startGif(): Recording {
    const { canvas, ctx } = this.frameCanvas(GIF_MAX_WIDTH, GIF_MAX_WIDTH, true);
    const worker = new Worker(new URL('./gif.worker.ts', import.meta.url), { type: 'module' });
    const waiting: { resolve(): void; reject(err: Error): void }[] = [];
    let result: ((bytes: Uint8Array) => void) | null = null;
    let failed: ((err: Error) => void) | null = null;
    let error: Error | null = null;
    worker.onmessage = (e: MessageEvent<{ done?: true; gif?: Uint8Array }>) => {
      if (e.data.gif) result?.(e.data.gif);
      else waiting.shift()?.resolve();
    };
    worker.onerror = (e) => {
      e.preventDefault();
      error = new Error(e.message || 'The GIF encoder failed.');
      for (const w of waiting.splice(0)) w.reject(error); // stops the recording (see frame)
      failed?.(error);
    };
    const delay = Math.round(1000 / GIF_FPS);
    return {
      format: 'gif',
      ext: 'gif',
      type: 'image/gif',
      canvas,
      ctx,
      fps: GIF_FPS,
      maxSeconds: GIF_MAX_SECONDS,
      start: performance.now(),
      next: 0,
      pending: 0,
      add: () => {
        if (error) return Promise.reject(error);
        const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const message: GifWorkerMessage = { frame: image.data, width: canvas.width, height: canvas.height, delay };
        return new Promise<void>((resolve, reject) => {
          waiting.push({ resolve, reject });
          worker.postMessage(message, [image.data.buffer]);
        });
      },
      finish: () =>
        new Promise<Blob>((resolve, reject) => {
          if (error) {
            worker.terminate();
            reject(error);
            return;
          }
          result = (bytes) => {
            worker.terminate();
            resolve(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/gif' }));
          };
          failed = (err) => {
            worker.terminate();
            reject(err);
          };
          const finish: GifWorkerMessage = { finish: true };
          worker.postMessage(finish); // after all frames (the worker handles messages in order)
        }),
      cancel: () => worker.terminate(),
    };
  }
}

function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function waitFor(done: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const check = () => (done() ? resolve() : setTimeout(check, 20));
    check();
  });
}
