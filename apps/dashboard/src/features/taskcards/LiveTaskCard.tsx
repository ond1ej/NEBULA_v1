// Live Task Card: one compact card per task with its lifecycle, current step, progress, environment and real
// controls (Pause / Resume / Stop / Retry / Open desktop / Details). Updates itself from the SSE stream.
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import { IconApprovals, IconMonitor, IconPause, IconPlay, IconRefresh, IconStop } from '../../components/icons';
import { ConfirmDialog } from '../../components/Modal';
import { ElapsedTimer, stageApplies, useTaskStage } from '../../components/TaskStage';
import { useToast } from '../../components/Toast';
import { Avatar, Badge, Button, ButtonLink, Meter, Mono, StatusDot, type Tone } from '../../components/ui';
import { useNebulaEvents } from '../../hooks/useEvents';
import { href } from '../../hooks/useHashRoute';
import { formatDuration, shortId } from '../../lib/format';
import { stageLabel } from '../../lib/taskStages';
import type { Task } from '../../types';
import { actionsFor, currentStep, ENV_LABEL, envOf, lifecycle, LIFECYCLE_LABEL, TERMINAL_LIFECYCLES, type Lifecycle, type LiveTask, type StepInfo } from './lifecycle';

export const LIFECYCLE_TONE: Record<Lifecycle, Tone> = {
  QUEUED: 'info',
  PREPARING: 'accent',
  RUNNING: 'accent',
  WAITING_FOR_APPROVAL: 'warn',
  PAUSED: 'warn',
  COMPLETED: 'success',
  FAILED: 'danger',
  CANCELLED: 'neutral',
};

const EDGE: Record<Tone, string> = {
  info: 'before:bg-info',
  accent: 'before:bg-accent-soft',
  warn: 'before:bg-warn',
  success: 'before:bg-success',
  danger: 'before:bg-danger',
  neutral: 'before:bg-subtle',
};

const STATE_EVENTS = new Set([
  'task.started',
  'task.paused',
  'task.resumed',
  'task.approval.requested',
  'task.approval.resolved',
  'task.completed',
  'task.failed',
  'task.cancelled',
]);

function stepNote(p: Record<string, unknown>): string | null {
  const detail = typeof p.detail === 'string' ? p.detail : '';
  switch (p.kind) {
    case 'waiting_for_resources':
      return `waiting for resources${detail ? `: ${detail}` : ''}`;
    case 'waking_desktop':
      return 'waking the agent desktop';
    case 'provider_retry':
      return `AI provider unavailable, retrying in ${String(p.retry_in_s ?? '?')} s`;
    case 'provider_fallback':
      return `switched to the fallback provider ${String(p.to ?? '')}`.trim();
    case 'waiting_for_control_release':
      return 'waiting: a viewer holds desktop control';
    default:
      return null;
  }
}

function newer(a: LiveTask, b: LiveTask): boolean {
  return (a.updated_at ?? 0) >= (b.updated_at ?? 0);
}

/** Memoised: the Command Center re-renders on every feed event; a card only re-renders for its own task. */
export const LiveTaskCard = memo(function LiveTaskCard({
  task: initial,
  onChanged,
  fetchDetail = true,
  showAgent = true,
}: {
  task: LiveTask;
  /** Called with the task returned by an action (for Retry: the new task). */
  onChanged?: (t: LiveTask) => void;
  /** Load GET /tasks/{id} once for the latest step (cards on the Command Center). */
  fetchDetail?: boolean;
  showAgent?: boolean;
}) {
  const toast = useToast();
  const [task, setTask] = useState<LiveTask>(initial);
  const [step, setStep] = useState<StepInfo | null>(null);
  const [note, setNoteState] = useState<string | null>(null);
  const noteAt = useRef(0);
  const setNote = (n: string | null) => {
    noteAt.current = n ? Date.now() : 0;
    setNoteState(n);
  };
  const [pending, setPending] = useState<string | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);

  // Lists re-render cards with fresh server rows; rows without updated_at (e.g. /overview) are a newer read too.
  useEffect(() => {
    setTask((cur) => (cur.id !== initial.id ? initial : initial.updated_at == null || newer(initial, cur) ? { ...cur, ...initial } : cur));
  }, [initial]);

  const refresh = useCallback(async () => {
    try {
      const d = await api.tasks.get(initial.id);
      if (!alive.current) return;
      setTask((cur) => ({ ...cur, ...(d as LiveTask) }));
      const last = d.steps?.[d.steps.length - 1];
      if (last) setStep({ tool_type: last.tool_type, result_status: last.result_status });
    } catch {
      // the list that rendered this card keeps showing the last known state; errors surface on actions
    }
  }, [initial.id]);

  useEffect(() => {
    alive.current = true;
    if (fetchDetail) void refresh();
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [fetchDetail, refresh]);

  useNebulaEvents((ev) => {
    if (ev.task_id !== task.id) return;
    const p = ev.payload ?? {};
    if (ev.type === 'task.step') {
      if (typeof p.seq === 'number' && typeof p.tool === 'string') {
        setStep({ tool_type: p.tool, result_status: String(p.status ?? '') });
        setNote(null);
        const seq = p.seq;
        setTask((t) => ({ ...t, current_step: Math.max(t.current_step, seq) }));
      } else {
        setNote(stepNote(p));
      }
      return;
    }
    if (STATE_EVENTS.has(ev.type)) {
      setNote(null);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void refresh(), 250);
    }
  });

  const stage = useTaskStage(task.id);
  const st = lifecycle(task);
  const tone = LIFECYCLE_TONE[st] ?? 'neutral';
  const env = envOf(task);
  const terminal = TERMINAL_LIFECYCLES.includes(st);
  const actions = actionsFor(task);
  const title = (task.prompt.trim().split('\n')[0] || 'Task').slice(0, 140);
  const pct = task.max_steps ? (task.current_step / task.max_steps) * 100 : 0;
  const agentName = task.agent_name ?? shortId(task.agent_id);
  const running = st === 'RUNNING' || st === 'PREPARING';
  const elapsed = task.started_at && task.finished_at ? task.finished_at - task.started_at : null;
  // The live stage ("Waiting for the model · 4 s") wins unless a more specific note arrived after it.
  const liveStage = !terminal && stage && stageApplies(task.state) && stage.receivedAt >= noteAt.current ? stage : null;

  const act = async (key: string, fn: () => Promise<Task>, success: (t: Task) => string) => {
    setPending(key);
    try {
      const r = await fn();
      if (key !== 'retry') setTask((cur) => ({ ...cur, ...(r as LiveTask) }));
      toast.success(success(r));
      onChanged?.(r as LiveTask);
      return r;
    } catch (e) {
      toast.error(e, 'Task action failed');
      return undefined;
    } finally {
      setPending(null);
    }
  };

  return (
    <article
      aria-label={`Task ${shortId(task.id)} — ${agentName}: ${LIFECYCLE_LABEL[st] ?? st}`}
      data-testid="live-task-card"
      data-lifecycle={st}
      className={`relative min-w-0 overflow-hidden rounded-xl border border-border bg-panel px-4 py-3.5 shadow-card before:absolute before:inset-y-0 before:left-0 before:w-[3px] ${EDGE[tone]}`}
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {showAgent && <Avatar name={agentName} id={task.agent_id} size="xs" />}
          {showAgent && (
            <a href={href(`/agents/${task.agent_id}`)} className="truncate rounded text-[13px] font-medium text-text hover:underline focus-ring">
              {agentName}
            </a>
          )}
          <Badge tone={env === 'host' ? 'warn' : 'neutral'} title={env === 'host' ? 'Runs natively on this Mac' : 'Runs in the shared Ubuntu VM'}>
            {ENV_LABEL[env]}
          </Badge>
        </div>
        <span className="inline-flex items-center gap-1.5 text-xs font-medium">
          <StatusDot tone={tone} pulse={running} label={LIFECYCLE_LABEL[st] ?? st} />
          <span className={tone === 'danger' ? 'text-danger' : tone === 'warn' ? 'text-warn' : tone === 'success' ? 'text-success' : 'text-text'}>{st}</span>
        </span>
      </header>

      <p className="mt-2 line-clamp-2 text-sm break-words text-text" title={task.prompt}>
        {title}
      </p>
      <p className={`mt-1 text-xs break-words ${st === 'FAILED' ? 'text-danger' : 'text-muted'}`}>
        <span className="text-subtle">{terminal ? 'Result: ' : 'Current step: '}</span>
        {liveStage ? (
          <span data-testid="task-card-step" data-stage={liveStage.stage}>
            <span className="text-text">{stageLabel(liveStage)}</span>
            <span className="text-subtle"> · </span>
            <ElapsedTimer stage={liveStage} className="text-subtle" />
          </span>
        ) : (
          <span data-testid="task-card-step">{currentStep(task, step, note)}</span>
        )}
      </p>

      <div className="mt-2.5">
        <div className="mb-1 flex items-center justify-between gap-2 text-2xs text-subtle tabular-nums">
          <span>{task.max_steps ? `Progress ${task.current_step}/${task.max_steps} steps` : `Step ${task.current_step}`}</span>
          <span className="flex items-center gap-2">
            {terminal ? (
              elapsed != null && elapsed > 0 && <span>{formatDuration(elapsed)}</span>
            ) : stage ? (
              <ElapsedTimer total={stage} />
            ) : task.started_at ? (
              <ElapsedTimer sinceEpoch={task.started_at} />
            ) : null}
            <Mono className="text-[10.5px]">#{shortId(task.id)}</Mono>
          </span>
        </div>
        <Meter value={pct} label={`Task ${shortId(task.id)} step budget used`} size="sm" tone={tone === 'danger' ? 'danger' : tone === 'warn' ? 'warn' : tone === 'success' ? 'success' : 'accent'} />
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {actions.includes('pause') && (
          <Button size="xs" icon={<IconPause />} loading={pending === 'pause'} disabled={pending !== null} onClick={() => void act('pause', () => api.tasks.pause(task.id, 'smart'), () => 'Pause requested')}>
            Pause
          </Button>
        )}
        {actions.includes('resume') && (
          <Button size="xs" variant="primary" icon={<IconPlay />} loading={pending === 'resume'} disabled={pending !== null} onClick={() => void act('resume', () => api.tasks.resume(task.id), () => 'Task resumed')}>
            Resume
          </Button>
        )}
        {actions.includes('approval') && (
          <ButtonLink size="xs" variant="primary" icon={<IconApprovals />} href={href('/approvals')}>
            Review approval
          </ButtonLink>
        )}
        {actions.includes('stop') && (
          <Button size="xs" variant="danger" icon={<IconStop />} disabled={pending !== null} loading={pending === 'stop'} onClick={() => setConfirmStop(true)}>
            Stop
          </Button>
        )}
        {actions.includes('retry') && (
          <Button size="xs" variant="primary" icon={<IconRefresh />} loading={pending === 'retry'} disabled={pending !== null} onClick={() => void act('retry', () => api.tasks.retry(task.id), (t) => `Retry queued as task ${shortId(t.id)}`)}>
            Retry
          </Button>
        )}
        {actions.includes('desktop') && (
          <ButtonLink size="xs" icon={<IconMonitor />} href={href(`/agents/${task.agent_id}/live`)}>
            Open desktop
          </ButtonLink>
        )}
        {actions.includes('details') && (
          <ButtonLink size="xs" variant="ghost" href={href(`/agents/${task.agent_id}/tasks?task=${task.id}`)}>
            Details
          </ButtonLink>
        )}
      </div>

      <ConfirmDialog
        open={confirmStop}
        title="Stop this task?"
        confirmLabel="Stop task"
        onCancel={() => setConfirmStop(false)}
        onConfirm={async () => {
          const r = await act('stop', () => api.tasks.stop(task.id, 'cancel'), () => 'Stop requested');
          if (r) setConfirmStop(false);
        }}
      >
        <p>
          <strong>{agentName}</strong> stops after the current tool call and the task ends as CANCELLED. An action already sent to the {env === 'host' ? 'Mac' : 'VM'} cannot be taken back.
        </p>
      </ConfirmDialog>
    </article>
  );
});
