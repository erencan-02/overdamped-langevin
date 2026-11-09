import type { PotentialField } from './field';
import { Rng } from './rng';

export type PresetName = 'double-well' | 'ring' | 'landscape';

const gauss = (A: number, s: number, x0: number, y0: number) => {
  const k = 1 / (2 * s * s);
  return (x: number, y: number) => A * Math.exp(-((x - x0) ** 2 + (y - y0) ** 2) * k);
};

/**
 * Replaces the field with a ready-made landscape centred at (cx, cy). Every preset is a
 * smooth function that decays to 0, so the clamped grid representation has no artificial edges.
 */
export function applyPreset(field: PotentialField, name: PresetName, cx: number, cy: number): void {
  field.clear();
  const terms: { f: (x: number, y: number) => number; reach: number; x: number; y: number }[] = [];
  const add = (A: number, s: number, x: number, y: number) =>
    terms.push({ f: gauss(A, s, cx + x, cy + y), reach: 4 * s, x: cx + x, y: cy + y });

  switch (name) {
    case 'double-well':
      add(-4.5, 1.0, -2.2, 0);
      add(-4.5, 1.0, 2.2, 0);
      add(1.2, 0.6, 0, 0); // a slightly raised saddle between the wells
      break;
    case 'ring': {
      const R = 3;
      const w = 0.55;
      const f = (x: number, y: number) => {
        const r = Math.hypot(x - cx, y - cy);
        return -4 * Math.exp(-((r - R) ** 2) / (2 * w * w));
      };
      field.addFunction(cx - R - 4 * w, cy - R - 4 * w, cx + R + 4 * w, cy + R + 4 * w, f);
      add(3, 0.9, 0, 0);
      break;
    }
    case 'landscape': {
      const rng = new Rng();
      for (let k = 0; k < 16; k++) {
        const A = (rng.float() < 0.5 ? -1 : 1) * (1.5 + 2.5 * rng.float());
        const s = 0.5 + 0.9 * rng.float();
        add(A, s, (rng.float() - 0.5) * 14, (rng.float() - 0.5) * 9);
      }
      break;
    }
  }

  for (const t of terms) {
    if (t.reach > 0) field.addFunction(t.x - t.reach, t.y - t.reach, t.x + t.reach, t.y + t.reach, t.f);
  }
}
