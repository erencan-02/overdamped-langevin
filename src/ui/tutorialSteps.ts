import type { TutorialStep } from './tutorial';

/**
 * The steps of the app's tutorial, in order. To add one, add an entry: the element to
 * highlight, a title and a text, and (if the element may be hidden or folded) a `prepare` that
 * shows it and returns how to undo that.
 */
export function appTutorialSteps(hooks: {
  /** Unfolds the side windows on the left; returns how to restore their previous state. */
  showTools(): () => void;
  /** Shows the Recordings window even if there is no recording yet; returns how to undo it. */
  showRecordings(): () => void;
}): TutorialStep[] {
  const byId = (id: string) => () => document.getElementById(id);
  return [
    {
      target: () => document.querySelector<HTMLElement>('.toolbar'),
      title: 'Controls',
      text:
        'Brush paints the potential Ψ (left button raises, right button lowers), Particles drops particles ' +
        '(Shift-drag sprays, right-drag fills a rectangle). Switch between the 2D and 3D view, and play or ' +
        'pause the simulation (Space, → for one step). The toggles show the grid, trails, contour lines and ' +
        'the force field, start a recording and the live camera. The layers menu has presets, images, ' +
        'undo and sharing. GPU switches the graphics card on or off, ? opens the help.',
    },
    {
      target: byId('left-col'),
      prepare: () => hooks.showTools(),
      title: 'Tools & analysis',
      text:
        'The process and the measurements. Potential Ψ (painted, or a formula), Drift & noise (a general ' +
        'SDE), Birth / death, and the instruments: observables E[f(X_t)], ergodicity, first-passage times, ' +
        'a Δt sweep of the convergence orders and KL to equilibrium. Settings holds σ, speed, scheme and ' +
        'seed. Each window only computes while it is open; the header folds them all away.',
    },
    {
      target: byId('scenario'),
      title: 'Scenarios',
      text:
        'Ready-made set-ups for an SDE course, each with a short text and questions; answers are kept in ' +
        'this browser and can be downloaded. Create & share turns the current set-up into a link, a file ' +
        'or a GitHub Gist that opens exactly this scenario for someone else.',
    },
    {
      target: byId('recordings'),
      prepare: () => hooks.showRecordings(),
      title: 'Recordings',
      text:
        'Appears once you record a run (the record button, or Shift+R). Each run can be downloaded as an ' +
        '.npz file for NumPy (positions with particle ids, Ψ, settings and the analysis curves) and played ' +
        'back by dropping it on the page. A recording stops by itself at its size limit.',
    },
    {
      target: () => document.querySelector<HTMLElement>('.legend'),
      title: 'Colour scale and readout',
      text:
        'The colours of Ψ: warm hills push particles away, cool valleys attract them. Below: the position ' +
        'and Ψ under the mouse, the simulated time t, the number of particles N and the noise level σ.',
    },
  ];
}
