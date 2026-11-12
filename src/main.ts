import './style.css';
import { createActions, createControls } from './app/actions';
import { Analysis } from './app/analysis';
import type { App } from './app/app';
import { createCore } from './app/core';
import { DriftArrows } from './app/driftArrows';
import { Files } from './app/files';
import { Formulas } from './app/formulas';
import { Graphics } from './app/graphics';
import { createStepKey, installKeyboard } from './app/keyboard';
import { Layout, setUpEmbedding } from './app/layout';
import { createLiveCamera } from './app/liveCamera';
import { Loop } from './app/loop';
import { setUpOffline } from './app/offline';
import { Recording } from './app/recording';
import { createTutorial, Scenarios } from './app/scenarios';
import { createSession } from './app/session';
import { createStage } from './app/stage';
import { mountHelp } from './ui/help';
import { buildSideWindows } from './ui/sideWindows';

/**
 * Builds the app part by part (see app/app.ts for what each part is and the rule for using
 * parts that are built later), then starts the animation loop.
 */
function main(): void {
  // The page's markup first: everything below looks up its elements.
  buildSideWindows();
  mountHelp();
  const embedded = setUpEmbedding();

  const app = {} as App;
  app.core = createCore();
  app.graphics = new Graphics(app.core.state, app.core.potential, () => app.layout.resize());
  ({ input: app.input, viewSwitch: app.viewSwitch } = createStage(app));
  app.actions = createActions(app);
  app.controls = createControls(app);
  app.layout = new Layout(app, embedded);
  app.formulas = new Formulas(app);
  app.arrows = new DriftArrows(app.core);
  app.analysis = new Analysis(app);
  app.session = createSession(app);
  app.recording = new Recording(app);
  app.liveCamera = createLiveCamera(app);
  app.files = new Files(app);
  app.scenarios = new Scenarios(app);
  app.tutorial = createTutorial(app);
  app.stepKey = createStepKey(app);
  installKeyboard(app);

  app.layout.start();
  new Loop(app).start();

  // A scenario named in the address (#s=…, #scenario=…, #gist=…) is opened at start.
  void app.scenarios.panel.loadFromHash();
  setUpOffline(app);

  exposeForDebugging(app);
}

/** `window.sde` in the browser console (also used by the end-to-end tests). */
function exposeForDebugging(app: App): void {
  const { core, analysis, recording } = app;
  Object.assign(window, {
    sde: {
      app,
      state: core.state,
      field: core.field,
      particles: core.particles,
      camera: core.camera,
      potential: core.potential,
      sde: core.sde,
      history: core.history,
      liveCamera: app.liveCamera,
      monitor: analysis.monitor,
      observables: analysis.observables,
      instruments: analysis.instruments,
      birthDeath: analysis.birthDeath,
      viewSwitch: app.viewSwitch,
      input: app.input,
      recorder: recording.recorder,
      session: app.session,
      playback: recording.playback,
      get renderer() {
        return app.graphics.gpuRenderer;
      },
    },
  });
}

main();
