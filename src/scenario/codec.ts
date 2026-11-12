import { deflateSync, Inflate, strFromU8, strToU8 } from 'fflate';

/**
 * Scenario links: the JSON is deflated (fflate) and written base64url-encoded into the URL hash,
 * `#s=…`. The hash never reaches a server, so sharing works on a static site. Built-in scenarios
 * are `#scenario=<name>` and Gists `#gist=<id>`.
 */

/** Longest link we offer; longer scenarios are shared as files or Gists. */
export const MAX_LINK_LENGTH = 16_000;
/** Largest decompressed scenario accepted from a link or a file (bytes). */
export const MAX_SCENARIO_BYTES = 4 * 1024 * 1024;

export function encodeScenario(json: unknown): string {
  return toBase64Url(deflateSync(strToU8(JSON.stringify(json)), { level: 9 }));
}

/** The JSON of an encoded scenario; throws if it is malformed or too large. */
export function decodeScenario(encoded: string): unknown {
  if (!/^[A-Za-z0-9_-]*$/.test(encoded)) throw new Error('The link is damaged.');
  if (encoded.length > MAX_SCENARIO_BYTES) throw new Error('The link is too long.');
  const bytes = fromBase64Url(encoded);
  const chunks: Uint8Array[] = [];
  let total = 0;
  const inflate = new Inflate((chunk) => {
    total += chunk.length;
    if (total > MAX_SCENARIO_BYTES) throw new Error('The scenario is too large.');
    chunks.push(chunk);
  });
  try {
    inflate.push(bytes, true);
  } catch (err) {
    throw err instanceof Error && err.message.startsWith('The scenario') ? err : new Error('The link is damaged.');
  }
  const all = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    all.set(c, o);
    o += c.length;
  }
  return parseJson(strFromU8(all));
}

/** JSON.parse with a message for the user. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('The scenario is not valid JSON.');
  }
}

/** What the URL hash asks for, if anything. */
export type HashRequest =
  | { kind: 'link'; data: string }
  | { kind: 'builtin'; name: string }
  | { kind: 'gist'; id: string }
  | null;

export function readHash(hash: string): HashRequest {
  const h = hash.replace(/^#/, '');
  const m = /^(s|scenario|gist)=(.*)$/.exec(h);
  if (!m) return null;
  const value = m[2];
  if (m[1] === 's') return { kind: 'link', data: value };
  if (m[1] === 'scenario') return /^[a-z0-9-]{1,60}$/.test(value) ? { kind: 'builtin', name: value } : null;
  return /^[0-9a-f]{20,40}$/i.test(value) ? { kind: 'gist', id: value } : null;
}

export function toBase64Url(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text: string): Uint8Array {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Float32 values as base64 (for painted potentials). */
export function floatsToBase64(values: ArrayLike<number>): string {
  const f = Float32Array.from(values);
  const bytes = new Uint8Array(f.buffer);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function base64ToFloats(text: string): Float32Array {
  const bin = atob(text);
  const n = Math.floor(bin.length / 4);
  const bytes = new Uint8Array(n * 4);
  for (let i = 0; i < n * 4; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

/** A short, stable id of a scenario (FNV-1a of its JSON), e.g. to keep its answers apart. */
export function scenarioKey(json: unknown): string {
  const s = JSON.stringify(json);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
