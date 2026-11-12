import { PALETTE } from '../config';
import { DEFAULT_DT_MAX, DEFAULT_WORK_BUDGET, MAX_PARTICLES } from '../sim/particles';
import type { App } from './app';
import { changeDetector } from './watch';

/** Simulated work per frame is kept below this many milliseconds of real time. */
const SIM_MS_PER_FRAME = 7;

/**
 * The animation loop. Each frame, in this order:
 *  1. input and playback,
 *  2. the simulation (as much as fits into the frame),
 *  3. what follows from Ψ and the process (Ψ at the current time, the drift arrows),
 *  4. the analysis and the recording (before drawing, so that the density drawn belongs to this
 *     frame's particles),
 *  5. drawing the 2D view and the 3D view,
 *  6. the readout under the mouse.
 */
export class Loop {
  private last = performance.now();
  /** Per-frame work budget, adapted to the measured cost of one drift evaluation. */
  private workBudget = DEFAULT_WORK_BUDGET;
  private nsPerEval = 125;
  /** The 2D camera moved (a change while in 3D re-centres the 3D view). */
  private readonly cameraMoved = changeDetector();

  constructor(private readonly app: App) {}

  start(): void {
    const frame = (now: number) => {
      this.frame(now);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  private frame(now: number): void {
    // Clamp the real-time step so a background tab or a hiccup never causes a huge jump.
    const dt = Math.min(0.05, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    this.handleInput(now, dt);
    this.simulate(dt);
    this.updateDerived(now);
    this.analyse(now);
    this.draw(now);
    // Pictures and video frames are taken right after drawing (WebGL keeps the picture only
    // until the frame is shown).
    this.app.exporter.frame(now);
    this.updateReadout();
  }

  private handleInput(now: number, dt: number): void {
    const { input, viewSwitch } = this.app;
    // The tools work in 2D and in 3D (on the surface), but not during the transition between them.
    input.enabled = viewSwitch.interactive2D || viewSwitch.interactive3D;
    input.picker = viewSwitch.interactive3D ? (sx, sy) => viewSwitch.pick(sx, sy) : null;
    input.update(dt);
    // Playback first: it notices if the user just altered the simulation and leaves.
    this.app.recording.playback.update(now);
  }

  private simulate(dt: number): void {
    const { state, particles, potential, sde } = this.app.core;
    // A time-dependent Ψ runs on even without particles; a formula that is still compiling waits.
    const moves = particles.count > 0 || potential.timeDependent || sde.coefficientsDependOnTime;
    if (!state.playing || !moves || this.app.formulas.waiting()) return;
    // Adapt the work budget so the simulation never takes more than ~SIM_MS_PER_FRAME, whatever
    // the device or scheme.
    const t0 = performance.now();
    particles.advance(this.app.core.processNow(), dt * state.speed, DEFAULT_DT_MAX, this.workBudget);
    const elapsed = performance.now() - t0;
    const work = particles.lastWork;
    if (work > 1000 && elapsed > 0) {
      this.nsPerEval = 0.9 * this.nsPerEval + 0.1 * ((elapsed * 1e6) / work);
      this.workBudget = Math.max(8000, Math.min(800_000, (SIM_MS_PER_FRAME * 1e6) / this.nsPerEval));
    }
  }

  private updateDerived(now: number): void {
    const { state, particles, potential, camera } = this.app.core;
    // Ψ at the current time (a formula may depend on t and σ), and its picture around the view.
    potential.setTime(particles.time, state.sigma);
    this.app.arrows.update();
    // Only a formula drawn from the CPU needs the display lattice (redrawn when the view moves).
    if (potential.analytic && !this.app.graphics.formulaOnGpu) potential.updateDisplay(camera.bounds(), now);
  }

  private analyse(now: number): void {
    const { state, particles } = this.app.core;
    this.app.analysis.instruments.frame({
      now,
      particles,
      process: this.app.core.processNow(),
      sigma: state.sigma,
      kernelVariance: state.kernelVariance,
      recording: this.app.recording.recorder.recording,
    });
    this.app.recording.frame(now);
  }

  private draw(now: number): void {
    const { app } = this;
    const { state, particles, potential, sde, camera } = app.core;
    const { graphics, viewSwitch, input, analysis } = app;

    // The 2D view is not drawn while the 3D view covers it completely. It is drawn by the GPU,
    // or by the CPU (no WebGL2, GPU switched off, or the GPU context not back yet).
    const onGpu = graphics.showActiveCanvas();
    if (viewSwitch.show2D) {
      graphics.renderer2D(onGpu).render(camera, potential.display, particles, {
        grid: state.grid,
        trails: state.trails,
        contours: state.contours,
        forceField: state.forceField,
        arrows: sde.extraDrift
          ? app.arrows
          : potential.analytic
            ? { ...potential.formulaDrift, revision: potential.revision, epoch: potential.epoch }
            : undefined,
        formula: potential.analytic && graphics.formulaOnGpu && onGpu ? { t: particles.time, sigma: state.sigma } : undefined,
        density: state.showDensity ? analysis.monitor.density : null,
      });
      graphics.overlay.draw(camera, {
        grid: state.grid,
        mode: state.mode,
        cursor: input.cursor,
        brushRadius: state.brushRadius,
        brushSign: input.brushSign,
        nextColor: PALETTE[input.nextColor],
        panning: input.panning,
        selection: input.selection,
        analysisBox: analysis.visibleBox(),
        marker: analysis.ergodicity.marker(),
        region: analysis.firstPassage.targetRegion(camera.bounds(), camera.scale, `${potential.revision}|${potential.epoch}`),
      });
    }

    // While the 3D view is up the mouse moves the 3D camera, never the 2D one, so a change of the
    // 2D camera is a jump (an image or recording opened, a scenario applied, the view reset): the
    // 3D view follows it.
    if (this.cameraMoved(`${camera.x}|${camera.y}|${camera.scale}`)) viewSwitch.refit();
    const glsl = potential.compiled?.glsl;
    viewSwitch.frame(
      now,
      state.grid,
      state.contours,
      graphics.formulaOnGpu && glsl ? { glsl, t: particles.time, sigma: state.sigma, heights: potential } : null,
    );
  }

  /** The toolbar's state and the readout of the point under the mouse. */
  private updateReadout(): void {
    const { state, particles, potential } = this.app.core;
    const { controls, input, viewSwitch } = this.app;
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
  }
}
