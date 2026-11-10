import './style.css';
import { CELL_SIZE, PALETTE, PSI_CAP } from './config';
import { Renderer } from './render/renderer';
import { PotentialField } from './sim/field';
import { DEFAULT_DT_MAX, DEFAULT_WORK_BUDGET, MAX_PARTICLES, ParticleSystem } from './sim/particles';
import { UndoHistory } from './sim/history';
import { RandomStreams } from './sim/random';
import { applyPreset, type PresetName } from './sim/presets';
import { SCHEMES, type SchemeId } from './sim/schemes';
import { initialState, type Mode, type ViewKind } from './state';
import { type ControlActions, Controls } from './ui/controls';
import { CollapsiblePanel } from './ui/collapsiblePanel';
import { KlPanel } from './ui/klPanel';
import { RecordingsPanel } from './ui/recordingsPanel';
import { InputController } from './ui/input';
import { EquilibriumMonitor } from './analysis/equilibrium';
import { ObservableMonitor } from './analysis/observable';
import { ObservablePanel } from './ui/observablePanel';
import { PotentialPanel } from './ui/potentialPanel';
import { Potential } from './sim/potential';
import { Recorder } from './record/recorder';
import { ImageDropHandler, ImageImporter } from './image/importer';
import { loadRecording, RecordingDropHandler } from './record/loader';
import { Playback } from './record/playback';
import { RecordingError } from './record/timeline';
import {
  AnalysisBoxComponent,
  ParticlesComponent,
  PotentialComponent,
  ViewComponent,
} from './session/components';
import { Session } from './session/session';
import { AnalysisSettings, DisplaySettings, PhysicsSettings, ToolSettings } from './session/settings';
import { BusyOverlay } from './ui/busyOverlay';
import { DropController } from './ui/dropzone';
import { PlaybackBar } from './ui/playbackBar';
import { StepKey } from './ui/stepKey';
import { ViewSwitch } from './view3d/viewSwitch';
import { LiveCamera } from './image/liveCamera';
import { Camera } from './view/camera';
import { Overlay } from './view/overlay';

function fatal(message: string): void {
  const el = document.getElementById('fatal');
  if (el) {
    el.textContent = message;
    el.hidden = false;
  }
}

function main(): void {
  const stage = document.getElementById('stage')!;
  const glCanvas = document.getElementById('gl') as HTMLCanvasElement;
  const overlayCanvas = document.getElementById('overlay') as HTMLCanvasElement;

  const state = initialState();
  const field = new PotentialField({ cellSize: CELL_SIZE, cap: PSI_CAP });
  // One seed drives every random number in the app (see sim/random.ts).
  const random = new RandomStreams(state.seed);
  const particles = new ParticleSystem(random.get('dynamics'));
  particles.scheme = SCHEMES[state.scheme];
  const camera = new Camera();
  // Undo/redo of brush strokes and other changes of Ψ, and of added/removed particles.
  const history = new UndoHistory(field, particles);

  let renderer: Renderer;
  try {
    renderer = new Renderer(glCanvas);
  } catch (err) {
    fatal('This simulator needs WebGL2, which your browser or device does not provide.');
    console.error(err);
    return;
  }
  const overlay = new Overlay(overlayCanvas);
  const input = new InputController(stage, camera, field, particles, state, random, history);
  // Ψ for the simulation, the analysis and the pictures: the painted lattice or a formula.
  const potential = new Potential(field);
  input.paintBlocked = () => {
    if (state.potentialMode !== 'formula') return false;
    controls.showToast('Ψ is given by a formula. Turn the formula off in the Potential window to paint.', {
      label: 'Paint',
      run: () => usePaintedPotential(),
    });
    return true;
  };
  /** Switches Ψ back to the painted lattice (if a formula was in use). Returns true if it did. */
  const usePaintedPotential = (): boolean => {
    if (state.potentialMode !== 'formula') return false;
    session.apply({ physics: { potentialMode: 'painted' } });
    controls.showToast('Formula off: Ψ is the painted lattice again');
    return true;
  };

  // 2D ↔ 3D view (three.js, loaded on first use). The tools work in both.
  const viewSwitch = new ViewSwitch(stage, () => potential.display, particles, {
    view2D: () => camera.bounds(),
    onModeChange: (mode) => {
      state.view = mode;
      input.cancel(); // ends a stroke or spray in progress: it belonged to the other view
      input.enabled = false; // until the transition has finished
      controls.sync();
    },
    onError: (message) => controls.showToast(message),
  });
  /**
   * Images and recordings move the 2D view to where they are placed, outside what the 3D view
   * shows, so they are opened in 2D. Returns true (with a hint) if that was refused.
   */
  const needs2D = (): boolean => {
    if (state.view !== '3d') return false;
    controls.showToast('Images and recordings open in the 2D view. Press 2 first.');
    return true;
  };

  const actions: ControlActions = {
    setMode(mode: Mode) {
      state.mode = mode;
      controls.sync();
    },
    setView(view: ViewKind) {
      viewSwitch.set(view);
    },
    setScheme(id: SchemeId) {
      if (id === state.scheme) return;
      session.apply({ physics: { scheme: id } }); // switches the integrator and refreshes the UI
      controls.showToast(`Scheme: ${SCHEMES[id].name}`);
    },
    togglePlay() {
      if (playback.active) return; // the recording, not the simulation, is playing
      state.playing = !state.playing;
      controls.sync();
    },
    toggleGrid() {
      state.grid = !state.grid;
      controls.sync();
    },
    toggleTrails() {
      state.trails = !state.trails;
      if (!state.trails) particles.clearTrails();
      controls.sync();
    },
    toggleContours() {
      state.contours = !state.contours;
      controls.sync();
    },
    toggleCamera() {
      // Allowed in 3D too: the camera image rises into a live relief. It paints Ψ, so a formula
      // is turned off first.
      if (!liveCamera.active) usePaintedPotential();
      liveCamera.toggle();
    },
    toggleRecording() {
      if (playback.active) return;
      const now = performance.now();
      if (recorder.recording) {
        const run = recorder.stop(now);
        controls.setRecording(false);
        recordings.render();
        if (run) controls.showToast(`${run.name} saved: ${run.frames} frames`);
      } else {
        // Ψ is recorded on the KL box (or the view, if there is none) for the whole run.
        recorder.start(now, monitor.region ?? camera.bounds());
        controls.setRecording(true);
        recordings.render(true);
      }
    },
    toggleDensity() {
      state.showDensity = !state.showDensity;
      controls.sync();
    },
    toggleForceField() {
      state.forceField = !state.forceField;
      controls.sync();
    },
    clearParticles() {
      if (particles.count === 0) return;
      history.run('Clear particles', () => particles.clear());
      controls.showToast('Particles cleared', { label: 'Undo', run: () => actions.undo() });
    },
    clearField() {
      usePaintedPotential();
      liveCamera.stop();
      history.run('Clear Ψ', () => field.clear());
      controls.showToast('Potential cleared', { label: 'Undo', run: () => actions.undo() });
    },
    undo() {
      if (busy.active || input.busy || history.recording) return;
      const label = history.undo();
      controls.showToast(label ? `Undone: ${label}` : 'Nothing to undo');
    },
    redo() {
      if (busy.active || input.busy || history.recording) return;
      const label = history.redo();
      controls.showToast(label ? `Redone: ${label}` : 'Nothing to redo');
    },
    resetView() {
      camera.reset();
    },
    importImage(target) {
      if (needs2D()) return;
      importer.openPicker(target);
    },
    setSeed(seed: number) {
      if (seed === state.seed) return;
      session.apply({ physics: { seed } });
      controls.showToast(`Seed ${seed}: all random streams restarted`);
    },
    openRecording() {
      if (needs2D()) return;
      if (!busy.active) recordingInput.click();
    },
    preset(name: string) {
      usePaintedPotential();
      liveCamera.stop();
      history.run('Preset', () => applyPreset(field, name as PresetName, camera.x, camera.y, random.get('presets')));
    },
  };
  const controls = new Controls(state, actions);
  // The settings card collapses like the analysis windows (open at start).
  new CollapsiblePanel({ section: 'settings', toggle: 'settings-toggle', body: 'panel' }, () => {}).setOpen(true);
  // Formulas in the side panels (ρ̂_h in the KL window) are typeset with KaTeX, which is loaded
  // when that window is first opened.
  let sideMathLoaded = false;
  const typesetSidePanels = () => {
    const sidePanels = document.querySelector<HTMLElement>('.left-col');
    if (sideMathLoaded || !sidePanels) return;
    sideMathLoaded = true;
    void import('./ui/helpMath').then((m) => m.renderMath(sidePanels, '.tex[data-tex]')).catch((err) => console.error(err));
  };

  const recorder = new Recorder({
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
    }),
    // Full settings for the metadata, so a recording restores the whole configuration.
    settings: () => session.capture(['physics', 'analysis', 'display', 'tools', 'analysisBox', 'view']),
  });
  const recordings = new RecordingsPanel(recorder, {
    toast: (text, action) => controls.showToast(text, action),
  });

  // Distance to equilibrium: KL between the kernel-smoothed particles and the Gibbs measure.
  const monitor = new EquilibriumMonitor(potential, particles);
  // Both analyses work on the same box; fitting it to the view restarts both curves.
  const fitBox = () => {
    monitor.setBox(camera.bounds());
    observables.reset();
    klPanel.draw();
    observablePanel.draw();
  };
  const klPanel = new KlPanel(monitor, { fitBox, opened: typesetSidePanels });

  // Weak convergence: E[f(X_t)] for a test function typed in LaTeX, against ∫ f dπ.
  const observables = new ObservableMonitor(potential, particles, monitor);
  const observablePanel = new ObservablePanel(observables, {
    expression: () => state.observable,
    setExpression: (tex) => {
      state.observable = tex;
    },
    fitBox,
  });

  // Everything that can be captured, restored and replayed (see src/session/). Settings that
  // change the simulation come first, then Ψ, particles, the analysis box and the view.
  // Ψ: painted, or a formula Ψ(t, x, y) with exact gradient.
  const potentialPanel = new PotentialPanel({
    mode: () => state.potentialMode,
    expression: () => state.potentialTex,
    // Entering or picking a formula means using it.
    setExpression: (tex) => session.apply({ physics: { potentialTex: tex, potentialMode: 'formula' } }),
    setMode: (mode) => {
      if (mode === 'formula') liveCamera.stop(); // the camera paints the lattice
      session.apply({ physics: { potentialMode: mode } });
    },
    apply: (compiled) => potential.setFormula(compiled),
  });

  const syncUi = () => {
    controls.sync();
    observablePanel.sync(); // e.g. the test function of a restored recording
    potentialPanel.sync(); // e.g. the potential of a restored recording
  };
  const session = new Session()
    .register(new PhysicsSettings(state, syncUi, particles, random))
    .register(new AnalysisSettings(state, syncUi))
    .register(new DisplaySettings(state, syncUi))
    .register(new ToolSettings(state, syncUi))
    .register(new PotentialComponent(field))
    .register(new ParticlesComponent(particles))
    .register(new AnalysisBoxComponent(monitor))
    .register(new ViewComponent(camera));

  // Playback of recorded runs: a floating player; altering the simulation leaves playback.
  const playback: Playback = new Playback(session, {
    onEnter: (timeline) => {
      history.clear(); // the recording replaces Ψ and the particles: earlier steps no longer apply
      state.playing = false;
      playerBar.show(timeline);
      controls.setPlaybackLock(true);
      controls.sync();
      const region = timeline.psiRegion() ?? timeline.particleBounds();
      if (region) camera.showRect(region.x0, region.y0, region.x1, region.y1);
    },
    onFrame: (k, jumped) => {
      playerBar.setFrame(k);
      if (jumped) {
        // The analysis curves restart after a jump in time.
        monitor.reset();
        observables.reset();
      }
    },
    onPlayingChange: (playing) => playerBar.setPlaying(playing),
    onExit: () => {
      playerBar.hide();
      controls.setPlaybackLock(false);
      controls.sync();
      controls.showToast('Left playback: press play to continue the simulation from here');
    },
  });
  const playerBar = new PlaybackBar(playback);

  input.onGridSpawned = (spawned, requested) => {
    if (spawned < requested) {
      controls.showToast(
        spawned === 0
          ? `Particle limit reached (${MAX_PARTICLES}). Clear some particles first.`
          : `Added ${spawned} of ${requested} particles: limit of ${MAX_PARTICLES} reached`,
      );
    }
  };

  const liveCamera = new LiveCamera(
    document.getElementById('cam-video') as HTMLVideoElement,
    field,
    camera,
    {
      onStateChange: (s) => {
        controls.setCameraState(s);
        // The camera rewrites Ψ every frame: steps recorded before it no longer apply.
        if (s === 'live') history.clear();
        if (s === 'starting') controls.showToast('Waiting for camera permission…');
        if (s === 'live') {
          controls.showToast('Camera live: dark areas are valleys', {
            label: 'Invert',
            run: () => {
              liveCamera.invert = !liveCamera.invert;
              controls.showToast(liveCamera.invert ? 'Inverted: light areas are valleys' : 'Dark areas are valleys');
            },
          });
        }
      },
      onError: (message) => controls.showToast(message),
    },
  );

  const busy = new BusyOverlay();
  const importer = new ImageImporter(field, particles, camera, random, busy, {
    onStart: (target) => {
      if (target === 'potential') {
        usePaintedPotential(); // an image is painted into the lattice: a formula is turned off
        liveCamera.stop(); // a dropped image replaces the live potential
      }
      input.cancel();
      controls.closeOverlays();
    },
    onImported: ({ inverted, target, count }) => {
      const text =
        target === 'potential'
          ? inverted
            ? 'Image inverted: light areas are now valleys'
            : 'Image converted to Ψ'
          : inverted
            ? `${count} particles placed on the light areas`
            : `Image converted to ${count} particles`;
      controls.showToast(text, { label: 'Invert', run: () => importer.invertLast() });
    },
    onError: (message) => controls.showToast(message),
    edit: (label, change) => history.run(label, change),
  });

  // ---------------------------------------------------------------- recordings & drag and drop

  const openRecording = async (file: File) => {
    if (busy.active) return;
    liveCamera.stop();
    input.cancel();
    controls.closeOverlays();
    if (recorder.recording) actions.toggleRecording(); // keep what was being recorded
    try {
      const timeline = await loadRecording(file, busy);
      playback.enter(timeline);
      controls.showToast(`${timeline.name}: ${timeline.frames} frames loaded. Press play below.`);
    } catch (err) {
      console.error(err);
      controls.showToast(err instanceof RecordingError ? err.message : 'This recording could not be loaded.');
    }
  };
  const recordingInput = document.getElementById('recording-input') as HTMLInputElement;
  recordingInput.addEventListener('change', () => {
    const file = recordingInput.files?.[0];
    recordingInput.value = '';
    if (file) void openRecording(file);
  });
  new DropController(
    [new ImageDropHandler(importer), new RecordingDropHandler((file) => void openRecording(file))],
    () => busy.active || state.view === '3d',
    (message) => controls.showToast(message),
    () => (state.view === '3d' ? 'Images and recordings open in the 2D view. Press 2, then drop the file again.' : null),
  );

  // ---------------------------------------------------------------- keyboard

  // →: one step per press (one integrator step, or the next frame of a recording); held, it plays.
  const stepKey = new StepKey({
    step: () => {
      if (playback.active) {
        const t = playback.timeline!;
        if (playback.frame < t.frames - 1) playback.seek(playback.frame + 1);
        else playback.pause();
        return;
      }
      if (state.playing) {
        state.playing = false; // stepping pauses, as in a video player
        controls.sync();
      }
      if (potentialPanel.pending) return; // the formula is not ready: never step with a wrong Ψ
      particles.advance(potential.drift, DEFAULT_DT_MAX, state.sigma);
    },
    startHold: () => {
      if (playback.active) playback.play(performance.now());
      else {
        state.playing = true;
        controls.sync();
      }
    },
    endHold: () => {
      if (playback.active) playback.pause();
      else {
        state.playing = false;
        controls.sync();
      }
    },
  });
  window.addEventListener('keyup', (e) => {
    if (e.key === 'ArrowRight') stepKey.release();
  });
  window.addEventListener('blur', () => stepKey.release());

  window.addEventListener('keydown', (e) => {
    // While an image or a recording is loading, the app accepts no input at all.
    if (busy.active) {
      e.preventDefault();
      return;
    }
    const target = e.target instanceof HTMLElement ? e.target : null;
    const typing = !!target?.matches('input[type="text"], input[type="number"], textarea, [contenteditable="true"]');
    if (e.ctrlKey || e.metaKey) {
      // Ctrl+Z undo, Ctrl+Shift+Z / Ctrl+Y redo (⌘ on macOS). In a text field they edit the text.
      const key = e.key.toLowerCase();
      if (typing || e.altKey || controls.helpOpen || (key !== 'z' && key !== 'y')) return;
      e.preventDefault();
      if (key === 'y' || e.shiftKey) actions.redo();
      else actions.undo();
      return;
    }
    const onButtonOrInput = target?.closest('button, input') ?? null;
    if (e.key === 'Escape') {
      input.cancel(); // e.g. abandons a spawn rectangle that is being dragged
      if (!controls.closeOverlays() && playback.active) playback.exit();
      return;
    }
    if (controls.helpOpen && e.key !== '?') return;
    // Typing in a text field (the test function, the seed) is not a shortcut.
    if (typing) return;
    switch (e.key) {
      case '2':
        actions.setView('2d');
        break;
      case '3':
        actions.setView('3d');
        break;
      case 'ArrowRight':
        // A focused slider uses the arrow keys itself.
        if (target?.matches('input[type="range"], select')) return;
        e.preventDefault();
        stepKey.press(); // auto-repeat key-downs are ignored; the hold is timed by StepKey
        break;
      case ' ':
        // Space would also "click" a focused button; take focus away and toggle once.
        e.preventDefault();
        if (onButtonOrInput) target?.blur();
        if (!e.repeat) {
          if (playback.active) playback.toggle(performance.now());
          else actions.togglePlay();
        }
        break;
      case 'b':
      case 'B':
        actions.setMode('brush');
        break;
      case 'p':
      case 'P':
        actions.setMode('particles');
        break;
      case 's':
      case 'S':
        actions.setScheme(state.scheme === 'heun' ? 'euler-maruyama' : 'heun');
        break;
      case 'i':
      case 'I':
        actions.importImage(e.shiftKey ? 'particles' : 'potential');
        break;
      case 'v':
      case 'V':
        actions.toggleCamera();
        break;
      case 'f':
      case 'F':
        actions.toggleForceField();
        break;
      case 'g':
      case 'G':
        actions.toggleGrid();
        break;
      case 't':
      case 'T':
        actions.toggleTrails();
        break;
      case 'l':
      case 'L':
        actions.toggleContours();
        break;
      case 'c':
      case 'C':
        actions.clearParticles();
        break;
      case 'x':
      case 'X':
        actions.clearField();
        break;
      case 'r':
      case 'R':
        if (e.shiftKey) actions.toggleRecording();
        else actions.resetView();
        break;
      case 'o':
      case 'O':
        actions.openRecording();
        break;
      case 'd':
      case 'D':
        actions.toggleDensity();
        break;
      case '?':
      case 'h':
      case 'H':
        controls.setHelp(!controls.helpOpen);
        break;
    }
  });

  // ---------------------------------------------------------------- sizing

  const resize = () => {
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    camera.setViewport(w, h);
    renderer.resize(w, h, dpr);
    overlay.resize(w, h, dpr);
    viewSwitch.resize(w, h, dpr);
    controls.sync();
  };
  new ResizeObserver(resize).observe(stage);
  window.addEventListener('resize', resize);
  resize();
  monitor.setBox(camera.bounds()); // the analysis box starts as the initial view
  document.fonts?.ready.then(() => controls.sync());

  // WebGL context loss (GPU reset, driver update, …): rebuild the renderer when restored.
  glCanvas.addEventListener('webglcontextlost', (e) => e.preventDefault());
  glCanvas.addEventListener('webglcontextrestored', () => {
    try {
      renderer = new Renderer(glCanvas);
      resize();
    } catch (err) {
      console.error(err);
    }
  });

  // ---------------------------------------------------------------- loop

  const SIM_MS_PER_FRAME = 7;
  let workBudget = DEFAULT_WORK_BUDGET;
  let nsPerEval = 125;
  let last = performance.now();
  const frame = (now: number) => {
    // Clamp the real-time step so a background tab or a hiccup never causes a huge jump.
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
    last = now;

    // The tools work in 2D and in 3D (on the surface), but not during the transition between them.
    input.enabled = viewSwitch.interactive2D || viewSwitch.interactive3D;
    input.picker = viewSwitch.interactive3D ? (sx, sy) => viewSwitch.pick(sx, sy) : null;
    input.update(dt);
    // Playback first: it notices if the user just altered the simulation and leaves.
    playback.update(now);
    // A time-dependent Ψ runs on even without particles; a formula that is still compiling waits.
    if (state.playing && (particles.count > 0 || potential.timeDependent) && !potentialPanel.pending) {
      // Adapt the per-frame work budget to the measured cost of one drift evaluation so the
      // simulation never takes more than ~SIM_MS_PER_FRAME, whatever the device or scheme.
      const t0 = performance.now();
      particles.advance(potential.drift, dt * state.speed, state.sigma, DEFAULT_DT_MAX, workBudget);
      const elapsed = performance.now() - t0;
      const work = particles.lastWork;
      if (work > 1000 && elapsed > 0) {
        nsPerEval = 0.9 * nsPerEval + 0.1 * ((elapsed * 1e6) / work);
        workBudget = Math.max(8000, Math.min(800_000, (SIM_MS_PER_FRAME * 1e6) / nsPerEval));
      }
    }

    // Ψ at the current time (a formula may depend on t and σ), and its picture around the view.
    potential.setTime(particles.time, state.sigma);
    potential.updateDisplay(camera.bounds(), now);

    // Analysis first, so that the density drawn below belongs to this frame's particles.
    monitor.keepRunning = recorder.recording || state.showDensity;
    if (monitor.update(now, state.sigma, state.kernelVariance, state.showDensity ? 33 : 100)) {
      klPanel.draw();
      const sample = monitor.latest;
      const region = monitor.region;
      if (recorder.recording && sample && region) recorder.addKl(particles.time, sample, region);
    }
    observables.keepRunning = recorder.recording;
    if (observables.update(now, state.sigma, state.kernelVariance)) {
      observablePanel.draw();
      const sample = observables.latest;
      if (recorder.recording && sample) recorder.addObservable(particles.time, sample, state.observable);
    }
    if (recorder.recording) {
      if (recorder.tick(now)) {
        controls.setRecording(false);
        controls.showToast('Recording stopped: memory limit reached (400 MB of raw data)');
      }
      recordings.renderLive(now);
    }

    // The 2D view is not drawn while the 3D view covers it completely.
    if (viewSwitch.show2D) {
      if (!renderer.gl.isContextLost()) {
        renderer.render(camera, potential.display, particles, {
          grid: state.grid,
          trails: state.trails,
          contours: state.contours,
          forceField: state.forceField,
          arrows: potential.analytic ? { ...potential.formulaDrift, revision: potential.revision, epoch: potential.epoch } : undefined,
          density: state.showDensity ? monitor.density : null,
        });
      }
      overlay.draw(camera, {
        grid: state.grid,
        mode: state.mode,
        cursor: input.cursor,
        brushRadius: state.brushRadius,
        brushSign: input.brushSign,
        nextColor: PALETTE[input.nextColor],
        panning: input.panning,
        selection: input.selection,
        analysisBox: monitor.active || observables.active ? monitor.region : null,
      });
    }
    viewSwitch.frame(now, state.grid, state.contours);

    controls.setPanning(input.panning);
    controls.setPlayAttention(!state.playing && particles.count > 0);
    // The point under the mouse: in 2D from the camera, in 3D on the surface (or none).
    const under = input.cursor.visible && input.enabled ? input.pick(input.cursor.x, input.cursor.y) : null;
    if (viewSwitch.interactive3D) {
      viewSwitch.setCursor(
        !under
          ? null
          : state.mode === 'brush'
            ? { kind: 'brush', x: under.x, y: under.y, radius: state.brushRadius, sign: input.brushSign, perPx: under.perPx }
            : { kind: 'particle', x: under.x, y: under.y, color: PALETTE[input.nextColor] },
      );
    }
    if (under) {
      controls.updateReadout(under.x, under.y, potential.sample(under.x, under.y), particles.time, particles.count, MAX_PARTICLES);
    } else {
      controls.updateReadout(null, null, null, particles.time, particles.count, MAX_PARTICLES);
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  // Handy for debugging from the console.
  Object.assign(window, {
    sde: {
      state,
      field,
      particles,
      camera,
      liveCamera,
      monitor,
      observables,
      potential,
      viewSwitch,
      input,
      recorder,
      history,
      session,
      playback,
      get renderer() {
        return renderer;
      },
    },
  });
}

main();
