import { Playback } from '../record/playback';
import { Recorder, type Run } from '../record/recorder';
import { PlaybackBar } from '../ui/playbackBar';
import { RecordingsPanel } from '../ui/recordingsPanel';
import type { App } from './app';

/**
 * Recording runs (the record button; they are listed in the Recordings window and download as
 * .npz) and playing recorded runs back (a floating player; altering the simulation leaves
 * playback).
 */
export class Recording {
  readonly recorder: Recorder;
  readonly recordings: RecordingsPanel;
  readonly playback: Playback;
  private readonly playerBar: PlaybackBar;

  constructor(private readonly app: App) {
    const { state, particles, field, sde, history, camera } = app.core;
    const controls = () => app.controls;

    this.recorder = new Recorder({
      field,
      particles,
      params: () => ({
        sigma: state.sigma,
        speed: state.speed,
        kernelVariance: state.kernelVariance,
        scheme: state.scheme,
        seed: state.seed,
        playing: state.playing,
        potentialTex: state.potentialMode === 'formula' ? state.potentialTex : null,
        process: {
          drift: sde.extraDrift ? [state.driftU1, state.driftU2] : null,
          noise: sde.noise ? [state.noiseS1, state.noiseS2] : null,
        },
        birthDeath: state.birthDeath,
        birthRate: state.birthRate,
        deathRate: state.deathRate,
      }),
      // Full settings for the metadata, so a recording restores the whole configuration.
      settings: () => app.session.capture(['physics', 'analysis', 'display', 'tools', 'analysisBox', 'view']),
    });
    this.recordings = new RecordingsPanel(this.recorder, {
      toast: (text, action) => controls().showToast(text, action),
    });

    this.playback = new Playback(app.session, {
      onEnter: (timeline) => {
        history.clear(); // the recording replaces Ψ and the particles: earlier steps no longer apply
        state.playing = false;
        this.playerBar.show(timeline);
        controls().setPlaybackLock(true);
        controls().sync();
        const region = timeline.psiRegion() ?? timeline.particleBounds();
        if (region) camera.showRect(region.x0, region.y0, region.x1, region.y1);
      },
      onFrame: (k, jumped) => {
        this.playerBar.setFrame(k);
        if (jumped) app.analysis.restartCurves(); // the analysis curves restart after a jump in time
      },
      onPlayingChange: (playing) => this.playerBar.setPlaying(playing),
      onExit: () => {
        this.playerBar.hide();
        controls().setPlaybackLock(false);
        controls().sync();
        controls().showToast('Left playback: press play to continue the simulation from here');
      },
    });
    this.playerBar = new PlaybackBar(this.playback);
  }

  /** The record button: starts a run, or stops the current one and keeps it. */
  toggle(): void {
    if (this.playback.active) return;
    const now = performance.now();
    if (this.recorder.recording) {
      this.stopped(this.recorder.stop(now));
    } else {
      // Ψ is recorded on the KL box (or the view, if there is none) for the whole run.
      const monitor = this.app.analysis.monitor;
      this.recorder.start(now, monitor.region ?? this.app.core.camera.bounds());
      this.app.controls.setRecording(true);
      this.recordings.render(true);
    }
  }

  /** Call once per frame (after the analysis): records a frame if due, stops at the size limit. */
  frame(now: number): void {
    if (!this.recorder.recording) return;
    const full = this.recorder.tick(now);
    if (full) this.stopped(full, `size limit of ${Math.round(this.recorder.maxBytes / 2 ** 20)} MB reached`);
    else this.recordings.renderLive(now);
  }

  /** After a run stopped (by hand, or at the size limit: `reason`): it is listed and kept. */
  private stopped(run: Run | null, reason?: string): void {
    this.app.controls.setRecording(false);
    this.recordings.render(true);
    if (run) this.app.controls.showToast(`${run.name} saved: ${run.frames} frames${reason ? ` (${reason})` : ''}`);
  }
}
