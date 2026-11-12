import { applyPreset, type PresetName } from '../sim/presets';
import { SCHEMES, type SchemeId } from '../sim/schemes';
import type { Mode, ViewKind } from '../state';
import { type ControlActions, Controls } from '../ui/controls';
import { fullAppUrl } from '../ui/embed';
import type { App } from './app';

/**
 * What the toolbar, the Scene menu and the keyboard do. Every user command goes through here, so
 * this is the place to look up what a button does.
 */
export function createActions(app: App): ControlActions {
  const { state, particles, field, history, camera, random } = app.core;
  const toast: Controls['showToast'] = (text, action) => app.controls.showToast(text, action);
  const sync = () => app.controls.sync();

  const actions: ControlActions = {
    setMode(mode: Mode) {
      state.mode = mode;
      sync();
    },
    setView(view: ViewKind) {
      app.viewSwitch.set(view);
    },
    toggleGpu() {
      const graphics = app.graphics;
      if (!graphics.gpuInfo.available) return;
      const on = !state.gpu;
      state.gpu = on;
      app.viewSwitch.setGpu(on); // without the GPU: 3D closes and releases its context
      graphics.useGpu(on);
      app.controls.setGpuInfo(graphics.gpuInfo.available, graphics.tip());
      sync();
      toast(on ? 'GPU on' : 'GPU off: everything is drawn on the CPU');
    },
    setScheme(id: SchemeId) {
      if (id === state.scheme) return;
      app.session.apply({ physics: { scheme: id } }); // switches the integrator and refreshes the UI
      toast(`Scheme: ${SCHEMES[id].name}`);
    },
    togglePlay() {
      if (app.recording.playback.active) return; // the recording, not the simulation, is playing
      state.playing = !state.playing;
      sync();
    },
    toggleGrid() {
      state.grid = !state.grid;
      sync();
    },
    toggleTrails() {
      state.trails = !state.trails;
      if (!state.trails) particles.clearTrails();
      sync();
    },
    toggleContours() {
      state.contours = !state.contours;
      sync();
    },
    toggleCamera() {
      // Allowed in 3D too: the camera image rises into a live relief. It paints Ψ, so a formula
      // is turned off first.
      if (!app.liveCamera.active) usePaintedPotential(app);
      app.liveCamera.toggle();
    },
    toggleRecording() {
      app.recording.toggle();
    },
    toggleDensity() {
      state.showDensity = !state.showDensity;
      sync();
    },
    toggleForceField() {
      state.forceField = !state.forceField;
      sync();
    },
    clearParticles() {
      if (particles.count === 0) return;
      history.run('Clear particles', () => particles.clear());
      toast('Particles cleared', { label: 'Undo', run: () => actions.undo() });
    },
    clearField() {
      usePaintedPotential(app);
      app.liveCamera.stop();
      history.run('Clear Ψ', () => field.clear());
      toast('Potential cleared', { label: 'Undo', run: () => actions.undo() });
    },
    undo() {
      if (app.files.busy.active || app.input.busy || history.recording) return;
      const label = history.undo();
      toast(label ? `Undone: ${label}` : 'Nothing to undo');
    },
    redo() {
      if (app.files.busy.active || app.input.busy || history.recording) return;
      const label = history.redo();
      toast(label ? `Redone: ${label}` : 'Nothing to redo');
    },
    resetView() {
      camera.reset();
    },
    importImage(target) {
      app.files.importer.openPicker(target);
    },
    setSeed(seed: number) {
      if (seed === state.seed) return;
      app.session.apply({ physics: { seed } });
      toast(`Seed ${seed}: all random streams restarted`);
    },
    openRecording() {
      app.files.pickRecording();
    },
    share() {
      app.scenarios.panel.openShare();
    },
    tutorial() {
      app.tutorial.start();
    },
    openFull() {
      window.open(fullAppUrl(), '_blank', 'noopener');
    },
    preset(name: string) {
      usePaintedPotential(app);
      app.liveCamera.stop();
      history.run('Preset', () => applyPreset(field, name as PresetName, camera.x, camera.y, random.get('presets')));
    },
  };
  return actions;
}

/** The toolbar, settings, help dialog, toasts and readout, wired to the actions. */
export function createControls(app: App): Controls {
  const controls = new Controls(app.core.state, app.actions);
  controls.setGpuInfo(app.graphics.gpuInfo.available, app.graphics.tip());
  app.viewSwitch.setGpu(app.core.state.gpu); // no 3D view without the GPU
  return controls;
}

/** Switches Ψ back to the painted lattice (if a formula was in use). Returns true if it did. */
export function usePaintedPotential(app: App): boolean {
  if (app.core.state.potentialMode !== 'formula') return false;
  app.session.apply({ physics: { potentialMode: 'painted' } });
  app.controls.showToast('Formula off: Ψ is the painted lattice again');
  return true;
}
