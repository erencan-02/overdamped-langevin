import { describe, expect, it } from 'vitest';
import { PotentialField } from '../src/sim/field';
import { UndoHistory } from '../src/sim/history';
import { ParticleSystem } from '../src/sim/particles';
import { Rng } from '../src/sim/rng';

function setup() {
  const field = new PotentialField({ cellSize: 0.04, cap: 5 });
  const ps = new ParticleSystem(new Rng(1));
  return { field, ps, history: new UndoHistory(field, ps) };
}

/** Ψ and ∇Ψ at a few points, to compare whole states. */
function probe(field: PotentialField): number[] {
  const g = new Float64Array(2);
  const out: number[] = [];
  for (const [x, y] of [[0, 0], [0.3, -0.2], [5.1, 5.1], [-2.6, 1.7], [5.12, 0]]) {
    out.push(field.sample(x, y));
    field.gradient(x, y, g);
    out.push(g[0], g[1]);
  }
  return out;
}

function ids(ps: ParticleSystem): number[] {
  return Array.from(ps.id.subarray(0, ps.count)).sort((a, b) => a - b);
}

describe('UndoHistory', () => {
  it('undoes and redoes brush strokes exactly, including across chunk borders', () => {
    const { field, history } = setup();
    const empty = probe(field);
    history.run('Brush stroke', () => field.applyBrush(0, 0, -3, 0.5));
    const one = probe(field);
    // A stroke across the border of chunk (0, 0) at x = 5.12, applied in many small dabs.
    history.begin('Brush stroke');
    for (let k = 0; k < 20; k++) field.applyBrush(4.9 + k * 0.03, 0, 0.4, 0.3);
    history.end();
    const two = probe(field);
    expect(two).not.toEqual(one);

    expect(history.undo()).toBe('Brush stroke');
    expect(probe(field)).toEqual(one);
    expect(history.undo()).toBe('Brush stroke');
    expect(probe(field)).toEqual(empty);
    expect(history.undo()).toBeNull();

    expect(history.redo()).toBe('Brush stroke');
    expect(probe(field)).toEqual(one);
    expect(history.redo()).toBe('Brush stroke');
    expect(probe(field)).toEqual(two);
    expect(history.redo()).toBeNull();
  });

  it('undoes clearing Ψ, and a new edit ends the redo branch', () => {
    const { field, history } = setup();
    field.applyBrush(1, 1, 2, 0.6); // before the history started: not undoable, but restorable
    const painted = probe(field);
    history.run('Clear Ψ', () => field.clear());
    expect(field.sample(1, 1)).toBe(0);
    history.undo();
    expect(probe(field)).toEqual(painted);
    expect(history.canRedo).toBe(true);
    history.run('Brush stroke', () => field.applyBrush(-1, 0, 1, 0.4));
    expect(history.canRedo).toBe(false);
  });

  it('removes added particles and brings back removed ones with their ids', () => {
    const { ps, history } = setup();
    history.run('Add particle', () => ps.add(0, 0, 3));
    history.run('Add particle grid', () => {
      for (let k = 1; k <= 4; k++) ps.add(k, 0, k);
    });
    expect(ids(ps)).toEqual([0, 1, 2, 3, 4]);
    history.run('Remove particle', () => ps.removeAt(2)); // id 2
    expect(ids(ps)).toEqual([0, 1, 3, 4]);

    // The simulation moves particles between edits; undo does not rewind that motion.
    ps.x[0] = 9;
    history.undo(); // particle 2 is back where it was removed
    expect(ids(ps)).toEqual([0, 1, 2, 3, 4]);
    const i2 = Array.from(ps.id.subarray(0, ps.count)).indexOf(2);
    expect([ps.x[i2], ps.y[i2], ps.color[i2]]).toEqual([2, 0, 2]);
    history.undo(); // the grid disappears
    expect(ids(ps)).toEqual([0]);
    expect(ps.x[0]).toBe(9);
    history.redo();
    expect(ids(ps)).toEqual([0, 1, 2, 3, 4]);
    expect(ps.nextId).toBe(5); // new particles still get fresh ids
    history.redo();
    expect(ids(ps)).toEqual([0, 1, 3, 4]);
  });

  it('records clearing the particles, nested actions as one step, and ignores empty actions', () => {
    const { field, ps, history } = setup();
    for (let k = 0; k < 3; k++) ps.add(k, k, k);
    history.run('Nothing', () => {});
    expect(history.canUndo).toBe(false);
    history.run('Image → particles', () => {
      history.run('inner', () => ps.clear());
      ps.add(7, 7, 1);
      field.applyBrush(0, 0, 1, 0.3);
    });
    expect(ids(ps)).toEqual([3]);
    expect(history.undo()).toBe('Image → particles');
    expect(ids(ps)).toEqual([0, 1, 2]);
    expect(field.sample(0, 0)).toBe(0);
    expect(history.canUndo).toBe(false);
  });

  it('a particle added and removed within one action leaves no trace; clear() forgets everything', () => {
    const { ps, history } = setup();
    history.run('Spray particles', () => {
      ps.add(1, 1, 1);
      ps.removeAt(0);
    });
    expect(history.canUndo).toBe(false);
    history.run('Add particle', () => ps.add(2, 2, 2));
    history.begin('Brush stroke');
    history.clear(); // e.g. a recording was opened mid-stroke
    expect(history.recording).toBe(false);
    expect(history.undo()).toBeNull();
    expect(ps.count).toBe(1);
  });
});
