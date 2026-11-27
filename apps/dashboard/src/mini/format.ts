// Small time / size formatting helpers of the Mini App (epoch seconds in, short human text out).

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

function fmt(d: Date, opts: Intl.DateTimeFormatOptions): string {
  try {
    return new Intl.DateTimeFormat(undefined, opts).format(d);
  } catch {
    return d.toLocaleString();
  }
}

/** Chat list time: "14:05" today, "Yesterday", weekday within a week, else "12 Nov" (with year if not this year). */
export function chatTime(epoch: number | null | undefined, now: number = Date.now()): string {
  if (!epoch) return '';
  const d = new Date(epoch * 1000);
  const n = new Date(now);
  if (sameDay(d, n)) return fmt(d, { hour: '2-digit', minute: '2-digit' });
  const y = new Date(n);
  y.setDate(n.getDate() - 1);
  if (sameDay(d, y)) return 'Yesterday';
  const days = (now - d.getTime()) / 86_400_000;
  if (days >= 0 && days < 6) return fmt(d, { weekday: 'short' });
  return fmt(d, d.getFullYear() === n.getFullYear() ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Message timestamp inside a bubble ("14:05"). */
export function clockTime(epoch: number): string {
  return fmt(new Date(epoch * 1000), { hour: '2-digit', minute: '2-digit' });
}

/** Day separator in a conversation: "Today", "Yesterday", "Monday, 10 November". */
export function dayLabel(epoch: number, now: number = Date.now()): string {
  const d = new Date(epoch * 1000);
  const n = new Date(now);
  if (sameDay(d, n)) return 'Today';
  const y = new Date(n);
  y.setDate(n.getDate() - 1);
  if (sameDay(d, y)) return 'Yesterday';
  return fmt(d, d.getFullYear() === n.getFullYear() ? { weekday: 'long', day: 'numeric', month: 'long' } : { day: 'numeric', month: 'long', year: 'numeric' });
}

export function dayKey(epoch: number): string {
  const d = new Date(epoch * 1000);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** "12 s", "1 min 05 s", "1 h 02 min" for durations in seconds. */
export function shortDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h) return `${h} h ${String(m).padStart(2, '0')} min`;
  if (m) return `${m} min ${String(r).padStart(2, '0')} s`;
  return `${r} s`;
}

export function bytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
