import { DEFAULTS } from './config';
import { DEFAULT_SCHEME, type SchemeId } from './sim/schemes';

export type Mode = 'brush' | 'particles';
/** 2D or 3D view. */
export type ViewKind = '2d' | '3d';
/** Ψ painted on a lattice (brush, images, camera), or given by a formula Ψ(t, x, y). */
export type PotentialMode = 'painted' | 'formula';

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
  /** Seed of all random number streams (non-negative integer). */
  seed: number;
  /** Standard deviation of the Gaussian brush (world units). */
  brushRadius: number;
  /** Rate at which the brush changes Ψ at its centre (Ψ units per second). */
  brushStrength: number;
  /** Distance between particles spawned on a grid with a right-drag (world units). */
  particleSpacing: number;
  /** Variance h² of the Gaussian kernel that smooths the empirical measure (world units²). */
  kernelVariance: number;
  /** Draw the smoothed empirical measure on the scene. */
  showDensity: boolean;
  /** 2D or 3D view (a viewing choice: not saved in recordings). */
  view: ViewKind;
  /** Where Ψ comes from. */
  potentialMode: PotentialMode;
  /** The formula Ψ(t, x, y) in LaTeX (used in 'formula' mode; always a valid expression). */
  potentialTex: string;
  /** Test function f(x, y) of the observables window, in LaTeX (always a valid expression). */
  observable: string;
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
    seed: 0,
    brushRadius: DEFAULTS.brushRadius,
    brushStrength: DEFAULTS.brushStrength,
    particleSpacing: DEFAULTS.particleSpacing,
    kernelVariance: DEFAULTS.kernelVariance,
    showDensity: false,
    view: '2d',
    potentialMode: 'painted',
    potentialTex: DEFAULTS.potential,
    observable: DEFAULTS.observable,
  };
}
