import { describe, expect, it } from 'vitest';
import { adaptQuality, ADAPTIVE_DEFAULTS, ADAPTIVE_START, vncQualityFor, VNC_HIGH, VNC_LOW, VNC_MOBILE, type AdaptiveState } from './liveQuality';

/** Feeds samples (bytes/s) every `stepMs` (the Mini App measures every 5 s). */
function run(samples: (number | null)[], stepMs = 5000, start: AdaptiveState = ADAPTIVE_START) {
  let s = start;
  const trace: boolean[] = [];
  samples.forEach((bps, i) => {
    s = adaptQuality(s, { bytesPerSec: bps, at: (i + 1) * stepMs });
    trace.push(s.reduced);
  });
  return { state: s, trace };
}

describe('Live Desktop adaptive quality (Mini App)', () => {
  it('starts at quality 4 / compression 2; High is noVNC default 6 / 2; reduced is 2 / 6', () => {
    expect(vncQualityFor('auto', ADAPTIVE_START)).toEqual(VNC_MOBILE);
    expect(VNC_MOBILE).toEqual({ qualityLevel: 4, compressionLevel: 2 });
    expect(vncQualityFor('high', { reduced: true, since: null })).toEqual(VNC_HIGH);
    expect(VNC_HIGH).toEqual({ qualityLevel: 6, compressionLevel: 2 });
    expect(vncQualityFor('auto', { reduced: true, since: null })).toEqual(VNC_LOW);
    expect(VNC_LOW).toEqual({ qualityLevel: 2, compressionLevel: 6 });
  });

  it('drops only after the stream stays below ~300 KB/s for a few seconds', () => {
    // one slow sample is not enough; the second (5 s later) is
    expect(run([120_000]).trace).toEqual([false]);
    expect(run([120_000, 150_000]).trace).toEqual([false, true]);
    // a fast sample in between resets the streak
    expect(run([120_000, 900_000, 120_000]).trace).toEqual([false, false, false]);
    expect(ADAPTIVE_DEFAULTS.slowBytesPerSec).toBe(300_000);
  });

  it('goes back up once throughput recovers (longer hold, no flapping)', () => {
    const reduced = run([100_000, 100_000]).state;
    expect(reduced.reduced).toBe(true);
    // fast for 5 s / 10 s: still reduced; fast for more than 8 s of samples (3 samples): back to quality 4
    expect(run([400_000, 450_000, 420_000], 5000, reduced).trace).toEqual([true, true, false]);
    // a slow sample interrupts the recovery
    expect(run([400_000, 100_000, 400_000], 5000, reduced).trace).toEqual([true, true, true]);
  });

  it('ignores an idle stream (still screen) and unknown rates: no evidence either way', () => {
    expect(run([2_000, 1_000, 0, null, 3_000]).trace.every((r) => r === false)).toBe(true);
    const reduced = run([100_000, 100_000]).state;
    expect(run([0, 0, 0, 0], 5000, reduced).state.reduced).toBe(true);
    // idle in the middle of a slow streak restarts it
    expect(run([100_000, 0, 100_000]).trace).toEqual([false, false, false]);
  });
});
