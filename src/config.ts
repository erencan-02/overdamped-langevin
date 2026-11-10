/** Global constants shared by simulation, rendering and UI. */

/** Lattice spacing of the potential grid (world units). */
export const CELL_SIZE = 0.04;

/** |Ψ| is capped at this value. The colour scale saturates at ±PSI_CAP. */
export const PSI_CAP = 5;

/**
 * Diverging colour map, shared by the heat-map shader and the legend. `stops` are positions in
 * |Ψ| / PSI_CAP; `hot` is used for Ψ > 0 and `cold` for Ψ < 0. Both start at white for Ψ = 0.
 */
export const COLORMAP = {
  stops: [0, 0.12, 0.32, 0.55, 0.78, 1],
  hot: ['#ffffff', '#fff4c2', '#ffd54a', '#ff9330', '#e83f2e', '#8c1028'],
  cold: ['#ffffff', '#dcf5ec', '#6fd3b6', '#3a9bdc', '#4256c9', '#4a1d84'],
} as const;

/** Particle colours (picked at random when a particle is dropped). */
export const PALETTE = [
  '#e11d48', // rose
  '#7c3aed', // violet
  '#2563eb', // blue
  '#0891b2', // cyan
  '#059669', // emerald
  '#65a30d', // lime
  '#d97706', // amber
  '#ea580c', // orange
  '#db2777', // pink
  '#4f46e5', // indigo
  '#0d9488', // teal
  '#9333ea', // purple
] as const;

export function hexToRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

export const PALETTE_RGB: Float32Array = new Float32Array(PALETTE.flatMap((c) => hexToRgb(c)));

/** Defaults for the user-adjustable parameters. */
export const DEFAULTS = {
  sigma: 0.6,
  speed: 1,
  brushRadius: 0.6,
  brushStrength: 6,
  particleSpacing: 0.5,
  kernelVariance: 0.09,
  /** Test function of the observables window (LaTeX). */
  observable: 'x^2 + y^2',
  scale: 64,
} as const;

/** Ranges of the user-adjustable parameters. */
export const RANGES = {
  sigma: [0, 3],
  speed: [0.1, 5],
  brushRadius: [0.15, 3],
  brushStrength: [0.5, 30],
  particleSpacing: [0.1, 3],
  kernelVariance: [0.0025, 4],
  scale: [6, 2500],
} as const;
