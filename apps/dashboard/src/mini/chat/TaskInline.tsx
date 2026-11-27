// Inline task status under the owner's message that created a task: "Working · Running browser.open · 4 s" →
// "Completed · 12 s". Tapping expands stage, elapsed time, tool steps, approval requests, result, screenshots and the
// error. Live from task.stage / task.step / task.completed / task.failed; raw logs are never dumped.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ElapsedTimer, stageApplies, useTaskStage } from '../../components/TaskStage';
import { useEventHub } from '../../hooks/useEvents';
import { relativeTime } from '../../lib/format';
import { stageLabel } from '../../lib/taskStages';
import type { NebulaEvent, TaskDetail } from '../../types';
import { ApprovalCard, fromTaskApproval } from '../approvals';
import { canDecide, hasPermission, useMini } from '../context';
import { shortDuration } from '../format';
import { useActions, useQuery } from '../hooks';
import { IcAlert, IcCheck, IcChevron, IcX } from '../icons';
import { mhref } from '../router';
import type { MessageTask } from '../types';
import { AuthImage } from '../uiExtra';
import { Btn, cx, Spinner, StatusDot, type Tone } from '../uiKit';
import { isTerminalTask } from './model';

// ---------------------------------------------------------------- live tool steps (task.step)
export interface LiveStep {
  seq: number;
  tool: string;
  status: string;
  summary: string | null;
}

const steps = new Map<string, LiveStep[]>();
const stepListeners = new Map<string, Set<() => void>>();
const hubs = new WeakSet<object>();
const NO_STEPS: LiveStep[] = [];

function recordStep(ev: NebulaEvent): void {
  if (ev.type !== 'task.step' || !ev.task_id) return;
  const p = ev.payload ?? {};
  if (typeof p.seq !== 'number' || typeof p.tool !== 'string') return;
  const cur = steps.get(ev.task_id) ?? [];
  if (cur.some((s) => s.seq === p.seq)) return;
  const next = [...cur, { seq: p.seq, tool: p.tool, status: typeof p.status === 'string' ? p.status : 'ok', summary: typeof p.summary === 'string' ? p.summary.slice(0, 240) : null }].slice(-30);
  steps.set(ev.task_id, next);
  if (steps.size > 100) steps.delete(steps.keys().next().value as string);
  for (const l of [...(stepListeners.get(ev.task_id) ?? [])]) l();
}

/** Subscribes the step store to the hub once (the conversation screen calls it on mount). */
export function useStepRecorder(): void {
  const hub = useEventHub();
  useEffect(() => {
    if (!hub || hubs.has(hub)) return;
    hubs.add(hub);
    hub.subscribe(recordStep);
  }, [hub]);
}

function useLiveSteps(taskId: string): LiveStep[] {
  return useSyncExternalStore(
    (cb) => {
      let set = stepListeners.get(taskId);
      if (!set) stepListeners.set(taskId, (set = new Set()));
      set.add(cb);
      return () => set.delete(cb);
    },
    () => steps.get(taskId) ?? NO_STEPS,
    () => NO_STEPS,
  );
}

// ---------------------------------------------------------------- status line
const STATE_LABEL: Record<string, string> = {
  RECEIVED: 'Queued',
  QUEUED: 'Queued',
  PLANNING: 'Working',
  EXECUTING: 'Working',
  VERIFYING: 'Verifying',
  WAITING_APPROVAL: 'Needs your approval',
  WAITING_PROVIDER: 'Waiting for the AI provider',
  WAITING_CONTROL: 'Waiting · you hold desktop control',
  PAUSING: 'Pausing',
  PAUSED: 'Paused',
  COMPLETED: 'Completed',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
};

function toneOf(state: string): Tone {
  if (state === 'COMPLETED') return 'success';
  if (state === 'FAILED') return 'danger';
  if (state === 'WAITING_APPROVAL' || state === 'WAITING_PROVIDER' || state === 'PAUSED' || state === 'PAUSING' || state === 'WAITING_CONTROL') return 'warning';
  if (state === 'CANCELLED') return 'neutral';
  return 'accent';
}

const duration = (t: MessageTask) => (t.started_at && t.finished_at ? shortDuration(t.finished_at - t.started_at) : null);

export function TaskInline({ task, align = 'end' }: { task: MessageTask; align?: 'start' | 'end' }) {
  const [open, setOpen] = useState(false);
  const stage = useTaskStage(task.id);
  const state = task.state;
  const terminal = isTerminalTask(state);
  const showStage = stage && !terminal && stageApplies(state) ? stage : null;
  const tone = toneOf(state);
  const base = STATE_LABEL[state] ?? state.toLowerCase().replace(/_/g, ' ');
  const detail = showStage ? stageLabel(showStage) : state === 'FAILED' && task.failure_reason ? task.failure_reason : null;
  const dur = state === 'COMPLETED' ? duration(task) : null;
  return (
    <div className={cx('mt-1 flex w-full flex-col', align === 'end' ? 'items-end' : 'items-start')}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="nb-press flex min-h-9 max-w-full items-center gap-1.5 rounded-full px-2.5 text-footnote text-muted focus-ring"
        data-testid="task-inline"
        data-state={state}
      >
        {terminal ? (
          state === 'COMPLETED' ? (
            <IcCheck className="size-3.5 text-success" />
          ) : state === 'FAILED' ? (
            <IcAlert className="size-3.5 text-danger" />
          ) : (
            <IcX className="size-3.5 text-subtle" />
          )
        ) : (
          <StatusDot tone={tone} pulse={tone === 'accent'} />
        )}
        <span className={cx('shrink-0 font-medium', tone === 'danger' ? 'text-danger' : tone === 'warning' ? 'text-warn' : tone === 'success' ? 'text-success' : 'text-text')}>{base}</span>
        {detail && <span className="min-w-0 truncate">· {detail}</span>}
        {dur && <span className="shrink-0">· {dur}</span>}
        {!terminal && (showStage || task.started_at) && (
          <span className="shrink-0 text-subtle">
            · <ElapsedTimer stage={showStage ? null : undefined} total={showStage} sinceEpoch={showStage ? undefined : task.started_at} />
          </span>
        )}
        <IcChevron aria-hidden className={cx('size-3.5 shrink-0 text-subtle transition-transform duration-200', open && 'rotate-90')} />
      </button>
      {open && <TaskDetails task={task} />}
    </div>
  );
}

function TaskDetails({ task }: { task: MessageTask }) {
  const ctx = useMini();
  const { api } = ctx;
  const { run, isPending } = useActions();
  const stage = useTaskStage(task.id);
  const live = useLiveSteps(task.id);
  const q = useQuery<TaskDetail>(`task:${task.id}`, (s) => api.tasks.get(task.id, s), {
    refreshOn: (ev) => ev.task_id === task.id && ev.type !== 'task.stage' && ev.type !== 'task.message' && ev.type !== 'task.step',
  });
  const [shots, setShots] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, []);
  const d = q.data;
  const state = d?.state ?? task.state;
  const terminal = isTerminalTask(state);
  const serverSteps = (d?.steps ?? []).map((s) => ({ seq: s.seq, tool: s.tool_type, status: s.result_status, summary: s.result_summary, ms: s.elapsed_ms, shot: s.screenshot_ref }));
  const known = new Set(serverSteps.map((s) => s.seq));
  const allSteps = [...serverSteps, ...live.filter((s) => !known.has(s.seq)).map((s) => ({ ...s, ms: null as number | null, shot: null as string | null }))].sort((a, b) => a.seq - b.seq);
  const recent = allSteps.slice(-8);
  const screenshots = allSteps.filter((s) => s.shot).map((s) => s.shot as string);
  const pending = (d?.approvals ?? []).filter((a) => a.decision === null);
  const canCommand = hasPermission(ctx, 'commands');
  const canApprove = canDecide(ctx);
  const act = async (key: string, fn: () => Promise<unknown>, success: string) => {
    if ((await run(key, fn, { success })) !== undefined) q.reload();
  };
  return (
    <div ref={box} className="mt-1 w-full max-w-xl animate-rise rounded-card bg-panel p-3.5 text-left" data-testid="task-details">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-footnote">
        {!terminal && stage && stageApplies(state) && (
          <>
            <dt className="text-subtle">Stage</dt>
            <dd className="text-text">
              {stageLabel(stage)} · <ElapsedTimer stage={stage} />
            </dd>
          </>
        )}
        <dt className="text-subtle">Elapsed</dt>
        <dd className="text-text">
          {task.started_at ? (terminal && (d?.finished_at ?? task.finished_at) ? shortDuration((d?.finished_at ?? task.finished_at ?? 0) - task.started_at) : <ElapsedTimer total={stage} sinceEpoch={stage ? undefined : task.started_at} />) : 'not started yet'}
        </dd>
        {d && (
          <>
            <dt className="text-subtle">Steps</dt>
            <dd className="text-text">
              {d.current_step} of {d.max_steps} · {d.tool_calls_done} tool call{d.tool_calls_done === 1 ? '' : 's'}
            </dd>
          </>
        )}
      </dl>

      {recent.length > 0 && (
        <ol className="mt-3 flex flex-col gap-1.5" aria-label="Tool steps">
          {recent.map((s) => (
            <li key={s.seq} className="flex items-start gap-2 text-footnote">
              <span className="mt-0.5 w-6 shrink-0 text-right font-mono text-[11px] text-subtle">{s.seq}</span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <StatusDot tone={/^(ok|success)$/i.test(s.status) ? 'success' : /^(error|failed)$/i.test(s.status) ? 'danger' : 'neutral'} />
                  <span className="truncate font-medium text-text">{s.tool}</span>
                  {s.ms != null && <span className="ml-auto shrink-0 text-subtle">{(s.ms / 1000).toFixed(1)} s</span>}
                </span>
                {s.summary && <span className="line-clamp-2 text-muted [overflow-wrap:anywhere]">{s.summary}</span>}
              </span>
            </li>
          ))}
        </ol>
      )}

      {pending.length > 0 && (
        <div className="mt-3 space-y-2">
          {pending.map((a) => (
            <ApprovalCard key={a.id} a={fromTaskApproval(a, d?.agent_name ?? null)} canApprove={canApprove} onDone={q.reload} />
          ))}
        </div>
      )}

      {(d?.failure_reason ?? task.failure_reason) && (
        <p className="mt-3 rounded-xl bg-danger/10 px-3 py-2 text-footnote text-danger [overflow-wrap:anywhere]">{d?.failure_reason ?? task.failure_reason}</p>
      )}
      {d?.result?.summary && state === 'COMPLETED' && (
        <p className="mt-3 line-clamp-4 rounded-xl bg-success/10 px-3 py-2 text-footnote text-text [overflow-wrap:anywhere]">{d.result.summary}</p>
      )}

      {screenshots.length > 0 && (
        <div className="mt-3">
          {shots ? (
            <div className="grid grid-cols-2 gap-2">
              {screenshots.slice(-4).map((ref) => (
                <AuthImage key={ref} load={async () => (await api.artifact(ref)).blob} alt="Screenshot of the agent's desktop" className="aspect-[16/10] w-full" />
              ))}
            </div>
          ) : (
            <Btn size="sm" variant="tinted" onClick={() => setShots(true)}>
              Show screenshots ({screenshots.length})
            </Btn>
          )}
        </div>
      )}

      {!d && !q.error && (
        <div className="mt-3">
          <Spinner className="size-4" label="Loading task…" />
        </div>
      )}
      {q.error && !d ? <p className="mt-3 text-footnote text-subtle">Task details are unavailable right now.</p> : null}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {canCommand && !terminal && d && (
          <>
            {state === 'PAUSED' ? (
              <Btn size="sm" loading={isPending('resume')} onClick={() => act('resume', () => api.tasks.resume(task.id), 'Task resumed')}>
                Resume
              </Btn>
            ) : (
              <Btn size="sm" loading={isPending('pause')} disabledReason={state === 'PAUSING' ? 'Already pausing' : null} onClick={() => act('pause', () => api.tasks.pause(task.id), 'Pause requested')}>
                Pause
              </Btn>
            )}
            <Btn size="sm" variant="danger" loading={isPending('stop')} onClick={() => act('stop', () => api.tasks.stop(task.id), 'Stop requested')}>
              Stop
            </Btn>
          </>
        )}
        <a href={mhref(`/tasks/${task.id}`)} className="ml-auto inline-flex min-h-9 items-center px-1 text-footnote font-medium text-accent-soft focus-ring">
          Task details{d ? ` · ${relativeTime(d.created_at)}` : ''}
        </a>
      </div>
    </div>
  );
}
