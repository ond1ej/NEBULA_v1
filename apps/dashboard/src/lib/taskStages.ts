// Live execution stages of running tasks (SSE `task.stage`).
//
// The host publishes `task.stage` with payload {stage, detail, elapsed_ms, at} (envelope with agent_id + task_id)
// whenever a task moves to another stage: `at` is when the stage began (host epoch seconds), `elapsed_ms` the task's
// total time since it was created. One store per event hub keeps the latest stage per task, so any card or screen that
// mounts later still shows the current stage.
//
// Timers never compare the browser's clock with the host's (a phone's clock may be off): the time in the stage is
// (envelope timestamp − at) at publication plus the local time since the event arrived; the task's total time is
// elapsed_ms plus the local time since arrival.
import type { NebulaEvent } from '../types';

/** The stages the host sends (do not add stages here that the host does not publish). */
export const TASK_STAGES = ['queued', 'waiting_for_resources', 'starting', 'waking_desktop', 'model_request', 'tool', 'verifying', 'delivering'] as const;
export type TaskStageName = (typeof TASK_STAGES)[number];

export interface TaskStage {
  stage: TaskStageName | string;
  /** For `tool`: the tool name; for `model_request`: provider/model. */
  detail: string | null;
  /** Time already spent in the stage when the event was published (ms; normally ~0). */
  stageBaseMs: number;
  /** `elapsed_ms` of the event: the task's total time when the stage began. */
  taskElapsedMs: number;
  /** `at` of the event (host epoch seconds; ordering). */
  at: number | null;
  /** Local Date.now() when the event arrived. */
  receivedAt: number;
}

const LABELS: Record<TaskStageName, string> = {
  queued: 'Waiting in the queue',
  waiting_for_resources: 'Waiting for resources',
  starting: 'Starting',
  waking_desktop: 'Waking the desktop',
  model_request: 'Waiting for the model',
  tool: 'Running a tool',
  verifying: 'Verifying the result',
  delivering: 'Delivering the result',
};

/** "Waiting for the model", "Running browser.open", … (unknown stages are shown as sent, humanised). */
export function stageLabel(s: Pick<TaskStage, 'stage' | 'detail'>): string {
  if (s.stage === 'tool') return s.detail ? `Running ${s.detail}` : LABELS.tool;
  const known = LABELS[s.stage as TaskStageName];
  if (known) return s.detail && s.stage === 'waiting_for_resources' ? `${known}: ${s.detail}` : known;
  const h = s.stage.replace(/[_.]+/g, ' ').trim();
  return h ? h[0].toUpperCase() + h.slice(1) : 'Working';
}

/** Time in the current stage ("Waiting for the model · 4 s"). */
export function stageElapsedMs(s: Pick<TaskStage, 'stageBaseMs' | 'receivedAt'>, now: number = Date.now()): number {
  return Math.max(0, s.stageBaseMs + Math.max(0, now - s.receivedAt));
}

/** The task's total time so far (host-measured, so independent of the device clock). */
export function taskElapsedMs(s: Pick<TaskStage, 'taskElapsedMs' | 'receivedAt'>, now: number = Date.now()): number {
  return Math.max(0, s.taskElapsedMs + Math.max(0, now - s.receivedAt));
}

/** "4 s", "1 min 05 s", "1 h 02 min" */
export function formatStageElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h) return `${h} h ${String(m).padStart(2, '0')} min`;
  if (m) return `${m} min ${String(r).padStart(2, '0')} s`;
  return `${r} s`;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
/** Epoch seconds (a millisecond value is converted). */
const epochSeconds = (v: unknown): number | null => {
  const n = num(v);
  return n === null ? null : n > 1e12 ? n / 1000 : n;
};

export function parseStageEvent(
  ev: Pick<NebulaEvent, 'type' | 'task_id' | 'payload'> & { timestamp?: number },
  receivedAt: number = Date.now(),
): { taskId: string; stage: TaskStage } | null {
  if (ev.type !== 'task.stage' || !ev.task_id) return null;
  const p = ev.payload ?? {};
  if (typeof p.stage !== 'string' || !p.stage) return null;
  const at = epochSeconds(p.at);
  const published = epochSeconds(ev.timestamp);
  return {
    taskId: ev.task_id,
    stage: {
      stage: p.stage,
      detail: typeof p.detail === 'string' && p.detail ? p.detail : null,
      stageBaseMs: at !== null && published !== null ? Math.min(Math.max(0, (published - at) * 1000), 24 * 3600_000) : 0,
      taskElapsedMs: Math.max(0, num(p.elapsed_ms) ?? 0),
      at,
      receivedAt,
    },
  };
}

/** Events after which a task has no current stage any more. */
const CLEARS = new Set(['task.completed', 'task.failed', 'task.cancelled', 'task.paused']);
const MAX_TASKS = 200;

export class TaskStageStore {
  private stages = new Map<string, TaskStage>();
  private listeners = new Map<string, Set<() => void>>();

  get(taskId: string): TaskStage | undefined {
    return this.stages.get(taskId);
  }

  subscribe(taskId: string, fn: () => void): () => void {
    let set = this.listeners.get(taskId);
    if (!set) this.listeners.set(taskId, (set = new Set()));
    set.add(fn);
    return () => {
      set.delete(fn);
      if (set.size === 0 && this.listeners.get(taskId) === set) this.listeners.delete(taskId);
    };
  }

  handle(ev: NebulaEvent, now: number = Date.now()): void {
    if (ev.type === 'task.stage') {
      const parsed = parseStageEvent(ev, now);
      if (!parsed) return;
      const cur = this.stages.get(parsed.taskId);
      if (cur && cur.at !== null && parsed.stage.at !== null && parsed.stage.at < cur.at) return; // stale (out of order)
      this.stages.delete(parsed.taskId); // re-insert: Map order = recency for the size cap
      this.stages.set(parsed.taskId, parsed.stage);
      if (this.stages.size > MAX_TASKS) {
        const oldest = this.stages.keys().next().value;
        if (oldest !== undefined) this.stages.delete(oldest);
      }
      this.emit(parsed.taskId);
    } else if (ev.task_id && CLEARS.has(ev.type) && this.stages.delete(ev.task_id)) {
      this.emit(ev.task_id);
    }
  }

  private emit(taskId: string): void {
    for (const fn of [...(this.listeners.get(taskId) ?? [])]) fn();
  }
}

const stores = new WeakMap<object, TaskStageStore>();

/** The stage store of an event hub (created, and subscribed, on first use: call it when the hub starts). */
export function taskStagesFor(hub: { subscribe(fn: (ev: NebulaEvent) => void): () => void }): TaskStageStore {
  let s = stores.get(hub);
  if (!s) {
    const store = new TaskStageStore();
    hub.subscribe((ev) => store.handle(ev));
    stores.set(hub, store);
    s = store;
  }
  return s;
}
