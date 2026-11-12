import { describe, expect, it, vi } from 'vitest';
import type { CameraPose, Rect } from '../src/view3d/types';

/** A stand-in for the three.js scene: records what the controller asks of it. */
class FakeScene {
  canvas = {
    hidden: true,
    style: {} as Record<string, string>,
    className: '',
    setAttribute() {},
    addEventListener() {},
    remove() {},
  };
  pose: CameraPose = { target: [0, 0, 0], distance: 1, polar: 0, azimuth: 0 };
  prepared: Rect[] = [];
  relief = 0;
  controls = false;
  prepare(view: Rect) {
    this.prepared.push(view);
    this.relief = 0;
    this.pose = this.homePose(view);
  }
  homePose(view: Rect): CameraPose {
    return { target: [(view.x0 + view.x1) / 2, (view.y0 + view.y1) / 2, 0], distance: view.y1 - view.y0, polar: 0, azimuth: -Math.PI / 2 };
  }
  getPose() {
    return this.pose;
  }
  setPose(p: CameraPose) {
    this.pose = p;
  }
  setRelief(r: number) {
    this.relief = r;
  }
  setControlsEnabled(on: boolean) {
    this.controls = on;
  }
  setGrid() {}
  setContours() {}
  setFormula() {}
  pick() {
    return null;
  }
  setCursor() {}
  resize() {}
  render() {}
  dispose() {}
}

let lastScene: FakeScene | null = null;
vi.mock('../src/view3d/scene3d', () => ({
  Scene3D: class {
    constructor() {
      lastScene = new FakeScene();
      return lastScene;
    }
  },
}));

const { ViewSwitch, TRANSITION_MS } = await import('../src/view3d/viewSwitch');

vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });

/** A controller in 3D (transition finished) over the 2D view `view()`. */
async function in3D(view: () => Rect) {
  const modes: string[] = [];
  const vs = new ViewSwitch({ appendChild() {} } as unknown as HTMLElement, () => ({}) as never, {} as never, {
    view2D: view,
    onModeChange: (m) => modes.push(m),
    onError: () => {},
  });
  vs.set('3d');
  await vi.waitFor(() => expect(lastScene).not.toBeNull());
  await vi.waitFor(() => expect(vs.show3D || lastScene!.canvas.hidden === false).toBe(true));
  const scene = lastScene!;
  vs.frame(performance.now() + TRANSITION_MS + 1, false, false);
  return { vs, scene, modes };
}

describe('ViewSwitch.refit (the 2D view jumped while the 3D view is up)', () => {
  it('rebuilds the 3D view around the new place and rises again', async () => {
    let view: Rect = { x0: -4, y0: -3, x1: 4, y1: 3 };
    lastScene = null;
    const { vs, scene } = await in3D(() => view);
    expect(vs.interactive3D).toBe(true);
    expect(scene.relief).toBe(1);

    view = { x0: 10, y0: 17, x1: 30, y1: 32 };
    vs.refit();
    expect(scene.prepared.at(-1)).toEqual(view);
    expect(vs.interactive3D).toBe(false); // during the rise
    expect(vs.show3D).toBe(true); // no fade: the 3D view stays up
    expect(scene.controls).toBe(false);

    vs.frame(performance.now() + TRANSITION_MS + 1, false, false);
    expect(vs.interactive3D).toBe(true);
    expect(scene.relief).toBe(1);
    expect(scene.controls).toBe(true);
    expect(scene.pose.target[0]).toBeCloseTo(20, 9); // over the new place
    expect(scene.pose.target[1]).toBeCloseTo(24.5, 9);
    expect(vs.mode).toBe('3d');
  });

  it('does nothing while only the 2D view is shown', async () => {
    let view: Rect = { x0: -4, y0: -3, x1: 4, y1: 3 };
    lastScene = null;
    const { vs, scene } = await in3D(() => view);
    vs.set('2d');
    vs.frame(performance.now() + TRANSITION_MS + 1, false, false);
    expect(vs.show3D).toBe(false);
    const n = scene.prepared.length;
    view = { x0: 0, y0: 0, x1: 2, y1: 2 };
    vs.refit();
    expect(scene.prepared.length).toBe(n);
    expect(vs.show3D).toBe(false);
  });

  it('shows 2D at once if the view jumps during the flight back to 2D', async () => {
    lastScene = null;
    const { vs, scene } = await in3D(() => ({ x0: -4, y0: -3, x1: 4, y1: 3 }));
    vs.set('2d');
    vs.frame(performance.now() + 50, false, false); // mid-flight
    expect(vs.show3D).toBe(true);
    vs.refit();
    expect(vs.show3D).toBe(false);
    expect(vs.interactive2D).toBe(true);
    expect(scene.canvas.hidden).toBe(true);
  });
});
