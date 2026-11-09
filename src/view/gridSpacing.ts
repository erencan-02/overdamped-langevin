export interface GridSpacing {
  /** Distance between major (labelled) lines in world units. */
  major: number;
  /** Distance between minor lines in world units. */
  minor: number;
  /** Decimal places needed to print a major line coordinate. */
  decimals: number;
}

/**
 * Picks a "nice" 1–2–5 major spacing so that major lines are at least `minPx` CSS pixels
 * apart, and subdivides it into 5 (or 4 for a mantissa of 2) minor intervals.
 */
export function gridSpacing(scale: number, minPx = 90): GridSpacing {
  const raw = minPx / scale;
  const exp = Math.floor(Math.log10(raw));
  const base = 10 ** exp;
  const m = raw / base;
  const mant = m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10;
  const major = mant * base;
  const minor = major / (mant === 2 ? 4 : 5);
  const decimals = Math.max(0, -Math.floor(Math.log10(major) + 1e-9));
  return { major, minor, decimals };
}
