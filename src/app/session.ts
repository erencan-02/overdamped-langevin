import { AnalysisBoxComponent, ParticlesComponent, PotentialComponent, ViewComponent } from '../session/components';
import { Session, type Snapshot } from '../session/session';
import { AnalysisSettings, DisplaySettings, PhysicsSettings, ToolSettings } from '../session/settings';
import { initialState } from '../state';
import type { App } from './app';

/**
 * Everything that can be captured, restored and replayed (see src/session/): recordings,
 * scenarios and the settings use it. Settings that change the simulation come first, then Ψ,
 * particles, the analysis box and the view. After any applied change the UI is refreshed.
 */
export function createSession(app: App): Session {
  const { state, particles, random, field, camera } = app.core;
  const syncUi = () => {
    const { analysis, formulas } = app;
    analysis.birthDeath.configure(state.birthDeath, state.birthRate, state.deathRate);
    analysis.birthDeathPanel.sync();
    app.controls.sync();
    analysis.observablePanel.sync(); // e.g. the test function of a restored recording
    analysis.ergodicity.sync();
    analysis.firstPassage.sync();
    formulas.potentialPanel.sync(); // e.g. the potential of a restored recording
    formulas.processPanel.sync(); // e.g. the drift and noise of a restored recording
  };
  return new Session()
    .register(new PhysicsSettings(state, syncUi, particles, random))
    .register(new AnalysisSettings(state, syncUi))
    .register(new DisplaySettings(state, syncUi))
    .register(new ToolSettings(state, syncUi))
    .register(new PotentialComponent(field))
    .register(new ParticlesComponent(particles))
    .register(new AnalysisBoxComponent(app.analysis.monitor))
    .register(new ViewComponent(camera));
}

/**
 * The settings of a fresh app (what a scenario resets the settings it does not mention to).
 */
export function freshSettings(app: App): Snapshot {
  const fresh = initialState();
  const { particles, random } = app.core;
  return new Session()
    .register(new PhysicsSettings(fresh, () => {}, particles, random))
    .register(new AnalysisSettings(fresh, () => {}))
    .register(new DisplaySettings(fresh, () => {}))
    .register(new ToolSettings(fresh, () => {}))
    .capture();
}
