import { describe, expect, it } from 'vitest';
import { epochToZoned, tzOffsetMs, zonedToEpoch } from './tz';

describe('time-zone helpers', () => {
  it('converts Prague wall-clock time to epoch seconds across DST', () => {
    // 2026-07-01 09:00 CEST (UTC+2) = 07:00 UTC
    expect(zonedToEpoch('2026-07-01', '09:00', 'Europe/Prague')).toBe(Date.UTC(2026, 6, 1, 7, 0) / 1000);
    // 2026-01-15 09:00 CET (UTC+1) = 08:00 UTC
    expect(zonedToEpoch('2026-01-15', '09:00', 'Europe/Prague')).toBe(Date.UTC(2026, 0, 15, 8, 0) / 1000);
    expect(zonedToEpoch('2026-01-15', '09:00', 'UTC')).toBe(Date.UTC(2026, 0, 15, 9, 0) / 1000);
  });

  it('round-trips epoch → wall clock in a zone', () => {
    const t = Date.UTC(2026, 10, 16, 23, 30) / 1000;
    expect(epochToZoned(t, 'Europe/Prague')).toEqual({ date: '2026-11-17', time: '00:30' });
    expect(zonedToEpoch('2026-11-17', '00:30', 'Europe/Prague')).toBe(t);
  });

  it('reports the zone offset and rejects malformed input', () => {
    expect(tzOffsetMs(Date.UTC(2026, 6, 1), 'Europe/Prague')).toBe(2 * 3600 * 1000);
    expect(zonedToEpoch('16.11.2026', '9:00', 'UTC')).toBeNull();
  });
});
