import { describe, expect, it } from 'vitest';
import {
  addEdge,
  autoLayout,
  canConnect,
  edgeMid,
  emptyDefinition,
  fitViewport,
  handlesOf,
  hasCycle,
  loopBody,
  missingRequired,
  moveNode,
  newNodeId,
  nodeIdsInError,
  normalizeDefinition,
  parsePayload,
  pruneInvalidEdges,
  removeEdge,
  removeNode,
  renameHandle,
  stepStates,
  takenEdges,
  toApiDefinition,
  updateNode,
  upstreamOf,
  visibleHandles,
  wouldCreateCycle,
  zoomAt,
} from './graph';
import { initHistory, pushHistory, redo, undo } from './history';
import type { WfDefinition, WfNode, WorkflowStep } from './types';

const node = (id: string, type: string, params: Record<string, unknown> = {}): WfNode => ({ id, type, params, position: { x: 0, y: 0 } });

function def(nodes: WfNode[], edges: [string, string, string?][] = []): WfDefinition {
  return {
    schema_version: 1,
    nodes,
    edges: edges.map(([source, target, handle = 'out']) => ({ id: `${source}-${handle}-${target}`, source, target, handle })),
  };
}

const step = (node_id: string, state: string, started_at: number, extra: Partial<WorkflowStep> = {}): WorkflowStep => ({
  id: `${node_id}-${started_at}`,
  run_id: 'r1',
  node_id,
  node_type: 'x',
  state,
  attempt: 1,
  output: null,
  ref: null,
  error: null,
  started_at,
  finished_at: null,
  ...extra,
});

describe('handlesOf (mirrors workflows.handles_of)', () => {
  it('returns the ports per block type', () => {
    expect(handlesOf('action.run_agent')).toEqual(['out', 'error']);
    expect(handlesOf('trigger.manual')).toEqual(['out', 'error']);
    expect(handlesOf('logic.condition')).toEqual(['true', 'false', 'error']);
    expect(handlesOf('logic.loop')).toEqual(['body', 'done', 'error']);
    expect(handlesOf('logic.wait_approval')).toEqual(['out', 'denied']);
    expect(handlesOf('logic.branch', { cases: ['a', 'b', 'a'] })).toEqual(['a', 'b', 'default', 'error']);
    expect(handlesOf('logic.branch', {})).toEqual(['default', 'error']);
  });

  it('hides the error port of blocks that cannot fail unless it is already used', () => {
    const d = def([node('t', 'trigger.manual'), node('a', 'action.run_agent')]);
    expect(visibleHandles(d.nodes[0], d.edges)).toEqual(['out']);
    expect(visibleHandles(d.nodes[1], d.edges)).toEqual(['out', 'error']);
    const withErr = def(d.nodes, [['t', 'a', 'error']]);
    expect(visibleHandles(withErr.nodes[0], withErr.edges)).toEqual(['out', 'error']);
  });
});

describe('edges', () => {
  const base = def([node('t', 'trigger.manual'), node('a', 'action.run_agent'), node('b', 'action.send_telegram'), node('t2', 'trigger.schedule')]);

  it('adds a valid edge with a deterministic id', () => {
    const r = addEdge(base, 't', 'out', 'a');
    expect(r.error).toBeNull();
    expect(r.def.edges).toEqual([{ id: 't-out-a', source: 't', target: 'a', handle: 'out' }]);
  });

  it('refuses self loops, edges into triggers, unknown handles and duplicates', () => {
    expect(addEdge(base, 'a', 'out', 'a').error).toMatch(/itself/);
    expect(addEdge(base, 'a', 'out', 't2').error).toMatch(/Triggers/);
    expect(addEdge(base, 'a', 'true', 'b').error).toMatch(/not an output/);
    const once = addEdge(base, 'a', 'out', 'b').def;
    expect(addEdge(once, 'a', 'out', 'b').error).toMatch(/already exists/);
    expect(addEdge(once, 'a', 'error', 'b').error).toBeNull(); // different handle is a different connection
  });

  it('pre-checks cycles', () => {
    const d = def([node('t', 'trigger.manual'), node('a', 'action.run_agent'), node('b', 'action.run_agent'), node('c', 'action.run_agent')], [
      ['t', 'a'],
      ['a', 'b'],
      ['b', 'c'],
    ]);
    expect(wouldCreateCycle(d.edges, 'c', 'a')).toBe(true);
    expect(wouldCreateCycle(d.edges, 'a', 'c')).toBe(false);
    expect(addEdge(d, 'c', 'out', 'a').error).toMatch(/cycle/);
    expect(hasCycle(d)).toBe(false);
    expect(hasCycle({ ...d, edges: [...d.edges, { source: 'c', target: 'a', handle: 'out' }] })).toBe(true);
  });

  it('enforces the retry rule (exactly one action target)', () => {
    const d = def([node('t', 'trigger.manual'), node('r', 'logic.retry', { max_attempts: 2 }), node('a', 'action.run_agent'), node('c', 'logic.condition')]);
    expect(canConnect(d, 'r', 'out', 'c')).toEqual({ ok: false, reason: expect.stringMatching(/action/) });
    const one = addEdge(d, 'r', 'out', 'a').def;
    expect(canConnect(one, 'r', 'error', 'a').ok).toBe(false);
  });

  it('removes edges and nodes (with their edges)', () => {
    const d = def([node('t', 'trigger.manual'), node('a', 'action.run_agent'), node('b', 'action.run_agent')], [
      ['t', 'a'],
      ['a', 'b'],
    ]);
    expect(removeEdge(d, 't-out-a').edges.map((e) => e.id)).toEqual(['a-out-b']);
    const r = removeNode(d, 'a');
    expect(r.nodes.map((n) => n.id)).toEqual(['t', 'b']);
    expect(r.edges).toEqual([]);
  });

  it('keeps branch connections when a case is renamed and drops them when it is removed', () => {
    const d = def([node('t', 'trigger.manual'), node('br', 'logic.branch', { value: 'x', cases: ['a', 'b'] }), node('x', 'action.run_agent')], [
      ['t', 'br'],
      ['br', 'x', 'b'],
    ]);
    const renamed = updateNode(renameHandle(d, 'br', 'b', 'beta'), 'br', { params: { value: 'x', cases: ['a', 'beta'] } });
    expect(renamed.edges.find((e) => e.source === 'br')).toMatchObject({ handle: 'beta', id: 'br-beta-x' });
    const removed = updateNode(d, 'br', { params: { value: 'x', cases: ['a'] } });
    expect(removed.edges.some((e) => e.source === 'br')).toBe(false);
    expect(pruneInvalidEdges(d).removed).toEqual([]);
  });
});

describe('node helpers', () => {
  it('generates unique ids that match the server pattern', () => {
    expect(newNodeId('action.run_agent', [])).toBe('run_agent_1');
    expect(newNodeId('action.run_agent', ['run_agent_1', 'run_agent_2'])).toBe('run_agent_3');
    expect(newNodeId('logic.wait_approval', ['x'])).toMatch(/^[\w-]{1,64}$/);
  });

  it('reports empty required params like the server (None, "" or [])', () => {
    expect(missingRequired(node('a', 'action.run_agent', { agent_id: '', prompt: 'hi' }))).toEqual(['agent_id']);
    expect(missingRequired(node('b', 'logic.branch', { value: 'v', cases: [] }))).toEqual(['cases']);
    expect(missingRequired(node('l', 'logic.loop'))).toEqual([]);
  });

  it('moves nodes to integer positions', () => {
    const d = moveNode(emptyDefinition(), 'manual_1', { x: 10.6, y: 20.2 });
    expect(d.nodes[0].position).toEqual({ x: 11, y: 20 });
  });

  it('finds the loop body and upstream blocks', () => {
    const d = def([node('t', 'trigger.manual'), node('l', 'logic.loop'), node('a', 'action.run_agent'), node('b', 'action.run_agent'), node('z', 'action.send_telegram')], [
      ['t', 'l'],
      ['l', 'a', 'body'],
      ['a', 'b'],
      ['l', 'z', 'done'],
    ]);
    expect([...loopBody('l', d.edges)].sort()).toEqual(['a', 'b']);
    expect(upstreamOf(d, 'b')).toEqual(['t', 'l', 'a']);
  });
});

describe('loading and serialising', () => {
  it('normalises imported definitions (default handle, ids, missing positions)', () => {
    const d = normalizeDefinition({
      nodes: [
        { id: 't', type: 'trigger.manual' },
        { id: 'a', type: 'action.run_agent', params: { agent_id: 'x' } },
      ],
      edges: [{ source: 't', target: 'a' }],
    });
    expect(d.edges[0]).toEqual({ id: 't-out-a', source: 't', target: 'a', handle: 'out' });
    expect(d.nodes[0].params).toEqual({});
    expect(d.nodes.every((n) => n.position)).toBe(true);
    expect(d.nodes[1].position!.x).toBeGreaterThan(d.nodes[0].position!.x);
  });

  it('auto-layout leaves positioned nodes alone', () => {
    const d = def([node('t', 'trigger.manual')]);
    expect(autoLayout(d)).toBe(d);
  });

  it('serialises without undefined fields and with explicit handles', () => {
    const d: WfDefinition = { schema_version: 1, nodes: [{ id: 't', type: 'trigger.manual', params: {} }], edges: [{ source: 't', target: 'a' }] };
    expect(JSON.parse(JSON.stringify(toApiDefinition(d)))).toEqual({
      schema_version: 1,
      nodes: [{ id: 't', type: 'trigger.manual', params: {} }],
      edges: [{ id: 't-out-a', source: 't', target: 'a', handle: 'out' }],
    });
  });

  it('extracts node ids from server validation messages', () => {
    const ids = ['run_agent_1', 'loop_1', 'a', 'b'];
    expect(nodeIdsInError("node run_agent_1 (action.run_agent): 'agent_id' is required", ids)).toEqual(['run_agent_1']);
    expect(nodeIdsInError("edge a→b: handle 'x' is not valid for logic.loop", ids)).toEqual(['a', 'b']);
    expect(nodeIdsInError('loop loop_1: nested loops, delays and approvals are not allowed in a loop body', ids)).toEqual(['loop_1']);
    expect(nodeIdsInError('the workflow contains a cycle', ids)).toEqual([]);
    expect(nodeIdsInError(null, ids)).toEqual([]);
  });
});

describe('run state', () => {
  it('latest step wins, retries keep the attempt and loop iterations are counted', () => {
    const s = stepStates([
      step('t', 'COMPLETED', 1, { output: { _handle: 'out' } }),
      step('a', 'FAILED', 2, { error: 'boom' }),
      step('a', 'COMPLETED', 3, { attempt: 2, output: { _handle: 'out', summary: 'ok' } }),
      step('c', 'COMPLETED', 4, { output: { result: false, _handle: 'false' } }),
      step('x#0', 'COMPLETED', 5),
      step('x#1', 'RUNNING', 6),
    ]);
    expect(s.get('a')).toMatchObject({ state: 'COMPLETED', attempt: 2, handle: 'out' });
    expect(s.get('a')!.steps).toHaveLength(2);
    expect(s.get('c')!.handle).toBe('false');
    expect(s.get('x')).toMatchObject({ state: 'RUNNING', iterations: 2 });
  });

  it('marks the edges a run followed', () => {
    const d = def([node('t', 'trigger.manual'), node('c', 'logic.condition', { left: 'x', op: 'exists' }), node('y', 'action.run_agent'), node('n', 'action.run_agent'), node('e', 'action.send_telegram')], [
      ['t', 'c'],
      ['c', 'y', 'true'],
      ['c', 'n', 'false'],
      ['y', 'e', 'error'],
    ]);
    const states = stepStates([
      step('t', 'COMPLETED', 1, { output: { _handle: 'out' } }),
      step('c', 'COMPLETED', 2, { output: { _handle: 'true' } }),
      step('y', 'FAILED', 3),
    ]);
    expect([...takenEdges(d, states)].sort()).toEqual(['c-true-y', 't-out-c', 'y-error-e']);
  });
});

describe('misc', () => {
  it('parses run payloads', () => {
    expect(parsePayload('')).toEqual({ ok: true, value: {} });
    expect(parsePayload('{"text":"hi"}')).toEqual({ ok: true, value: { text: 'hi' } });
    expect(parsePayload('[1]').ok).toBe(false);
    expect(parsePayload('{oops').ok).toBe(false);
  });

  it('zooms around a fixed screen point and clamps', () => {
    const v = zoomAt({ x: 0, y: 0, k: 1 }, 2, 100, 100);
    expect(v).toEqual({ k: 2, x: -100, y: -100 });
    expect(zoomAt(v, 99, 0, 0).k).toBe(2);
    expect(zoomAt(v, 0.01, 0, 0).k).toBe(0.2);
  });

  it('fits bounds into the viewport', () => {
    const v = fitViewport({ minX: 0, minY: 0, maxX: 1000, maxY: 500 }, 548, 348, 24);
    expect(v.k).toBeCloseTo(0.5);
    expect(fitViewport(null, 100, 100)).toEqual({ x: 40, y: 40, k: 1 });
  });

  it('puts edge labels on the curve midpoint', () => {
    expect(edgeMid({ x: 0, y: 0 }, { x: 200, y: 100 })).toEqual({ x: 100, y: 50 });
  });

  it('undo / redo history', () => {
    let h = initHistory(1);
    h = pushHistory(h, 2);
    h = pushHistory(h, 3);
    expect(undo(h).present).toBe(2);
    expect(redo(undo(h)).present).toBe(3);
    expect(pushHistory(undo(h), 9).future).toEqual([]);
    expect(pushHistory(h, 3)).toBe(h);
    let big = initHistory(0);
    for (let i = 1; i <= 150; i += 1) big = pushHistory(big, i, 100);
    expect(big.past).toHaveLength(100);
  });
});
