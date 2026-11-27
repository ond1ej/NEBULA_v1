import { describe, expect, it } from 'vitest';
import { downsample, niceTicks, segments } from './Charts';

describe('chart helpers', () => {
  it('produces nice, covering y ticks', () => {
    expect(niceTicks(0, 100)).toEqual([0, 25, 50, 75, 100]);
    const t = niceTicks(0, 1410);
    expect(t[0]).toBe(0);
    expect(t[t.length - 1]).toBeGreaterThanOrEqual(1410);
  });

  it('breaks lines at nulls and at long sampling gaps', () => {
    const pts = [
      { t: 0, v: 1 },
      { t: 20, v: 2 },
      { t: 40, v: null },
      { t: 60, v: 3 },
      { t: 80, v: 4 },
      { t: 2000, v: 5 },
    ];
    expect(segments(pts).map((s) => s.map((p) => p.v))).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('downsamples but keeps the last point', () => {
    const xs = Array.from({ length: 100 }, (_, i) => i);
    const d = downsample(xs, 10);
    expect(d).toHaveLength(10);
    expect(d[d.length - 1]).toBe(99);
  });
});
