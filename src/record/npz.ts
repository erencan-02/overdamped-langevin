import { zip, type Zippable } from 'fflate';

/**
 * Minimal writer for NumPy's .npy / .npz formats (format version 1.0), so recordings open
 * directly with `numpy.load`. An .npz file is a zip archive of .npy members. Text (e.g. JSON
 * metadata) is stored as a 0-d NumPy unicode array, because NumPy 2.x cannot read non-.npy
 * members of an .npz.
 */

/** NumPy dtypes used here; `<U{n}` is a unicode string of n characters (UTF-32). */
export type DType = '<f4' | '<f8' | '<i4' | '<u4' | '|u1' | `<U${number}`;

export interface NpyArray {
  dtype: DType;
  shape: number[];
  data: Float32Array | Float64Array | Int32Array | Uint32Array | Uint8Array;
}

const MAGIC = [0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59]; // "\x93NUMPY"

export function npyArray(arr: NpyArray): Uint8Array {
  const chars = arr.dtype.startsWith('<U') ? Number(arr.dtype.slice(2)) : 1;
  const count = arr.shape.reduce((a, b) => a * b, 1) * chars;
  if (count !== arr.data.length) {
    throw new Error(`Shape ${arr.shape.join('x')} does not match ${arr.data.length} elements`);
  }
  const shape =
    arr.shape.length === 0 ? '()' : arr.shape.length === 1 ? `(${arr.shape[0]},)` : `(${arr.shape.join(', ')})`;
  let header = `{'descr': '${arr.dtype}', 'fortran_order': False, 'shape': ${shape}, }`;
  // Pad with spaces so that magic (6) + version (2) + length (2) + header ends on a multiple of 64,
  // terminated by a newline, as the format specification requires.
  const total = Math.ceil((10 + header.length + 1) / 64) * 64;
  header = header.padEnd(total - 10 - 1, ' ') + '\n';
  const headerBytes = new TextEncoder().encode(header);
  const body = new Uint8Array(arr.data.buffer, arr.data.byteOffset, arr.data.byteLength);
  const out = new Uint8Array(10 + headerBytes.length + body.length);
  out.set(MAGIC, 0);
  out[6] = 1; // major version
  out[7] = 0; // minor version
  out[8] = headerBytes.length & 0xff;
  out[9] = headerBytes.length >> 8;
  out.set(headerBytes, 10);
  out.set(body, 10 + headerBytes.length);
  return out;
}

/** A 0-d unicode array holding `text` (read back in Python with `str(arr)`). */
export function npyString(text: string): NpyArray {
  const codes = Uint32Array.from(Array.from(text), (ch) => ch.codePointAt(0) ?? 0);
  return { dtype: `<U${codes.length}`, shape: [], data: codes };
}

/** Builds an .npz archive (deflate-compressed, compressed in parallel by fflate's workers). */
export function npzArchive(
  arrays: Record<string, NpyArray>,
  level: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 = 6,
): Promise<Uint8Array> {
  const files: Zippable = {};
  for (const [name, arr] of Object.entries(arrays)) files[`${name}.npy`] = [npyArray(arr), { level }];
  return new Promise((resolve, reject) => {
    zip(files, { level }, (err, data) => (err ? reject(err) : resolve(data)));
  });
}
