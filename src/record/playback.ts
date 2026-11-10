import type { Session } from '../session/session';
import type { RecordingTimeline } from './timeline';

export interface PlaybackHooks {
  /** Playback started with a new recording. */
  onEnter(timeline: RecordingTimeline): void;
  /** A frame was shown; `jumped` is true unless it directly followed the previous frame. */
  onFrame(frame: number, jumped: boolean): void;
  /** Play / pause changed. */
  onPlayingChange(playing: boolean): void;
  /** Playback mode ended (the user altered the simulation, or closed the player). */
  onExit(): void;
}

/** Applying more frames than this in one go is treated as a jump (no trail continuity needed). */
const MAX_CATCH_UP = 12;

/**
 * Playback mode: shows a recording frame by frame through the session, like a video. Frames
 * are paced by the recorded wall-clock times, so playback runs at the speed it was recorded.
 *
 * Playback ends as soon as the user alters the simulation: after every applied frame the session
 * fingerprint is stored, and any later difference (a brush stroke, a new particle, a changed σ, …)
 * exits playback, leaving the app in the state of the shown frame so the run can be continued.
 */
export class Playback {
  timeline: RecordingTimeline | null = null;
  frame = 0;
  playing = false;

  private appliedPotential = -2;
  private fingerprint = '';
  private playStartReal = 0;
  private playStartWall = 0;

  constructor(
    private readonly session: Session,
    private readonly hooks: PlaybackHooks,
  ) {}

  get active(): boolean {
    return this.timeline !== null;
  }

  enter(timeline: RecordingTimeline): void {
    this.timeline = timeline;
    this.playing = false;
    this.appliedPotential = -2;
    this.session.apply(timeline.initialSnapshot());
    this.hooks.onEnter(timeline);
    this.show(0, true);
  }

  /** Shows frame k (pauses playback). */
  seek(k: number): void {
    if (!this.timeline) return;
    this.setPlaying(false);
    this.show(k, k !== this.frame + 1);
  }

  play(nowMs: number): void {
    const t = this.timeline;
    if (!t || this.playing) return;
    if (this.frame >= t.frames - 1) this.show(0, true); // restart at the end
    this.playStartReal = nowMs;
    this.playStartWall = t.wall[this.frame];
    this.setPlaying(true);
  }

  pause(): void {
    this.setPlaying(false);
  }

  toggle(nowMs: number): void {
    if (this.playing) this.pause();
    else this.play(nowMs);
  }

  /** Call once per animation frame: leaves playback on user changes, advances while playing. */
  update(nowMs: number): void {
    const t = this.timeline;
    if (!t) return;
    if (this.session.fingerprint() !== this.fingerprint) {
      this.exit();
      return;
    }
    if (!this.playing) return;
    const wall = this.playStartWall + (nowMs - this.playStartReal) / 1000;
    const target = t.frameAtWall(wall);
    if (target > this.frame) {
      // Step through skipped frames when there are few, so trails stay continuous.
      if (target - this.frame <= MAX_CATCH_UP) {
        for (let k = this.frame + 1; k <= target; k++) this.show(k, false);
      } else {
        this.show(target, true);
      }
    }
    if (this.frame >= t.frames - 1 && wall >= t.wall[t.frames - 1]) this.setPlaying(false);
  }

  /** Leaves playback mode; the state of the current frame stays. */
  exit(): void {
    if (!this.timeline) return;
    this.timeline = null;
    this.setPlaying(false);
    this.hooks.onExit();
  }

  private show(k: number, jumped: boolean): void {
    const t = this.timeline!;
    const frame = Math.max(0, Math.min(t.frames - 1, Math.round(k)));
    this.session.apply(t.frameSnapshot(frame, this.appliedPotential, !jumped));
    this.appliedPotential = t.potentialIndexAt(frame);
    this.frame = frame;
    this.fingerprint = this.session.fingerprint();
    this.hooks.onFrame(frame, jumped);
  }

  private setPlaying(playing: boolean): void {
    if (playing === this.playing) return;
    this.playing = playing;
    this.hooks.onPlayingChange(playing);
  }
}
