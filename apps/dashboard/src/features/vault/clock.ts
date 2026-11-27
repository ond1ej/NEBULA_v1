// Countdown clock shared by the vault views (auto-lock, lockout, reveal auto-hide).
import { useEffect, useState } from 'react';

/** Seconds left until `until` (epoch seconds); ticks once a second while in the future. */
export function useSecondsLeft(until: number | null | undefined): number {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    if (!until) return;
    setNow(Date.now() / 1000);
    const t = setInterval(() => {
      const n = Date.now() / 1000;
      setNow(n);
      if (n >= until) clearInterval(t);
    }, 1000);
    return () => clearInterval(t);
  }, [until]);
  return until ? Math.max(0, until - now) : 0;
}
