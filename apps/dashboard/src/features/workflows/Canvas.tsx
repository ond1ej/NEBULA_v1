// Workflow canvas: absolutely positioned node cards + an SVG edge layer inside one transformed "world".
// Pointer events only (mouse, pen and touch): drag the background to pan, two fingers / ctrl+wheel to
// zoom, drag a node to move it, drag from an output port onto another block to connect (or tap the port,
// then tap the target block).
import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { StatusPill } from '../../components/StatusPill';
import {
  boundsOf,
  canConnect,
  edgeKey,
  edgeMid,
  edgePath,
  fitViewport,
  groupOf,
  handleLabel,
  handleOf,
  HEADER_H,
  inPortPos,
  isTrigger,
  NODE_W,
  nodeHeight,
  outPortPos,
  PORT_ROW,
  toWorld,
  visibleHandles,
  zoomAt,
  type NodeRunState,
  type Viewport,
} from './graph';
import { IconBolt, IconBranch, IconFit, IconMinus, IconPlayCircle, IconPlus } from './icons';
import type { Position, WfDefinition, WfNode } from './types';

export type Selection = { kind: 'node'; id: string } | { kind: 'edge'; id: string } | null;

export interface CanvasHandle {
  /** World position of a client point, or null when the point is outside the canvas. */
  clientToWorld(clientX: number, clientY: number): Position | null;
  /** World position that puts a new block in the middle of the visible area. */
  centerWorld(): Position;
  fit(): void;
}

interface Props {
  def: WfDefinition;
  labelOf: (type: string) => string;
  selection: Selection;
  onSelect: (s: Selection) => void;
  readOnly?: boolean;
  onMoveNode?: (id: string, pos: Position) => void;
  /** Returns an error message when the connection is refused. */
  onConnect?: (source: string, handle: string, target: string) => string | null;
  onDelete?: () => void;
  onOpen?: (id: string) => void;
  runStates?: Map<string, NodeRunState>;
  taken?: Set<string>;
  errorNodes?: Set<string>;
  warnNodes?: Set<string>;
  /** Changing this value re-fits the view (e.g. when another definition is loaded). */
  fitKey?: string;
  label?: string;
}

type Gesture =
  | { kind: 'none' }
  | { kind: 'pan'; pointerId: number; sx: number; sy: number; orig: Position; moved: boolean; tapNode: string | null }
  | { kind: 'node'; pointerId: number; id: string; sx: number; sy: number; orig: Position; moved: boolean }
  | { kind: 'link'; pointerId: number; sx: number; sy: number; source: string; handle: string; moved: boolean }
  | { kind: 'pinch'; startDist: number; startVp: Viewport; startMid: Position };

interface LinkState {
  source: string;
  handle: string;
  from: Position;
  to: Position;
  over: string | null;
  sticky: boolean;
}

const SNAP = 10;
const snap = (v: number) => Math.round(v / SNAP) * SNAP;

const GROUP_STYLE: Record<string, { icon: string; Icon: typeof IconBolt }> = {
  Triggers: { icon: 'bg-info/15 text-info', Icon: IconBolt },
  Actions: { icon: 'bg-accent/15 text-accent-soft', Icon: IconPlayCircle },
  Logic: { icon: 'bg-warn/15 text-warn', Icon: IconBranch },
};

const RUN_RING: Record<string, string> = {
  RUNNING: 'ring-2 ring-info/80',
  WAITING: 'ring-2 ring-warn/80',
  COMPLETED: 'ring-2 ring-success/60',
  FAILED: 'ring-2 ring-danger/80',
  UNKNOWN: 'ring-2 ring-warn/60',
  SKIPPED: 'opacity-50',
  CANCELLED: 'opacity-60',
};

function edgeStroke(handle: string): { cls: string; dash?: string } {
  if (handle === 'error' || handle === 'denied') return { cls: 'stroke-danger/70', dash: '6 5' };
  if (handle === 'true') return { cls: 'stroke-success/70' };
  if (handle === 'false') return { cls: 'stroke-warn/70' };
  if (handle === 'body') return { cls: 'stroke-accent-soft/70' };
  return { cls: 'stroke-subtle' };
}

function nodeIdAt(clientX: number, clientY: number): string | null {
  if (typeof document.elementFromPoint !== 'function') return null;
  const el = document.elementFromPoint(clientX, clientY);
  return el?.closest('[data-node-id]')?.getAttribute('data-node-id') ?? null;
}

export const WorkflowCanvas = forwardRef<CanvasHandle, Props>(function WorkflowCanvas(
  {
    def,
    labelOf,
    selection,
    onSelect,
    readOnly = false,
    onMoveNode,
    onConnect,
    onDelete,
    onOpen,
    runStates,
    taken,
    errorNodes,
    warnNodes,
    fitKey,
    label = 'Workflow canvas',
  },
  ref,
) {
  const rootRef = useRef<HTMLDivElement>(null);
  const helpId = useId();
  const [vp, setVp] = useState<Viewport>({ x: 40, y: 40, k: 1 });
  const vpRef = useRef(vp);
  vpRef.current = vp;
  const [drag, setDrag] = useState<{ id: string; x: number; y: number } | null>(null);
  const [link, setLink] = useState<LinkState | null>(null);
  const linkRef = useRef(link);
  linkRef.current = link;
  const [hint, setHint] = useState<string | null>(null);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gesture = useRef<Gesture>({ kind: 'none' });
  const pointers = useRef(new Map<number, Position>());

  const layout = useMemo(() => {
    const m = new Map<string, { node: WfNode; pos: Position; handles: string[]; height: number }>();
    for (const n of def.nodes) {
      const handles = visibleHandles(n, def.edges);
      const pos = drag && drag.id === n.id ? { x: drag.x, y: drag.y } : (n.position ?? { x: 0, y: 0 });
      m.set(n.id, { node: n, pos, handles, height: nodeHeight(handles.length) });
    }
    return m;
  }, [def, drag]);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  const flash = useCallback((msg: string | null, ms = 3500) => {
    if (hintTimer.current) clearTimeout(hintTimer.current);
    setHint(msg);
    if (msg && ms > 0) hintTimer.current = setTimeout(() => setHint(null), ms);
  }, []);
  useEffect(() => () => {
    if (hintTimer.current) clearTimeout(hintTimer.current);
  }, []);

  const rect = () => rootRef.current?.getBoundingClientRect() ?? new DOMRect(0, 0, 0, 0);

  const fit = useCallback(() => {
    const r = rootRef.current?.getBoundingClientRect();
    if (!r) return;
    const items = [...layoutRef.current.values()].map((l) => ({ position: l.pos, height: l.height }));
    setVp(fitViewport(boundsOf(items), r.width, r.height));
  }, []);

  useLayoutEffect(() => {
    fit();
  }, [fitKey, fit]);

  useImperativeHandle(
    ref,
    () => ({
      clientToWorld(cx, cy) {
        const r = rect();
        if (cx < r.left || cx > r.right || cy < r.top || cy > r.bottom) return null;
        return toWorld(vpRef.current, cx - r.left, cy - r.top);
      },
      centerWorld() {
        const r = rect();
        const c = toWorld(vpRef.current, r.width / 2, r.height / 2);
        return { x: c.x - NODE_W / 2, y: c.y - 50 };
      },
      fit,
    }),
    [fit],
  );

  const zoomBy = useCallback((f: number) => {
    const r = rect();
    setVp((v) => zoomAt(v, v.k * f, r.width / 2, r.height / 2));
  }, []);

  // Non-passive wheel listener (React's onWheel is passive): ctrl/⌘ + wheel or trackpad pinch zooms, wheel pans.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? r.height : 1;
      if (e.ctrlKey || e.metaKey) {
        const f = Math.exp(-e.deltaY * unit * 0.01);
        setVp((v) => zoomAt(v, v.k * f, e.clientX - r.left, e.clientY - r.top));
      } else {
        setVp((v) => ({ ...v, x: v.x - e.deltaX * unit, y: v.y - e.deltaY * unit }));
      }
    };
    const noGesture = (e: Event) => e.preventDefault(); // Safari page pinch-zoom
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('gesturestart', noGesture);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('gesturestart', noGesture);
    };
  }, []);

  const tryConnect = (source: string, handle: string, target: string) => {
    const err = onConnect?.(source, handle, target) ?? null;
    flash(err);
  };

  const cancelLink = () => {
    setLink(null);
    flash(null);
  };

  const capture = (id: number) => {
    try {
      rootRef.current?.setPointerCapture(id);
    } catch {
      // pointer already released (e.g. synthetic events in tests)
    }
  };

  // ------------------------------------------------------------ pointer handling
  const onPointerDownCapture = (e: ReactPointerEvent<HTMLDivElement>) => {
    if ((e.target as Element).closest('[data-no-pan]')) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      if (gesture.current.kind === 'node') setDrag(null);
      if (gesture.current.kind === 'link') setLink(null);
      const r = rect();
      gesture.current = {
        kind: 'pinch',
        startDist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
        startVp: vpRef.current,
        startMid: { x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top },
      };
      capture(e.pointerId);
      e.stopPropagation();
    }
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (gesture.current.kind === 'pinch') return;
    const target = e.target as Element;
    if (target.closest('[data-no-pan]')) return;
    if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 1) return;
    const root = rootRef.current;
    if (!root) return;
    const portEl = target.closest<HTMLElement>('[data-port-out]');
    const nodeEl = target.closest<HTMLElement>('[data-node-id]');
    const edgeEl = target.closest('[data-edge-id]');
    const nodeId = nodeEl?.dataset.nodeId ?? null;
    const sticky = linkRef.current?.sticky ? linkRef.current : null;

    if (sticky && !portEl) {
      e.preventDefault();
      if (nodeId && nodeId !== sticky.source) tryConnect(sticky.source, sticky.handle, nodeId);
      else flash(null);
      setLink(null);
      return;
    }
    if (e.button === 1) {
      gesture.current = { kind: 'pan', pointerId: e.pointerId, sx: e.clientX, sy: e.clientY, orig: { x: vp.x, y: vp.y }, moved: false, tapNode: null };
      capture(e.pointerId);
      e.preventDefault();
      return;
    }
    if (portEl && nodeId && !readOnly) {
      const l = layout.get(nodeId);
      const handle = portEl.dataset.portOut ?? 'out';
      if (!l) return;
      const from = outPortPos(l.pos, Math.max(0, l.handles.indexOf(handle)));
      setLink({ source: nodeId, handle, from, to: from, over: null, sticky: false });
      gesture.current = { kind: 'link', pointerId: e.pointerId, sx: e.clientX, sy: e.clientY, source: nodeId, handle, moved: false };
      capture(e.pointerId);
      e.preventDefault();
      return;
    }
    if (nodeId && nodeEl) {
      onSelect({ kind: 'node', id: nodeId });
      nodeEl.focus({ preventScroll: true });
      if (e.pointerType === 'mouse') e.preventDefault();
      if (readOnly) {
        gesture.current = { kind: 'pan', pointerId: e.pointerId, sx: e.clientX, sy: e.clientY, orig: { x: vp.x, y: vp.y }, moved: false, tapNode: nodeId };
      } else {
        const l = layout.get(nodeId);
        gesture.current = { kind: 'node', pointerId: e.pointerId, id: nodeId, sx: e.clientX, sy: e.clientY, orig: l?.pos ?? { x: 0, y: 0 }, moved: false };
      }
      capture(e.pointerId);
      return;
    }
    if (edgeEl && !readOnly) {
      const id = edgeEl.getAttribute('data-edge-id');
      if (id) onSelect({ kind: 'edge', id });
      root.focus({ preventScroll: true });
      e.preventDefault();
      return;
    }
    gesture.current = { kind: 'pan', pointerId: e.pointerId, sx: e.clientX, sy: e.clientY, orig: { x: vp.x, y: vp.y }, moved: false, tapNode: null };
    capture(e.pointerId);
    if (e.pointerType === 'mouse') e.preventDefault();
    root.focus({ preventScroll: true });
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    if (g.kind === 'pinch') {
      if (pointers.current.size < 2) return;
      const [a, b] = [...pointers.current.values()];
      const r = rect();
      const mid = { x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top };
      const z = zoomAt(g.startVp, (g.startVp.k * Math.hypot(a.x - b.x, a.y - b.y)) / g.startDist, g.startMid.x, g.startMid.y);
      setVp({ k: z.k, x: z.x + (mid.x - g.startMid.x), y: z.y + (mid.y - g.startMid.y) });
      return;
    }
    if (g.kind === 'none') {
      const l = linkRef.current;
      if (l?.sticky && e.pointerType === 'mouse') {
        const r = rect();
        setLink({ ...l, to: toWorld(vpRef.current, e.clientX - r.left, e.clientY - r.top) });
      }
      return;
    }
    if (g.pointerId !== e.pointerId) return;
    const dx = e.clientX - g.sx;
    const dy = e.clientY - g.sy;
    if (!g.moved && Math.hypot(dx, dy) < (e.pointerType === 'touch' ? 8 : 4)) return;
    g.moved = true;
    if (g.kind === 'pan') {
      setVp((v) => ({ ...v, x: g.orig.x + dx, y: g.orig.y + dy }));
    } else if (g.kind === 'node') {
      const k = vpRef.current.k;
      setDrag({ id: g.id, x: g.orig.x + dx / k, y: g.orig.y + dy / k });
    } else if (g.kind === 'link') {
      const r = rect();
      const over = nodeIdAt(e.clientX, e.clientY);
      setLink((l) =>
        l ? { ...l, to: toWorld(vpRef.current, e.clientX - r.left, e.clientY - r.top), over: over && over !== l.source ? over : null } : l,
      );
    }
  };

  const endPointer = (e: ReactPointerEvent<HTMLDivElement>, cancelled: boolean) => {
    pointers.current.delete(e.pointerId);
    const g = gesture.current;
    if (g.kind === 'pinch') {
      if (pointers.current.size === 0) gesture.current = { kind: 'none' };
      return;
    }
    if (g.kind === 'none' || g.pointerId !== e.pointerId) return;
    gesture.current = { kind: 'none' };
    if (g.kind === 'pan') {
      if (!g.moved && !cancelled && !g.tapNode) onSelect(null);
      return;
    }
    if (g.kind === 'node') {
      setDrag(null);
      if (g.moved && !cancelled && onMoveNode) {
        const k = vpRef.current.k;
        onMoveNode(g.id, { x: snap(g.orig.x + (e.clientX - g.sx) / k), y: snap(g.orig.y + (e.clientY - g.sy) / k) });
      }
      return;
    }
    if (g.kind === 'link') {
      if (cancelled) {
        setLink(null);
        return;
      }
      const target = nodeIdAt(e.clientX, e.clientY);
      if (target && target !== g.source) {
        setLink(null);
        tryConnect(g.source, g.handle, target);
      } else if (!g.moved) {
        setLink((l) => (l ? { ...l, sticky: true } : l));
        flash('Now tap the block to connect to — or empty space to cancel.', 0);
      } else {
        setLink(null);
      }
    }
  };

  // ------------------------------------------------------------ keyboard
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    if (t.closest('input, textarea, select, [contenteditable="true"]')) return;
    if (e.key === 'Escape') {
      if (link) {
        e.preventDefault();
        e.stopPropagation();
        cancelLink();
      } else if (selection) {
        e.preventDefault();
        e.stopPropagation();
        onSelect(null);
      }
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && selection && !readOnly) {
      e.preventDefault();
      onDelete?.();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      zoomBy(1.2);
      return;
    }
    if (e.key === '-' || e.key === '_') {
      e.preventDefault();
      zoomBy(1 / 1.2);
      return;
    }
    if (e.key === '0') {
      e.preventDefault();
      fit();
      return;
    }
    const nodeId = t.closest('[data-node-id]')?.getAttribute('data-node-id');
    if (!nodeId) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect({ kind: 'node', id: nodeId });
      onOpen?.(nodeId);
      return;
    }
    const dir: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const d = dir[e.key];
    if (d && !readOnly && onMoveNode) {
      e.preventDefault();
      const l = layout.get(nodeId);
      if (!l) return;
      const step = e.shiftKey ? 50 : 10;
      onMoveNode(nodeId, { x: l.pos.x + d[0] * step, y: l.pos.y + d[1] * step });
    }
  };

  // ------------------------------------------------------------ render
  const edgeGeo = def.edges.flatMap((e) => {
    const s = layout.get(e.source);
    const t = layout.get(e.target);
    if (!s || !t) return [];
    const h = handleOf(e);
    const idx = s.handles.indexOf(h);
    const a = outPortPos(s.pos, idx < 0 ? s.handles.length - 1 : idx);
    const b = inPortPos(t.pos);
    return [{ id: edgeKey(e), h, a, b, d: edgePath(a, b), mid: edgeMid(a, b) }];
  });
  // The SVG viewport covers every node, edge curve and the pending link (no reliance on overflow hit-testing).
  const box = (() => {
    let minX = 0;
    let minY = 0;
    let maxX = 1;
    let maxY = 1;
    const add = (x: number, y: number) => {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    };
    for (const l of layout.values()) {
      add(l.pos.x - 40, l.pos.y - 40);
      add(l.pos.x + NODE_W + 40, l.pos.y + l.height + 40);
    }
    for (const g of edgeGeo) {
      const dx = Math.max(40, Math.abs(g.b.x - g.a.x) / 2);
      add(g.a.x + dx + 20, g.a.y);
      add(g.b.x - dx - 20, g.b.y);
    }
    if (link) {
      add(link.to.x - 60, link.to.y - 60);
      add(link.to.x + 60, link.to.y + 60);
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  })();
  const linkCheck = link?.over ? canConnect(def, link.source, link.handle, link.over) : null;
  const gridSize = 22 * vp.k;

  return (
    <div
      ref={rootRef}
      role="region"
      aria-label={label}
      aria-describedby={helpId}
      tabIndex={0}
      data-wf-canvas
      onPointerDownCapture={onPointerDownCapture}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => endPointer(e, false)}
      onPointerCancel={(e) => endPointer(e, true)}
      onLostPointerCapture={(e) => {
        if (gesture.current.kind === 'none') pointers.current.delete(e.pointerId);
      }}
      onKeyDown={onKeyDown}
      className="relative h-full w-full touch-none overflow-hidden bg-bg outline-none select-none focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:ring-inset"
      style={{
        backgroundImage: 'radial-gradient(circle, rgb(255 255 255 / 0.075) 1px, transparent 1.3px)',
        backgroundSize: `${gridSize}px ${gridSize}px`,
        backgroundPosition: `${vp.x}px ${vp.y}px`,
        cursor: gesture.current.kind === 'pan' && gesture.current.moved ? 'grabbing' : link ? 'crosshair' : 'default',
      }}
    >
      <p id={helpId} className="sr-only">
        {readOnly
          ? 'Read-only view of a workflow run. Tab moves between blocks; select a block to see its steps. Plus and minus zoom, 0 fits the view.'
          : 'Tab moves between blocks. Arrow keys move the focused block (Shift for larger steps), Delete removes the selection, Enter edits the block. Connections can also be added in the block panel. Plus and minus zoom, 0 fits the view.'}
      </p>
      <div className="absolute top-0 left-0 origin-top-left" style={{ transform: `translate(${vp.x}px, ${vp.y}px) scale(${vp.k})` }}>
        <svg
          className="pointer-events-none absolute overflow-visible"
          style={{ left: box.x, top: box.y }}
          width={box.w}
          height={box.h}
          viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`}
          aria-hidden
        >
          {edgeGeo.map(({ id, h, b, d, mid }) => {
            const sel = selection?.kind === 'edge' && selection.id === id;
            const isTaken = taken?.has(id) ?? false;
            const st = edgeStroke(h);
            return (
              <g key={id}>
                <path
                  d={d}
                  data-edge-id={id}
                  className="fill-none stroke-transparent"
                  strokeWidth={18}
                  style={{ pointerEvents: readOnly ? 'none' : 'stroke', cursor: 'pointer' }}
                />
                <path
                  d={d}
                  className={`fill-none ${sel ? 'stroke-accent-soft' : isTaken ? 'stroke-success' : st.cls}`}
                  strokeWidth={sel || isTaken ? 2.75 : 1.75}
                  strokeDasharray={isTaken ? undefined : st.dash}
                  opacity={taken && !isTaken ? 0.35 : 1}
                />
                <circle cx={b.x} cy={b.y} r={2.5} className={sel ? 'fill-accent-soft' : 'fill-subtle'} opacity={taken && !isTaken ? 0.35 : 1} />
                {h !== 'out' && (
                  <text
                    x={mid.x}
                    y={mid.y - 6}
                    textAnchor="middle"
                    className="fill-muted text-[11px] font-medium"
                    stroke="var(--color-bg)"
                    strokeWidth={4}
                    paintOrder="stroke"
                  >
                    {handleLabel(h)}
                  </text>
                )}
              </g>
            );
          })}
          {link && <path d={edgePath(link.from, link.to)} className="fill-none stroke-accent-soft" strokeWidth={2} strokeDasharray="5 4" />}
        </svg>
        {[...layout.values()].map(({ node, pos, handles, height }) => (
          <NodeCard
            key={node.id}
            node={node}
            pos={pos}
            handles={handles}
            height={height}
            typeLabel={labelOf(node.type)}
            selected={selection?.kind === 'node' && selection.id === node.id}
            dragging={drag?.id === node.id}
            readOnly={readOnly}
            run={runStates ? (runStates.get(node.id) ?? null) : undefined}
            invalid={errorNodes?.has(node.id) ?? false}
            needsSetup={warnNodes?.has(node.id) ?? false}
            linkTarget={link?.over === node.id ? (linkCheck?.ok ? 'ok' : 'bad') : link?.sticky && link.source !== node.id ? 'maybe' : null}
            linkSource={link?.source === node.id ? link.handle : null}
            onFocus={() => {
              if (!(selection?.kind === 'node' && selection.id === node.id)) onSelect({ kind: 'node', id: node.id });
            }}
          />
        ))}
      </div>

      {def.nodes.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-muted">
          Drag a block from the palette onto the canvas, or tap a block to add it.
        </div>
      )}

      {(hint || (link && !link.sticky && linkCheck && !linkCheck.ok)) && (
        <div className="pointer-events-none absolute inset-x-0 top-3 flex justify-center px-3" role="status" aria-live="polite">
          <p className="max-w-md rounded-md border border-border bg-panel-2/95 px-3 py-2 text-center text-xs text-text shadow-pop">
            {link && !link.sticky && linkCheck && !linkCheck.ok ? linkCheck.reason : hint}
          </p>
        </div>
      )}

      <div data-no-pan className="absolute right-3 bottom-3 flex items-center gap-1 rounded-lg border border-border bg-panel/95 p-1 shadow-pop">
        <CtrlButton label="Zoom out" onClick={() => zoomBy(1 / 1.2)}>
          <IconMinus />
        </CtrlButton>
        <button
          type="button"
          onClick={() => {
            const r = rect();
            setVp((v) => zoomAt(v, 1, r.width / 2, r.height / 2));
          }}
          aria-label={`Zoom ${Math.round(vp.k * 100)} percent, reset to 100 percent`}
          className="h-11 min-w-12 rounded-md px-1 font-mono text-[11px] text-muted tabular-nums hover:bg-panel-3 hover:text-text focus-visible:outline-2 focus-visible:outline-accent sm:h-8"
        >
          {Math.round(vp.k * 100)}%
        </button>
        <CtrlButton label="Zoom in" onClick={() => zoomBy(1.2)}>
          <IconPlus />
        </CtrlButton>
        <CtrlButton label="Fit all blocks in view" onClick={fit}>
          <IconFit />
        </CtrlButton>
      </div>
    </div>
  );
});

function CtrlButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="flex size-11 items-center justify-center rounded-md text-muted hover:bg-panel-3 hover:text-text focus-visible:outline-2 focus-visible:outline-accent sm:size-8"
    >
      {children}
    </button>
  );
}

function NodeCard({
  node,
  pos,
  handles,
  height,
  typeLabel,
  selected,
  dragging,
  readOnly,
  run,
  invalid,
  needsSetup,
  linkTarget,
  linkSource,
  onFocus,
}: {
  node: WfNode;
  pos: Position;
  handles: string[];
  height: number;
  typeLabel: string;
  selected: boolean;
  dragging: boolean;
  readOnly: boolean;
  /** undefined: not in run view; null: run view, block not reached (yet). */
  run: NodeRunState | null | undefined;
  invalid: boolean;
  needsSetup: boolean;
  linkTarget: 'ok' | 'bad' | 'maybe' | null;
  linkSource: string | null;
  onFocus: () => void;
}) {
  const group = groupOf(node.type) ?? 'Actions';
  const gs = GROUP_STYLE[group] ?? GROUP_STYLE.Actions;
  const trigger = isTrigger(node.type);
  const title = node.label || typeLabel;
  const runCls = run ? (RUN_RING[run.state] ?? '') : run === null ? 'opacity-75' : '';
  const ring = selected
    ? 'border-accent ring-2 ring-accent/45'
    : linkTarget === 'ok'
      ? 'border-success ring-2 ring-success/50'
      : linkTarget === 'bad'
        ? 'border-danger ring-2 ring-danger/50'
        : invalid
          ? 'border-danger/80'
          : 'border-border-strong';
  const runLabel = run
    ? `${run.state.replace(/_/g, ' ')}${run.attempt > 1 ? ` · try ${run.attempt}` : ''}${run.iterations > 0 ? ` · ${run.iterations}×` : ''}`
    : null;
  const aria = [
    title,
    typeLabel !== title ? typeLabel : null,
    run ? `state ${run.state.toLowerCase()}` : run === null ? 'not run' : null,
    invalid ? 'has an error' : needsSetup ? 'needs setup' : null,
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <div
      data-node-id={node.id}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={aria}
      onFocus={onFocus}
      className={`absolute flex flex-col rounded-lg border bg-panel-2 shadow-card transition-[box-shadow,opacity] outline-none focus-visible:ring-2 focus-visible:ring-accent ${ring} ${runCls} ${
        dragging ? 'z-10 shadow-pop' : ''
      } ${readOnly ? 'cursor-pointer' : 'cursor-grab active:cursor-grabbing'}`}
      style={{ left: pos.x, top: pos.y, width: NODE_W, height }}
    >
      {!trigger && (
        <span
          data-port-in
          aria-hidden
          className={`absolute -left-[7px] size-3.5 rounded-full border-2 bg-panel ${linkTarget === 'ok' ? 'border-success' : 'border-subtle'}`}
          style={{ top: HEADER_H / 2 - 7 }}
        />
      )}
      <div className="flex shrink-0 items-center gap-2.5 border-b border-border/70 px-3" style={{ height: HEADER_H }}>
        <span className={`flex size-7 shrink-0 items-center justify-center rounded-md ${gs.icon}`}>
          <gs.Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] leading-tight font-semibold text-text">{title}</p>
          <p className="truncate font-mono text-[10.5px] leading-tight text-subtle">{node.id}</p>
        </div>
        {run?.state === 'RUNNING' && <span aria-hidden className="size-2 shrink-0 animate-pulse rounded-full bg-info" />}
      </div>
      <div className="relative flex-1">
        <div className="absolute bottom-2 left-3 max-w-[110px]">
          {runLabel ? (
            <StatusPill state={run?.state} label={runLabel} pulse={run?.state === 'RUNNING'} />
          ) : invalid ? (
            <span className="text-[11px] font-medium text-danger">Error</span>
          ) : needsSetup ? (
            <span className="text-[11px] font-medium text-warn">Needs setup</span>
          ) : null}
        </div>
        {handles.map((h, i) => (
          <div
            key={h}
            className="absolute right-0 flex items-center justify-end pr-3 text-[11px] text-muted"
            style={{ top: i * PORT_ROW, height: PORT_ROW, maxWidth: NODE_W - 16 }}
          >
            <span className={`truncate ${linkSource === h ? 'text-accent-soft' : ''}`}>{handleLabel(h)}</span>
            {!readOnly ? (
              <span
                data-port-out={h}
                aria-hidden
                title={`Drag to connect “${handleLabel(h)}”`}
                className="absolute top-1/2 -right-[15px] flex size-[30px] -translate-y-1/2 cursor-crosshair items-center justify-center"
              >
                <span
                  className={`size-3.5 rounded-full border-2 bg-panel transition-colors ${
                    linkSource === h ? 'border-accent-soft bg-accent' : h === 'error' || h === 'denied' ? 'border-danger/80' : 'border-accent-soft/80'
                  } hover:bg-accent-soft`}
                />
              </span>
            ) : (
              <span aria-hidden className="absolute top-1/2 -right-[7px] size-3.5 -translate-y-1/2 rounded-full border-2 border-subtle bg-panel" />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
