"""Small, dependency-free schedule calculator: once / interval / daily / weekly / monthly / 5-field cron,
evaluated in the schedule's IANA time zone (DST-safe: wall-clock times are resolved with zoneinfo)."""

from __future__ import annotations

import re
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

FIELDS = [("minute", 0, 59), ("hour", 0, 23), ("day", 1, 31), ("month", 1, 12), ("weekday", 0, 6)]
ALIASES = {"@hourly": "0 * * * *", "@daily": "0 0 * * *", "@midnight": "0 0 * * *", "@weekly": "0 0 * * 0",
           "@monthly": "0 0 1 * *", "@yearly": "0 0 1 1 *", "@annually": "0 0 1 1 *"}
NAMES = {"jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6, "jul": 7, "aug": 8, "sep": 9, "oct": 10,
         "nov": 11, "dec": 12, "sun": 0, "mon": 1, "tue": 2, "wed": 3, "thu": 4, "fri": 5, "sat": 6}


class CronError(ValueError):
    pass


def tz(name: str) -> ZoneInfo:
    try:
        return ZoneInfo(name or "UTC")
    except (ZoneInfoNotFoundError, ValueError) as e:
        raise CronError(f"unknown time zone {name!r}") from e


def _field(expr: str, lo: int, hi: int) -> set[int]:
    out: set[int] = set()
    for part in expr.lower().split(","):
        step = 1
        if "/" in part:
            part, s = part.split("/", 1)
            if not s.isdigit() or int(s) < 1:
                raise CronError(f"bad step in {expr!r}")
            step = int(s)
        if part in ("*", ""):
            a, b = lo, hi
        elif "-" in part:
            x, y = part.split("-", 1)
            a, b = int(NAMES.get(x, x)), int(NAMES.get(y, y))
        else:
            a = int(NAMES.get(part, part)) if re.match(r"^(\d+|[a-z]{3})$", part) else -1
            b = a if step == 1 else hi
        if not (lo <= a <= hi and lo <= b <= hi + (1 if hi == 6 else 0)) or a > b:
            raise CronError(f"value out of range in {expr!r}")
        out.update(v % 7 if hi == 6 else v for v in range(a, b + 1, step))
    return out


def parse_cron(expr: str) -> list[set[int]]:
    expr = ALIASES.get(expr.strip(), expr.strip())
    parts = expr.split()
    if len(parts) != 5:
        raise CronError("cron needs 5 fields: minute hour day month weekday")
    try:
        return [_field(p, lo, hi) for p, (_, lo, hi) in zip(parts, FIELDS, strict=True)]
    except ValueError as e:
        raise CronError(str(e)) from e


def _cron_next(fields: list[set[int]], after: datetime, raw_dom: bool, raw_dow: bool) -> datetime:
    mins, hours, days, months, wdays = fields
    t = after.replace(second=0, microsecond=0) + timedelta(minutes=1)
    for _ in range(366 * 24 * 60 // 15):  # bounded search (minute granularity with day/hour skips)
        if t.month not in months:
            t = (t.replace(day=1, hour=0, minute=0) + timedelta(days=32)).replace(day=1)
            continue
        dom_ok, dow_ok = t.day in days, (t.isoweekday() % 7) in wdays
        day_ok = (dom_ok or dow_ok) if (raw_dom and raw_dow) else (dom_ok and dow_ok)
        if not day_ok:
            t = (t + timedelta(days=1)).replace(hour=0, minute=0)
            continue
        if t.hour not in hours:
            t = (t + timedelta(hours=1)).replace(minute=0)
            continue
        if t.minute not in mins:
            t += timedelta(minutes=1)
            continue
        return t
    raise CronError("no matching time within a year")


def _local(naive: datetime, zone: ZoneInfo) -> datetime:
    return naive.replace(tzinfo=zone)


def next_run(kind: str, spec: dict, tz_name: str, after_ts: float, created_ts: float | None = None) -> float | None:
    """Next fire time strictly after `after_ts` (unix seconds), or None when the schedule is exhausted."""
    zone = tz(tz_name)
    after = datetime.fromtimestamp(after_ts, zone)
    if kind == "once":
        at = float(spec.get("at") or 0)
        return at if at > after_ts else None
    if kind == "interval":
        every = int(spec.get("every_s") or 0)
        if every < 60:
            raise CronError("interval must be at least 60 seconds")
        base = float(spec.get("start_at") or created_ts or after_ts)
        if base > after_ts:
            return base
        n = int((after_ts - base) // every) + 1
        return base + n * every
    if kind in ("daily", "weekly", "monthly"):
        hh, mm = _hhmm(spec.get("time", "09:00"))
        if kind == "daily":
            expr = f"{mm} {hh} * * *"
        elif kind == "weekly":
            wd = spec.get("weekdays") or [1]
            if not all(isinstance(d, int) and 0 <= d <= 6 for d in wd):
                raise CronError("weekdays must be 0 (Sunday) .. 6")
            expr = f"{mm} {hh} * * {','.join(str(d) for d in sorted(set(wd)))}"
        else:
            day = int(spec.get("day", 1))
            if not 1 <= day <= 31:
                raise CronError("day must be 1..31")
            expr = f"{mm} {hh} {day} * *"
        return next_run("cron", {"cron": expr}, tz_name, after_ts)
    if kind == "cron":
        raw = ALIASES.get(str(spec.get("cron", "")).strip(), str(spec.get("cron", "")).strip())
        fields = parse_cron(raw)
        parts = raw.split()
        nxt = _cron_next(fields, after.replace(tzinfo=None), parts[2] != "*", parts[4] != "*")
        return _local(nxt, zone).astimezone(UTC).timestamp()
    raise CronError(f"unknown schedule kind {kind!r}")


def _hhmm(s: str) -> tuple[int, int]:
    m = re.match(r"^(\d{1,2}):(\d{2})$", str(s))
    if not m or int(m.group(1)) > 23 or int(m.group(2)) > 59:
        raise CronError("time must be HH:MM")
    return int(m.group(1)), int(m.group(2))


def preview(kind: str, spec: dict, tz_name: str, after_ts: float, n: int = 5) -> list[float]:
    out, t = [], after_ts
    for _ in range(n):
        nx = next_run(kind, spec, tz_name, t, created_ts=after_ts)
        if nx is None:
            break
        out.append(nx)
        t = nx
    return out
