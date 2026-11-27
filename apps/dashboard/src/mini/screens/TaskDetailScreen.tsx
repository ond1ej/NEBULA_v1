import { useState } from 'react';
import { ConfirmDialog } from '../../components/Modal';
import { IconPause, IconPlay, IconRefresh, IconStop } from '../../components/icons';
import { BUSY_STATES, StatusPill } from '../../components/StatusPill';
import { ElapsedTimer, TaskStageLine } from '../../components/TaskStage';
import { Badge, KeyValue, Notice } from '../../components/ui';
import { TASK_PROGRESS_EVENTS } from '../../hooks/useEvents';
import { formatDuration, formatTime, relativeTime, shortId } from '../../lib/format';
import { TERMINAL_TASK_STATES, type TaskDetail } from '../../types';
import { canDecide, hasPermission, useMini } from '../context';
import { useActions, useQuery } from '../hooks';
import { mhref, navigate } from '../router';
import { Card, Clamp, QueryView, Screen, Section, TapButton } from '../uiKit';
import { AuthImage } from '../uiExtra';

export function TaskDetailScreen({ taskId }: { taskId: string }) {
  const ctx = useMini();
  const { api } = ctx;
  const { run, isPending } = useActions();
  const q = useQuery<TaskDetail>(`task:${taskId}`, (s) => api.tasks.get(taskId, s), {
    // steps and state changes refetch; the live stage and streamed text do not
    refreshOn: (ev) => ev.task_id === taskId && !TASK_PROGRESS_EVENTS.has(ev.type),
    pollMs: 10_000,
  });
  const [confirm, setConfirm] = useState<null | 'stop'>(null);
  const t = q.data;
  const canCommand = hasPermission(ctx, 'commands');
  const canApprove = canDecide(ctx);
  const act = async (key: string, fn: () => Promise<unknown>, success: string) => {
    const r = await run(key, fn, { success });
    if (r !== undefined) q.reload();
    return r;
  };
  const terminal = t ? TERMINAL_TASK_STATES.includes(t.state) : false;
  const paused = t?.state === 'PAUSED' || t?.state === 'WAITING_PROVIDER';

  return (
    <Screen title={t ? `Task ${shortId(t.id)}` : 'Task'} subtitle={t ? (t.agent_name ?? 'agent') : undefined}>
      <QueryView q={q}>
        {(task) => (
          <>
            <Card className="mb-4">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <StatusPill state={task.state} pulse={BUSY_STATES.has(task.state)} />
                <a href={mhref(`/agents/${task.agent_id}`)} className="inline-flex min-h-11 items-center text-[13px] text-accent-soft underline-offset-2 focus-ring">
                  {task.agent_name ?? `agent ${shortId(task.agent_id)}`}
                </a>
                <span className="text-xs text-subtle">via {task.source_channel}</span>
              </div>
              <p className="text-[14.5px] leading-snug whitespace-pre-wrap text-text [overflow-wrap:anywhere]">{task.prompt}</p>
              {!terminal && (
                <div className="mt-3 rounded-lg border border-accent/25 bg-accent/[0.06] px-3 py-2 text-[13.5px] text-text">
                  <TaskStageLine taskId={task.id} state={task.state} startedAt={task.started_at} className="max-w-full" />
                </div>
              )}
              {task.failure_reason && (
                <div className="mt-3">
                  <Notice tone="danger" title="Failed">
                    {task.failure_reason}
                  </Notice>
                </div>
              )}
              {task.result?.summary && (
                <div className="mt-3 rounded-lg border border-success/30 bg-success/[0.07] p-3">
                  <p className="mb-1 text-xs font-semibold text-success">Result</p>
                  <p className="text-[13.5px] whitespace-pre-wrap text-text [overflow-wrap:anywhere]">{task.result.summary}</p>
                  {task.result.verification && <p className="mt-1 text-xs text-muted">{String(task.result.verification)}</p>}
                </div>
              )}
            </Card>

            {canCommand && (
              <div className="mb-4 grid grid-cols-2 gap-2">
                {!terminal &&
                  (paused ? (
                    <TapButton icon={<IconPlay />} loading={isPending('resume')} onClick={() => act('resume', () => api.tasks.resume(task.id), 'Task resumed')}>
                      Resume
                    </TapButton>
                  ) : (
                    <TapButton icon={<IconPause />} loading={isPending('pause')} disabledReason={task.state === 'PAUSING' ? 'Already pausing' : null} onClick={() => act('pause', () => api.tasks.pause(task.id), 'Pause requested')}>
                      Pause
                    </TapButton>
                  ))}
                {!terminal && (
                  <TapButton variant="danger" icon={<IconStop />} onClick={() => setConfirm('stop')}>
                    Stop
                  </TapButton>
                )}
                {(task.state === 'FAILED' || task.state === 'CANCELLED') && (
                  <TapButton
                    variant="primary"
                    icon={<IconRefresh />}
                    loading={isPending('retry')}
                    className="col-span-2"
                    onClick={async () => {
                      const r = (await act('retry', () => api.tasks.retry(task.id), 'Task queued again')) as { id?: string } | undefined;
                      if (r?.id) navigate(`/tasks/${r.id}`);
                    }}
                  >
                    Retry task
                  </TapButton>
                )}
              </div>
            )}

            {task.approvals.some((a) => a.decision === null) && (
              <Section title="Waiting for your approval">
                <div className="space-y-2">
                  {task.approvals
                    .filter((a) => a.decision === null)
                    .map((a) => (
                      <Card key={a.id} className="border-warn/40">
                        <p className="text-xs font-semibold text-warn">{a.tool}</p>
                        <p className="mt-1 text-[14px] whitespace-pre-wrap text-text [overflow-wrap:anywhere]">{a.action_summary}</p>
                        {a.reason && <p className="mt-1 text-xs text-muted">Reason: {a.reason}</p>}
                        <p className="mt-1 text-[11px] text-subtle">expires {relativeTime(a.expires_at)}</p>
                        {canApprove && (
                          <div className="mt-2 grid grid-cols-2 gap-2">
                            <TapButton variant="danger" loading={isPending(`deny:${a.id}`)} onClick={() => act(`deny:${a.id}`, () => api.approvals.resolveTask(a.id, 'denied'), 'Rejected')}>
                              Reject
                            </TapButton>
                            <TapButton variant="primary" loading={isPending(`ok:${a.id}`)} onClick={() => act(`ok:${a.id}`, () => api.approvals.resolveTask(a.id, 'approved'), 'Approved')}>
                              Approve
                            </TapButton>
                          </div>
                        )}
                      </Card>
                    ))}
                </div>
              </Section>
            )}

            <Section title="Details">
              <Card>
                <KeyValue
                  items={[
                    ['Created', formatTime(task.created_at)],
                    ['Started', formatTime(task.started_at)],
                    ['Finished', formatTime(task.finished_at)],
                    ['Duration', task.started_at ? (task.finished_at || terminal ? formatDuration((task.finished_at ?? Date.now() / 1000) - task.started_at) : <ElapsedTimer key="d" sinceEpoch={task.started_at} />) : '—'],
                    ['Steps', `${task.current_step} / ${task.max_steps} · ${task.tool_calls_done} tool calls`],
                    ['Retries', String(task.retry_count)],
                  ]}
                />
              </Card>
            </Section>

            <Section title={`Steps (${task.steps.length})`}>
              {task.steps.length === 0 ? (
                <p className="px-1 text-sm text-muted">No steps yet.</p>
              ) : (
                <ol className="space-y-2">
                  {[...task.steps].reverse().map((s) => (
                    <li key={s.id} className="rounded-card bg-panel p-3">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-mono text-[11px] text-subtle">#{s.seq}</span>
                        <span className="text-[13px] font-medium text-text">{s.tool_type}</span>
                        <Badge tone={s.result_status === 'ok' || s.result_status === 'success' ? 'success' : s.result_status === 'error' || s.result_status === 'failed' ? 'danger' : 'neutral'}>
                          {s.result_status}
                        </Badge>
                        {s.elapsed_ms != null && <span className="ml-auto text-[11px] text-subtle">{(s.elapsed_ms / 1000).toFixed(1)} s</span>}
                      </div>
                      {s.result_summary && <Clamp lines={3} className="mt-1 text-[12.5px] text-muted">{s.result_summary}</Clamp>}
                      {s.screenshot_ref && (
                        <details className="mt-2">
                          <summary className="inline-flex min-h-11 items-center text-xs font-medium text-accent-soft">Show screenshot</summary>
                          <AuthImage load={async () => (await api.artifact(s.screenshot_ref!)).blob} alt={`Screenshot after step ${s.seq}`} className="mt-1 aspect-[16/10] w-full" />
                        </details>
                      )}
                    </li>
                  ))}
                </ol>
              )}
            </Section>
          </>
        )}
      </QueryView>
      <ConfirmDialog
        open={confirm === 'stop'}
        title="Stop this task?"
        confirmLabel="Stop task"
        busyText="Stopping…"
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          const r = await act('stop', () => api.tasks.stop(taskId), 'Stop requested');
          if (r !== undefined) setConfirm(null);
        }}
      >
        <p>The agent stops at the next safe point. Completed steps are kept.</p>
      </ConfirmDialog>
    </Screen>
  );
}
