import { MAX_PARTICLES } from '../sim/particles';
import { InputController } from '../ui/input';
import { ViewSwitch } from '../view3d/viewSwitch';
import { usePaintedPotential } from './actions';
import type { App } from './app';

/**
 * The scene: mouse input (brush, particles, panning) and the switch between the 2D view and the
 * 3D view (three.js, loaded on first use). The tools work in both.
 */
export function createStage(app: App): { input: InputController; viewSwitch: ViewSwitch } {
  const { state, camera, field, particles, random, history, potential } = app.core;
  const stage = document.getElementById('stage')!;

  const input = new InputController(stage, camera, field, particles, state, random, history);
  // Painting needs the painted lattice: with a formula, offer to switch back.
  input.paintBlocked = () => {
    if (state.potentialMode !== 'formula') return false;
    app.controls.showToast('Ψ is given by a formula. Turn the formula off in the Potential window to paint.', {
      label: 'Paint',
      run: () => usePaintedPotential(app),
    });
    return true;
  };
  input.onGridSpawned = (spawned, requested) => {
    if (spawned < requested) {
      app.controls.showToast(
        spawned === 0
          ? `Particle limit reached (${MAX_PARTICLES}). Clear some particles first.`
          : `Added ${spawned} of ${requested} particles: limit of ${MAX_PARTICLES} reached`,
      );
    }
  };

  const viewSwitch = new ViewSwitch(stage, () => potential.display, particles, {
    view2D: () => camera.bounds(),
    onModeChange: (mode) => {
      state.view = mode;
      input.cancel(); // ends a stroke or spray in progress: it belonged to the other view
      input.enabled = false; // until the transition has finished
      app.controls.sync();
    },
    onError: (message) => app.controls.showToast(message),
  });

  return { input, viewSwitch };
}
