// Task lists follow `task.step` events locally (step counter, tool calls) instead of refetching the whole list on
// every tool call; state changes (queued / started / paused / finished …) still refetch.
import type { NebulaEvent } from '../types';

interface StepRow {
  id: string;
  current_step: number;
  tool_calls_done?: number;
}

/** The rows with the step of `ev` applied (same array when the event does not concern them). */
export function applyStepEvent<T extends StepRow>(rows: T[] | null, ev: Pick<NebulaEvent, 'type' | 'task_id' | 'payload'>): T[] | null {
  if (!rows || ev.type !== 'task.step' || !ev.task_id) return rows;
  const seq = ev.payload?.seq;
  if (typeof seq !== 'number' || typeof ev.payload?.tool !== 'string') return rows; // status notes carry no step
  let changed = false;
  const next = rows.map((t) => {
    if (t.id !== ev.task_id || t.current_step >= seq) return t;
    changed = true;
    return { ...t, current_step: seq, ...(typeof t.tool_calls_done === 'number' ? { tool_calls_done: t.tool_calls_done + 1 } : {}) };
  });
  return changed ? next : rows;
}
