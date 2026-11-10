import { Rng } from './rng';

/**
 * All randomness in the app comes from named streams derived from one seed. Each stream is an
 * independent xoshiro128** generator, so e.g. dropping an extra particle (which draws a colour)
 * does not change the Brownian noise. With the same seed and the same actions every run is
 * identical.
 */
export type StreamName = 'dynamics' | 'colors' | 'spawn' | 'images' | 'presets';

const STREAMS: StreamName[] = ['dynamics', 'colors', 'spawn', 'images', 'presets'];

/** FNV-1a hash of a stream name, combined with the seed, so every stream starts elsewhere. */
function derive(seed: number, name: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h ^ Math.imul(seed | 0, 0x9e3779b1)) >>> 0;
}

export class RandomStreams {
  private seedValue = 0;
  private readonly streams = new Map<StreamName, Rng>();

  constructor(seed = 0) {
    for (const name of STREAMS) this.streams.set(name, new Rng(derive(seed, name)));
    this.seedValue = seed;
  }

  get seed(): number {
    return this.seedValue;
  }

  /** The generator of a stream. The object stays the same when reseeding. */
  get(name: StreamName): Rng {
    return this.streams.get(name)!;
  }

  /** Restarts every stream from `seed`. */
  reseed(seed: number): void {
    this.seedValue = seed;
    for (const [name, rng] of this.streams) rng.reseed(derive(seed, name));
  }

  /** Uniform float in [0, 1) from a stream (bound function, handy as a callback). */
  uniform(name: StreamName): () => number {
    const rng = this.get(name);
    return () => rng.float();
  }
}
