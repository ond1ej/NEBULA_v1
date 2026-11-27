import { describe, expect, it, vi } from 'vitest';
import type { NebulaEvent } from '../types';
import { formatStageElapsed, parseStageEvent, stageElapsedMs, stageLabel, taskElapsedMs, TaskStageStore, taskStagesFor } from './taskStages';
import { applyStepEvent } from './taskRows';

let seq = 0;
const stageEv = (taskId: string, stage: string, opts: { detail?: string | null; elapsed_ms?: number; at?: number; timestamp?: number } = {}): NebulaEvent => {
  seq += 1;
  return {
    id: `e${seq}`,
    sequence: seq,
    type: 'task.stage',
    agent_id: 'a1',
    task_id: taskId,
    timestamp: opts.timestamp ?? opts.at ?? 1_700_000_000,
    payload: { stage, detail: opts.detail ?? null, elapsed_ms: opts.elapsed_ms ?? 0, at: opts.at ?? 1_700_000_000 },
  };
};
const ev = (type: string, taskId: string): NebulaEvent => ({ id: `x${(seq += 1)}`, sequence: seq, type, agent_id: 'a1', task_id: taskId, timestamp: 1, payload: {} });

describe('task stages', () => {
  it('labels the stages the host sends, the tool name for `tool`, and humanises unknown ones', () => {
    expect(stageLabel({ stage: 'model_request', detail: 'anthropic-api/claude-x' })).toBe('Waiting for the model');
    expect(stageLabel({ stage: 'tool', detail: 'browser.open' })).toBe('Running browser.open');
    expect(stageLabel({ stage: 'tool', detail: null })).toBe('Running a tool');
    expect(stageLabel({ stage: 'queued', detail: null })).toBe('Waiting in the queue');
    expect(stageLabel({ stage: 'waiting_for_resources', detail: 'memory pressure' })).toBe('Waiting for resources: memory pressure');
    expect(stageLabel({ stage: 'waking_desktop', detail: null })).toBe('Waking the desktop');
    expect(stageLabel({ stage: 'verifying', detail: null })).toBe('Verifying the result');
    expect(stageLabel({ stage: 'delivering', detail: null })).toBe('Delivering the result');
    expect(stageLabel({ stage: 'something_new', detail: null })).toBe('Something new');
  });

  it('times the stage from the event (no device-clock comparison) and the task from elapsed_ms', () => {
    // stage began 2 s before the envelope was written; task total 40 s; received at local t=1000
    const p = parseStageEvent(stageEv('t1', 'model_request', { at: 1_700_000_000, timestamp: 1_700_000_002, elapsed_ms: 40_000 }), 1000);
    expect(p?.taskId).toBe('t1');
    expect(stageElapsedMs(p!.stage, 1000)).toBe(2000);
    expect(stageElapsedMs(p!.stage, 5000)).toBe(6000);
    expect(taskElapsedMs(p!.stage, 5000)).toBe(44_000);
    expect(formatStageElapsed(4_200)).toBe('4 s');
    expect(formatStageElapsed(65_000)).toBe('1 min 05 s');
    expect(formatStageElapsed(3_725_000)).toBe('1 h 02 min');
    expect(parseStageEvent({ type: 'task.stage', task_id: 't1', payload: {} })).toBeNull();
    expect(parseStageEvent({ type: 'task.step', task_id: 't1', payload: { stage: 'tool' } })).toBeNull();
  });

  it('keeps the latest stage per task, ignores stale ones, clears on finish and notifies only that task', () => {
    const store = new TaskStageStore();
    const t1 = vi.fn();
    const t2 = vi.fn();
    store.subscribe('t1', t1);
    store.subscribe('t2', t2);
    store.handle(stageEv('t1', 'model_request', { at: 100 }), 0);
    store.handle(stageEv('t1', 'tool', { detail: 'shell.run', at: 105 }), 0);
    store.handle(stageEv('t1', 'model_request', { at: 101 }), 0); // older than the current one
    expect(store.get('t1')?.stage).toBe('tool');
    expect(store.get('t1')?.detail).toBe('shell.run');
    expect(t1).toHaveBeenCalledTimes(2);
    expect(t2).not.toHaveBeenCalled();
    store.handle(ev('task.step', 't1'));
    expect(store.get('t1')?.stage).toBe('tool');
    store.handle(ev('task.completed', 't1'));
    expect(store.get('t1')).toBeUndefined();
    expect(t1).toHaveBeenCalledTimes(3);
  });

  it('one store per hub, subscribed once', () => {
    const subs: ((e: NebulaEvent) => void)[] = [];
    const hub = { subscribe: (fn: (e: NebulaEvent) => void) => (subs.push(fn), () => {}) };
    const a = taskStagesFor(hub);
    expect(taskStagesFor(hub)).toBe(a);
    expect(subs).toHaveLength(1);
    subs[0](stageEv('t9', 'starting'));
    expect(a.get('t9')?.stage).toBe('starting');
  });
});

describe('task rows follow task.step locally', () => {
  it('advances the step counter and tool calls of the matching row only', () => {
    const rows = [
      { id: 't1', current_step: 2, tool_calls_done: 2 },
      { id: 't2', current_step: 5, tool_calls_done: 5 },
    ];
    const step = { type: 'task.step', task_id: 't1', payload: { seq: 3, tool: 'browser.open', status: 'ok' } };
    const next = applyStepEvent(rows, step);
    expect(next).toEqual([
      { id: 't1', current_step: 3, tool_calls_done: 3 },
      { id: 't2', current_step: 5, tool_calls_done: 5 },
    ]);
    expect(applyStepEvent(next, step)).toBe(next); // replay / duplicate: unchanged
    expect(applyStepEvent(rows, { type: 'task.step', task_id: 't1', payload: { kind: 'waking_desktop' } })).toBe(rows);
    expect(applyStepEvent(null, step)).toBeNull();
  });
});
