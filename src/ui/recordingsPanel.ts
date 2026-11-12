import type { Recorder, Run } from '../record/recorder';
import { downloadBlob } from './download';

const DOWNLOAD_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11" /><path d="m7 10.5 5 5 5-5" /><path d="M5 19.5h14" /></svg>';
const DELETE_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 7h15" /><path d="M9.5 7V5h5v2" /><path d="M6.5 7l1 12.5h9l1-12.5" /></svg>';

export interface RecordingsHooks {
  toast(text: string, action?: { label: string; run(): void }): void;
}

/**
 * The "Recordings" panel: the run being recorded and all finished runs with download / delete.
 * It is only shown once there is something in it (a run being recorded, or a finished one).
 */
export class RecordingsPanel {
  private readonly section = el('recordings');
  private readonly toggle = el('recordings-toggle');
  private readonly body = el('recordings-body');
  private readonly list = el('run-list');
  private readonly count = el('recordings-count');
  private liveMeta: HTMLElement | null = null;
  private lastLive = -Infinity;

  constructor(
    private readonly recorder: Recorder,
    private readonly hooks: RecordingsHooks,
  ) {
    this.toggle.addEventListener('click', () => this.setOpen(this.body.hidden));
    this.render();
  }

  /** Shows the panel even while it is empty (e.g. for the tutorial); returns how to undo it. */
  reveal(): () => void {
    this.section.hidden = false;
    return () => {
      this.section.hidden = !this.visible;
    };
  }

  /** There is a run being recorded or a finished one (the panel is shown then). */
  get visible(): boolean {
    return this.recorder.recording || this.recorder.runs.length > 0;
  }

  setOpen(open: boolean): void {
    this.body.hidden = !open;
    this.toggle.setAttribute('aria-expanded', String(open));
    this.section.classList.toggle('collapsed', !open);
  }

  /** Rebuilds the list (after a run starts, stops or is deleted). */
  render(open = false): void {
    if (open) this.setOpen(true);
    const runs = this.recorder.runs;
    this.section.hidden = !this.visible;
    this.count.textContent = String(runs.length + (this.recorder.recording ? 1 : 0));
    this.list.replaceChildren();
    this.liveMeta = null;

    const current = this.recorder.current;
    if (current) {
      const li = this.row(current, true);
      this.liveMeta = li.querySelector('.run-meta');
      this.list.append(li);
    }
    for (const run of runs) this.list.append(this.row(run, false));
    if (!current && runs.length === 0) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'No runs yet. Press the record button to start one.';
      this.list.append(li);
    }
  }

  /** Updates the live row's numbers (twice per second). */
  renderLive(nowMs: number): void {
    const run = this.recorder.current;
    if (!run || !this.liveMeta || nowMs - this.lastLive < 500) return;
    this.lastLive = nowMs;
    this.liveMeta.textContent = describe(run, (nowMs - run.wallStart) / 1000, this.recorder.maxBytes);
  }

  private row(run: Run, live: boolean): HTMLLIElement {
    const li = document.createElement('li');
    li.className = live ? 'run live' : 'run';
    const main = document.createElement('div');
    main.className = 'run-main';
    const name = document.createElement('div');
    name.className = 'run-name';
    name.textContent = live ? `${run.name} · recording` : run.name;
    const meta = document.createElement('div');
    meta.className = 'run-meta';
    meta.textContent = describe(run);
    main.append(name, meta);
    li.append(main);
    if (live) return li;

    const download = button('Download as .npz', DOWNLOAD_ICON);
    download.addEventListener('click', () => void this.download(run, download));
    const remove = button('Delete this run', DELETE_ICON);
    remove.addEventListener('click', () => {
      this.recorder.remove(run);
      this.render();
      this.hooks.toast(`${run.name} deleted`, {
        label: 'Undo',
        run: () => {
          this.recorder.runs.unshift(run);
          this.recorder.runs.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
          this.render();
        },
      });
    });
    li.append(download, remove);
    return li;
  }

  private async download(run: Run, button: HTMLButtonElement): Promise<void> {
    button.classList.add('busy');
    try {
      const bytes = await run.toNpz();
      downloadBlob(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/octet-stream' }), fileName(run));
    } catch (err) {
      console.error(err);
      this.hooks.toast('The recording could not be exported.');
    } finally {
      button.classList.remove('busy');
    }
  }
}

function describe(run: Run, wallSeconds?: number, limitBytes?: number): string {
  const n = run.counts.length ? Math.max(...run.counts) : 0;
  const mb = run.bytes / (1024 * 1024);
  const size = mb >= 10 ? `${mb.toFixed(0)} MB` : `${mb.toFixed(1)} MB`;
  const time = wallSeconds !== undefined ? `${wallSeconds.toFixed(0)} s` : `t ${run.duration.toFixed(1)}`;
  // While recording, the size is shown against the limit at which recording stops.
  const limit = limitBytes !== undefined ? ` of ${Math.round(limitBytes / (1024 * 1024))} MB` : '';
  return `${time} · ${run.frames} frames · ${n} particles · ${size}${limit}`;
}

function fileName(run: Run): string {
  const d = run.startedAt;
  const pad = (v: number) => String(v).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `langevin-dynamics-${run.name.toLowerCase().replace(/\s+/g, '-')}-${stamp}.npz`;
}

function button(label: string, icon: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'icon-btn';
  b.title = label;
  b.setAttribute('aria-label', label);
  b.innerHTML = icon;
  return b;
}

function el(id: string): HTMLElement {
  const e = document.getElementById(id);
  if (!e) throw new Error(`Missing element #${id}`);
  return e;
}
