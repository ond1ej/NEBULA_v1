// Pure graph helpers for the workflow editor. Mirrors the rules of
// apps/host-api/nebula_host/workflows.py (validate, handles_of, loop_body) so the editor can refuse
// obviously invalid edits immediately; the server stays the authority (POST /workflows/validate).
import type { CatalogBlock, Params, Position, StepState, WfDefinition, WfEdge, WfNode, WorkflowStep } from './types';

export const TRIGGER_TYPES = new Set([
  'trigger.manual',
  'trigger.schedule',
  'trigger.telegram_message',
  'trigger.task_completed',
  'trigger.file_created',
]);
export const ACTION_TYPES = new Set([
  'action.run_agent',
  'action.run_team',
  'action.read_file',
  'action.write_file',
  'action.browser_task',
  'action.generate_report',
  'action.send_telegram',
  'action.create_task',
  'action.execute_command',
]);
export const LOGIC_TYPES = new Set([
  'logic.condition',
  'logic.branch',
  'logic.delay',
  'logic.retry',
  'logic.loop',
  'logic.parallel',
  'logic.wait_approval',
]);

/** workflows.REQUIRED */
export const REQUIRED: Record<string, string[]> = {
  'action.run_agent': ['agent_id', 'prompt'],
  'action.run_team': ['team_id', 'prompt'],
  'action.read_file': ['root', 'path'],
  'action.write_file': ['root', 'path', 'content'],
  'action.browser_task': ['agent_id', 'url', 'instructions'],
  'action.generate_report': ['template'],
  'action.send_telegram': ['text'],
  'action.create_task': ['agent_id', 'prompt'],
  'action.execute_command': ['agent_id', 'command'],
  'logic.condition': ['left', 'op'],
  'logic.branch': ['value', 'cases'],
  'logic.delay': ['seconds'],
  'logic.retry': ['max_attempts'],
  'logic.loop': [],
  'logic.wait_approval': ['summary'],
  'trigger.schedule': ['kind'],
  'trigger.telegram_message': ['command'],
};

export const MAX_NODES = 60;
export const MAX_LOOP = 50;
const NODE_ID_RE = /^[\w-]{1,64}$/;

export type Group = 'Triggers' | 'Actions' | 'Logic';

export function groupOf(type: string): Group | null {
  if (TRIGGER_TYPES.has(type)) return 'Triggers';
  if (ACTION_TYPES.has(type)) return 'Actions';
  if (LOGIC_TYPES.has(type)) return 'Logic';
  return null;
}

export const isTrigger = (type: string) => TRIGGER_TYPES.has(type);

export function casesOf(params: Params): string[] {
  const c = params.cases;
  return Array.isArray(c) ? c.map((x) => String(x)) : [];
}

/** Output handles of a block, in display order (workflows.handles_of). */
export function handlesOf(type: string, params: Params = {}): string[] {
  if (type === 'logic.condition') return ['true', 'false', 'error'];
  if (type === 'logic.branch') {
    const cases = casesOf(params).filter((c, i, a) => a.indexOf(c) === i && c !== 'default' && c !== 'error');
    return [...cases, 'default', 'error'];
  }
  if (type === 'logic.loop') return ['body', 'done', 'error'];
  if (type === 'logic.wait_approval') return ['out', 'denied'];
  return ['out', 'error'];
}

/** Blocks that never fail on their own: their (valid) `error` port is only drawn when already used. */
const NO_ERROR_PORT = new Set([...TRIGGER_TYPES, 'logic.retry', 'logic.parallel']);

/** Handles drawn as ports on the canvas. */
export function visibleHandles(node: WfNode, edges: WfEdge[]): string[] {
  const all = handlesOf(node.type, node.params);
  if (!NO_ERROR_PORT.has(node.type)) return all;
  return all.filter((h) => h !== 'error' || edges.some((e) => e.source === node.id && handleOf(e) === 'error'));
}

export const HANDLE_LABELS: Record<string, string> = {
  out: 'next',
  error: 'on error',
  true: 'true',
  false: 'false',
  body: 'each item',
  done: 'done',
  denied: 'denied',
  default: 'default',
};

export const handleLabel = (h: string) => HANDLE_LABELS[h] ?? h;
export const handleOf = (e: WfEdge) => e.handle ?? 'out';
export const edgeIdOf = (source: string, handle: string, target: string) => `${source}-${handle}-${target}`;
export const edgeKey = (e: WfEdge) => e.id ?? edgeIdOf(e.source, handleOf(e), e.target);

// ---------------------------------------------------------------- reachability / cycles
function adjacency(edges: WfEdge[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const e of edges) {
    const l = out.get(e.source);
    if (l) l.push(e.target);
    else out.set(e.source, [e.target]);
  }
  return out;
}

/** True when `to` can be reached from `from` following edges. */
export function reaches(edges: WfEdge[], from: string, to: string): boolean {
  const adj = adjacency(edges);
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length) {
    const n = stack.pop() as string;
    if (n === to) return true;
    if (seen.has(n)) continue;
    seen.add(n);
    for (const t of adj.get(n) ?? []) stack.push(t);
  }
  return false;
}

export function wouldCreateCycle(edges: WfEdge[], source: string, target: string): boolean {
  return source === target || reaches(edges, target, source);
}

export function hasCycle(def: WfDefinition): boolean {
  const indeg = new Map(def.nodes.map((n) => [n.id, 0]));
  for (const e of def.edges) if (indeg.has(e.target)) indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
  const adj = adjacency(def.edges);
  const q = [...indeg].filter(([, d]) => d === 0).map(([i]) => i);
  let seen = 0;
  while (q.length) {
    const i = q.pop() as string;
    seen += 1;
    for (const t of adj.get(i) ?? []) {
      const d = (indeg.get(t) ?? 0) - 1;
      indeg.set(t, d);
      if (d === 0) q.push(t);
    }
  }
  return seen !== def.nodes.length;
}

/** workflows.loop_body: everything reachable from the loop's `body` handle. */
export function loopBody(loopId: string, edges: WfEdge[]): Set<string> {
  const body = new Set<string>();
  const adj = adjacency(edges);
  const stack = edges.filter((e) => e.source === loopId && handleOf(e) === 'body').map((e) => e.target);
  while (stack.length) {
    const i = stack.pop() as string;
    if (body.has(i)) continue;
    body.add(i);
    for (const t of adj.get(i) ?? []) stack.push(t);
  }
  return body;
}

/** Ancestors of a node (for template suggestions such as {{nodes.<id>.summary}}). */
export function upstreamOf(def: WfDefinition, nodeId: string): string[] {
  const rev = new Map<string, string[]>();
  for (const e of def.edges) {
    const l = rev.get(e.target);
    if (l) l.push(e.source);
    else rev.set(e.target, [e.source]);
  }
  const seen = new Set<string>();
  const stack = [...(rev.get(nodeId) ?? [])];
  while (stack.length) {
    const i = stack.pop() as string;
    if (seen.has(i) || i === nodeId) continue;
    seen.add(i);
    stack.push(...(rev.get(i) ?? []));
  }
  return def.nodes.map((n) => n.id).filter((id) => seen.has(id));
}

// ---------------------------------------------------------------- edits
export type Check = { ok: true } | { ok: false; reason: string };

export function canConnect(def: WfDefinition, source: string, handle: string, target: string): Check {
  const src = def.nodes.find((n) => n.id === source);
  const dst = def.nodes.find((n) => n.id === target);
  if (!src || !dst) return { ok: false, reason: 'Both blocks must exist.' };
  if (source === target) return { ok: false, reason: 'A block cannot connect to itself.' };
  if (isTrigger(dst.type)) return { ok: false, reason: 'Triggers cannot have incoming connections.' };
  if (!handlesOf(src.type, src.params).includes(handle))
    return { ok: false, reason: `“${handle}” is not an output of this block.` };
  if (def.edges.some((e) => e.source === source && e.target === target && handleOf(e) === handle))
    return { ok: false, reason: 'This connection already exists.' };
  if (src.type === 'logic.retry') {
    if (def.edges.some((e) => e.source === source)) return { ok: false, reason: 'A Retry block connects to exactly one action.' };
    if (!ACTION_TYPES.has(dst.type)) return { ok: false, reason: 'A Retry block must connect to an action block.' };
  }
  if (wouldCreateCycle(def.edges, source, target))
    return { ok: false, reason: 'This would create a cycle — use a Loop block (with a limit) for repetition.' };
  return { ok: true };
}

export function addEdge(
  def: WfDefinition,
  source: string,
  handle: string,
  target: string,
): { def: WfDefinition; error: string | null } {
  const c = canConnect(def, source, handle, target);
  if (!c.ok) return { def, error: c.reason };
  const edge: WfEdge = { id: edgeIdOf(source, handle, target), source, target, handle };
  return { def: { ...def, edges: [...def.edges, edge] }, error: null };
}

export function removeEdge(def: WfDefinition, edgeId: string): WfDefinition {
  return { ...def, edges: def.edges.filter((e) => edgeKey(e) !== edgeId) };
}

export function removeNode(def: WfDefinition, nodeId: string): WfDefinition {
  return {
    ...def,
    nodes: def.nodes.filter((n) => n.id !== nodeId),
    edges: def.edges.filter((e) => e.source !== nodeId && e.target !== nodeId),
  };
}

export function moveNode(def: WfDefinition, nodeId: string, position: Position): WfDefinition {
  const p = { x: Math.round(position.x), y: Math.round(position.y) };
  return { ...def, nodes: def.nodes.map((n) => (n.id === nodeId ? { ...n, position: p } : n)) };
}

export function updateNode(def: WfDefinition, nodeId: string, patch: Partial<Pick<WfNode, 'label' | 'params'>>): WfDefinition {
  const next = { ...def, nodes: def.nodes.map((n) => (n.id === nodeId ? { ...n, ...patch } : n)) };
  return pruneInvalidEdges(next).def;
}

/** Drop edges whose handle no longer exists (e.g. a removed Branch case) or whose endpoints are gone. */
export function pruneInvalidEdges(def: WfDefinition): { def: WfDefinition; removed: WfEdge[] } {
  const byId = new Map(def.nodes.map((n) => [n.id, n]));
  const removed: WfEdge[] = [];
  const edges = def.edges.filter((e) => {
    const src = byId.get(e.source);
    const ok = !!src && byId.has(e.target) && handlesOf(src.type, src.params).includes(handleOf(e));
    if (!ok) removed.push(e);
    return ok;
  });
  return removed.length ? { def: { ...def, edges }, removed } : { def, removed };
}

/** Rename an output handle (Branch case renamed) and keep its connections. */
export function renameHandle(def: WfDefinition, nodeId: string, from: string, to: string): WfDefinition {
  if (from === to) return def;
  return {
    ...def,
    edges: def.edges.map((e) =>
      e.source === nodeId && handleOf(e) === from ? { ...e, handle: to, id: edgeIdOf(e.source, to, e.target) } : e,
    ),
  };
}

export function newNodeId(type: string, existing: Iterable<string>): string {
  const taken = new Set(existing);
  const base = (type.split('.').pop() || 'block').replace(/[^\w-]/g, '_').slice(0, 56) || 'block';
  for (let i = 1; ; i += 1) {
    const id = `${base}_${i}`;
    if (!taken.has(id)) return id;
  }
}

export const isValidNodeId = (id: string) => NODE_ID_RE.test(id);

function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

export function createNode(block: Pick<CatalogBlock, 'type' | 'label' | 'params'>, position: Position, existing: Iterable<string>): WfNode {
  return {
    id: newNodeId(block.type, existing),
    type: block.type,
    label: block.label,
    params: clone(block.params ?? {}),
    position: { x: Math.round(position.x), y: Math.round(position.y) },
  };
}

// ---------------------------------------------------------------- loading
export function emptyDefinition(): WfDefinition {
  return {
    schema_version: 1,
    nodes: [{ id: 'manual_1', type: 'trigger.manual', label: 'Manual', params: {}, position: { x: 80, y: 120 } }],
    edges: [],
  };
}

/** Accepts a stored / imported definition and fills in what the editor needs (positions, edge ids). */
export function normalizeDefinition(raw: unknown): WfDefinition {
  const r = (raw && typeof raw === 'object' ? raw : {}) as { nodes?: unknown; edges?: unknown };
  const nodes: WfNode[] = (Array.isArray(r.nodes) ? r.nodes : [])
    .filter((n): n is Record<string, unknown> => !!n && typeof n === 'object')
    .map((n) => {
      const pos = n.position as Partial<Position> | undefined;
      const hasPos = pos && Number.isFinite(pos.x) && Number.isFinite(pos.y);
      return {
        id: String(n.id ?? ''),
        type: String(n.type ?? ''),
        label: typeof n.label === 'string' ? n.label : undefined,
        params: n.params && typeof n.params === 'object' && !Array.isArray(n.params) ? (n.params as Params) : {},
        position: hasPos ? { x: Number(pos.x), y: Number(pos.y) } : undefined,
      };
    });
  const edges: WfEdge[] = (Array.isArray(r.edges) ? r.edges : [])
    .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object')
    .map((e) => {
      const source = String(e.source ?? '');
      const target = String(e.target ?? '');
      const handle = typeof e.handle === 'string' && e.handle ? e.handle : 'out';
      return { id: typeof e.id === 'string' && e.id ? e.id : edgeIdOf(source, handle, target), source, target, handle };
    });
  return autoLayout({ schema_version: 1, nodes, edges });
}

/** Places nodes without a position in columns by their depth in the graph. */
export function autoLayout(def: WfDefinition): WfDefinition {
  if (def.nodes.every((n) => n.position)) return def;
  const depth = new Map<string, number>(def.nodes.map((n) => [n.id, 0]));
  // longest-path depth, bounded by node count (also terminates on cyclic input)
  for (let pass = 0; pass < def.nodes.length; pass += 1) {
    let changed = false;
    for (const e of def.edges) {
      const d = (depth.get(e.source) ?? 0) + 1;
      if (depth.has(e.target) && d > (depth.get(e.target) ?? 0) && d <= def.nodes.length) {
        depth.set(e.target, d);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const rows = new Map<number, number>();
  for (const n of def.nodes) if (n.position) rows.set(depth.get(n.id) ?? 0, (rows.get(depth.get(n.id) ?? 0) ?? 0) + 1);
  return {
    ...def,
    nodes: def.nodes.map((n) => {
      if (n.position) return n;
      const d = depth.get(n.id) ?? 0;
      const row = rows.get(d) ?? 0;
      rows.set(d, row + 1);
      return { ...n, position: { x: 80 + d * 300, y: 80 + row * 160 } };
    }),
  };
}

/** Definition sent to the API: drops editor-only undefined fields. */
export function toApiDefinition(def: WfDefinition): WfDefinition {
  return {
    schema_version: 1,
    nodes: def.nodes.map((n) => ({
      id: n.id,
      type: n.type,
      ...(n.label ? { label: n.label } : {}),
      params: n.params ?? {},
      ...(n.position ? { position: n.position } : {}),
    })),
    edges: def.edges.map((e) => ({ id: edgeKey(e), source: e.source, target: e.target, handle: handleOf(e) })),
  };
}

/** Node ids named in a server validation message ("node x …", "loop x: …", "edge a→b …"). */
export function nodeIdsInError(message: string | null | undefined, ids: Iterable<string>): string[] {
  if (!message) return [];
  const known = new Set(ids);
  const found: string[] = [];
  const add = (id: string) => {
    if (known.has(id) && !found.includes(id)) found.push(id);
  };
  for (const m of message.matchAll(/\b(?:node|loop|retry|trigger|block|duplicate node id)\s+([\w-]+)/g)) add(m[1]);
  for (const m of message.matchAll(/edge\s+([\w-]+)→([\w-]+)/g)) {
    add(m[1]);
    add(m[2]);
  }
  return found;
}

/** Required params that are empty (same test as the server: None, "" or []). */
export function missingRequired(node: WfNode): string[] {
  return (REQUIRED[node.type] ?? []).filter((k) => {
    const v = node.params?.[k];
    return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
  });
}

// ---------------------------------------------------------------- runs
export interface NodeRunState {
  state: StepState | string;
  attempt: number;
  /** Output handle taken by the latest completed step. */
  handle: string | null;
  /** Loop iterations seen for blocks inside a loop body. */
  iterations: number;
  error: string | null;
  steps: WorkflowStep[];
}

export const baseNodeId = (stepNodeId: string) => stepNodeId.split('#')[0];

function outputHandle(output: unknown): string | null {
  if (output && typeof output === 'object' && '_handle' in output) {
    const h = (output as { _handle?: unknown })._handle;
    return typeof h === 'string' ? h : null;
  }
  return null;
}

/** Per-node state of a run: the latest step (by start time, then attempt) wins. */
export function stepStates(steps: WorkflowStep[]): Map<string, NodeRunState> {
  const out = new Map<string, NodeRunState>();
  const iterations = new Map<string, Set<string>>();
  const ordered = [...steps].sort((a, b) => a.started_at - b.started_at || a.attempt - b.attempt);
  for (const s of ordered) {
    const id = baseNodeId(s.node_id);
    const hash = s.node_id.indexOf('#');
    if (hash >= 0) {
      const set = iterations.get(id) ?? new Set<string>();
      set.add(s.node_id.slice(hash + 1));
      iterations.set(id, set);
    }
    out.set(id, {
      state: s.state,
      attempt: s.attempt,
      handle: s.state === 'COMPLETED' ? (outputHandle(s.output) ?? 'out') : null,
      iterations: iterations.get(id)?.size ?? 0,
      error: s.error,
      steps: [...(out.get(id)?.steps ?? []), s],
    });
  }
  return out;
}

/** Edges the run actually followed. */
export function takenEdges(def: WfDefinition, states: Map<string, NodeRunState>): Set<string> {
  const taken = new Set<string>();
  for (const e of def.edges) {
    const s = states.get(e.source);
    if (!s) continue;
    const h = handleOf(e);
    if ((s.state === 'COMPLETED' && (s.handle ?? 'out') === h) || ((s.state === 'FAILED' || s.state === 'UNKNOWN') && h === 'error'))
      taken.add(edgeKey(e));
  }
  return taken;
}

export const ACTIVE_RUN_STATES = new Set(['RUNNING', 'WAITING']);

// ---------------------------------------------------------------- payload
export function parsePayload(text: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const t = text.trim();
  if (!t) return { ok: true, value: {} };
  let v: unknown;
  try {
    v = JSON.parse(t);
  } catch (e) {
    return { ok: false, error: `Not valid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, error: 'The payload must be a JSON object, e.g. {"text": "hello"}.' };
  return { ok: true, value: v as Record<string, unknown> };
}

// ---------------------------------------------------------------- geometry
export const NODE_W = 220;
export const HEADER_H = 54;
export const PORT_ROW = 26;
const FOOT = 8;

export function nodeHeight(portCount: number): number {
  return HEADER_H + Math.max(1, portCount) * PORT_ROW + FOOT;
}

export function outPortPos(pos: Position, index: number): Position {
  return { x: pos.x + NODE_W, y: pos.y + HEADER_H + index * PORT_ROW + PORT_ROW / 2 };
}

export function inPortPos(pos: Position): Position {
  return { x: pos.x, y: pos.y + HEADER_H / 2 };
}

const ctrl = (a: Position, b: Position) => Math.max(40, Math.abs(b.x - a.x) / 2);

export function edgePath(a: Position, b: Position): string {
  const dx = ctrl(a, b);
  return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
}

/** Point at t = 0.5 of the edge's cubic Bézier (for labels). */
export function edgeMid(a: Position, b: Position): Position {
  const dx = ctrl(a, b);
  return { x: (a.x + 3 * (a.x + dx) + 3 * (b.x - dx) + b.x) / 8, y: (a.y + 3 * a.y + 3 * b.y + b.y) / 8 };
}

export interface Viewport {
  x: number;
  y: number;
  k: number;
}

export const ZOOM_MIN = 0.2;
export const ZOOM_MAX = 2;

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Zoom to `k` keeping the screen point (cx, cy) fixed. */
export function zoomAt(vp: Viewport, k: number, cx: number, cy: number): Viewport {
  const nk = clamp(k, ZOOM_MIN, ZOOM_MAX);
  const wx = (cx - vp.x) / vp.k;
  const wy = (cy - vp.y) / vp.k;
  return { k: nk, x: cx - wx * nk, y: cy - wy * nk };
}

export function toWorld(vp: Viewport, sx: number, sy: number): Position {
  return { x: (sx - vp.x) / vp.k, y: (sy - vp.y) / vp.k };
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function boundsOf(items: { position?: Position; height: number }[]): Bounds | null {
  if (items.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const it of items) {
    const p = it.position ?? { x: 0, y: 0 };
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + NODE_W);
    maxY = Math.max(maxY, p.y + it.height);
  }
  return { minX, minY, maxX, maxY };
}

export function fitViewport(b: Bounds | null, width: number, height: number, pad = 48, maxK = 1.1): Viewport {
  if (!b || width <= 0 || height <= 0) return { x: 40, y: 40, k: 1 };
  const bw = Math.max(1, b.maxX - b.minX);
  const bh = Math.max(1, b.maxY - b.minY);
  const k = clamp(Math.min((width - 2 * pad) / bw, (height - 2 * pad) / bh), ZOOM_MIN, maxK);
  return { k, x: (width - bw * k) / 2 - b.minX * k, y: (height - bh * k) / 2 - b.minY * k };
}
