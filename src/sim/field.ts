/**
 * Potential field Ψ on an unbounded 2D plane.
 *
 * Ψ is stored on a regular lattice of nodes x = i·h, y = j·h. The lattice is split into
 * square chunks of CHUNK × CHUNK nodes that are allocated lazily, so the user can paint
 * anywhere on the (practically) infinite plane while memory only grows with the painted area.
 * Nodes inside unallocated chunks have Ψ = 0.
 *
 * Alongside Ψ every chunk stores ∇Ψ at its nodes (second-order central differences). The
 * gradient is kept up to date incrementally whenever Ψ changes, so evaluating the drift of a
 * particle is just a bilinear interpolation of the stored nodal gradient, which gives a
 * continuous, O(h²)-accurate drift field.
 */

export const CHUNK = 128;
const CHUNK_MASK = CHUNK - 1;
const CHUNK_SHIFT = 7; // log2(CHUNK)
const KEY_OFFSET = 2 ** 24; // chunk coords of any int32 node index fit
const KEY_SPAN = 2 ** 25;

export interface FieldOptions {
  /** Lattice spacing h in world units. */
  cellSize: number;
  /** |Ψ| is clamped to this value. */
  cap: number;
}

export class Chunk {
  readonly psi = new Float32Array(CHUNK * CHUNK);
  readonly gx = new Float32Array(CHUNK * CHUNK);
  readonly gy = new Float32Array(CHUNK * CHUNK);
  constructor(
    readonly cx: number,
    readonly cy: number,
    readonly key: number,
  ) {}
}

export function chunkKey(cx: number, cy: number): number {
  return (cx + KEY_OFFSET) * KEY_SPAN + (cy + KEY_OFFSET);
}

export class PotentialField {
  readonly h: number;
  readonly invH: number;
  readonly cap: number;
  readonly chunks = new Map<number, Chunk>();
  /**
   * Keys of chunks whose rendered texture is stale. A chunk's texture also contains the first
   * row/column of its +x/+y neighbours (for seamless interpolation), so a change in one chunk
   * marks its −x/−y neighbours as dirty as well.
   */
  readonly dirty = new Set<number>();
  /** Bumped by `clear()` so consumers can drop everything they cached. */
  epoch = 0;

  private lastKey = -1;
  private lastChunk: Chunk | undefined = undefined;

  constructor(opts: FieldOptions) {
    this.h = opts.cellSize;
    this.invH = 1 / opts.cellSize;
    this.cap = opts.cap;
  }

  // ---------------------------------------------------------------- chunk access

  getChunk(cx: number, cy: number): Chunk | undefined {
    const key = chunkKey(cx, cy);
    if (key === this.lastKey) return this.lastChunk;
    const c = this.chunks.get(key);
    this.lastKey = key;
    this.lastChunk = c;
    return c;
  }

  private ensureChunk(cx: number, cy: number): Chunk {
    let c = this.getChunk(cx, cy);
    if (!c) {
      const key = chunkKey(cx, cy);
      c = new Chunk(cx, cy, key);
      this.chunks.set(key, c);
      this.lastKey = key;
      this.lastChunk = c;
    }
    return c;
  }

  private markDirty(cx: number, cy: number): void {
    for (let dy = -1; dy <= 0; dy++) {
      for (let dx = -1; dx <= 0; dx++) {
        const key = chunkKey(cx + dx, cy + dy);
        if (this.chunks.has(key)) this.dirty.add(key);
      }
    }
  }

  clear(): void {
    this.chunks.clear();
    this.dirty.clear();
    this.lastKey = -1;
    this.lastChunk = undefined;
    this.epoch++;
  }

  // ---------------------------------------------------------------- node access

  /** Ψ at lattice node (i, j). */
  node(i: number, j: number): number {
    const c = this.getChunk(i >> CHUNK_SHIFT, j >> CHUNK_SHIFT);
    return c ? c.psi[((j & CHUNK_MASK) << CHUNK_SHIFT) | (i & CHUNK_MASK)] : 0;
  }

  // ---------------------------------------------------------------- sampling

  /** Bilinearly interpolated Ψ at world position (x, y). */
  sample(x: number, y: number): number {
    const u = x * this.invH;
    const v = y * this.invH;
    const i = Math.floor(u);
    const j = Math.floor(v);
    const fx = u - i;
    const fy = v - j;
    const a = this.node(i, j);
    const b = this.node(i + 1, j);
    const c = this.node(i, j + 1);
    const d = this.node(i + 1, j + 1);
    return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
  }

  /**
   * ∇Ψ at world position (x, y), bilinearly interpolated from the nodal gradients.
   * Writes the result into `out[0], out[1]`.
   */
  gradient(x: number, y: number, out: Float64Array): void {
    const u = x * this.invH;
    const v = y * this.invH;
    const i = Math.floor(u);
    const j = Math.floor(v);
    const fx = u - i;
    const fy = v - j;
    const li = i & CHUNK_MASK;
    const lj = j & CHUNK_MASK;
    let gx00: number, gx10: number, gx01: number, gx11: number;
    let gy00: number, gy10: number, gy01: number, gy11: number;

    if (li !== CHUNK_MASK && lj !== CHUNK_MASK) {
      // Fast path: all four surrounding nodes live in the same chunk.
      const c = this.getChunk(i >> CHUNK_SHIFT, j >> CHUNK_SHIFT);
      if (!c) {
        out[0] = 0;
        out[1] = 0;
        return;
      }
      const k = (lj << CHUNK_SHIFT) | li;
      const gx = c.gx;
      const gy = c.gy;
      gx00 = gx[k];
      gx10 = gx[k + 1];
      gx01 = gx[k + CHUNK];
      gx11 = gx[k + CHUNK + 1];
      gy00 = gy[k];
      gy10 = gy[k + 1];
      gy01 = gy[k + CHUNK];
      gy11 = gy[k + CHUNK + 1];
    } else {
      // Slow path: the cell straddles a chunk boundary.
      const g = this.nodeGrad;
      this.nodeGradient(i, j, g);
      gx00 = g[0];
      gy00 = g[1];
      this.nodeGradient(i + 1, j, g);
      gx10 = g[0];
      gy10 = g[1];
      this.nodeGradient(i, j + 1, g);
      gx01 = g[0];
      gy01 = g[1];
      this.nodeGradient(i + 1, j + 1, g);
      gx11 = g[0];
      gy11 = g[1];
    }

    const w00 = (1 - fx) * (1 - fy);
    const w10 = fx * (1 - fy);
    const w01 = (1 - fx) * fy;
    const w11 = fx * fy;
    out[0] = gx00 * w00 + gx10 * w10 + gx01 * w01 + gx11 * w11;
    out[1] = gy00 * w00 + gy10 * w10 + gy01 * w01 + gy11 * w11;
  }

  private readonly nodeGrad = new Float64Array(2);

  private nodeGradient(i: number, j: number, out: Float64Array): void {
    const c = this.getChunk(i >> CHUNK_SHIFT, j >> CHUNK_SHIFT);
    if (!c) {
      out[0] = 0;
      out[1] = 0;
      return;
    }
    const k = ((j & CHUNK_MASK) << CHUNK_SHIFT) | (i & CHUNK_MASK);
    out[0] = c.gx[k];
    out[1] = c.gy[k];
  }

  // ---------------------------------------------------------------- editing

  /**
   * Adds a Gaussian bump  amount · exp(−r² / (2·radius²))  centred at (x, y) and clamps the
   * result to [−cap, cap]. A negative `amount` lowers the potential.
   */
  applyBrush(x: number, y: number, amount: number, radius: number): void {
    if (amount === 0 || !(radius > 0)) return;
    const reach = 3.5 * radius;
    const inv2s2 = 1 / (2 * radius * radius);
    this.modifyRegion(x - reach, y - reach, x + reach, y + reach, (wx, wy, psi) => {
      const dx = wx - x;
      const dy = wy - y;
      const r2 = dx * dx + dy * dy;
      return r2 > reach * reach ? psi : psi + amount * Math.exp(-r2 * inv2s2);
    });
  }

  /** Adds an arbitrary function f(x, y) over a rectangle (used by presets). */
  addFunction(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    f: (x: number, y: number) => number,
  ): void {
    this.modifyRegion(x0, y0, x1, y1, (wx, wy, psi) => psi + f(wx, wy));
  }

  /**
   * Applies `update` to every node inside the world rectangle, clamps to the cap and then
   * recomputes the nodal gradient where it may have changed.
   */
  private modifyRegion(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    update: (x: number, y: number, psi: number) => number,
  ): void {
    const h = this.h;
    const cap = this.cap;
    const i0 = Math.ceil(x0 * this.invH);
    const i1 = Math.floor(x1 * this.invH);
    const j0 = Math.ceil(y0 * this.invH);
    const j1 = Math.floor(y1 * this.invH);
    if (i1 < i0 || j1 < j0) return;

    // Gradient at nodes adjacent to the region changes too, so allocate one node of margin.
    const ci0 = (i0 - 1) >> CHUNK_SHIFT;
    const ci1 = (i1 + 1) >> CHUNK_SHIFT;
    const cj0 = (j0 - 1) >> CHUNK_SHIFT;
    const cj1 = (j1 + 1) >> CHUNK_SHIFT;
    for (let cy = cj0; cy <= cj1; cy++) {
      for (let cx = ci0; cx <= ci1; cx++) {
        this.ensureChunk(cx, cy);
      }
    }

    for (let cy = j0 >> CHUNK_SHIFT; cy <= j1 >> CHUNK_SHIFT; cy++) {
      for (let cx = i0 >> CHUNK_SHIFT; cx <= i1 >> CHUNK_SHIFT; cx++) {
        const c = this.ensureChunk(cx, cy);
        const psi = c.psi;
        const baseI = cx << CHUNK_SHIFT;
        const baseJ = cy << CHUNK_SHIFT;
        const la = Math.max(i0 - baseI, 0);
        const lb = Math.min(i1 - baseI, CHUNK_MASK);
        const ma = Math.max(j0 - baseJ, 0);
        const mb = Math.min(j1 - baseJ, CHUNK_MASK);
        for (let m = ma; m <= mb; m++) {
          const wy = (baseJ + m) * h;
          const row = m << CHUNK_SHIFT;
          for (let l = la; l <= lb; l++) {
            const k = row | l;
            let v = update((baseI + l) * h, wy, psi[k]);
            if (v > cap) v = cap;
            else if (v < -cap) v = -cap;
            psi[k] = v;
          }
        }
      }
    }

    this.updateGradient(i0 - 1, j0 - 1, i1 + 1, j1 + 1);

    for (let cy = cj0; cy <= cj1; cy++) {
      for (let cx = ci0; cx <= ci1; cx++) {
        this.markDirty(cx, cy);
      }
    }
  }

  /** Recomputes ∇Ψ by central differences at all nodes in [i0, i1] × [j0, j1]. */
  private updateGradient(i0: number, j0: number, i1: number, j1: number): void {
    const s = 0.5 * this.invH;
    for (let cy = j0 >> CHUNK_SHIFT; cy <= j1 >> CHUNK_SHIFT; cy++) {
      for (let cx = i0 >> CHUNK_SHIFT; cx <= i1 >> CHUNK_SHIFT; cx++) {
        const c = this.getChunk(cx, cy);
        if (!c) continue;
        const { psi, gx, gy } = c;
        const baseI = cx << CHUNK_SHIFT;
        const baseJ = cy << CHUNK_SHIFT;
        const la = Math.max(i0 - baseI, 0);
        const lb = Math.min(i1 - baseI, CHUNK_MASK);
        const ma = Math.max(j0 - baseJ, 0);
        const mb = Math.min(j1 - baseJ, CHUNK_MASK);
        for (let m = ma; m <= mb; m++) {
          const interiorRow = m > 0 && m < CHUNK_MASK;
          for (let l = la; l <= lb; l++) {
            const k = (m << CHUNK_SHIFT) | l;
            if (interiorRow && l > 0 && l < CHUNK_MASK) {
              gx[k] = (psi[k + 1] - psi[k - 1]) * s;
              gy[k] = (psi[k + CHUNK] - psi[k - CHUNK]) * s;
            } else {
              const i = baseI + l;
              const j = baseJ + m;
              gx[k] = (this.node(i + 1, j) - this.node(i - 1, j)) * s;
              gy[k] = (this.node(i, j + 1) - this.node(i, j - 1)) * s;
            }
          }
        }
      }
    }
  }
}
