import './style.css';
import { CELL_SIZE, PALETTE, PSI_CAP } from './config';
import { Renderer } from './render/renderer';
import { PotentialField } from './sim/field';
import { DEFAULT_DT_MAX, DEFAULT_WORK_BUDGET, MAX_PARTICLES, ParticleSystem } from './sim/particles';
import { applyPreset, type PresetName } from './sim/presets';
import { SCHEMES, type SchemeId } from './sim/schemes';
import { initialState, type Mode } from './state';
import { type ControlActions, Controls } from './ui/controls';
import { InputController } from './ui/input';
import { ImageImporter } from './image/importer';
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
  const particles = new ParticleSystem();
  particles.scheme = SCHEMES[state.scheme];
  const camera = new Camera();

  let renderer: Renderer;
  try {
    renderer = new Renderer(glCanvas);
  } catch (err) {
    fatal('This simulator needs WebGL2, which your browser or device does not provide.');
    console.error(err);
    return;
  }
  const overlay = new Overlay(overlayCanvas);
  const input = new InputController(stage, camera, field, particles, state);

  const actions: ControlActions = {
    setMode(mode: Mode) {
      state.mode = mode;
      controls.sync();
    },
    setScheme(id: SchemeId) {
      if (id === state.scheme) return;
      state.scheme = id;
      particles.scheme = SCHEMES[id];
      controls.sync();
      controls.showToast(`Scheme: ${SCHEMES[id].name}`);
    },
    togglePlay() {
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
      liveCamera.toggle();
    },
    toggleForceField() {
      state.forceField = !state.forceField;
      controls.sync();
    },
    clearParticles() {
      particles.clear();
      controls.showToast('Particles cleared');
    },
    clearField() {
      liveCamera.stop();
      field.clear();
      controls.showToast('Potential cleared');
    },
    resetView() {
      camera.reset();
    },
    importImage(target) {
      importer.openPicker(target);
    },
    preset(name: string) {
      liveCamera.stop();
      applyPreset(field, name as PresetName, camera.x, camera.y);
    },
  };
  const controls = new Controls(state, actions);

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

  const importer = new ImageImporter(field, particles, camera, {
    onStart: (target) => {
      if (target === 'potential') liveCamera.stop(); // a dropped image replaces the live potential
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
  });

  // ---------------------------------------------------------------- keyboard

  window.addEventListener('keydown', (e) => {
    // While an image is being converted, the app accepts no input at all.
    if (importer.busy) {
      e.preventDefault();
      return;
    }
    if (e.ctrlKey || e.metaKey) return;
    const target = e.target instanceof HTMLElement ? e.target : null;
    const onButtonOrInput = target?.closest('button, input') ?? null;
    if (e.key === 'Escape') {
      input.cancel(); // e.g. abandons a spawn rectangle that is being dragged
      controls.closeOverlays();
      return;
    }
    if (controls.helpOpen && e.key !== '?') return;
    switch (e.key) {
      case ' ':
        // Space would also "click" a focused button; take focus away and toggle once.
        e.preventDefault();
        if (onButtonOrInput) target?.blur();
        if (!e.repeat) actions.togglePlay();
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
        actions.resetView();
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
    controls.sync();
  };
  new ResizeObserver(resize).observe(stage);
  window.addEventListener('resize', resize);
  resize();
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

    input.update(dt);
    if (state.playing && particles.count > 0) {
      // Adapt the per-frame work budget to the measured cost of one drift evaluation so the
      // simulation never takes more than ~SIM_MS_PER_FRAME, whatever the device or scheme.
      const t0 = performance.now();
      particles.advance(field, dt * state.speed, state.sigma, DEFAULT_DT_MAX, workBudget);
      const elapsed = performance.now() - t0;
      const work = particles.lastWork;
      if (work > 1000 && elapsed > 0) {
        nsPerEval = 0.9 * nsPerEval + 0.1 * ((elapsed * 1e6) / work);
        workBudget = Math.max(8000, Math.min(800_000, (SIM_MS_PER_FRAME * 1e6) / nsPerEval));
      }
    }

    if (!renderer.gl.isContextLost()) {
      renderer.render(camera, field, particles, {
        grid: state.grid,
        trails: state.trails,
        contours: state.contours,
        forceField: state.forceField,
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
    });

    controls.setPanning(input.panning);
    controls.setPlayAttention(!state.playing && particles.count > 0);
    if (input.cursor.visible) {
      const wx = camera.toWorldX(input.cursor.x);
      const wy = camera.toWorldY(input.cursor.y);
      controls.updateReadout(wx, wy, field.sample(wx, wy), particles.time, particles.count, MAX_PARTICLES);
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
      get renderer() {
        return renderer;
      },
    },
  });
}

main();
