import { ImageDropHandler, ImageImporter } from '../image/importer';
import { loadRecording, RecordingDropHandler } from '../record/loader';
import { RecordingError } from '../record/timeline';
import { BusyOverlay } from '../ui/busyOverlay';
import { DropController } from '../ui/dropzone';
import { usePaintedPotential } from './actions';
import type { App } from './app';

/**
 * Opening files: images (→ Ψ or → particles), recordings (.npz, played back) and scenarios
 * (.json), from the file pickers or dropped anywhere on the window, in 2D and in 3D (the 3D view
 * follows the place of what was opened). While a file is being processed, the busy overlay blocks
 * all input.
 */
export class Files {
  readonly busy = new BusyOverlay();
  readonly importer: ImageImporter;
  private readonly recordingInput = document.getElementById('recording-input') as HTMLInputElement;

  constructor(private readonly app: App) {
    const { field, particles, camera, random, history } = app.core;
    const controls = () => app.controls;

    this.importer = new ImageImporter(field, particles, camera, random, this.busy, {
      onStart: (target) => {
        if (target === 'potential') {
          usePaintedPotential(app); // an image is painted into the lattice: a formula is turned off
          app.liveCamera.stop(); // a dropped image replaces the live potential
        }
        app.input.cancel();
        controls().closeOverlays();
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
        controls().showToast(text, { label: 'Invert', run: () => this.importer.invertLast() });
      },
      onError: (message) => controls().showToast(message),
      edit: (label, change) => history.run(label, change),
    });

    this.recordingInput.addEventListener('change', () => {
      const file = this.recordingInput.files?.[0];
      this.recordingInput.value = '';
      if (file) void this.openRecording(file);
    });

    new DropController(
      [
        new ImageDropHandler(this.importer),
        // Scenario files share the recording's drop layout (both are "a file that sets everything up").
        {
          id: 'recording',
          acceptsDrag: () => false,
          acceptsFile: (file: File) => /\.json$/i.test(file.name) || file.type === 'application/json',
          drop: (file: File) => void app.scenarios.panel.openFile(file),
        },
        new RecordingDropHandler((file) => void this.openRecording(file)),
      ],
      () => this.busy.active,
      (message) => controls().showToast(message),
    );
  }

  /** Opens the file picker for a recording. */
  pickRecording(): void {
    if (!this.busy.active) this.recordingInput.click();
  }

  /** Loads a recording and plays it back (a run being recorded is stopped and kept first). */
  async openRecording(file: File): Promise<void> {
    const app = this.app;
    if (this.busy.active) return;
    app.liveCamera.stop();
    app.input.cancel();
    app.controls.closeOverlays();
    if (app.recording.recorder.recording) app.recording.toggle(); // keep what was being recorded
    try {
      const timeline = await loadRecording(file, this.busy);
      app.recording.playback.enter(timeline);
      app.controls.showToast(`${timeline.name}: ${timeline.frames} frames loaded. Press play below.`);
    } catch (err) {
      console.error(err);
      app.controls.showToast(err instanceof RecordingError ? err.message : 'This recording could not be loaded.');
    }
  }
}
