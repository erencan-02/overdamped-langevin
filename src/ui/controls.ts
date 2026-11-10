import { COLORMAP, PSI_CAP, RANGES } from '../config';
import { SCHEMES, type SchemeId } from '../sim/schemes';
import type { AppState, Mode } from '../state';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
};

export interface ControlActions {
  setMode(mode: Mode): void;
  setScheme(id: SchemeId): void;
  togglePlay(): void;
  toggleGrid(): void;
  toggleTrails(): void;
  toggleContours(): void;
  toggleForceField(): void;
  toggleCamera(): void;
  toggleRecording(): void;
  toggleDensity(): void;
  clearParticles(): void;
  clearField(): void;
  resetView(): void;
  importImage(target: 'potential' | 'particles'): void;
  preset(name: string): void;
}

interface SliderSpec {
  id: string;
  range: readonly [number, number];
  log: boolean;
  get(): number;
  set(v: number): void;
  format(v: number): string;
}

/** Binds the DOM controls (toolbar, panel, menu, help dialog) to the app state. */
export class Controls {
  private readonly stage = $('stage');
  private readonly play = $('play');
  private readonly playLabel = $('play-label');
  private readonly menu = $('menu');
  private readonly menuBtn = $('menu-btn');
  private readonly help = $('help');
  private readonly hint = $('hint');
  private readonly toast = $('toast');
  private readonly readout = $('readout');
  private readonly particleCount = $('particle-count');
  private readonly segButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('.seg-btn'));
  private readonly segThumb = document.querySelector<HTMLElement>('.seg-thumb')!;
  private readonly schemeButtons = Array.from(
    document.querySelectorAll<HTMLButtonElement>('[data-scheme]'),
  );
  private readonly schemeNote = $('scheme-note');
  private readonly sliders: { spec: SliderSpec; input: HTMLInputElement; out: HTMLOutputElement }[] = [];
  private toastTimer = 0;

  constructor(
    private readonly state: AppState,
    actions: ControlActions,
  ) {
    for (const b of this.segButtons) {
      b.addEventListener('click', () => actions.setMode(b.dataset.mode as Mode));
    }
    for (const b of this.schemeButtons) {
      b.addEventListener('click', () => actions.setScheme(b.dataset.scheme as SchemeId));
    }
    this.play.addEventListener('click', () => actions.togglePlay());
    $('toggle-grid').addEventListener('click', () => actions.toggleGrid());
    $('toggle-trails').addEventListener('click', () => actions.toggleTrails());
    $('toggle-contours').addEventListener('click', () => actions.toggleContours());
    $('toggle-force').addEventListener('click', () => actions.toggleForceField());
    $('toggle-camera').addEventListener('click', () => actions.toggleCamera());
    $('toggle-record').addEventListener('click', () => actions.toggleRecording());
    $<HTMLInputElement>('show-density').addEventListener('change', () => actions.toggleDensity());
    $('clear-particles').addEventListener('click', () => actions.clearParticles());

    // Scene menu
    this.menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.setMenu(this.menu.hidden);
    });
    this.menu.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button');
      if (!b) return;
      if (b.dataset.preset) actions.preset(b.dataset.preset);
      else if (b.dataset.action === 'clear-particles') actions.clearParticles();
      else if (b.dataset.action === 'clear-field') actions.clearField();
      else if (b.dataset.action === 'reset-view') actions.resetView();
      else if (b.dataset.action === 'import-image') actions.importImage('potential');
      else if (b.dataset.action === 'import-image-particles') actions.importImage('particles');
      this.setMenu(false);
    });
    document.addEventListener('pointerdown', (e) => {
      if (!this.menu.hidden && !(e.target as HTMLElement).closest('.menu-wrap')) this.setMenu(false);
    });

    // Help dialog
    $('help-btn').addEventListener('click', () => this.setHelp(true));
    $('help-close').addEventListener('click', () => this.setHelp(false));
    this.help.addEventListener('pointerdown', (e) => {
      if (e.target === this.help) this.setHelp(false);
    });
    $('help-cap').textContent = String(PSI_CAP);

    // Sliders
    const s = state;
    this.addSlider({
      id: 'sigma',
      range: RANGES.sigma,
      log: false,
      get: () => s.sigma,
      set: (v) => (s.sigma = v),
      format: (v) => v.toFixed(2),
    });
    this.addSlider({
      id: 'speed',
      range: RANGES.speed,
      log: true,
      get: () => s.speed,
      set: (v) => (s.speed = v),
      format: (v) => `${v < 1 ? v.toFixed(2) : v.toFixed(1)}×`,
    });
    this.addSlider({
      id: 'kernel-var',
      range: RANGES.kernelVariance,
      log: true,
      get: () => s.kernelVariance,
      set: (v) => (s.kernelVariance = v),
      format: (v) => v.toFixed(v < 0.1 ? 3 : 2),
    });
    this.addSlider({
      id: 'grid-spacing',
      range: RANGES.particleSpacing,
      log: true,
      get: () => s.particleSpacing,
      set: (v) => (s.particleSpacing = v),
      format: (v) => v.toFixed(2),
    });
    this.addSlider({
      id: 'brush-size',
      range: RANGES.brushRadius,
      log: true,
      get: () => s.brushRadius,
      set: (v) => (s.brushRadius = v),
      format: (v) => v.toFixed(2),
    });
    this.addSlider({
      id: 'brush-strength',
      range: RANGES.brushStrength,
      log: true,
      get: () => s.brushStrength,
      set: (v) => (s.brushStrength = v),
      format: (v) => `${v < 10 ? v.toFixed(1) : v.toFixed(0)}/s`,
    });

    this.buildLegend();
    this.sync();
    // Button sizes change with breakpoints (labels hidden on phones) and late-loading fonts.
    const ro = new ResizeObserver(() => this.placeThumb());
    for (const b of this.segButtons) ro.observe(b);
    // Enable the sliding animation of the mode switch only after its first placement.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => this.segThumb.parentElement?.classList.add('animate')),
    );
  }

  get helpOpen(): boolean {
    return !this.help.hidden;
  }

  get menuOpen(): boolean {
    return !this.menu.hidden;
  }

  setMenu(open: boolean): void {
    this.menu.hidden = !open;
    this.menuBtn.setAttribute('aria-expanded', String(open));
  }

  setHelp(open: boolean): void {
    this.help.hidden = !open;
    if (open) {
      this.setMenu(false);
      // KaTeX is loaded on first use only.
      void import('./helpMath').then((m) => m.renderMath(this.help));
    }
  }

  closeOverlays(): boolean {
    const any = this.helpOpen || this.menuOpen;
    this.setHelp(false);
    this.setMenu(false);
    return any;
  }

  private addSlider(spec: SliderSpec): void {
    const input = $<HTMLInputElement>(spec.id);
    const out = $<HTMLOutputElement>(`${spec.id}-out`);
    const [lo, hi] = spec.range;
    const toValue = (t: number) => (spec.log ? lo * (hi / lo) ** t : lo + (hi - lo) * t);
    input.addEventListener('input', () => {
      spec.set(toValue(Number(input.value)));
      this.syncSlider(this.sliders.find((x) => x.input === input)!);
    });
    // Double-click a slider to restore its initial value.
    const initial = spec.get();
    input.addEventListener('dblclick', () => {
      spec.set(initial);
      this.syncSlider(this.sliders.find((x) => x.input === input)!);
    });
    this.sliders.push({ spec, input, out });
  }

  private syncSlider(sl: { spec: SliderSpec; input: HTMLInputElement; out: HTMLOutputElement }): void {
    const { spec, input, out } = sl;
    const [lo, hi] = spec.range;
    const v = spec.get();
    const t = spec.log ? Math.log(v / lo) / Math.log(hi / lo) : (v - lo) / (hi - lo);
    const tc = Math.min(1, Math.max(0, t));
    input.value = String(tc);
    input.style.setProperty('--p', `${(tc * 100).toFixed(2)}%`);
    out.value = spec.format(v);
  }

  private buildLegend(): void {
    const { stops, hot, cold } = COLORMAP;
    const parts: string[] = [];
    for (let i = stops.length - 1; i >= 0; i--) parts.push(`${cold[i]} ${(50 - stops[i] * 50).toFixed(1)}%`);
    for (let i = 1; i < stops.length; i++) parts.push(`${hot[i]} ${(50 + stops[i] * 50).toFixed(1)}%`);
    $('legend-bar').style.background = `linear-gradient(90deg, ${parts.join(', ')})`;
    $('legend-min').textContent = `−${PSI_CAP}`;
    $('legend-max').textContent = `+${PSI_CAP}`;
  }

  /** Updates every control from the state (call after any state change). */
  sync(): void {
    const s = this.state;
    this.stage.dataset.mode = s.mode;
    for (const b of this.segButtons) b.setAttribute('aria-checked', String(b.dataset.mode === s.mode));
    this.placeThumb();
    for (const el of document.querySelectorAll<HTMLElement>('.mode-only')) {
      el.hidden = el.dataset.for !== s.mode;
    }
    this.play.classList.toggle('playing', s.playing);
    this.playLabel.textContent = s.playing ? 'Pause' : 'Play';
    this.play.dataset.tip = s.playing ? 'Pause' : 'Play';
    this.play.setAttribute('aria-label', s.playing ? 'Pause' : 'Play');
    $('toggle-grid').setAttribute('aria-pressed', String(s.grid));
    $('toggle-trails').setAttribute('aria-pressed', String(s.trails));
    $('toggle-contours').setAttribute('aria-pressed', String(s.contours));
    $('toggle-force').setAttribute('aria-pressed', String(s.forceField));
    $<HTMLInputElement>('show-density').checked = s.showDensity;
    for (const b of this.schemeButtons) {
      b.setAttribute('aria-checked', String(b.dataset.scheme === s.scheme));
    }
    this.schemeNote.textContent = SCHEMES[s.scheme].summary;
    for (const sl of this.sliders) this.syncSlider(sl);
    this.updateHint();
  }

  /** Moves the highlight of the mode switch under the active button. */
  private placeThumb(): void {
    const active = this.segButtons.find((b) => b.dataset.mode === this.state.mode);
    if (!active) return;
    this.segThumb.style.width = `${active.offsetWidth}px`;
    this.segThumb.style.transform = `translateX(${active.offsetLeft}px)`;
  }

  /** Reflects the recording state in the toolbar button. */
  setRecording(on: boolean): void {
    const b = $('toggle-record');
    b.setAttribute('aria-pressed', String(on));
    b.dataset.tip = on ? 'Stop recording' : 'Record run';
  }

  /** Reflects the live camera state in the toolbar button and the preview. */
  setCameraState(state: 'off' | 'starting' | 'live'): void {
    const button = $('toggle-camera');
    button.setAttribute('aria-pressed', String(state !== 'off'));
    button.classList.toggle('starting', state === 'starting');
    button.dataset.tip = state === 'off' ? 'Live camera → Ψ' : 'Stop camera';
    const preview = $('cam-preview');
    preview.hidden = state === 'off';
    preview.classList.toggle('starting', state === 'starting');
    $('cam-badge-text').textContent = state === 'starting' ? 'Starting' : 'Live';
  }

  setPanning(p: boolean): void {
    this.stage.classList.toggle('panning', p);
  }

  /** Pulses the play button when there is something to simulate but time is stopped. */
  setPlayAttention(on: boolean): void {
    this.play.classList.toggle('attention', on);
  }

  private updateHint(): void {
    const brush =
      '<span><b>Left-drag</b> raise Ψ</span><span><b>Right-drag</b> lower Ψ</span>' +
      '<span><b>Wheel-drag</b> pan</span><span><b>Scroll</b> zoom</span>';
    const particles =
      '<span><b>Click</b> drop particle</span><span><b>Shift-drag</b> spray</span>' +
      '<span><b>Right-drag</b> grid</span><span><b>Right-click</b> remove</span>';
    this.hint.innerHTML = this.state.mode === 'brush' ? brush : particles;
  }

  /** Shows a short message, optionally with one action button (then it stays longer). */
  showToast(text: string, action?: { label: string; run(): void }): void {
    $('toast-text').textContent = text;
    const button = $<HTMLButtonElement>('toast-action');
    button.hidden = !action;
    button.textContent = action?.label ?? '';
    button.onclick = action
      ? () => {
          this.toast.classList.remove('show');
          action.run();
        }
      : null;
    this.toast.classList.toggle('has-action', !!action);
    this.toast.classList.add('show');
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toast.classList.remove('show'), action ? 6000 : 1400);
  }

  private lastReadout = '';
  private lastCount = '';

  updateReadout(x: number | null, y: number | null, psi: number | null, t: number, n: number, max: number): void {
    const f = (v: number | null, d = 2) => (v === null ? '—' : (Math.abs(v) < 0.5 * 10 ** -d ? 0 : v).toFixed(d));
    const html =
      `<span><b>x</b>${f(x)}</span><span><b>y</b>${f(y)}</span>` +
      `<span><b>Ψ</b>${f(psi)}</span><span><b>t</b>${t.toFixed(1)}</span>` +
      `<span><b>N</b>${n}</span><span><b>σ</b>${this.state.sigma.toFixed(2)}</span>`;
    if (html !== this.lastReadout) {
      this.readout.innerHTML = html;
      this.lastReadout = html;
    }
    const count = n >= max ? `${n} (max)` : String(n);
    if (count !== this.lastCount) {
      this.particleCount.textContent = count;
      this.lastCount = count;
    }
  }
}
