import { applyScenario, captureScenario, type ScenarioHost } from '../scenario/setup';
import { toolsParam } from '../ui/embed';
import { ScenarioPanel } from '../ui/scenarioPanel';
import { Tutorial } from '../ui/tutorial';
import { appTutorialSteps } from '../ui/tutorialSteps';
import type { App } from './app';
import { narrow } from './layout';
import { freshSettings } from './session';

/**
 * Scenarios: a scenario sets the app up (settings over a fresh app's, Ψ, particles, view,
 * windows) and may carry a worksheet; see src/scenario/. The Scenario window lists the course
 * scenarios, shows the worksheet and creates share links.
 */
export class Scenarios {
  readonly panel: ScenarioPanel;
  private readonly host: ScenarioHost;

  constructor(app: App) {
    const { state, field, random, camera, history } = app.core;
    const { recording, analysis, formulas, layout } = app;
    const instruments = analysis.instruments;

    this.host = {
      session: app.session,
      // Settings a scenario does not mention are reset to a fresh app's.
      defaults: freshSettings(app),
      field,
      rng: { presets: random.get('presets'), positions: random.get('scenario'), colors: random.get('colors') },
      reseed: () => random.reseed(state.seed),
      prepare: () => {
        if (recording.playback.active) recording.playback.exit();
        if (recording.recorder.recording) recording.toggle();
        app.liveCamera.stop();
        app.input.cancel();
        app.controls.closeOverlays();
        history.clear(); // the scenario replaces Ψ and the particles
        layout.analysisBoxGiven(); // the scenario sets the analysis box
      },
      showRect: (b) => camera.showRect(b.x0, b.y0, b.x1, b.y1),
      viewBounds: () => camera.bounds(),
      openPanels: (ids) => {
        // The windows it opens are on the left (unless the embedding page asked for them folded).
        if (ids.length > 0 && toolsParam() !== false) layout.toolsPanel.setOpen(true);
        for (const i of instruments.all) i.setOpen?.(ids.includes(i.id));
        formulas.processPanel.setOpen(ids.includes('process'));
        layout.settingsPanel.setOpen(ids.includes('settings'));
      },
      openPanelIds: () => [
        ...instruments.all.filter((i) => i.open).map((i) => i.id),
        ...(formulas.processPanel.open ? ['process'] : []),
        ...(layout.settingsPanel.open ? ['settings'] : []),
      ],
      resetInstruments: () => instruments.resetAll(),
      setPlaying: (playing) => {
        state.playing = playing;
        app.controls.sync();
      },
    };

    this.panel = new ScenarioPanel({
      apply: (s) => applyScenario(s, this.host),
      capture: (o) => captureScenario(this.host, o),
      readouts: () => instruments.readouts(),
      toast: (text) => app.controls.showToast(text),
      opened: () => {
        // On phones the side windows and the Scenario window would cover each other.
        if (narrow()) layout.toolsPanel.setOpen(false);
      },
    });
  }
}

/** The guided tour of the main areas (the book button). Steps live in ui/tutorialSteps.ts. */
export function createTutorial(app: App): Tutorial {
  return new Tutorial(
    appTutorialSteps({
      showTools: () => {
        const tools = app.layout.toolsPanel;
        const was = tools.open;
        tools.setOpen(true);
        return () => tools.setOpen(was);
      },
      showRecordings: () => app.recording.recordings.reveal(),
    }),
    {
      starting: () => {
        app.input.cancel(); // e.g. a stroke in progress
        app.controls.closeOverlays(); // menus, the help dialog
        app.stepKey.release();
      },
    },
  );
}
