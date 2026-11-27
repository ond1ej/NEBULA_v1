// Collaboration graph of a team run: subtasks as nodes, dependency / delegation edges (inline SVG, layered layout).
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { TeamSubtask } from '../types';

export interface GraphNode {
  id: string;
  level: number;
  index: number;
  sub: TeamSubtask;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: 'dependency' | 'delegation';
}

/** Layered layout: level = longest path from a root (dependencies + delegations); order inside a level = creation order. */
export function layoutGraph(subs: TeamSubtask[]): { nodes: GraphNode[]; edges: GraphEdge[]; levels: number } {
  const ids = new Set(subs.map((s) => s.id));
  const edges: GraphEdge[] = [];
  for (const s of subs) {
    for (const d of s.depends_on ?? []) if (ids.has(d)) edges.push({ from: d, to: s.id, kind: 'dependency' });
    if (s.parent_subtask_id && ids.has(s.parent_subtask_id)) edges.push({ from: s.parent_subtask_id, to: s.id, kind: 'delegation' });
  }
  const incoming = new Map<string, string[]>();
  for (const e of edges) incoming.set(e.to, [...(incoming.get(e.to) ?? []), e.from]);
  const memo = new Map<string, number>();
  const visiting = new Set<string>();
  const level = (id: string): number => {
    const m = memo.get(id);
    if (m !== undefined) return m;
    if (visiting.has(id)) return 0; // cycle guard (should not happen)
    visiting.add(id);
    const preds = incoming.get(id) ?? [];
    const l = preds.length ? 1 + Math.max(...preds.map(level)) : 0;
    visiting.delete(id);
    memo.set(id, l);
    return l;
  };
  const ordered = [...subs].sort((a, b) => a.created_at - b.created_at);
  const counters = new Map<number, number>();
  const nodes = ordered.map((s) => {
    const l = level(s.id);
    const i = counters.get(l) ?? 0;
    counters.set(l, i + 1);
    return { id: s.id, level: l, index: i, sub: s };
  });
  const levels = nodes.length ? Math.max(...nodes.map((n) => n.level)) + 1 : 0;
  return { nodes, edges, levels };
}

const STATE_STROKE: Record<string, string> = {
  COMPLETED: 'var(--color-success)',
  RUNNING: 'var(--color-info)',
  FAILED: 'var(--color-danger)',
  READY: 'var(--color-accent-soft)',
};

function truncate(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function CollabGraph({
  subtasks,
  selected,
  onSelect,
}: {
  subtasks: TeamSubtask[];
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [cw, setCw] = useState(900);
  useEffect(() => {
    const el = wrap.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((e) => setCw(Math.round(e[0]?.contentRect.width ?? 900)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const { nodes, edges, levels } = layoutGraph(subtasks);
  if (nodes.length === 0) return <p className="text-sm text-muted">No subtasks yet.</p>;

  const horizontal = cw >= 520;
  const maxPerLevel = Math.max(...Array.from({ length: levels }, (_, l) => nodes.filter((n) => n.level === l).length));
  const pad = 12;
  const GX = horizontal ? 64 : 16;
  const GY = horizontal ? 22 : 52;
  // phones: shrink nodes so a level fits the card width when possible (min 120 px, then the box scrolls)
  const NW = horizontal ? 196 : Math.max(120, Math.min(176, Math.floor((cw - 4 - pad * 2 - (maxPerLevel - 1) * GX) / maxPerLevel)));
  const NH = 66;
  const chars = Math.max(12, Math.floor((NW - 22) / 6.6));
  const pos = (n: GraphNode) =>
    horizontal ? { x: pad + n.level * (NW + GX), y: pad + n.index * (NH + GY) } : { x: pad + n.index * (NW + GX), y: pad + n.level * (NH + GY) };
  const W = horizontal ? pad * 2 + levels * NW + (levels - 1) * GX : pad * 2 + maxPerLevel * NW + (maxPerLevel - 1) * GX;
  const H = horizontal ? pad * 2 + maxPerLevel * NH + (maxPerLevel - 1) * GY : pad * 2 + levels * NH + (levels - 1) * GY;
  const byId = new Map(nodes.map((n) => [n.id, n]));

  const onKey = (e: KeyboardEvent, id: string) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect(id);
    }
  };

  return (
    <div ref={wrap} className="min-w-0">
      <div className="overflow-x-auto rounded-lg border border-border bg-input/60">
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="group" aria-label={`Collaboration graph with ${nodes.length} subtasks`} className="block">
          <defs>
            <marker id="cg-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill="var(--color-border-hover)" />
            </marker>
            <marker id="cg-arrow-d" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill="var(--color-accent-soft)" />
            </marker>
          </defs>
          {edges.map((e, i) => {
            const a = byId.get(e.from);
            const b = byId.get(e.to);
            if (!a || !b) return null;
            const pa = pos(a);
            const pb = pos(b);
            const [x1, y1, x2, y2] = horizontal ? [pa.x + NW, pa.y + NH / 2, pb.x - 2, pb.y + NH / 2] : [pa.x + NW / 2, pa.y + NH, pb.x + NW / 2, pb.y - 2];
            const d = horizontal
              ? `M${x1},${y1} C${x1 + GX / 2},${y1} ${x2 - GX / 2},${y2} ${x2},${y2}`
              : `M${x1},${y1} C${x1},${y1 + GY / 2} ${x2},${y2 - GY / 2} ${x2},${y2}`;
            const del = e.kind === 'delegation';
            return (
              <path
                key={i}
                d={d}
                fill="none"
                stroke={del ? 'var(--color-accent-soft)' : 'var(--color-border-hover)'}
                strokeWidth="1.5"
                strokeDasharray={del ? '5 4' : undefined}
                markerEnd={del ? 'url(#cg-arrow-d)' : 'url(#cg-arrow)'}
              />
            );
          })}
          {nodes.map((n) => {
            const p = pos(n);
            const s = n.sub;
            const stroke = STATE_STROKE[s.state] ?? 'var(--color-border-strong)';
            const sel = selected === n.id;
            const lead = s.parent_subtask_id === 'lead' || s.parent_subtask_id === 'aggregate';
            return (
              <g
                key={n.id}
                transform={`translate(${p.x},${p.y})`}
                role="button"
                tabIndex={0}
                aria-pressed={sel}
                aria-label={`${s.title} by ${s.agent_name ?? 'agent'}: ${s.state.toLowerCase()}`}
                onClick={() => onSelect(n.id)}
                onKeyDown={(e) => onKey(e, n.id)}
                className="cursor-pointer outline-none [&:focus-visible>rect:first-child]:stroke-[var(--color-accent-soft)] [&:focus-visible>rect:first-child]:[stroke-width:2.5]"
              >
                <rect width={NW} height={NH} rx="10" fill={sel ? 'var(--color-panel-3)' : 'var(--color-panel-2)'} stroke={sel ? 'var(--color-accent-soft)' : stroke} strokeWidth={sel ? 2 : 1.25} />
                <rect x="0" y="10" width="3" height={NH - 20} rx="1.5" fill={stroke} />
                <text x="14" y="22" className="fill-text text-[12px] font-semibold">
                  {truncate(s.role, chars)}
                  {lead ? ' ★' : ''}
                </text>
                <text x="14" y="39" className="fill-muted text-[11px]">
                  {truncate(s.agent_name ?? s.agent_id.slice(0, 8), chars + 2)}
                </text>
                <circle cx="17" cy="52" r="3" fill={stroke} className={s.state === 'RUNNING' ? 'animate-pulse-soft' : undefined} />
                <text x="25" y="55.5" className="fill-subtle text-[10px] tracking-wide">
                  {s.state.replace(/_/g, ' ')}
                  {s.attempts > 1 ? ` · try ${s.attempts}/${s.max_attempts}` : ''}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-2xs text-subtle" aria-hidden>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-px w-5 bg-border-hover" /> hand-off (depends on)
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-px w-5 border-t border-dashed border-accent-soft" /> delegated by the lead
        </span>
        <span>★ team lead</span>
      </div>
    </div>
  );
}
