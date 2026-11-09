import { DEFAULTS } from './config';
import { DEFAULT_SCHEME, type SchemeId } from './sim/schemes';

export type Mode = 'brush' | 'particles';

/** User-controlled application state. */
export interface AppState {
  mode: Mode;
  playing: boolean;
  grid: boolean;
  trails: boolean;
  contours: boolean;
  /** Show the force field −∇Ψ as arrows. */
  forceField: boolean;
  /** Diffusivity σ of the Brownian term. */
  sigma: number;
  /** Simulated time per real second. */
  speed: number;
  /** Numerical scheme used to integrate the SDE. */
  scheme: SchemeId;
  /** Standard deviation of the Gaussian brush (world units). */
  brushRadius: number;
  /** Rate at which the brush changes Ψ at its centre (Ψ units per second). */
  brushStrength: number;
  /** Distance between particles spawned on a grid with a right-drag (world units). */
  particleSpacing: number;
  /** Variance h² of the Gaussian kernel that smooths the empirical measure (world units²). */
  kernelVariance: number;
}

export function initialState(): AppState {
  return {
    mode: 'brush',
    playing: false,
    grid: true,
    trails: true,
    contours: true,
    forceField: false,
    sigma: DEFAULTS.sigma,
    speed: DEFAULTS.speed,
    scheme: DEFAULT_SCHEME,
    brushRadius: DEFAULTS.brushRadius,
    brushStrength: DEFAULTS.brushStrength,
    particleSpacing: DEFAULTS.particleSpacing,
    kernelVariance: DEFAULTS.kernelVariance,
  };
}
