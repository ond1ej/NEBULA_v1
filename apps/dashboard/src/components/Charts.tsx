// Inline-SVG charts (no chart library). Single series per chart, one y-axis, 2 px line, 10 % area wash,
// recessive hairline grid, crosshair + tooltip on hover/focus, and a data table for non-visual access.
import { memo, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

export interface Point {
  /** epoch seconds */
  t: number;
  v: number | null;
}

function niceStep(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  const exp = Math.floor(Math.log10(raw));
  const f = raw / 10 ** exp;
  const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nf * 10 ** exp;
}

/** Nice y-axis ticks covering [min, max] (exported for tests). */
export function niceTicks(min: number, max: number, count = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (max === min) max = min + 1;
  const step = niceStep((max - min) / count);
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const out: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) out.push(Number(v.toFixed(6)));
  return out;
}

/** Split a series into drawable runs: null values and gaps much longer than the sampling interval break the line. */
export function segments(points: Point[]): Point[][] {
  const diffs: number[] = [];
  for (let i = 1; i < points.length; i += 1) diffs.push(points[i].t - points[i - 1].t);
  const sorted = [...diffs].sort((a, b) => a - b);
  const typical = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  const out: Point[][] = [];
  let cur: Point[] = [];
  points.forEach((p, i) => {
    const gap = i > 0 && typical > 0 && p.t - points[i - 1].t > typical * 4;
    if (p.v === null || !Number.isFinite(p.v) || gap) {
      if (cur.length) out.push(cur);
      cur = [];
    }
    if (p.v !== null && Number.isFinite(p.v)) cur.push(p);
  });
  if (cur.length) out.push(cur);
  return out;
}

function fmtTime(t: number, span: number): string {
  const d = new Date(t * 1000);
  if (span <= 86400 * 1.05) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

function useWidth(fallback: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof ResizeObserver === 'undefined') {
      if (el.clientWidth) setW(el.clientWidth);
      return;
    }
    const ro = new ResizeObserver((entries) => {
      const cw = entries[0]?.contentRect.width;
      if (cw) setW(Math.round(cw));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, width: w };
}

const defaultFormat = (v: number) => v.toFixed(1);

/**
 * Memoised: a page that refreshes its snapshot or receives events does not re-render (and re-layout) its charts
 * unless their points change. Pass stable `data` (useMemo) and `format` (module-level) to benefit.
 */
export const TimeSeriesChart = memo(function TimeSeriesChart({
  data,
  label,
  format = defaultFormat,
  yMin,
  yMax,
  height = 170,
  color = 'var(--color-chart)',
  emptyText = 'No samples in this time range yet.',
  showTable = true,
}: {
  data: Point[];
  label: string;
  format?: (v: number) => string;
  yMin?: number;
  yMax?: number;
  height?: number;
  color?: string;
  emptyText?: string;
  showTable?: boolean;
}) {
  const { ref, width } = useWidth(640);
  const gradId = useId().replace(/:/g, '');
  const [hover, setHover] = useState<number | null>(null);
  const valid = useMemo(() => data.filter((p) => p.v !== null && Number.isFinite(p.v)), [data]);
  const M = { l: 44, r: 12, t: 10, b: 24 };
  const W = Math.max(200, width);
  const H = height;
  const iw = W - M.l - M.r;
  const ih = H - M.t - M.b;

  const geo = useMemo(() => {
    if (valid.length === 0) return null;
    const vals = valid.map((p) => p.v as number);
    const lo = yMin ?? Math.min(0, ...vals);
    const hiRaw = yMax ?? Math.max(...vals);
    const ticks = niceTicks(lo, hiRaw === lo ? lo + 1 : hiRaw, 4);
    const y0 = yMin ?? ticks[0];
    const y1 = yMax ?? ticks[ticks.length - 1];
    const t0 = data[0].t;
    const t1 = data[data.length - 1].t;
    const span = Math.max(1, t1 - t0);
    const x = (t: number) => M.l + ((t - t0) / span) * iw;
    const y = (v: number) => M.t + ih - ((v - y0) / (y1 - y0 || 1)) * ih;
    const segs = segments(data);
    const lines = segs.map((s) => s.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v as number).toFixed(1)}`).join(''));
    const areas = segs.map(
      (s) =>
        `${s.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v as number).toFixed(1)}`).join('')}L${x(s[s.length - 1].t).toFixed(1)},${(M.t + ih).toFixed(1)}L${x(s[0].t).toFixed(1)},${(M.t + ih).toFixed(1)}Z`,
    );
    const singles = segs.filter((s) => s.length === 1).map((s) => s[0]);
    const yTicks = ticks.filter((v) => v >= y0 - 1e-9 && v <= y1 + 1e-9);
    const nx = Math.max(2, Math.min(6, Math.floor(iw / 110)));
    const xTicks = Array.from({ length: nx }, (_, i) => t0 + (span * i) / (nx - 1));
    return { x, y, lines, areas, singles, yTicks, xTicks, span };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, valid, iw, ih, yMin, yMax]);

  const nearest = (px: number): number | null => {
    if (!geo || valid.length === 0) return null;
    let best = 0;
    let bd = Infinity;
    valid.forEach((p, i) => {
      const d = Math.abs(geo.x(p.t) - px);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    return best;
  };

  const onMove = (e: PointerEvent<SVGRectElement>) => {
    const box = (e.currentTarget.ownerSVGElement ?? e.currentTarget).getBoundingClientRect();
    const scale = box.width ? W / box.width : 1;
    setHover(nearest((e.clientX - box.left) * scale));
  };
  const onKey = (e: KeyboardEvent) => {
    if (valid.length === 0) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const d = e.key === 'ArrowLeft' ? -1 : 1;
      setHover((h) => Math.max(0, Math.min(valid.length - 1, (h ?? (d < 0 ? valid.length : -1)) + d)));
    } else if (e.key === 'Home') setHover(0);
    else if (e.key === 'End') setHover(valid.length - 1);
    else if (e.key === 'Escape') setHover(null);
  };

  const last = valid[valid.length - 1];
  const vals = valid.map((p) => p.v as number);
  const summary = last
    ? `${label}: latest ${format(last.v as number)}, min ${format(Math.min(...vals))}, max ${format(Math.max(...vals))} over ${valid.length} samples.`
    : `${label}: ${emptyText}`;
  const hp = hover !== null ? valid[hover] : null;

  return (
    <div className="min-w-0">
      <div ref={ref} className="relative w-full">
        {!geo ? (
          <div className="grid place-items-center rounded-lg border border-dashed border-border text-xs text-muted" style={{ height: H }}>
            {emptyText}
          </div>
        ) : (
          <div
            tabIndex={0}
            role="group"
            aria-label={`${summary} Use the arrow keys to read individual samples.`}
            onKeyDown={onKey}
            onBlur={() => setHover(null)}
            className="rounded-lg focus-ring"
          >
            <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-hidden className="block touch-pan-y select-none">
              <defs>
                <linearGradient id={`g${gradId}`} x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0%" stopColor={color} stopOpacity="0.16" />
                  <stop offset="100%" stopColor={color} stopOpacity="0.02" />
                </linearGradient>
              </defs>
              {geo.yTicks.map((v) => (
                <g key={v}>
                  <line x1={M.l} x2={W - M.r} y1={geo.y(v)} y2={geo.y(v)} stroke="var(--color-border)" strokeWidth="1" />
                  <text x={M.l - 8} y={geo.y(v)} dy="0.32em" textAnchor="end" className="fill-subtle text-[10px] tabular-nums">
                    {format(v)}
                  </text>
                </g>
              ))}
              {geo.xTicks.map((t, i) => (
                <text
                  key={t}
                  x={geo.x(t)}
                  y={H - 6}
                  textAnchor={i === 0 ? 'start' : i === geo.xTicks.length - 1 ? 'end' : 'middle'}
                  className="fill-subtle text-[10px] tabular-nums"
                >
                  {fmtTime(t, geo.span)}
                </text>
              ))}
              {geo.areas.map((d, i) => (
                <path key={`a${i}`} d={d} fill={`url(#g${gradId})`} />
              ))}
              {geo.lines.map((d, i) => (
                <path key={`l${i}`} d={d} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
              ))}
              {geo.singles.map((p) => (
                <circle key={p.t} cx={geo.x(p.t)} cy={geo.y(p.v as number)} r="3" fill={color} />
              ))}
              {hp && (
                <g>
                  <line x1={geo.x(hp.t)} x2={geo.x(hp.t)} y1={M.t} y2={M.t + ih} stroke="var(--color-muted)" strokeOpacity="0.5" strokeWidth="1" />
                  <circle cx={geo.x(hp.t)} cy={geo.y(hp.v as number)} r="4.5" fill={color} stroke="var(--color-panel)" strokeWidth="2" />
                </g>
              )}
              <rect
                x={M.l}
                y={M.t}
                width={iw}
                height={ih}
                fill="transparent"
                onPointerMove={onMove}
                onPointerDown={onMove}
                onPointerLeave={() => setHover(null)}
              />
            </svg>
            {hp && (
              <div
                className="pointer-events-none absolute top-1 z-10 rounded-lg border border-border-strong bg-elevated px-2.5 py-1.5 text-xs shadow-pop"
                style={{
                  left: `${Math.min(Math.max((geo.x(hp.t) / W) * 100, 8), 92)}%`,
                  transform: 'translateX(-50%)',
                }}
              >
                <p className="text-subtle tabular-nums">{new Date(hp.t * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })}</p>
                <p className="flex items-center gap-1.5 font-medium text-text tabular-nums">
                  <span aria-hidden className="inline-block h-0.5 w-3 rounded" style={{ background: color }} />
                  {format(hp.v as number)}
                </p>
              </div>
            )}
          </div>
        )}
        <p className="sr-only" aria-live="polite">
          {hp ? `${new Date(hp.t * 1000).toLocaleTimeString()}: ${format(hp.v as number)}` : ''}
        </p>
      </div>
      {showTable && valid.length > 0 && (
        <details className="mt-1.5 text-xs">
          <summary className="inline-flex rounded text-subtle hover:text-text focus-ring">Data table</summary>
          <div className="mt-2 max-h-48 overflow-auto rounded-lg border border-border">
            <table className="w-full text-left text-xs">
              <caption className="sr-only">{label}</caption>
              <thead className="sticky top-0 bg-panel-2 text-subtle">
                <tr>
                  <th scope="col" className="px-3 py-1.5 font-medium">Time</th>
                  <th scope="col" className="px-3 py-1.5 text-right font-medium">Value</th>
                </tr>
              </thead>
              <tbody>
                {downsample(valid, 60)
                  .slice()
                  .reverse()
                  .map((p) => (
                    <tr key={p.t} className="border-t border-border/60">
                      <td className="px-3 py-1 text-muted tabular-nums">{new Date(p.t * 1000).toLocaleString()}</td>
                      <td className="px-3 py-1 text-right text-text tabular-nums">{format(p.v as number)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  );
});

export function downsample<T>(xs: T[], max: number): T[] {
  if (xs.length <= max) return xs;
  const step = xs.length / max;
  const out: T[] = [];
  for (let i = 0; i < max; i += 1) out.push(xs[Math.floor(i * step)]);
  out[out.length - 1] = xs[xs.length - 1];
  return out;
}

/** Tiny trend line for stat tiles (decorative; the tile's number carries the value). */
export function Sparkline({
  values,
  width = 84,
  height = 26,
  color = 'var(--color-chart)',
  label,
}: {
  values: (number | null)[];
  width?: number;
  height?: number;
  color?: string;
  label?: string;
}) {
  const pts = values.map((v, i) => ({ i, v })).filter((p) => p.v !== null && Number.isFinite(p.v)) as { i: number; v: number }[];
  if (pts.length < 2) return null;
  const min = Math.min(...pts.map((p) => p.v));
  const max = Math.max(...pts.map((p) => p.v));
  const n = values.length - 1 || 1;
  const x = (i: number) => 1 + (i / n) * (width - 2);
  const y = (v: number) => height - 2 - ((v - min) / (max - min || 1)) * (height - 4);
  const d = pts.map((p, k) => `${k ? 'L' : 'M'}${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
  const last = pts[pts.length - 1];
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true} className="shrink-0">
      <path d={`${d}L${x(last.i)},${height}L${x(pts[0].i)},${height}Z`} fill={color} opacity="0.1" />
      <path d={d} fill="none" stroke={color} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(last.i)} cy={y(last.v)} r="2.2" fill={color} />
    </svg>
  );
}
