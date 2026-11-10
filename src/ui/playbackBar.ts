import type { Playback } from '../record/playback';
import type { RecordingTimeline } from '../record/timeline';

/** The floating player shown in playback mode: play/pause, a scrubber, times and an exit button. */
export class PlaybackBar {
  private readonly bar = el('player');
  private readonly playBtn = el('player-play');
  private readonly seek = el('player-seek') as HTMLInputElement;
  private readonly time = el('player-time');
  private readonly duration = el('player-duration');
  private readonly label = el('player-label');
  private timeline: RecordingTimeline | null = null;

  constructor(playback: Playback) {
    this.playBtn.addEventListener('click', () => playback.toggle(performance.now()));
    el('player-exit').addEventListener('click', () => playback.exit());
    this.seek.addEventListener('input', () => playback.seek(Number(this.seek.value)));
    // The bar is part of the player, not the scene: keep its pointer events away from the canvas.
    this.bar.addEventListener('pointerdown', (e) => e.stopPropagation());
  }

  show(timeline: RecordingTimeline): void {
    this.timeline = timeline;
    this.seek.min = '0';
    this.seek.max = String(Math.max(0, timeline.frames - 1));
    this.duration.textContent = `t ${timeline.t[timeline.frames - 1].toFixed(2)}`;
    this.label.textContent = `${timeline.name} · ${timeline.frames} frames`;
    this.bar.hidden = false;
    document.body.classList.add('in-playback');
  }

  hide(): void {
    this.timeline = null;
    this.bar.hidden = true;
    document.body.classList.remove('in-playback');
  }

  setFrame(k: number): void {
    const t = this.timeline;
    if (!t) return;
    this.seek.value = String(k);
    const p = t.frames > 1 ? (k / (t.frames - 1)) * 100 : 0;
    this.seek.style.setProperty('--p', `${p.toFixed(2)}%`);
    this.time.textContent = `t ${t.t[k].toFixed(2)}`;
  }

  setPlaying(playing: boolean): void {
    this.playBtn.classList.toggle('playing', playing);
    this.playBtn.setAttribute('aria-label', playing ? 'Pause recording' : 'Play recording');
  }
}

function el(id: string): HTMLElement {
  const e = document.getElementById(id);
  if (!e) throw new Error(`Missing element #${id}`);
  return e;
}
