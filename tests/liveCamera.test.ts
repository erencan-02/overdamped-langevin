import { describe, expect, it } from 'vitest';
import { cameraErrorMessage, smoothLevels } from '../src/image/liveCamera';

describe('smoothLevels', () => {
  it('takes the first measurement as is', () => {
    expect(smoothLevels(null, { lo: 0.1, hi: 0.8 })).toEqual({ lo: 0.1, hi: 0.8 });
  });

  it('moves gradually towards new measurements (no flicker on exposure changes)', () => {
    let l = { lo: 0.1, hi: 0.8 };
    l = smoothLevels(l, { lo: 0.3, hi: 0.6 });
    expect(l.lo).toBeGreaterThan(0.1);
    expect(l.lo).toBeLessThan(0.15);
    for (let k = 0; k < 100; k++) l = smoothLevels(l, { lo: 0.3, hi: 0.6 });
    expect(l.lo).toBeCloseTo(0.3, 3);
    expect(l.hi).toBeCloseTo(0.6, 3);
  });

  it('never stretches a nearly flat scene beyond the minimum span', () => {
    const l = smoothLevels(null, { lo: 0.5, hi: 0.52 });
    expect(l.hi - l.lo).toBeCloseTo(0.25, 10);
    expect((l.hi + l.lo) / 2).toBeCloseTo(0.51, 10);
  });
});

describe('cameraErrorMessage', () => {
  it('explains the common getUserMedia failures', () => {
    const msg = (name: string) => cameraErrorMessage(new DOMException('x', name));
    expect(msg('NotAllowedError')).toMatch(/blocked/);
    expect(msg('NotFoundError')).toMatch(/No camera/);
    expect(msg('NotReadableError')).toMatch(/another app/);
    expect(cameraErrorMessage('weird')).toMatch(/could not be started/);
  });
});
