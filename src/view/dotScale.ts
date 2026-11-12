import { CPU_PARTICLES } from '../sim/particles';

/**
 * Size of the particle dots relative to their normal size: 1 up to CPU_PARTICLES particles, then
 * shrinking like 1/√n (so the ink per area stays about the same) down to 0.3. Shared by the 2D
 * renderers and the 3D view.
 */
export function dotScale(n: number): number {
  return n <= CPU_PARTICLES ? 1 : Math.max(0.3, Math.sqrt(CPU_PARTICLES / n));
}
