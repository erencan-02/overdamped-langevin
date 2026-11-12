import type { Controls, ControlActions } from '../ui/controls';
import type { InputController } from '../ui/input';
import type { StepKey } from '../ui/stepKey';
import type { Tutorial } from '../ui/tutorial';
import type { ViewSwitch } from '../view3d/viewSwitch';
import type { Session } from '../session/session';
import type { LiveCamera } from '../image/liveCamera';
import type { SceneExport } from '../export/sceneExport';
import type { Analysis } from './analysis';
import type { Core } from './core';
import type { DriftArrows } from './driftArrows';
import type { Files } from './files';
import type { Formulas } from './formulas';
import type { Graphics } from './graphics';
import type { Layout } from './layout';
import type { Recording } from './recording';
import type { Scenarios } from './scenarios';

/**
 * The whole app, part by part. main.ts builds the parts in the order listed here; each part is
 * made by one module of src/app/ (named in the comment) from the parts before it.
 *
 * The parts call each other back (the toolbar starts a recording, a recording stops the toolbar's
 * record button, …), so a part may also use LATER parts, but only inside callbacks that run after
 * start-up (a click, a key, a frame), through `app`: `app.recording.toggle()`. Code that runs
 * while a part is being built may only use the parts built before it.
 */
export interface App {
  /** The simulation state: settings, Ψ, particles, the process, the 2D camera (core.ts). */
  core: Core;
  /** Drawing the 2D view on the GPU or the CPU, and the overlay (graphics.ts). */
  graphics: Graphics;
  /** Mouse input on the stage: brush, particles, panning (stage.ts). */
  input: InputController;
  /** 2D ↔ 3D view (stage.ts). */
  viewSwitch: ViewSwitch;
  /** What the toolbar, the menus and the keyboard do (actions.ts). */
  actions: ControlActions;
  /** Toolbar, settings, help dialog, toasts, readout (actions.ts). */
  controls: Controls;
  /** Folding of the side windows, typesetting, window size (layout.ts). */
  layout: Layout;
  /** KL, observable, birth / death and the analysis instruments (analysis.ts). */
  analysis: Analysis;
  /** Ψ and the drift & noise as formulas (formulas.ts). */
  formulas: Formulas;
  /** The force arrows of the whole drift −∇Ψ + u (driftArrows.ts). */
  arrows: DriftArrows;
  /** Capturing and restoring everything (session.ts). */
  session: Session;
  /** Recording runs and playing them back (recording.ts). */
  recording: Recording;
  /** The live camera as Ψ (liveCamera.ts). */
  liveCamera: LiveCamera;
  /** Images, recordings and scenarios from files: pickers and drag and drop (files.ts). */
  files: Files;
  /** Scenarios and their worksheets (scenarios.ts). */
  scenarios: Scenarios;
  /** The guided tour (scenarios.ts). */
  tutorial: Tutorial;
  /** → steps (keyboard.ts). */
  stepKey: StepKey;
  /** Pictures and videos of the scene (export/sceneExport.ts, created in main.ts). */
  exporter: SceneExport;
}
