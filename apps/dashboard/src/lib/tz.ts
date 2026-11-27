// IANA time-zone helpers without a date library (Intl only).

export const DEFAULT_TZ = 'Europe/Prague';

const FALLBACK_ZONES = [
  'UTC',
  'Europe/Prague',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Paris',
  'Europe/Vienna',
  'Europe/Warsaw',
  'Europe/Bratislava',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Asia/Tokyo',
  'Asia/Singapore',
  'Australia/Sydney',
];

export function timeZones(): string[] {
  try {
    const intl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
    const all = intl.supportedValuesOf?.('timeZone');
    if (all && all.length) return all.includes('UTC') ? all : ['UTC', ...all];
  } catch {
    // older engines: fall through
  }
  return FALLBACK_ZONES;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function parts(epochMs: number, tz: string) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const o: Record<string, number> = {};
  for (const p of dtf.formatToParts(new Date(epochMs))) if (p.type !== 'literal') o[p.type] = Number(p.value);
  return { y: o.year, m: o.month, d: o.day, h: (o.hour ?? 0) % 24, mi: o.minute, s: o.second };
}

/** Offset of `tz` from UTC at the given instant, in milliseconds (Prague in summer: +7 200 000). */
export function tzOffsetMs(epochMs: number, tz: string): number {
  const p = parts(epochMs, tz);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
  return asUtc - Math.floor(epochMs / 1000) * 1000;
}

/** Wall-clock date ("YYYY-MM-DD") + time ("HH:MM") in `tz` → epoch seconds (DST-safe). */
export function zonedToEpoch(date: string, time: string, tz: string): number | null {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const tm = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!dm || !tm) return null;
  const guess = Date.UTC(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]), Number(tm[1]), Number(tm[2]));
  const off1 = tzOffsetMs(guess, tz);
  let t = guess - off1;
  const off2 = tzOffsetMs(t, tz);
  if (off2 !== off1) t = guess - off2;
  return Math.round(t / 1000);
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Epoch seconds → wall-clock date/time in `tz` (for form inputs). */
export function epochToZoned(epochS: number, tz: string): { date: string; time: string } {
  const p = parts(epochS * 1000, tz);
  return { date: `${p.y}-${pad(p.m)}-${pad(p.d)}`, time: `${pad(p.h)}:${pad(p.mi)}` };
}

/** Calendar day key ("YYYY-MM-DD") of an instant in the browser's local time. */
export function localDayKey(epochS: number): string {
  const d = new Date(epochS * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function formatInZone(epochS: number, tz: string, opts: Intl.DateTimeFormatOptions = {}): string {
  try {
    return new Date(epochS * 1000).toLocaleString(undefined, {
      timeZone: tz,
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      ...opts,
    });
  } catch {
    return new Date(epochS * 1000).toLocaleString();
  }
}
