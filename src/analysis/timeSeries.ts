/** History length; when full, every other point is dropped (the whole run stays visible). */
export const MAX_POINTS = 1200;

/**
 * A time series over the simulated time with any number of value channels (e.g. an estimate
 * and the two ends of its confidence interval). Memory is bounded: when MAX_POINTS is
 * exceeded, every other point is dropped, so the whole history stays visible at half the
 * resolution. A sample at a time not after the last one (paused simulation) replaces the last
 * point instead of adding one.
 */
export class TimeSeries<C extends string = string> {
  readonly times: number[] = [];
  readonly channels: Record<C, number[]>;
  private readonly names: readonly C[];

  constructor(names: readonly C[]) {
    this.names = names;
    this.channels = {} as Record<C, number[]>;
    for (const n of names) this.channels[n] = [];
  }

  get length(): number {
    return this.times.length;
  }

  clear(): void {
    this.times.length = 0;
    for (const n of this.names) this.channels[n].length = 0;
  }

  push(t: number, values: Record<C, number>): void {
    const n = this.times.length;
    if (n > 0 && t <= this.times[n - 1]) {
      for (const c of this.names) this.channels[c][n - 1] = values[c];
      return;
    }
    this.times.push(t);
    for (const c of this.names) this.channels[c].push(values[c]);
    if (this.times.length > MAX_POINTS) this.decimate();
  }

  private decimate(): void {
    const all = [this.times, ...this.names.map((c) => this.channels[c])];
    let w = 0;
    for (let r = 0; r < this.times.length; r += 2) {
      for (const a of all) a[w] = a[r];
      w++;
    }
    for (const a of all) a.length = w;
  }
}
