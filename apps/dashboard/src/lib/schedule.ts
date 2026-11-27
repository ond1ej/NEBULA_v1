import type { ScheduleKind, ScheduleSpec } from '../types';
import { formatInZone } from './tz';

/** 0 = Sunday … 6 = Saturday (the host's cron convention). */
export const WEEKDAYS = [
  { d: 1, short: 'Mon', long: 'Monday' },
  { d: 2, short: 'Tue', long: 'Tuesday' },
  { d: 3, short: 'Wed', long: 'Wednesday' },
  { d: 4, short: 'Thu', long: 'Thursday' },
  { d: 5, short: 'Fri', long: 'Friday' },
  { d: 6, short: 'Sat', long: 'Saturday' },
  { d: 0, short: 'Sun', long: 'Sunday' },
];

export type IntervalUnit = 'minutes' | 'hours' | 'days';
const UNIT_S: Record<IntervalUnit, number> = { minutes: 60, hours: 3600, days: 86400 };

export function intervalToSeconds(n: number, unit: IntervalUnit): number {
  return Math.round(n * UNIT_S[unit]);
}

export function secondsToInterval(s: number): { n: number; unit: IntervalUnit } {
  if (s > 0 && s % 86400 === 0) return { n: s / 86400, unit: 'days' };
  if (s > 0 && s % 3600 === 0) return { n: s / 3600, unit: 'hours' };
  return { n: Math.max(1, Math.round(s / 60)), unit: 'minutes' };
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function describeWeekdays(days: number[]): string {
  const set = [...new Set(days)].sort();
  if (set.length === 7) return 'every day';
  if (set.length === 5 && [1, 2, 3, 4, 5].every((d) => set.includes(d))) return 'every weekday';
  if (set.length === 2 && set.includes(0) && set.includes(6)) return 'weekends';
  return WEEKDAYS.filter((w) => set.includes(w.d))
    .map((w) => w.short)
    .join(', ');
}

/** Human summary of a schedule's timing, e.g. "Every weekday at 09:00". */
export function describeSchedule(kind: ScheduleKind | string, spec: ScheduleSpec, tz: string): string {
  switch (kind) {
    case 'once':
      return spec.at ? `Once · ${formatInZone(spec.at, tz, { year: 'numeric' })}` : 'Once';
    case 'interval': {
      const { n, unit } = secondsToInterval(spec.every_s ?? 0);
      return `Every ${plural(n, unit.replace(/s$/, ''))}`;
    }
    case 'daily':
      return `Every day at ${spec.time ?? '09:00'}`;
    case 'weekly': {
      const w = describeWeekdays(spec.weekdays ?? [1]);
      return `${w.startsWith('every') ? w[0].toUpperCase() + w.slice(1) : `Every ${w}`} at ${spec.time ?? '09:00'}`;
    }
    case 'monthly':
      return `Monthly on day ${spec.day ?? 1} at ${spec.time ?? '09:00'}`;
    case 'cron':
      return `Cron ${spec.cron ?? ''}`.trim();
    default:
      return String(kind);
  }
}

export const CRON_PRESETS: { label: string; cron: string }[] = [
  { label: 'Every 15 minutes', cron: '*/15 * * * *' },
  { label: 'Every hour, on the hour', cron: '0 * * * *' },
  { label: 'Weekdays at 08:30', cron: '30 8 * * 1-5' },
  { label: 'Every Monday at 07:00', cron: '0 7 * * 1' },
  { label: 'First day of the month at 06:00', cron: '0 6 1 * *' },
];
