import './style.css';
import { CELL_SIZE, PALETTE, PSI_CAP } from './config';
import { CpuRenderer } from './render/cpuRenderer';
import { detectGpu } from './render/gpuInfo';
import { Renderer } from './render/renderer';
import { PotentialField } from './sim/field';
import { DEFAULT_DT_MAX, DEFAULT_WORK_BUDGET, MAX_PARTICLES, ParticleSystem } from './sim/particles';
import { UndoHistory } from './sim/history';
import { RandomStreams } from './sim/random';
import { applyPreset, type PresetName } from './sim/presets';
import { SCHEME_ORDER, SCHEMES, type SchemeId } from './sim/schemes';
import { type ProcessCapabilities, Sde } from './sim/process';
import { ProcessPanel } from './ui/processPanel';
import { chainSteps, InstrumentRegistry } from './instruments/instrument';
import { GradientNormInstrument, KlInstrument, ObservableInstrument } from './instruments/builtins';
import { ErgodicityInstrument } from './instruments/ergodicity';
import { FirstPassageInstrument } from './instruments/firstPassage';
import { StepSweepInstrument } from './instruments/stepSweep';
import { ScenarioPanel } from './ui/scenarioPanel';
import { applyScenario, captureScenario, type ScenarioHost } from './scenario/setup';
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
import { BirthDeath } from './sim/birthDeath';
import { BirthDeathPanel } from './ui/birthDeathPanel';
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

  // Drawing: WebGL2 on the GPU, or Canvas 2D on the CPU (without WebGL2, or with the GPU switched
  // off by the GPU button). Switching off releases the WebGL context, so the app then holds no
  // GPU resources at all; switching on restores it.
  let renderer: Renderer | null = null;
  try {
    renderer = new Renderer(glCanvas);
  } catch (err) {
    console.warn('WebGL2 is not available: drawing on the CPU.', err);
  }
  const gpuInfo = detectGpu(renderer?.gl ?? null);
  const loseContext = renderer?.gl.getExtension('WEBGL_lose_context') ?? null;
  // A hardware GPU is used from the start; with WebGL only emulated in software (or none),
  // the CPU renderer starts instead. The GPU button switches at any time.
  state.gpu = gpuInfo.available && gpuInfo.hardware;
  const cpuCanvas = document.createElement('canvas');
  cpuCanvas.id = 'cpu';
  cpuCanvas.hidden = true;
  glCanvas.after(cpuCanvas);
  let cpuRenderer: CpuRenderer | null = null;
  let viewSize = { w: 1, h: 1, dpr: 1 };
  /** The CPU renderer (created the first time it is needed). */
  const cpu = (): CpuRenderer => {
    if (!cpuRenderer) {
      cpuRenderer = new CpuRenderer(cpuCanvas);
      cpuRenderer.resize(viewSize.w, viewSize.h, viewSize.dpr);
    }
    return cpuRenderer;
  };
  /** The GPU draws now (allowed, and its context is alive). */
  const gpuReady = (): boolean => state.gpu && renderer !== null && !renderer.gl.isContextLost();
  if (renderer && !state.gpu) loseContext?.loseContext(); // software WebGL: start on the CPU
  /** The GPU button's tooltip: whether there is a GPU, which one, and whether it is used. */
  const gpuTip = (): string => {
    if (!gpuInfo.available) {
      return 'No GPU available: this browser offers no WebGL2, so everything is drawn on the CPU (no 3D view)';
    }
    const model = gpuInfo.name ?? 'model not reported by the browser';
    const what = gpuInfo.hardware ? `GPU available: ${model}` : `No hardware GPU: WebGL runs in software (${model})`;
    return state.gpu
      ? `${what} · in use · click to draw on the CPU instead`
      : `GPU off: drawing on the CPU (no 3D view) · ${what} · click to use it`;
  };
  const overlay = new Overlay(overlayCanvas);
  const input = new InputController(stage, camera, field, particles, state, random, history);
  // Ψ for the simulation, the analysis and the pictures: the painted lattice or a formula.
  const potential = new Potential(field);
  // The process the particles follow: dX = (−∇Ψ + u) dt + diag(s₁, s₂) dW (the drift & noise
  // window sets u and s; off, it is the Langevin equation). What the analysis may assume about it
  // (e.g. that the Gibbs measure is invariant) follows its capabilities.
  const sde = new Sde();
  let capabilities: ProcessCapabilities = sde.capabilities;
  /** The process at the current Ψ and σ, ready for the integrator. */
  const processNow = (): Sde => {
    sde.potential = potential.drift;
    sde.sigma = state.sigma;
    return sde;
  };
  /** The simulation must wait: a formula of Ψ, u or s is not compiled yet. */
  const waiting = (): boolean => potentialPanel.pending || processPanel.pending;
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
    toggleGpu() {
      if (!gpuInfo.available) return;
      const on = !state.gpu;
      state.gpu = on;
      viewSwitch.setGpu(on); // without the GPU: 3D closes and releases its context
      if (on) {
        if (renderer?.gl.isContextLost()) loseContext?.restoreContext(); // → webglcontextrestored
        formulaOnGpu = useFormulaOnGpu();
      } else {
        formulaOnGpu = false; // a formula is drawn from the CPU now
        loseContext?.loseContext();
      }
      controls.setGpuInfo(gpuInfo.available, gpuTip());
      controls.sync();
      controls.showToast(on ? 'GPU on' : 'GPU off: everything is drawn on the CPU');
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
    share() {
      scenarioPanel.openShare();
    },
    preset(name: string) {
      usePaintedPotential();
      liveCamera.stop();
      history.run('Preset', () => applyPreset(field, name as PresetName, camera.x, camera.y, random.get('presets')));
    },
  };
  const controls = new Controls(state, actions);
  controls.setGpuInfo(gpuInfo.available, gpuTip());
  viewSwitch.setGpu(state.gpu); // no 3D view without the GPU
  // The settings card collapses like the analysis windows (open at start).
  const settingsPanel = new CollapsiblePanel({ section: 'settings', toggle: 'settings-toggle', body: 'panel' }, () => {});
  settingsPanel.setOpen(true);
  // All side windows on the left fold away under one header (open at start, except on phones,
  // where they would cover the scene). Folded windows keep their state and keep measuring.
  // On phones the side windows and the Scenario window would cover each other: opening one
  // folds the other.
  const narrow = () => window.matchMedia('(max-width: 640px)').matches;
  const toolsPanel = new CollapsiblePanel({ section: 'left-col', toggle: 'left-toggle', body: 'left-body' }, (open) => {
    if (open && narrow()) scenarioPanel.setOpen(false);
  });
  toolsPanel.setOpen(!narrow());
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
      process: {
        drift: sde.extraDrift ? [state.driftU1, state.driftU2] : null,
        noise: sde.noise ? [state.noiseS1, state.noiseS2] : null,
      },
      birthDeath: state.birthDeath,
      birthRate: state.birthRate,
      deathRate: state.deathRate,
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
    // ‖∇Ψ‖ over the analysis box; the key changes with Ψ (incl. time, for a formula) and the box.
    gradientNorm: () => {
      const b = monitor.box;
      if (!b) return null;
      return {
        key: `${potential.revision}|${potential.epoch}|${b.x0},${b.y0},${b.x1},${b.y1}`,
        compute: () => potential.gradientNormL2(b),
      };
    },
    apply: (compiled) => {
      potential.setFormula(compiled);
      formulaOnGpu = useFormulaOnGpu();
    },
  });
  /**
   * A formula is drawn by the GPU (2D heat map and 3D relief, evaluated per pixel and per vertex)
   * when its GLSL passes the renderer's check against the exact values; otherwise from the CPU
   * through the display lattice.
   */
  let formulaOnGpu = false;
  const useFormulaOnGpu = (): boolean => {
    const f = potential.compiled;
    if (!renderer || !gpuReady()) return false; // drawn from the CPU (restored later if the GPU comes back)
    if (!f?.glsl) return renderer.setFormula(null);
    return renderer.setFormula({ glsl: f.glsl, exact: (xs, ys, n, t, sigma, out) => f.value(xs, ys, n, t, sigma, out) });
  };

  // Drift and noise: u and s as formulas (the Langevin equation while both are off).
  const processPanel = new ProcessPanel({
    settings: () => state,
    set: (change) => session.apply({ physics: change }),
    apply: (drift, noise) => {
      sde.extraDrift = drift;
      sde.noise = noise;
      capabilities = sde.capabilities;
      // The equilibrium tools need the Gibbs measure to be the invariant measure.
      monitor.gibbs = capabilities.gibbs;
      observables.gibbs = capabilities.gibbs;
      klPanel.draw();
      observablePanel.draw();
      showEquation();
      arrowEpoch++;
    },
    capabilities: () => capabilities,
  });
  /** The equation in the title card follows the process. */
  const brandEq = document.querySelector<HTMLElement>('.brand-eq');
  const showEquation = () => {
    if (!brandEq) return;
    const drift = sde.extraDrift ? '(−∇Ψ + u)(t, X<sub>t</sub>)' : '−∇Ψ(t, X<sub>t</sub>)';
    const noise = sde.noise ? 's(t, X<sub>t</sub>)' : 'σ';
    brandEq.innerHTML = `dX<sub>t</sub> = ${drift} dt + ${noise} dW<sub>t</sub>`; // fixed markup only
  };
  /**
   * Force arrows show the whole drift b = −∇Ψ + u when there is an extra drift (otherwise the
   * renderers draw −∇Ψ of the potential). The counters tell them when to rebuild.
   */
  let arrowEpoch = 0;
  let arrowRevision = 0;
  let arrowKey = '';
  let arrowEpochKey = '';
  const driftArrows = {
    gradient(x: number, y: number, out: Float64Array) {
      const xs = Float64Array.of(x);
      const ys = Float64Array.of(y);
      const bx = new Float64Array(1);
      const by = new Float64Array(1);
      processNow().drift(xs, ys, 1, particles.time, bx, by);
      out[0] = -bx[0];
      out[1] = -by[0];
    },
    gradientBatch(xs: Float64Array, ys: Float64Array, n: number, _t: number, gx: Float64Array, gy: Float64Array) {
      processNow().drift(xs, ys, n, particles.time, gx, gy);
      for (let i = 0; i < n; i++) {
        gx[i] = -gx[i];
        gy[i] = -gy[i];
      }
    },
    get revision() {
      return arrowRevision;
    },
    get epoch() {
      return arrowEpoch;
    },
  };

  // Births and deaths: exponential clocks per particle, run after every integrator step. They
  // draw from their own random stream, and recordings get every event (the lineage).
  const birthDeath = new BirthDeath(random.get('births'), {
    birth: (t, parent, child) => recorder.addBirth(t, parent, child),
    death: (t, id) => recorder.addDeath(t, id),
  });
  const birthDeathPanel = new BirthDeathPanel(
    birthDeath,
    particles,
    {
      settings: () => ({ enabled: state.birthDeath, birthRate: state.birthRate, deathRate: state.deathRate }),
      set: (change) => session.apply({ physics: change }),
    },
    random.get('replicas'),
  );

  // The analysis tools, all behind one interface (see instruments/instrument.ts): each gets every
  // frame, the path-following ones also every integrator step (after births and deaths).
  const instruments = new InstrumentRegistry();
  particles.events = chainSteps(birthDeath, instruments);
  instruments.register(new GradientNormInstrument(potentialPanel));
  instruments.register(birthDeathPanel);
  const ergodicity = instruments.register(
    new ErgodicityInstrument(particles, potential, {
      expression: () => state.ergodicF,
      setExpression: (tex) => session.apply({ analysis: { ergodicF: tex } }),
      sigma: () => state.sigma,
    }),
  );
  const firstPassage = instruments.register(
    new FirstPassageInstrument(potential, {
      expression: () => state.passageTarget,
      setExpression: (tex) => session.apply({ analysis: { passageTarget: tex } }),
      sigma: () => state.sigma,
    }),
  );
  instruments.register(
    new StepSweepInstrument(particles, {
      process: processNow,
      rng: () => random.get('sweep'),
      blocked: () => (waiting() ? 'A formula is not ready yet: wait until it has compiled.' : null),
    }),
  );
  instruments.register(
    new ObservableInstrument(observables, observablePanel, {
      sampled: (t) => {
        const sample = observables.latest;
        if (recorder.recording && sample) recorder.addObservable(t, sample, state.observable);
      },
    }),
  );
  instruments.register(
    new KlInstrument(monitor, klPanel, {
      showDensity: () => state.showDensity,
      sampled: (t) => {
        const sample = monitor.latest;
        const region = monitor.region;
        if (recorder.recording && sample && region) recorder.addKl(t, sample, region);
      },
    }),
  );

  const syncUi = () => {
    birthDeath.configure(state.birthDeath, state.birthRate, state.deathRate);
    birthDeathPanel.sync();
    controls.sync();
    observablePanel.sync(); // e.g. the test function of a restored recording
    ergodicity.sync();
    firstPassage.sync();
    potentialPanel.sync(); // e.g. the potential of a restored recording
    processPanel.sync(); // e.g. the drift and noise of a restored recording
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

  // ---------------------------------------------------------------- scenarios

  // A scenario sets the app up (settings over a fresh app's, Ψ, particles, view, windows) and
  // may carry a worksheet; see src/scenario/. Settings it does not mention are reset to these.
  const fresh = initialState();
  const freshSettings = new Session()
    .register(new PhysicsSettings(fresh, () => {}, particles, random))
    .register(new AnalysisSettings(fresh, () => {}))
    .register(new DisplaySettings(fresh, () => {}))
    .register(new ToolSettings(fresh, () => {}))
    .capture();
  const scenarioHost: ScenarioHost = {
    session,
    defaults: freshSettings,
    field,
    rng: { presets: random.get('presets'), positions: random.get('scenario'), colors: random.get('colors') },
    reseed: () => random.reseed(state.seed),
    prepare: () => {
      if (playback.active) playback.exit();
      if (recorder.recording) actions.toggleRecording();
      liveCamera.stop();
      input.cancel();
      controls.closeOverlays();
      history.clear(); // the scenario replaces Ψ and the particles
      boxFromView = true; // the scenario sets the analysis box
    },
    showRect: (b) => camera.showRect(b.x0, b.y0, b.x1, b.y1),
    viewBounds: () => camera.bounds(),
    openPanels: (ids) => {
      if (ids.length > 0) toolsPanel.setOpen(true); // the windows it opens are on the left
      for (const i of instruments.all) i.setOpen?.(ids.includes(i.id));
      processPanel.setOpen(ids.includes('process'));
      settingsPanel.setOpen(ids.includes('settings'));
    },
    openPanelIds: () => [
      ...instruments.all.filter((i) => i.open).map((i) => i.id),
      ...(processPanel.open ? ['process'] : []),
      ...(settingsPanel.open ? ['settings'] : []),
    ],
    resetInstruments: () => instruments.resetAll(),
    setPlaying: (playing) => {
      state.playing = playing;
      controls.sync();
    },
  };
  const scenarioPanel = new ScenarioPanel({
    apply: (s) => applyScenario(s, scenarioHost),
    capture: (o) => captureScenario(scenarioHost, o),
    readouts: () => instruments.readouts(),
    toast: (text) => controls.showToast(text),
    opened: () => {
      if (narrow()) toolsPanel.setOpen(false);
    },
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
    [
      new ImageDropHandler(importer),
      // Scenario files share the recording's drop layout (both are "a file that sets everything up").
      {
        id: 'recording',
        acceptsDrag: () => false,
        acceptsFile: (file: File) => /\.json$/i.test(file.name) || file.type === 'application/json',
        drop: (file: File) => void scenarioPanel.openFile(file),
      },
      new RecordingDropHandler((file) => void openRecording(file)),
    ],
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
      if (waiting()) return; // a formula is not ready: never step with a wrong process
      particles.advance(processNow(), DEFAULT_DT_MAX);
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
        actions.setScheme(SCHEME_ORDER[(SCHEME_ORDER.indexOf(state.scheme) + 1) % SCHEME_ORDER.length]);
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

  let boxFromView = false;
  const resize = () => {
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    camera.setViewport(w, h);
    viewSize = { w, h, dpr };
    renderer?.resize(w, h, dpr);
    cpuRenderer?.resize(w, h, dpr);
    overlay.resize(w, h, dpr);
    viewSwitch.resize(w, h, dpr);
    // The analysis box starts as the initial view: set once the stage has a real size (a page
    // opened in a background tab is laid out with a 1-pixel stage at first).
    if (!boxFromView && w > 1 && h > 1) {
      boxFromView = true;
      monitor.setBox(camera.bounds());
    }
    controls.sync();
  };
  new ResizeObserver(resize).observe(stage);
  window.addEventListener('resize', resize);
  resize();
  document.fonts?.ready.then(() => controls.sync());

  // WebGL context loss (GPU reset, driver update, …): rebuild the renderer when restored.
  glCanvas.addEventListener('webglcontextlost', (e) => e.preventDefault());
  glCanvas.addEventListener('webglcontextrestored', () => {
    if (!state.gpu) {
      loseContext?.loseContext(); // restored by the browser while the GPU is switched off
      return;
    }
    try {
      renderer = new Renderer(glCanvas);
      formulaOnGpu = useFormulaOnGpu(); // the new context needs the formula's shader again
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
    if (state.playing && (particles.count > 0 || potential.timeDependent || sde.coefficientsDependOnTime) && !waiting()) {
      // Adapt the per-frame work budget to the measured cost of one drift evaluation so the
      // simulation never takes more than ~SIM_MS_PER_FRAME, whatever the device or scheme.
      const t0 = performance.now();
      particles.advance(processNow(), dt * state.speed, DEFAULT_DT_MAX, workBudget);
      const elapsed = performance.now() - t0;
      const work = particles.lastWork;
      if (work > 1000 && elapsed > 0) {
        nsPerEval = 0.9 * nsPerEval + 0.1 * ((elapsed * 1e6) / work);
        workBudget = Math.max(8000, Math.min(800_000, (SIM_MS_PER_FRAME * 1e6) / nsPerEval));
      }
    }


    // Ψ at the current time (a formula may depend on t and σ), and its picture around the view.
    potential.setTime(particles.time, state.sigma);
    if (sde.extraDrift && state.forceField) {
      // The drift arrows change with Ψ, and with time or σ if u depends on them. A replaced Ψ
      // rebuilds them at once (epoch); edits and time only at the renderers' refresh rate.
      const epochKey = `${potential.epoch}`;
      if (epochKey !== arrowEpochKey) {
        arrowEpochKey = epochKey;
        arrowEpoch++;
      }
      const key = `${potential.revision}|${sde.coefficientsDependOnTime ? `${particles.time}|${state.sigma}` : ''}`;
      if (key !== arrowKey) {
        arrowKey = key;
        arrowRevision++;
      }
    }
    // Only a formula drawn from the CPU needs the display lattice (redrawn when the view moves).
    if (potential.analytic && !formulaOnGpu) potential.updateDisplay(camera.bounds(), now);

    // Analysis first, so that the density drawn below belongs to this frame's particles.
    instruments.frame({
      now,
      particles,
      process: processNow(),
      sigma: state.sigma,
      kernelVariance: state.kernelVariance,
      recording: recorder.recording,
    });
    if (recorder.recording) {
      if (recorder.tick(now)) {
        controls.setRecording(false);
        controls.showToast(`Recording stopped: size limit reached (${Math.round(recorder.maxBytes / 2 ** 20)} MB of raw data)`);
      }
      recordings.renderLive(now);
    }

    // The 2D view is not drawn while the 3D view covers it completely. It is drawn by the GPU,
    // or by the CPU (no WebGL2, GPU switched off, or the GPU context not back yet).
    const onGpu = gpuReady();
    if (glCanvas.hidden === onGpu) glCanvas.hidden = !onGpu;
    if (cpuCanvas.hidden !== onGpu) cpuCanvas.hidden = onGpu;
    if (viewSwitch.show2D) {
      const drawer = onGpu ? renderer! : cpu();
      drawer.render(camera, potential.display, particles, {
        grid: state.grid,
        trails: state.trails,
        contours: state.contours,
        forceField: state.forceField,
        arrows: sde.extraDrift
          ? driftArrows
          : potential.analytic
            ? { ...potential.formulaDrift, revision: potential.revision, epoch: potential.epoch }
            : undefined,
        formula: potential.analytic && formulaOnGpu && onGpu ? { t: particles.time, sigma: state.sigma } : undefined,
        density: state.showDensity ? monitor.density : null,
      });
      overlay.draw(camera, {
        grid: state.grid,
        mode: state.mode,
        cursor: input.cursor,
        brushRadius: state.brushRadius,
        brushSign: input.brushSign,
        nextColor: PALETTE[input.nextColor],
        panning: input.panning,
        selection: input.selection,
        analysisBox: monitor.active || observables.active || potentialPanel.open ? (monitor.region ?? monitor.box) : null,
        marker: ergodicity.marker(),
        region: firstPassage.targetRegion(camera.bounds(), camera.scale, `${potential.revision}|${potential.epoch}`),
      });
    }
    const glsl = potential.compiled?.glsl;
    viewSwitch.frame(
      now,
      state.grid,
      state.contours,
      formulaOnGpu && glsl ? { glsl, t: particles.time, sigma: state.sigma, heights: potential } : null,
    );

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

  // A scenario named in the address (#s=…, #scenario=…, #gist=…) is opened at start.
  void scenarioPanel.loadFromHash();

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
      sde,
      instruments,
      birthDeath,
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
