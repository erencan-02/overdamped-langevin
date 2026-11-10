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
/**
 * Chunk coordinates are limited to ±CHUNK_LIMIT (≈ ±84 000 world units at h = 0.04) so that
 * chunk keys stay small integers (V8 "Smi"s), which keeps Map lookups fast.
 */
export const CHUNK_LIMIT = (1 << 14) - 1;
const KEY_OFFSET = 1 << 14;

export interface FieldOptions {
  /** Lattice spacing h in world units. */
  cellSize: number;
  /** |Ψ| is clamped to this value. */
  cap: number;
  /** Keep ∇Ψ up to date (default). A lattice that is only drawn can skip it. */
  gradients?: boolean;
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

/** Ψ of one chunk at some moment; `psi` null means Ψ = 0 there (e.g. not allocated yet). */
export interface ChunkState {
  cx: number;
  cy: number;
  psi: Float32Array | null;
}

/**
 * A change of Ψ: the chunks it touched, as they were before and after. Applying `before`
 * undoes it, applying `after` redoes it (see PotentialField.applyChunks).
 */
export interface PotentialEdit {
  before: ChunkState[];
  after: ChunkState[];
  /** Memory held by the copies, in bytes. */
  bytes: number;
}

/** Integer key of chunk (cx, cy), or −1 if it lies outside the supported range. */
export function chunkKey(cx: number, cy: number): number {
  if (cx < -CHUNK_LIMIT || cx > CHUNK_LIMIT || cy < -CHUNK_LIMIT || cy > CHUNK_LIMIT) return -1;
  return ((cx + KEY_OFFSET) << 15) | (cy + KEY_OFFSET);
}

export class PotentialField {
  readonly h: number;
  readonly invH: number;
  readonly cap: number;
  private readonly keepGradients: boolean;
  readonly chunks = new Map<number, Chunk>();
  /**
   * Keys of chunks whose rendered texture is stale. A chunk's texture also contains the first
   * row/column of its +x/+y neighbours (for seamless interpolation), so a change in one chunk
   * marks its −x/−y neighbours as dirty as well.
   */
  readonly dirty = new Set<number>();
  /** Bumped by `clear()` so consumers can drop everything they cached. */
  epoch = 0;
  /** Bumped on every change of Ψ (painting, presets, clearing). */
  revision = 0;
  /** Scratch rows for writeGrid (reused between video frames). */
  /**
   * While an edit is being recorded (beginEdit … endEdit): every chunk as it was before its
   * first change in this edit.
   */
  private editBefore: Map<number, ChunkState> | null = null;
  private rowScratch = new Float32Array(0);
  private colIdx = new Int32Array(0);
  private colW = new Float32Array(0);

  /**
   * Dense lookup table over the bounding box of all allocated chunks. Chunk lookups are on the
   * hot path of the integrator (two drift evaluations per particle and step), and a plain array
   * index is several times faster than a Map lookup.
   */
  private index: (Chunk | null)[] = [];
  private indexX0 = 0;
  private indexY0 = 0;
  private indexW = 0;
  private indexH = 0;

  constructor(opts: FieldOptions) {
    this.h = opts.cellSize;
    this.invH = 1 / opts.cellSize;
    this.cap = opts.cap;
    this.keepGradients = opts.gradients ?? true;
  }

  // ---------------------------------------------------------------- chunk access

  getChunk(cx: number, cy: number): Chunk | null {
    const gx = cx - this.indexX0;
    const gy = cy - this.indexY0;
    if (gx < 0 || gy < 0 || gx >= this.indexW || gy >= this.indexH) return null;
    return this.index[gy * this.indexW + gx];
  }

  private ensureChunk(cx: number, cy: number): Chunk {
    let c = this.getChunk(cx, cy);
    if (!c) {
      const key = chunkKey(cx, cy);
      c = new Chunk(cx, cy, key);
      this.chunks.set(key, c);
      const gx = cx - this.indexX0;
      const gy = cy - this.indexY0;
      if (gx < 0 || gy < 0 || gx >= this.indexW || gy >= this.indexH) {
        this.rebuildIndex(cx, cy);
      } else {
        this.index[gy * this.indexW + gx] = c;
      }
    }
    return c;
  }

  /** Grows the lookup table so that it covers all chunks plus (cx, cy), with some slack. */
  private rebuildIndex(cx: number, cy: number): void {
    const PAD = 4;
    let x0 = cx;
    let x1 = cx;
    let y0 = cy;
    let y1 = cy;
    if (this.indexW > 0) {
      x0 = Math.min(x0, this.indexX0);
      y0 = Math.min(y0, this.indexY0);
      x1 = Math.max(x1, this.indexX0 + this.indexW - 1);
      y1 = Math.max(y1, this.indexY0 + this.indexH - 1);
    }
    x0 -= PAD;
    y0 -= PAD;
    x1 += PAD;
    y1 += PAD;
    const w = x1 - x0 + 1;
    const hgt = y1 - y0 + 1;
    const index = new Array<Chunk | null>(w * hgt).fill(null);
    for (const c of this.chunks.values()) index[(c.cy - y0) * w + (c.cx - x0)] = c;
    this.index = index;
    this.indexX0 = x0;
    this.indexY0 = y0;
    this.indexW = w;
    this.indexH = hgt;
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
    if (this.editBefore) for (const c of this.chunks.values()) this.noteBeforeChange(c.cx, c.cy);
    this.chunks.clear();
    this.dirty.clear();
    this.index = [];
    this.indexW = 0;
    this.indexH = 0;
    this.epoch++;
    this.revision++;
  }

  // ---------------------------------------------------------------- undo support

  /** Starts recording the chunks that change, for undo (see endEdit). */
  beginEdit(): void {
    this.editBefore ??= new Map();
  }

  /**
   * Stops recording and returns the chunks that actually changed since beginEdit, before and
   * after, or null if Ψ did not change.
   */
  endEdit(): PotentialEdit | null {
    const before = this.editBefore;
    this.editBefore = null;
    if (!before) return null;
    const edit: PotentialEdit = { before: [], after: [], bytes: 0 };
    for (const [key, b] of before) {
      const now = this.chunks.get(key);
      const a: ChunkState = { cx: b.cx, cy: b.cy, psi: now ? now.psi.slice() : null };
      if (samePsi(a.psi, b.psi)) continue; // allocated or prepared, but not changed
      edit.before.push(b);
      edit.after.push(a);
      edit.bytes += (b.psi?.byteLength ?? 0) + (a.psi?.byteLength ?? 0);
    }
    return edit.before.length ? edit : null;
  }

  /**
   * Sets Ψ in the given chunks (a `before` or `after` list of an edit) and updates the
   * gradient around them. Other chunks are not touched.
   */
  applyChunks(states: readonly ChunkState[]): void {
    for (const st of states) {
      const c = this.ensureChunk(st.cx, st.cy);
      if (st.psi) c.psi.set(st.psi);
      else c.psi.fill(0);
    }
    for (const st of states) {
      const i0 = st.cx << CHUNK_SHIFT;
      const j0 = st.cy << CHUNK_SHIFT;
      this.finishRegion(i0, j0, i0 + CHUNK_MASK, j0 + CHUNK_MASK);
    }
  }

  /** Records chunk (cx, cy) as it is now, if an edit is open and it was not recorded yet. */
  private noteBeforeChange(cx: number, cy: number): void {
    const edits = this.editBefore;
    if (!edits) return;
    const key = chunkKey(cx, cy);
    if (key < 0 || edits.has(key)) return;
    const c = this.getChunk(cx, cy);
    edits.set(key, { cx, cy, psi: c ? c.psi.slice() : null });
  }

  // ---------------------------------------------------------------- node access

  /** Ψ at lattice node (i, j). */
  node(i: number, j: number): number {
    const c = this.getChunk(i >> CHUNK_SHIFT, j >> CHUNK_SHIFT);
    return c ? c.psi[((j & CHUNK_MASK) << CHUNK_SHIFT) | (i & CHUNK_MASK)] : 0;
  }

  /**
   * Copies Ψ at the lattice nodes (i0 + c·stride, j0 + r·stride), c < nx, r < ny, into `out`
   * (row-major, row 0 at j0). Nodes in unallocated chunks are 0. Looks up each chunk once per
   * row, so copying a whole view is about as fast as copying the memory (used to upload Ψ to the
   * GPU for the 3D view).
   */
  copyNodes(i0: number, j0: number, nx: number, ny: number, stride: number, out: Float32Array): void {
    for (let r = 0; r < ny; r++) {
      const j = j0 + r * stride;
      const cy = j >> CHUNK_SHIFT;
      const row = (j & CHUNK_MASK) << CHUNK_SHIFT;
      const o = r * nx;
      let cx = Number.NaN;
      let psi: Float32Array | null = null;
      for (let c = 0; c < nx; c++) {
        const i = i0 + c * stride;
        const ci = i >> CHUNK_SHIFT;
        if (ci !== cx) {
          cx = ci;
          psi = this.getChunk(ci, cy)?.psi ?? null;
        }
        out[o + c] = psi ? psi[row | (i & CHUNK_MASK)] : 0;
      }
    }
  }

  // ---------------------------------------------------------------- sampling

  /**
   * ∫ |∇Ψ|² over the world rectangle, as a sum over the lattice nodes inside it (each node
   * stands for a cell of area h²). The nodal gradients are stored, so this only adds up the
   * chunks' arrays; unallocated chunks contribute nothing.
   */
  gradientSquaredIntegral(x0: number, y0: number, x1: number, y1: number): number {
    const i0 = Math.ceil(x0 * this.invH);
    const i1 = Math.ceil(x1 * this.invH) - 1; // nodes with x0 ≤ i·h < x1
    const j0 = Math.ceil(y0 * this.invH);
    const j1 = Math.ceil(y1 * this.invH) - 1;
    if (i1 < i0 || j1 < j0) return 0;
    let sum = 0;
    for (let cy = j0 >> CHUNK_SHIFT; cy <= j1 >> CHUNK_SHIFT; cy++) {
      for (let cx = i0 >> CHUNK_SHIFT; cx <= i1 >> CHUNK_SHIFT; cx++) {
        const c = this.getChunk(cx, cy);
        if (!c) continue;
        const { gx, gy } = c;
        const baseI = cx << CHUNK_SHIFT;
        const baseJ = cy << CHUNK_SHIFT;
        const la = Math.max(i0 - baseI, 0);
        const lb = Math.min(i1 - baseI, CHUNK_MASK);
        const ma = Math.max(j0 - baseJ, 0);
        const mb = Math.min(j1 - baseJ, CHUNK_MASK);
        let part = 0; // per chunk, so small terms are not lost against a large total
        for (let m = ma; m <= mb; m++) {
          const row = m << CHUNK_SHIFT;
          for (let l = la; l <= lb; l++) {
            const a = gx[row | l];
            const b = gy[row | l];
            part += a * a + b * b;
          }
        }
        sum += part;
      }
    }
    return sum * this.h * this.h;
  }

  /** Ψ at n points into `out` (bilinear, as `sample`). */
  samplePoints(xs: Float64Array, ys: Float64Array, n: number, out: Float64Array): void {
    for (let i = 0; i < n; i++) out[i] = this.sample(xs[i], ys[i]);
  }

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
   * Overwrites Ψ with f(x, y) at every node inside a rectangle (clamped to the cap). Used to
   * write image and camera potentials, which replace rather than add to what is there.
   */
  setFunction(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    f: (x: number, y: number) => number,
  ): void {
    this.modifyRegion(x0, y0, x1, y1, (wx, wy) => f(wx, wy));
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
    if (i1 < i0 || j1 < j0 || !this.prepareRegion(i0, j0, i1, j1)) return;

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
    this.finishRegion(i0, j0, i1, j1);
  }

  /**
   * Overwrites Ψ at every lattice node covered by a grid of samples with the bilinear
   * interpolation of the grid (clamped to the cap). `values` has W × H samples, row 0 at world
   * y = `top`, column 0 at world x = `left`, neighbouring samples `cell` apart; rows run towards
   * −y. Nodes outside the grid's rectangle are not touched.
   *
   * This is the fast path for images and video frames: interpolation indices and weights are
   * computed once per lattice column and row, and the inner loop has no function calls.
   */
  writeGrid(values: Float32Array, W: number, H: number, left: number, top: number, cell: number): void {
    if (W < 2 || H < 2 || !(cell > 0)) return;
    const h = this.h;
    const cap = this.cap;
    const inv = 1 / cell;
    const i0 = Math.ceil(left * this.invH);
    const i1 = Math.floor((left + (W - 1) * cell) * this.invH);
    const j0 = Math.ceil((top - (H - 1) * cell) * this.invH);
    const j1 = Math.floor(top * this.invH);
    if (i1 < i0 || j1 < j0 || !this.prepareRegion(i0, j0, i1, j1)) return;

    // Bilinear interpolation is separable: first interpolate every grid row at the lattice
    // columns (H × nI values), then blend two of those rows per lattice row. The hot loop is a
    // single multiply-add over contiguous memory.
    const nI = i1 - i0 + 1;
    if (this.rowScratch.length < H * nI) this.rowScratch = new Float32Array(H * nI);
    const rows = this.rowScratch;
    if (this.colIdx.length < nI) {
      this.colIdx = new Int32Array(nI);
      this.colW = new Float32Array(nI);
    }
    const colIdx = this.colIdx;
    const colW = this.colW;
    for (let a = 0; a < nI; a++) {
      const u = ((i0 + a) * h - left) * inv;
      const i = Math.min(W - 2, Math.max(0, Math.floor(u)));
      colIdx[a] = i;
      colW[a] = Math.min(1, Math.max(0, u - i));
    }
    for (let j = 0; j < H; j++) {
      const src = j * W;
      const dst = j * nI;
      for (let a = 0; a < nI; a++) {
        const k = src + colIdx[a];
        const v0 = values[k];
        rows[dst + a] = v0 + (values[k + 1] - v0) * colW[a];
      }
    }

    for (let cy = j0 >> CHUNK_SHIFT; cy <= j1 >> CHUNK_SHIFT; cy++) {
      const baseJ = cy << CHUNK_SHIFT;
      const ma = Math.max(j0 - baseJ, 0);
      const mb = Math.min(j1 - baseJ, CHUNK_MASK);
      for (let cx = i0 >> CHUNK_SHIFT; cx <= i1 >> CHUNK_SHIFT; cx++) {
        const psi = this.ensureChunk(cx, cy).psi;
        const baseI = cx << CHUNK_SHIFT;
        const la = Math.max(i0 - baseI, 0);
        const lb = Math.min(i1 - baseI, CHUNK_MASK);
        const aOff = baseI - i0;
        for (let m = ma; m <= mb; m++) {
          const v = (top - (baseJ + m) * h) * inv;
          const j = Math.min(H - 2, Math.max(0, Math.floor(v)));
          const fy = Math.min(1, Math.max(0, v - j));
          const r0 = j * nI + aOff;
          const r1 = r0 + nI;
          const row = m << CHUNK_SHIFT;
          for (let l = la; l <= lb; l++) {
            const t = rows[r0 + l];
            let val = t + (rows[r1 + l] - t) * fy;
            if (val > cap) val = cap;
            else if (val < -cap) val = -cap;
            psi[row | l] = val;
          }
        }
      }
    }
    this.finishRegion(i0, j0, i1, j1);
  }

  /**
   * Allocates the chunks needed to change nodes [i0, i1] × [j0, j1] (plus one node of margin,
   * whose gradient changes too). Returns false if the region is outside the supported plane.
   */
  private prepareRegion(i0: number, j0: number, i1: number, j1: number): boolean {
    const ci0 = (i0 - 1) >> CHUNK_SHIFT;
    const ci1 = (i1 + 1) >> CHUNK_SHIFT;
    const cj0 = (j0 - 1) >> CHUNK_SHIFT;
    const cj1 = (j1 + 1) >> CHUNK_SHIFT;
    if (chunkKey(ci0, cj0) < 0 || chunkKey(ci1, cj1) < 0) return false;
    for (let cy = cj0; cy <= cj1; cy++) {
      for (let cx = ci0; cx <= ci1; cx++) {
        this.noteBeforeChange(cx, cy); // only while an edit is recorded
        this.ensureChunk(cx, cy);
      }
    }
    return true;
  }

  /** Updates the gradient around changed nodes and marks the affected textures dirty. */
  private finishRegion(i0: number, j0: number, i1: number, j1: number): void {
    if (this.keepGradients) this.updateGradient(i0 - 1, j0 - 1, i1 + 1, j1 + 1);
    this.revision++;
    for (let cy = (j0 - 1) >> CHUNK_SHIFT; cy <= (j1 + 1) >> CHUNK_SHIFT; cy++) {
      for (let cx = (i0 - 1) >> CHUNK_SHIFT; cx <= (i1 + 1) >> CHUNK_SHIFT; cx++) {
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

/** Whether two chunk states hold the same Ψ (null counts as all zeros). */
function samePsi(a: Float32Array | null, b: Float32Array | null): boolean {
  if (a === b) return true;
  const n = CHUNK * CHUNK;
  for (let k = 0; k < n; k++) if ((a ? a[k] : 0) !== (b ? b[k] : 0)) return false;
  return true;
}
