import { DEFAULT_DT_MAX } from '../sim/particles';
import { SCHEME_ORDER } from '../sim/schemes';
import { type Content, kbd, sub, tex } from '../ui/panelKit';
import { StepKey } from '../ui/stepKey';
import type { App } from './app';

/**
 * A keyboard shortcut: which key, what it does, and how the help dialog lists it.
 * Letters match in both cases; Shift only matters where `shift` is given.
 */
interface Shortcut {
  /** `KeyboardEvent.key` values. */
  keys: readonly string[];
  /** Only with Ctrl (⌘ on macOS); these also work while the help dialog is open. */
  ctrl?: boolean;
  /** true: only with Shift, false: only without; absent: either. */
  shift?: boolean;
  /** As shown in the help: the key caps (several alternatives are joined by "or"). */
  caps: readonly (readonly string[])[];
  label: Content;
  /** Shortcuts with the same line number share a line in the help, in this order. */
  line: number;
  /** `target` is the focused element, if any. */
  run(e: KeyboardEvent, target: HTMLElement | null): void;
}

const letter = (c: string) => [c, c.toUpperCase()];
const rhoH = () => tex('\\hat{\\rho}_h', ['ρ̂', sub('h')]);

/**
 * All shortcuts. To add one, add an entry: the keyboard handler and the list in the help dialog
 * both come from this table.
 */
function shortcuts(app: App): Shortcut[] {
  const a = app.actions;
  const { state } = app.core;
  const playback = () => app.recording.playback;
  return [
    {
      keys: [' '],
      caps: [['Space']],
      label: 'Play / pause',
      line: 1,
      run: (e, target) => {
        // Space would also "click" a focused button; take focus away and toggle once.
        e.preventDefault();
        if (target?.closest('button, input')) target.blur();
        if (e.repeat) return;
        if (playback().active) playback().toggle(performance.now());
        else a.togglePlay();
      },
    },
    {
      keys: ['ArrowRight'],
      caps: [['→']],
      label: 'One step (Δt); hold to play while held',
      line: 2,
      run: (e, target) => {
        // A focused slider uses the arrow keys itself.
        if (target?.matches('input[type="range"], select')) return;
        e.preventDefault();
        app.stepKey.press(); // auto-repeat key-downs are ignored; the hold is timed by StepKey
      },
    },
    { keys: ['2'], caps: [['2']], label: '2D view', line: 3, run: () => a.setView('2d') },
    { keys: ['3'], caps: [['3']], label: '3D view', line: 3, run: () => a.setView('3d') },
    { keys: letter('b'), caps: [['B']], label: 'Brush', line: 4, run: () => a.setMode('brush') },
    { keys: letter('p'), caps: [['P']], label: 'Particles', line: 4, run: () => a.setMode('particles') },
    { keys: letter('g'), caps: [['G']], label: 'Grid', line: 5, run: () => a.toggleGrid() },
    { keys: letter('t'), caps: [['T']], label: 'Trails', line: 5, run: () => a.toggleTrails() },
    { keys: letter('l'), caps: [['L']], label: 'Contours', line: 5, run: () => a.toggleContours() },
    { keys: letter('f'), caps: [['F']], label: 'Force field −∇Ψ', line: 6, run: () => a.toggleForceField() },
    { keys: letter('i'), shift: false, caps: [['I']], label: 'Image → Ψ', line: 7, run: () => a.importImage('potential') },
    { keys: letter('i'), shift: true, caps: [['⇧', 'I']], label: 'Image → particles', line: 7, run: () => a.importImage('particles') },
    { keys: letter('v'), caps: [['V']], label: 'Live camera as Ψ', line: 8, run: () => a.toggleCamera() },
    { keys: letter('o'), caps: [['O']], label: 'Open recording', line: 8, run: () => a.openRecording() },
    { keys: letter('d'), caps: [['D']], label: ['Show ', rhoH()], line: 9, run: () => a.toggleDensity() },
    { keys: letter('r'), shift: true, caps: [['⇧', 'R']], label: 'Record', line: 9, run: () => a.toggleRecording() },
    {
      keys: letter('s'),
      caps: [['S']],
      label: 'Next numerical scheme (Heun, Euler–Maruyama, Milstein)',
      line: 10,
      run: () => a.setScheme(SCHEME_ORDER[(SCHEME_ORDER.indexOf(state.scheme) + 1) % SCHEME_ORDER.length]),
    },
    { keys: letter('c'), caps: [['C']], label: 'Clear particles', line: 11, run: () => a.clearParticles() },
    { keys: letter('x'), caps: [['X']], label: 'Clear Ψ', line: 11, run: () => a.clearField() },
    { keys: letter('z'), ctrl: true, shift: false, caps: [['Ctrl', 'Z']], label: 'Undo', line: 12, run: () => a.undo() },
    {
      keys: [...letter('z'), ...letter('y')],
      ctrl: true,
      caps: [
        ['Ctrl', '⇧', 'Z'],
        ['Ctrl', 'Y'],
      ],
      label: 'Redo (Ψ edits, added and removed particles)',
      line: 12,
      run: () => a.redo(),
    },
    { keys: letter('r'), shift: false, caps: [['R']], label: 'Reset view', line: 13, run: () => a.resetView() },
    {
      keys: ['?', ...letter('h')],
      caps: [['?']],
      label: 'Help',
      line: 13,
      run: () => app.controls.setHelp(!app.controls.helpOpen),
    },
  ];
}

function matches(s: Shortcut, e: KeyboardEvent, ctrl: boolean): boolean {
  return !!s.ctrl === ctrl && s.keys.includes(e.key) && (s.shift === undefined || s.shift === e.shiftKey);
}

/**
 * → steps the simulation: one integrator step per press (in playback, the next recorded frame);
 * held, it plays until released.
 */
export function createStepKey(app: App): StepKey {
  const { state, particles } = app.core;
  const playback = () => app.recording.playback;
  const setPlaying = (playing: boolean) => {
    state.playing = playing;
    app.controls.sync();
  };
  return new StepKey({
    step: () => {
      const p = playback();
      if (p.active) {
        if (p.frame < p.timeline!.frames - 1) p.seek(p.frame + 1);
        else p.pause();
        return;
      }
      if (state.playing) setPlaying(false); // stepping pauses, as in a video player
      if (app.formulas.waiting()) return; // a formula is not ready: never step with a wrong process
      particles.advance(app.core.processNow(), DEFAULT_DT_MAX);
    },
    startHold: () => {
      if (playback().active) playback().play(performance.now());
      else setPlaying(true);
    },
    endHold: () => {
      if (playback().active) playback().pause();
      else setPlaying(false);
    },
  });
}

/** Listens to the keyboard (see `shortcuts`) and fills the list of shortcuts in the help dialog. */
export function installKeyboard(app: App): void {
  const table = shortcuts(app);
  renderHelp(table);

  window.addEventListener('keyup', (e) => {
    if (e.key === 'ArrowRight') app.stepKey.release();
  });
  window.addEventListener('blur', () => app.stepKey.release());

  window.addEventListener('keydown', (e) => {
    const { controls } = app;
    // While an image or a recording is loading, the app accepts no input at all.
    if (app.files.busy.active) {
      e.preventDefault();
      return;
    }
    const target = e.target instanceof HTMLElement ? e.target : null;
    const typing = !!target?.matches('input[type="text"], input[type="number"], textarea, [contenteditable="true"]');

    if (e.ctrlKey || e.metaKey) {
      // Ctrl shortcuts (undo, redo). In a text field they edit the text.
      if (typing || e.altKey || controls.helpOpen) return;
      const s = table.find((x) => matches(x, e, true));
      if (!s) return;
      e.preventDefault();
      s.run(e, target);
      return;
    }
    if (e.key === 'Escape') {
      app.input.cancel(); // e.g. abandons a spawn rectangle that is being dragged
      if (!controls.closeOverlays() && app.recording.playback.active) app.recording.playback.exit();
      return;
    }
    // While the help is open, only its own key works; typing in a text field is not a shortcut.
    if (controls.helpOpen && e.key !== '?') return;
    if (typing) return;
    table.find((x) => matches(x, e, false))?.run(e, target);
  });
}

/** The list of shortcuts in the help dialog (`#help-keys`), one line per `line` number. */
function renderHelp(table: readonly Shortcut[]): void {
  const list = document.getElementById('help-keys');
  if (!list) return;
  const lines = new Map<number, Shortcut[]>();
  for (const s of table) lines.set(s.line, [...(lines.get(s.line) ?? []), s]);
  for (const line of [...lines.keys()].sort((x, y) => x - y)) {
    const li = document.createElement('li');
    lines.get(line)!.forEach((s, k) => {
      if (k > 0) li.append(' · ');
      s.caps.forEach((caps, j) => {
        if (j > 0) li.append(' or ');
        li.append(...caps.map((c) => kbd(c)));
      });
      li.append(' ');
      if (typeof s.label === 'string' || s.label instanceof Node) li.append(s.label);
      else li.append(...s.label);
    });
    list.append(li);
  }
}
