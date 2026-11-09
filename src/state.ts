import { DEFAULTS } from './config';

export type Mode = 'brush' | 'particles';

/** User-controlled application state. */
export interface AppState {
  mode: Mode;
  playing: boolean;
  grid: boolean;
  trails: boolean;
  contours: boolean;
  /** Diffusivity σ of the Brownian term. */
  sigma: number;
  /** Simulated time per real second. */
  speed: number;
  /** Standard deviation of the Gaussian brush (world units). */
  brushRadius: number;
  /** Rate at which the brush changes Ψ at its centre (Ψ units per second). */
  brushStrength: number;
}

export function initialState(): AppState {
  return {
    mode: 'brush',
    playing: false,
    grid: true,
    trails: true,
    contours: true,
    sigma: DEFAULTS.sigma,
    speed: DEFAULTS.speed,
    brushRadius: DEFAULTS.brushRadius,
    brushStrength: DEFAULTS.brushStrength,
  };
}
