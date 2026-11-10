import { unzip } from 'fflate';

/**
 * Reader for NumPy .npy / .npz files (format versions 1–3), the counterpart of npz.ts. Supports
 * the numeric dtypes a recording uses, in either byte order, plus 64-bit integers (converted to
 * Float64Array, as written e.g. by `np.savez` for int64 offsets), booleans and unicode strings.
 */

export type NumericArray =
  | Float32Array
  | Float64Array
  | Int8Array
  | Uint8Array
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array;

export interface NpyValue {
  /** NumPy dtype descriptor as written in the header, e.g. "<f4". */
  dtype: string;
  shape: number[];
  /** Numeric data (C order), or null for string arrays. */
  data: NumericArray | null;
  /** For unicode arrays: the strings (C order). */
  strings: string[] | null;
}

const MAGIC = [0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59];

export function parseNpy(bytes: Uint8Array): NpyValue {
  for (let i = 0; i < 6; i++) if (bytes[i] !== MAGIC[i]) throw new Error('Not a .npy array');
  const major = bytes[6];
  let headerLen: number;
  let offset: number;
  if (major === 1) {
    headerLen = bytes[8] | (bytes[9] << 8);
    offset = 10;
  } else if (major === 2 || major === 3) {
    headerLen = (bytes[8] | (bytes[9] << 8) | (bytes[10] << 16) | (bytes[11] << 24)) >>> 0;
    offset = 12;
  } else {
    throw new Error(`Unsupported .npy version ${major}`);
  }
  const header = new TextDecoder(major === 3 ? 'utf-8' : 'latin1').decode(bytes.subarray(offset, offset + headerLen));
  const descr = /'descr'\s*:\s*'([^']+)'/.exec(header)?.[1];
  const fortran = /'fortran_order'\s*:\s*(True|False)/.exec(header)?.[1];
  const shapeText = /'shape'\s*:\s*\(([^)]*)\)/.exec(header)?.[1];
  if (!descr || !fortran || shapeText === undefined) throw new Error('Malformed .npy header');
  const shape = shapeText
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v !== '')
    .map((v) => Number(v.replace(/L$/, '')));
  if (shape.some((v) => !Number.isInteger(v) || v < 0)) throw new Error('Malformed .npy shape');
  if (fortran === 'True' && shape.filter((d) => d > 1).length > 1) {
    throw new Error('Fortran-ordered arrays are not supported (save with C order)');
  }
  const count = shape.reduce((a, b) => a * b, 1);
  const body = bytes.slice(offset + headerLen); // copy: aligned, independent buffer

  const order = descr[0];
  const kind = descr[1];
  const size = Number(descr.slice(2));
  const bigEndian = order === '>';
  if (bigEndian && size > 1) swapBytes(body, kind === 'U' ? 4 : size);

  if (kind === 'U') {
    const codes = new Uint32Array(body.buffer, 0, count * size);
    const strings: string[] = [];
    for (let k = 0; k < count; k++) {
      let s = '';
      for (let c = 0; c < size; c++) {
        const code = codes[k * size + c];
        if (code === 0) break;
        s += String.fromCodePoint(code);
      }
      strings.push(s);
    }
    return { dtype: descr, shape, data: null, strings };
  }

  const buf = body.buffer;
  let data: NumericArray;
  switch (`${kind}${size}`) {
    case 'f4':
      data = new Float32Array(buf, 0, count);
      break;
    case 'f8':
      data = new Float64Array(buf, 0, count);
      break;
    case 'i1':
      data = new Int8Array(buf, 0, count);
      break;
    case 'u1':
    case 'b1':
      data = new Uint8Array(buf, 0, count);
      break;
    case 'i2':
      data = new Int16Array(buf, 0, count);
      break;
    case 'u2':
      data = new Uint16Array(buf, 0, count);
      break;
    case 'i4':
      data = new Int32Array(buf, 0, count);
      break;
    case 'u4':
      data = new Uint32Array(buf, 0, count);
      break;
    case 'i8':
    case 'u8': {
      const src = kind === 'i' ? new BigInt64Array(buf, 0, count) : new BigUint64Array(buf, 0, count);
      data = Float64Array.from(src, (v) => Number(v));
      break;
    }
    default:
      throw new Error(`Unsupported dtype ${descr}`);
  }
  return { dtype: descr, shape, data, strings: null };
}

function swapBytes(b: Uint8Array, size: number): void {
  for (let i = 0; i + size <= b.length; i += size) {
    for (let lo = i, hi = i + size - 1; lo < hi; lo++, hi--) {
      const t = b[lo];
      b[lo] = b[hi];
      b[hi] = t;
    }
  }
}

/** Reads an .npz archive into a map name → array (".npy" stripped from the names). */
export function readNpz(bytes: Uint8Array): Promise<Map<string, NpyValue>> {
  return new Promise((resolve, reject) => {
    unzip(bytes, (err, files) => {
      if (err) {
        reject(new Error('This file is not a valid .npz archive.'));
        return;
      }
      try {
        const out = new Map<string, NpyValue>();
        for (const [name, data] of Object.entries(files)) {
          if (!name.endsWith('.npy')) continue;
          out.set(name.slice(0, -4), parseNpy(data));
        }
        resolve(out);
      } catch (e) {
        reject(e);
      }
    });
  });
}
