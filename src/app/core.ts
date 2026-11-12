import { CELL_SIZE, PSI_CAP } from '../config';
import { PotentialField } from '../sim/field';
import { UndoHistory } from '../sim/history';
import { ParticleSystem } from '../sim/particles';
import { Potential } from '../sim/potential';
import { type ProcessCapabilities, Sde } from '../sim/process';
import { RandomStreams } from '../sim/random';
import { SCHEMES } from '../sim/schemes';
import { type AppState, initialState } from '../state';
import { Camera } from '../view/camera';

/** The simulation and what it is seen through: no UI. */
export interface Core {
  state: AppState;
  /** The painted lattice of Ψ. */
  field: PotentialField;
  /** One seed drives every random number in the app (see sim/random.ts). */
  random: RandomStreams;
  particles: ParticleSystem;
  /** The 2D camera (also what the 3D view is built around). */
  camera: Camera;
  /** Undo/redo of brush strokes and other changes of Ψ, and of added/removed particles. */
  history: UndoHistory;
  /** Ψ for the simulation, the analysis and the pictures: the painted lattice or a formula. */
  potential: Potential;
  /**
   * The process the particles follow: dX = (−∇Ψ + u) dt + diag(s₁, s₂) dW (the drift & noise
   * window sets u and s; off, it is the Langevin equation).
   */
  sde: Sde;
  /**
   * What the analysis may assume about the process (e.g. that the Gibbs measure is invariant).
   * Updated whenever the drift or the noise changes (formulas.ts).
   */
  capabilities: ProcessCapabilities;
  /** The process at the current Ψ and σ, ready for the integrator. */
  processNow(): Sde;
}

export function createCore(): Core {
  const state = initialState();
  const field = new PotentialField({ cellSize: CELL_SIZE, cap: PSI_CAP });
  const random = new RandomStreams(state.seed);
  const particles = new ParticleSystem(random.get('dynamics'));
  particles.scheme = SCHEMES[state.scheme];
  const potential = new Potential(field);
  const sde = new Sde();
  return {
    state,
    field,
    random,
    particles,
    camera: new Camera(),
    history: new UndoHistory(field, particles),
    potential,
    sde,
    capabilities: sde.capabilities,
    processNow() {
      sde.potential = potential.drift;
      sde.sigma = state.sigma;
      return sde;
    },
  };
}
