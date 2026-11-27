import { useState, type ReactNode } from 'react';
import { api, artifactUrl } from '../api';
import { useAction, useApi } from '../hooks/useApi';
import { TASK_PROGRESS_EVENTS, useLiveRefresh } from '../hooks/useEvents';
import { href } from '../hooks/useHashRoute';
import { useAuthedUrl } from '../lib/authedUrl';
import { formatDuration, formatTime, percent, shortId } from '../lib/format';
import { TERMINAL_TASK_STATES, type Task, type TaskStep } from '../types';
import { ApprovalCard } from './Approval';
import { IconPause, IconPlay, IconRefresh, IconStop } from './icons';
import { ConfirmDialog } from './Modal';
import { StatusPill } from './StatusPill';
import { ElapsedTimer, TaskStageLine } from './TaskStage';
import { Badge, Button, Card, ErrorBanner, KeyValue, LoadingRows, Meter, Mono, Notice } from './ui';

export function isTerminal(state: string): boolean {
  return TERMINAL_TASK_STATES.includes(state);
}

/** Pause / Resume / Stop / Emergency stop / Retry for one task, with confirmations. */
export function TaskActions({ task, onChanged, size = 'sm' }: { task: Task; onChanged?: (t: Task) => void; size?: 'sm' | 'md' }) {
  const { run, isPending } = useAction();
  const [confirm, setConfirm] = useState<null | 'cancel' | 'emergency'>(null);
  const terminal = isTerminal(task.state);
  const paused = task.state === 'PAUSED';
  const canResume = paused || task.state === 'WAITING_PROVIDER';
  const canPause = !terminal && !paused && task.state !== 'PAUSING';
  const canRetry = task.state === 'FAILED' || task.state === 'CANCELLED';

  const act = async (key: string, fn: () => Promise<Task>, success: string) => {
    const r = await run(key, fn, { success });
    if (r) onChanged?.(r);
    return r;
  };

  return (
    <div className="flex flex-wrap gap-1.5">
      {canPause && (
        <Button size={size} icon={<IconPause />} onClick={() => act('pause', () => api.tasks.pause(task.id, 'smart'), 'Smart pause requested')} loading={isPending('pause')}>
          Pause
        </Button>
      )}
      {canPause && (
        <Button
          size={size}
          variant="ghost"
          onClick={() => act('ipause', () => api.tasks.pause(task.id, 'immediate'), 'Immediate pause requested')}
          loading={isPending('ipause')}
          title="Blocks new tool calls now; an action already sent cannot be taken back"
        >
          Pause now
        </Button>
      )}
      {canResume && (
        <Button size={size} variant="primary" icon={<IconPlay />} onClick={() => act('resume', () => api.tasks.resume(task.id), 'Task resumed')} loading={isPending('resume')}>
          Resume
        </Button>
      )}
      {!terminal && (
        <Button size={size} variant="danger" icon={<IconStop />} onClick={() => setConfirm('cancel')}>
          Stop
        </Button>
      )}
      {!terminal && (
        <Button size={size} variant="danger" onClick={() => setConfirm('emergency')}>
          Emergency stop
        </Button>
      )}
      {canRetry && (
        <Button size={size} variant="primary" icon={<IconRefresh />} onClick={() => act('retry', () => api.tasks.retry(task.id), 'Retry queued as a new task')} loading={isPending('retry')}>
          Retry
        </Button>
      )}
      <ConfirmDialog
        open={confirm === 'cancel'}
        title="Stop this task?"
        confirmLabel="Stop task"
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          const r = await act('stop', () => api.tasks.stop(task.id, 'cancel'), 'Stop requested');
          if (r) setConfirm(null);
        }}
      >
        <p>The agent finishes or aborts its current step at the next safe boundary and the task ends as <strong>CANCELLED</strong>. The agent and its desktop keep running.</p>
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm === 'emergency'}
        title="Emergency stop?"
        confirmLabel="Emergency stop"
        busyText="Killing agent runtime…"
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          const r = await act('estop', () => api.tasks.stop(task.id, 'emergency'), 'Emergency stop executed');
          if (r) setConfirm(null);
        }}
      >
        <div className="space-y-2">
          <p>This immediately kills this agent's tool runtime (its browser and shell processes). The shared Ubuntu VM and other agents are not affected.</p>
          <Notice tone="warn">An action that was already in flight (e.g. a submitted form, a sent message) may be incomplete. The task result will list possible incomplete side effects.</Notice>
        </div>
      </ConfirmDialog>
    </div>
  );
}

export function StepScreenshot({ refPath, alt }: { refPath: string; alt: string }) {
  const url = useAuthedUrl(artifactUrl(refPath));
  if (!url) return <span role="img" aria-label={alt} className="block h-24 w-40 animate-pulse-soft rounded-lg border border-border bg-panel-2" />;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className="block w-fit overflow-hidden rounded-lg border border-border focus-ring">
      <img src={url} alt={alt} loading="lazy" className="max-h-40 max-w-full object-contain sm:max-w-[280px]" />
    </a>
  );
}

export function StepRow({ step }: { step: Pick<TaskStep, 'seq' | 'tool_type' | 'result_status' | 'result_summary' | 'screenshot_ref' | 'elapsed_ms'> & { args_sanitized?: TaskStep['args_sanitized'] } }) {
  return (
    <li className="rounded-lg border border-border bg-input/60 px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <Mono className="text-subtle tabular-nums">#{step.seq}</Mono>
        <Mono className="text-text">{step.tool_type}</Mono>
        <StatusPill state={step.result_status} />
        {step.elapsed_ms != null && <span className="text-2xs text-subtle tabular-nums">{step.elapsed_ms} ms</span>}
      </div>
      {step.result_summary && <p className="mt-1 text-[13px] leading-relaxed break-words whitespace-pre-wrap text-muted">{step.result_summary}</p>}
      {step.args_sanitized && Object.keys(step.args_sanitized).length > 0 && (
        <details className="mt-1">
          <summary className="inline-flex rounded text-xs text-subtle hover:text-text focus-ring">Arguments</summary>
          <pre className="mt-1 max-h-40 overflow-auto rounded-md bg-bg p-2 font-mono text-2xs text-muted">{JSON.stringify(step.args_sanitized, null, 2)}</pre>
        </details>
      )}
      {step.screenshot_ref && (
        <div className="mt-2">
          <StepScreenshot refPath={step.screenshot_ref} alt={`Screenshot after step ${step.seq} (${step.tool_type})`} />
        </div>
      )}
    </li>
  );
}

function H3({ children }: { children: ReactNode }) {
  return <h3 className="mb-1.5 text-2xs font-semibold tracking-wider text-subtle uppercase">{children}</h3>;
}

export function TaskDetailPanel({ taskId, onClose, variant = 'card' }: { taskId: string; onClose?: () => void; variant?: 'card' | 'plain' }) {
  const { data: task, error, loading, reload, setData } = useApi(() => api.tasks.get(taskId), [taskId]);
  // stage changes and streamed text are shown live without refetching the whole task
  useLiveRefresh(reload, (ev) => ev.task_id === taskId && !TASK_PROGRESS_EVENTS.has(ev.type), 400);

  if (!task && loading)
    return variant === 'card' ? (
      <Card title="Task">
        <LoadingRows label="Loading task…" />
      </Card>
    ) : (
      <LoadingRows label="Loading task…" />
    );
  if (!task) return <ErrorBanner error={error} onRetry={reload} title="Could not load task" />;

  const res = task.result ?? null;
  const elapsed = task.started_at ? (task.finished_at ?? Date.now() / 1000) - task.started_at : null;
  const incomplete = Array.isArray(res?.possible_incomplete_side_effects) ? res.possible_incomplete_side_effects : [];

  const body = (
    <>
      {error ? (
        <div className="mb-3">
          <ErrorBanner error={error} onRetry={reload} title="Refresh failed" />
        </div>
      ) : null}
      <div className={`grid gap-6 ${variant === 'card' ? 'lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]' : ''}`}>
        <div className="min-w-0 space-y-5">
          <div>
            <H3>Prompt</H3>
            <p className="text-sm leading-relaxed whitespace-pre-wrap text-text">{task.prompt}</p>
          </div>
          <div>
            <H3>Progress</H3>
            <p className="mb-2 text-sm text-muted tabular-nums">
              Step {task.current_step} · {task.tool_calls_done} tool call{task.tool_calls_done === 1 ? '' : 's'} done · budget {task.max_steps} steps
            </p>
            <Meter value={percent(task.current_step, task.max_steps)} label="Step budget used" tone={task.state === 'FAILED' ? 'danger' : 'accent'} />
            <p className="mt-1.5 text-xs text-subtle">The bar shows the share of the step budget used, not an estimate of completion.</p>
            {!isTerminal(task.state) && <TaskStageLine taskId={task.id} state={task.state} startedAt={task.started_at} className="mt-2 text-sm text-text" />}
          </div>
          <KeyValue
            items={[
              ['Source', task.source_channel],
              ['Created', formatTime(task.created_at)],
              ['Started', formatTime(task.started_at)],
              ['Finished', formatTime(task.finished_at)],
              ['Running time', task.started_at && !task.finished_at && !isTerminal(task.state) ? <ElapsedTimer key="rt" sinceEpoch={task.started_at} /> : formatDuration(elapsed)],
              ['Retries', String(task.retry_count)],
              ['Checkpoint', task.checkpoint_id ? <Mono>{shortId(task.checkpoint_id)}</Mono> : '—'],
              ['Pause requested', task.pause_requested ?? '—'],
            ]}
          />
          {task.failure_reason && (
            <Notice tone={task.state === 'FAILED' ? 'danger' : 'warn'} title={task.state === 'FAILED' ? 'Failure reason' : 'Last provider issue'}>
              {task.failure_reason}
            </Notice>
          )}
          {res && (
            <div className="space-y-2.5">
              <H3>Result</H3>
              {res.summary && <p className="text-sm leading-relaxed whitespace-pre-wrap text-text">{res.summary}</p>}
              {res.verification && (
                <p className="text-sm text-muted">
                  Verification: <StatusPill state={res.verification} tone={res.verification === 'artifacts_verified' ? 'success' : 'neutral'} />
                </p>
              )}
              {Array.isArray(res.verified_artifacts) && res.verified_artifacts.length > 0 && (
                <ul className="space-y-1 text-sm">
                  {res.verified_artifacts.map((a, i) => (
                    <li key={i} className="flex min-w-0 gap-2">
                      <Badge>{a.type}</Badge> <span className="min-w-0 break-all text-text">{a.value}</span>
                    </li>
                  ))}
                </ul>
              )}
              {incomplete.length > 0 && (
                <Notice tone="warn" title="Possible incomplete side effects">
                  <pre className="overflow-auto font-mono text-2xs">{JSON.stringify(incomplete, null, 2)}</pre>
                </Notice>
              )}
              {Array.isArray(res.screenshots) && res.screenshots.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {res.screenshots.slice(-4).map((r) => (
                    <StepScreenshot key={r} refPath={r} alt="Task screenshot" />
                  ))}
                </div>
              )}
            </div>
          )}
          {task.approvals.length > 0 && (
            <div className="space-y-2">
              <H3>Approvals</H3>
              {task.approvals.map((a) => (
                <ApprovalCard key={a.id} approval={a} compact onResolved={() => reload()} />
              ))}
            </div>
          )}
        </div>
        <div className="min-w-0">
          <H3>Run log ({task.steps.length} steps)</H3>
          {task.steps.length === 0 ? (
            <p className="text-sm text-muted">No tool steps recorded yet.</p>
          ) : (
            <ol className={`space-y-2 overflow-y-auto pr-1 ${variant === 'card' ? 'max-h-[640px]' : ''}`}>
              {task.steps.map((s) => (
                <StepRow key={s.id} step={s} />
              ))}
            </ol>
          )}
        </div>
      </div>
    </>
  );

  const header = (
    <span className="flex flex-wrap items-center gap-2">
      Task <Mono className="text-text">{shortId(task.id)}</Mono>
      <StatusPill state={task.state} pulse={!isTerminal(task.state)} />
    </span>
  );

  if (variant === 'plain') {
    return (
      <div className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-text">{header}</p>
            {task.agent_name && (
              <p className="mt-0.5 text-xs text-muted">
                Agent{' '}
                <a className="rounded underline underline-offset-2 hover:text-text focus-ring" href={href(`/agents/${task.agent_id}`)}>
                  {task.agent_name}
                </a>
              </p>
            )}
          </div>
          <TaskActions task={task} onChanged={(t) => setData((prev) => (prev ? { ...prev, ...t } : prev))} />
        </div>
        {body}
      </div>
    );
  }

  return (
    <Card
      title={header}
      subtitle={
        task.agent_name ? (
          <>
            Agent{' '}
            <a className="rounded underline underline-offset-2 hover:text-text focus-ring" href={href(`/agents/${task.agent_id}`)}>
              {task.agent_name}
            </a>
          </>
        ) : undefined
      }
      actions={
        <>
          <TaskActions task={task} onChanged={(t) => setData((prev) => (prev ? { ...prev, ...t } : prev))} />
          {onClose && (
            <Button size="sm" variant="ghost" onClick={onClose}>
              Close
            </Button>
          )}
        </>
      }
    >
      {body}
    </Card>
  );
}
