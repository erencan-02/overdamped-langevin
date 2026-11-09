import './style.css';
import { CELL_SIZE, PALETTE, PSI_CAP } from './config';
import { Renderer } from './render/renderer';
import { PotentialField } from './sim/field';
import { DEFAULT_DT_MAX, DEFAULT_WORK_BUDGET, MAX_PARTICLES, ParticleSystem } from './sim/particles';
import { applyPreset, type PresetName } from './sim/presets';
import { initialState, type Mode } from './state';
import { type ControlActions, Controls } from './ui/controls';
import { InputController } from './ui/input';
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
    clearParticles() {
      particles.clear();
      controls.showToast('Particles cleared');
    },
    clearField() {
      field.clear();
      controls.showToast('Potential cleared');
    },
    resetView() {
      camera.reset();
    },
    preset(name: string) {
      applyPreset(field, name as PresetName, camera.x, camera.y);
    },
  };
  const controls = new Controls(state, actions);

  // ---------------------------------------------------------------- keyboard

  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey) return;
    const target = e.target as HTMLElement;
    const onButtonOrInput = target.closest('button, input');
    if (e.key === 'Escape') {
      controls.closeOverlays();
      return;
    }
    if (controls.helpOpen && e.key !== '?') return;
    switch (e.key) {
      case ' ':
        // Space would also "click" a focused button; take focus away and toggle once.
        e.preventDefault();
        if (onButtonOrInput) (target as HTMLElement).blur();
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
      get renderer() {
        return renderer;
      },
    },
  });
}

main();
