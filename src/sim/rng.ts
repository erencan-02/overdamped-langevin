/**
 * xoshiro128** pseudo random number generator (Blackman & Vigna) with a ziggurat sampler for
 * standard normal variates (Marsaglia & Tsang, 2000).
 *
 * The ziggurat needs ~1 random integer and no transcendental function for 98.8 % of all draws,
 * which makes it several times faster than Box–Muller while being exact. Following Doornik
 * (2005) the layer index and the sample value are taken from independent random integers to
 * avoid the correlation defect of the original implementation.
 */

const ZIG_LAYERS = 128;
const ZIG_R = 3.442619855899;
const ZIG_V = 9.91256303526217e-3;
const TWO_POW_31 = 2147483648;
const TWO_POW_M32 = 1 / 4294967296;

const kn = new Float64Array(ZIG_LAYERS);
const wn = new Float64Array(ZIG_LAYERS);
const fn = new Float64Array(ZIG_LAYERS);
(() => {
  let dn = ZIG_R;
  let tn = dn;
  const q = ZIG_V / Math.exp(-0.5 * dn * dn);
  kn[0] = (dn / q) * TWO_POW_31;
  kn[1] = 0;
  wn[0] = q / TWO_POW_31;
  wn[ZIG_LAYERS - 1] = dn / TWO_POW_31;
  fn[0] = 1;
  fn[ZIG_LAYERS - 1] = Math.exp(-0.5 * dn * dn);
  for (let i = ZIG_LAYERS - 2; i >= 1; i--) {
    dn = Math.sqrt(-2 * Math.log(ZIG_V / dn + Math.exp(-0.5 * dn * dn)));
    kn[i + 1] = (dn / tn) * TWO_POW_31;
    tn = dn;
    fn[i] = Math.exp(-0.5 * dn * dn);
    wn[i] = dn / TWO_POW_31;
  }
})();

export class Rng {
  /** 128-bit state, kept as int32 values so V8 stores them unboxed. */
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed = 0) {
    this.a = this.b = this.c = this.d = 0;
    this.reseed(seed);
  }

  /** Restarts the sequence from `seed` (any 32-bit integer). */
  reseed(seed: number): void {
    // splitmix32 to spread the seed over the 128-bit state.
    let s = seed | 0;
    const next = () => {
      s = (s + 0x9e3779b9) | 0;
      let z = s;
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
      return (z ^ (z >>> 16)) | 0;
    };
    this.a = next();
    this.b = next();
    this.c = next();
    this.d = next();
    if ((this.a | this.b | this.c | this.d) === 0) this.a = 1;
  }

  /** The full generator state (4 × 32 bits), e.g. to store it in a recording. */
  getState(): [number, number, number, number] {
    return [this.a >>> 0, this.b >>> 0, this.c >>> 0, this.d >>> 0];
  }

  /** Restores a state returned by getState(): the sequence continues exactly from there. */
  setState(state: ArrayLike<number>): void {
    this.a = state[0] | 0;
    this.b = state[1] | 0;
    this.c = state[2] | 0;
    this.d = state[3] | 0;
    if ((this.a | this.b | this.c | this.d) === 0) this.a = 1;
  }

  /** Uniform random 32-bit integer, returned as a signed int32. */
  i32(): number {
    const b = this.b;
    const r = Math.imul(b, 5);
    const result = Math.imul((r << 7) | (r >>> 25), 9);
    const t = b << 9;
    this.c ^= this.a;
    this.d ^= b;
    this.b ^= this.c;
    this.a ^= this.d;
    this.c ^= t;
    this.d = (this.d << 11) | (this.d >>> 21);
    return result;
  }

  /** Uniform in [0, 1). */
  float(): number {
    return (this.i32() >>> 0) * TWO_POW_M32;
  }

  /** Uniform integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.float() * n);
  }

  /** Standard normal variate N(0, 1). */
  normal(): number {
    for (;;) {
      const hz = this.i32();
      const iz = this.i32() & (ZIG_LAYERS - 1);
      const x = hz * wn[iz];
      // Inside the rectangle of layer iz: accept immediately (the common case).
      if (Math.abs(hz) < kn[iz]) return x;
      if (iz === 0) {
        // Base layer: sample from the tail beyond R.
        let tx: number;
        let ty: number;
        do {
          tx = -Math.log(1 - this.float()) / ZIG_R;
          ty = -Math.log(1 - this.float());
        } while (ty + ty < tx * tx);
        return hz > 0 ? ZIG_R + tx : -ZIG_R - tx;
      }
      // Wedge: accept with probability proportional to the density.
      if (fn[iz] + this.float() * (fn[iz - 1] - fn[iz]) < Math.exp(-0.5 * x * x)) return x;
    }
  }
}
