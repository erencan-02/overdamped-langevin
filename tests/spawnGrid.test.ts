import { describe, expect, it } from 'vitest';
import { forEachGridPoint, spawnGrid } from '../src/sim/spawnGrid';

function points(g: ReturnType<typeof spawnGrid>, limit = Infinity) {
  const out: [number, number][] = [];
  forEachGridPoint(g, limit, (x, y) => out.push([x, y]));
  return out;
}

describe('spawnGrid', () => {
  it('places points exactly `spacing` apart', () => {
    const g = spawnGrid(0, 0, 2, 1, 0.5);
    expect([g.nx, g.ny, g.count]).toEqual([5, 3, 15]);
    const p = points(g);
    expect(p[0]).toEqual([0, 0]);
    expect(p[1][0] - p[0][0]).toBeCloseTo(0.5, 12);
    expect(p[5][1] - p[0][1]).toBeCloseTo(0.5, 12);
    expect(p[14]).toEqual([2, 1]);
  });

  it('centres the block so that opposite margins are equal', () => {
    const g = spawnGrid(0, 0, 1.3, 0.7, 0.5); // 3 × 2 points, leftover space split evenly
    const p = points(g);
    const xs = p.map((q) => q[0]);
    const ys = p.map((q) => q[1]);
    expect(Math.min(...xs) - 0).toBeCloseTo(1.3 - Math.max(...xs), 12);
    expect(Math.min(...ys) - 0).toBeCloseTo(0.7 - Math.max(...ys), 12);
  });

  it('does not depend on the drag direction', () => {
    const a = points(spawnGrid(0, 0, 3, 2, 0.4));
    const b = points(spawnGrid(3, 2, 0, 0, 0.4));
    expect(b).toEqual(a);
  });

  it('gives a single point (at the centre) for a rectangle smaller than the spacing', () => {
    const g = spawnGrid(1, 1, 1.2, 1.1, 0.5);
    expect(g.count).toBe(1);
    const [[x, y]] = points(g);
    expect(x).toBeCloseTo(1.1, 12);
    expect(y).toBeCloseTo(1.05, 12);
  });

  it('respects the limit', () => {
    const g = spawnGrid(0, 0, 10, 10, 0.1);
    expect(g.count).toBe(101 * 101);
    expect(points(g, 50)).toHaveLength(50);
  });
});
