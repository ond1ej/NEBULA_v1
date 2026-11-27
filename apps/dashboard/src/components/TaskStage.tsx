// Live execution stage of a running task ("Waiting for the model · 4 s"), shared by the Dashboard and the Mini App.
// Only the small timer re-renders every second; the store pushes stage changes from the event stream.
import { useEffect, useState, useSyncExternalStore } from 'react';
import { useEventHub } from '../hooks/useEvents';
import { formatStageElapsed, stageElapsedMs, stageLabel, taskElapsedMs, taskStagesFor, type TaskStage } from '../lib/taskStages';

const noop = () => () => {};

/** Latest `task.stage` of a task (null before the first stage event, e.g. tasks started by an older host). */
export function useTaskStage(taskId: string | null | undefined): TaskStage | null {
  const hub = useEventHub();
  const store = hub ? taskStagesFor(hub) : null;
  return useSyncExternalStore(
    store && taskId ? (cb) => store.subscribe(taskId, cb) : noop,
    () => (store && taskId ? (store.get(taskId) ?? null) : null),
    () => null,
  );
}

function useSecondTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

/**
 * Live timer. `stage`: time in that stage; `total`: the task's total time from the same stage event (host-measured);
 * otherwise the time since `sinceEpoch` (host seconds, e.g. started_at of tasks without stage events).
 */
export function ElapsedTimer({ stage, total, sinceEpoch, className = '' }: { stage?: TaskStage | null; total?: TaskStage | null; sinceEpoch?: number | null; className?: string }) {
  const active = Boolean(stage) || Boolean(total) || typeof sinceEpoch === 'number';
  const now = useSecondTick(active);
  if (!active) return null;
  const ms = stage ? stageElapsedMs(stage, now) : total ? taskElapsedMs(total, now) : Math.max(0, now - (sinceEpoch as number) * 1000);
  return (
    <span className={`tabular-nums ${className}`} data-testid="task-elapsed">
      {formatStageElapsed(ms)}
    </span>
  );
}

/** States in which the task waits for something more specific than its stage (shown by the caller instead). */
const OVERRIDING_STATES = new Set(['WAITING_APPROVAL', 'WAITING_PROVIDER', 'WAITING_CONTROL', 'PAUSING', 'PAUSED']);
const TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);

/** A stage is worth showing for this task state (running or queued, not waiting on the owner / provider). */
export function stageApplies(state: string | null | undefined): boolean {
  return !state || (!OVERRIDING_STATES.has(state) && !TERMINAL.has(state));
}

const FALLBACK: Record<string, string> = {
  RECEIVED: 'Waiting in the queue',
  QUEUED: 'Waiting in the queue',
  PLANNING: 'Preparing',
  EXECUTING: 'Working',
  VERIFYING: 'Verifying the result',
  WAITING_APPROVAL: 'Waiting for your approval',
  WAITING_PROVIDER: 'Waiting for the AI provider',
  WAITING_CONTROL: 'Waiting: a viewer holds desktop control',
  PAUSING: 'Pausing after the current step',
  PAUSED: 'Paused',
};

/**
 * One line for a running task: the current stage with a live timer, or — before any stage event (older tasks) — a
 * label from the task state with the time since it started. Renders nothing for finished tasks.
 */
export function TaskStageLine({
  taskId,
  state,
  startedAt,
  className = '',
}: {
  taskId: string;
  state: string;
  startedAt?: number | null;
  className?: string;
}) {
  const stage = useTaskStage(taskId);
  if (TERMINAL.has(state)) return null;
  const show = stage && stageApplies(state) ? stage : null;
  const label = show ? stageLabel(show) : (FALLBACK[state] ?? 'Working');
  const since = show ? null : startedAt && state !== 'QUEUED' && state !== 'RECEIVED' ? startedAt : null;
  return (
    <span className={`inline-flex min-w-0 items-center gap-1.5 ${className}`} data-testid="task-stage" data-stage={show?.stage ?? ''}>
      <span aria-hidden className="size-1.5 shrink-0 animate-pulse-soft rounded-full bg-accent-soft" />
      <span className="min-w-0 truncate" title={show?.detail && show.stage !== 'tool' ? show.detail : undefined}>
        {label}
      </span>
      {(show || since) && (
        <>
          <span className="text-subtle">{' · '}</span>
          <ElapsedTimer stage={show} sinceEpoch={since} className="shrink-0 text-subtle" />
        </>
      )}
    </span>
  );
}
