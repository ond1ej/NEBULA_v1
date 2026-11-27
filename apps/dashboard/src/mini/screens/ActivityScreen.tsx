// Activity: what needs you and what is happening — sign-in requests of agents (Smart Authentication, from the same
// approval-center response: no extra request), pending approvals (task, owner and vault sign-in; approve / deny
// inline), running, queued, failed and recently completed tasks, and recent workflow runs. Compact rows; tap a task
// row for its details, then its full page.
import { useEffect, useMemo, useState } from 'react';
import { ElapsedTimer, TaskStageLine } from '../../components/TaskStage';
import { isTaskLifecycleEvent } from '../../hooks/useEvents';
import { relativeTime, shortId } from '../../lib/format';
import type { RunSummary } from '../../features/workflows/types';
import type { Task } from '../../types';
import { ApprovalCard, fromCenter } from '../approvals';
import { canDecide, useMini } from '../context';
import { shortDuration } from '../format';
import { approvalCenterEvent, useQuery, useTick } from '../hooks';
import { IcActivity, IcCheck, IcChevron } from '../icons';
import { mhref } from '../router';
import { AuthSheet, SignInRow } from '../signin';
import type { ApprovalCenter } from '../types';
import type { AuthSession } from '../../features/smartauth/core/types';
import { Avatar, cx, Empty, ErrorState, List, Pill, Row, Screen, Section, SkeletonList, StatusDot } from '../uiKit';
import { Segmented } from '../uiExtra';

type Filter = 'all' | 'approvals' | 'running' | 'failed';

const RUNNING = new Set(['PLANNING', 'EXECUTING', 'VERIFYING', 'WAITING_APPROVAL', 'WAITING_PROVIDER', 'WAITING_CONTROL', 'PAUSING', 'PAUSED']);
const QUEUED = new Set(['RECEIVED', 'QUEUED']);

export function ActivityScreen({ focus }: { focus?: 'approvals' }) {
  const ctx = useMini();
  const { api } = ctx;
  useTick(30_000);
  const approvals = useQuery<ApprovalCenter>('approvals:count', (s) => api.approvals.center(s), {
    refreshOn: approvalCenterEvent,
    pollMs: 15_000,
  });
  const [signIn, setSignIn] = useState<AuthSession | null>(null);
  const tasks = useQuery<Task[]>('tasks:all', (s) => api.tasks.list(undefined, s), { refreshOn: isTaskLifecycleEvent });
  const workflows = useQuery<RunSummary[]>('workflow-runs', (s) => api.workflows.runs(undefined, s), { refreshOn: (ev) => ev.type.startsWith('workflow.run') });
  const [view, setView] = useState<Filter>(focus ?? 'all');
  useEffect(() => setView(focus ?? 'all'), [focus]);
  const canApprove = canDecide(ctx);

  const groups = useMemo(() => {
    const all = tasks.data ?? [];
    return {
      running: all.filter((t) => RUNNING.has(t.state)),
      queued: all.filter((t) => QUEUED.has(t.state)),
      failed: all.filter((t) => t.state === 'FAILED').slice(0, 10),
      done: all.filter((t) => t.state === 'COMPLETED' || t.state === 'CANCELLED').slice(0, 10),
    };
  }, [tasks.data]);
  const pending = (approvals.data?.pending ?? []).map(fromCenter);
  const signIns = approvals.data?.sign_ins ?? [];
  const show = (f: Filter) => view === 'all' || view === f;

  return (
    <Screen large title={focus === 'approvals' ? 'Approvals' : 'Activity'}>
      <div className="mb-5">
        <Segmented<Filter>
          label="Show"
          value={view}
          onChange={setView}
          options={[
            { id: 'all', label: 'All' },
            { id: 'approvals', label: 'Approvals', badge: pending.length + signIns.length },
            { id: 'running', label: 'Running' },
            { id: 'failed', label: 'Failed' },
          ]}
        />
      </div>

      {show('approvals') && signIns.length > 0 && (
        <Section title={`Needs you · sign-in${signIns.length > 1 ? 's' : ''} · ${signIns.length}`} footer="An agent waits for you to sign in to a website. What you type goes only to the isolated sign-in browser — never to the agent or the AI.">
          <ul className="overflow-hidden rounded-card bg-panel" aria-label="Sign-in requests">
            {signIns.map((s) => (
              <SignInRow key={s.id} s={s} onOpen={setSignIn} />
            ))}
          </ul>
        </Section>
      )}

      {show('approvals') && (
        <Section title={`Needs your approval${pending.length ? ` · ${pending.length}` : ''}`}>
          {approvals.data ? (
            pending.length ? (
              <ul className="space-y-2.5" aria-label="Pending approvals">
                {pending.map((a) => (
                  <li key={a.key}>
                    <ApprovalCard a={a} canApprove={canApprove} onDone={approvals.reload} />
                  </li>
                ))}
              </ul>
            ) : (
              <div className="flex items-center gap-3 rounded-card bg-panel px-4 py-3.5 text-subhead text-muted">
                <span className="grid size-8 place-items-center rounded-full bg-success/15 text-success [&>svg]:size-4">
                  <IcCheck />
                </span>
                {signIns.length ? 'No other approval waits for you.' : 'Nothing waits for you. Agents ask here before risky actions.'}
              </div>
            )
          ) : approvals.error ? (
            <ErrorState error={approvals.error} onRetry={approvals.reload} />
          ) : (
            <SkeletonList rows={1} />
          )}
          {view === 'approvals' && approvals.data && approvals.data.recent.length > 0 && (
            <div className="mt-5">
              <h3 className="mb-1.5 px-4 text-footnote font-medium tracking-[0.02em] text-subtle uppercase">Recently decided</h3>
              <List>
                {approvals.data.recent.slice(0, 10).map((r) => (
                  <Row
                    key={r.id}
                    title={r.action_summary}
                    subtitle={`${r.tool} · ${r.resolved_by ?? '—'} · ${relativeTime(r.resolved_at)}`}
                    trailing={<Pill tone={r.decision === 'approved' ? 'success' : r.decision === 'denied' ? 'danger' : 'neutral'}>{r.decision}</Pill>}
                    chevron={false}
                  />
                ))}
              </List>
            </div>
          )}
        </Section>
      )}

      {view !== 'approvals' && (
        <>
          {!tasks.data ? (
            tasks.error ? (
              <ErrorState error={tasks.error} onRetry={tasks.reload} />
            ) : (
              <SkeletonList rows={4} />
            )
          ) : (
            <>
              {show('running') && <TaskGroup title="Running" tasks={groups.running} empty="No task is running right now." />}
              {view === 'all' && groups.queued.length > 0 && <TaskGroup title="Queued" tasks={groups.queued} />}
              {show('failed') && <TaskGroup title="Failed" tasks={groups.failed} empty={view === 'failed' ? 'No recent failures.' : undefined} />}
              {view === 'all' && groups.done.length > 0 && <TaskGroup title="Recently completed" tasks={groups.done} />}
              {view === 'all' && !tasks.data.length && (
                <Empty title="No activity yet" icon={<IcActivity />}>
                  Tasks you give agents in Chats show up here.
                </Empty>
              )}
            </>
          )}
          {view === 'all' && workflows.data && workflows.data.length > 0 && (
            <Section title="Workflow runs" action={<a href={mhref('/workflows')} className="inline-flex min-h-9 items-center text-subhead text-accent-soft">All workflows</a>}>
              <List>
                {workflows.data.slice(0, 6).map((r) => (
                  <Row
                    key={r.id}
                    href={mhref(`/workflow-runs/${r.id}`)}
                    leading={<StatusDot tone={r.state === 'COMPLETED' ? 'success' : r.state === 'FAILED' ? 'danger' : r.state === 'RUNNING' || r.state === 'WAITING' ? 'accent' : 'neutral'} pulse={r.state === 'RUNNING'} />}
                    title={(r as RunSummary & { workflow_name?: string }).workflow_name ?? `Workflow run ${shortId(r.id)}`}
                    subtitle={`${r.state.toLowerCase()} · ${r.trigger} · ${relativeTime(r.created_at)}${r.error ? ` · ${r.error}` : ''}`}
                  />
                ))}
              </List>
            </Section>
          )}
        </>
      )}
      {signIn && <AuthSheet key={signIn.id} sessionId={signIn.id} seed={signIn} onClose={() => setSignIn(null)} />}
    </Screen>
  );
}

function TaskGroup({ title, tasks, empty }: { title: string; tasks: Task[]; empty?: string }) {
  if (!tasks.length && !empty) return null;
  return (
    <Section title={`${title}${tasks.length ? ` · ${tasks.length}` : ''}`}>
      {tasks.length ? (
        <ul className="overflow-hidden rounded-card bg-panel" aria-label={title}>
          {tasks.map((t) => (
            <TaskRow key={t.id} t={t} />
          ))}
        </ul>
      ) : (
        <p className="rounded-card bg-panel px-4 py-3.5 text-subhead text-muted">{empty}</p>
      )}
    </Section>
  );
}

function TaskRow({ t }: { t: Task }) {
  const [open, setOpen] = useState(false);
  const running = RUNNING.has(t.state) || QUEUED.has(t.state);
  const name = t.agent_name ?? `Agent ${shortId(t.agent_id)}`;
  const tone = t.state === 'FAILED' ? 'danger' : t.state === 'COMPLETED' ? 'success' : t.state === 'WAITING_APPROVAL' || t.state === 'PAUSED' ? 'warning' : running ? 'accent' : 'neutral';
  return (
    <li className="group/row">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="nb-row flex w-full items-start gap-3 pl-4 text-left focus-ring">
        <span className="py-3">
          <Avatar name={name} id={t.agent_id} size="sm" />
        </span>
        <span className="min-w-0 flex-1 border-b border-border py-3 pr-3 group-last/row:border-b-0">
          <span className="flex items-center gap-2">
            <span className="truncate text-subhead font-semibold text-text">{name}</span>
            <span className="ml-auto shrink-0 text-caption text-subtle">{relativeTime(t.finished_at ?? t.started_at ?? t.created_at)}</span>
          </span>
          <span className="line-clamp-1 text-subhead text-muted">{t.prompt}</span>
          <span className="mt-0.5 flex items-center gap-1.5 text-caption">
            {running ? (
              <TaskStageLine taskId={t.id} state={t.state} startedAt={t.started_at} className="min-w-0 text-muted" />
            ) : (
              <span className={cx(tone === 'danger' ? 'text-danger' : tone === 'success' ? 'text-success' : 'text-muted', 'flex min-w-0 items-center gap-1.5')}>
                <StatusDot tone={tone} />
                <span className="truncate">
                {t.state === 'COMPLETED' ? `Completed${t.started_at && t.finished_at ? ` · ${shortDuration(t.finished_at - t.started_at)}` : ''}` : t.state === 'FAILED' ? `Failed${t.failure_reason ? ` · ${t.failure_reason}` : ''}` : t.state.toLowerCase()}
                </span>
              </span>
            )}
            <IcChevron aria-hidden className={cx('ml-auto size-3.5 shrink-0 text-subtle transition-transform duration-200', open && 'rotate-90')} />
          </span>
        </span>
      </button>
      {open && (
        <div className="animate-rise border-b border-border bg-panel-2 px-4 py-3 text-footnote group-last/row:border-b-0">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt className="text-subtle">Task</dt>
            <dd className="font-mono text-text">{shortId(t.id)}</dd>
            <dt className="text-subtle">Steps</dt>
            <dd className="text-text">
              {t.current_step} of {t.max_steps} · {t.tool_calls_done} tool calls
            </dd>
            <dt className="text-subtle">Source</dt>
            <dd className="text-text">{t.source_channel}</dd>
            {t.started_at && (
              <>
                <dt className="text-subtle">{t.finished_at ? 'Took' : 'Running for'}</dt>
                <dd className="text-text">{t.finished_at ? shortDuration(t.finished_at - t.started_at) : <ElapsedTimer sinceEpoch={t.started_at} />}</dd>
              </>
            )}
          </dl>
          <p className="mt-2 whitespace-pre-wrap text-muted [overflow-wrap:anywhere]">{t.prompt.slice(0, 600)}</p>
          {t.result?.summary && <p className="mt-2 line-clamp-4 rounded-xl bg-success/10 px-3 py-2 text-text [overflow-wrap:anywhere]">{t.result.summary}</p>}
          {t.failure_reason && <p className="mt-2 rounded-xl bg-danger/10 px-3 py-2 text-danger [overflow-wrap:anywhere]">{t.failure_reason}</p>}
          <div className="mt-2 flex gap-4">
            <a href={mhref(`/tasks/${t.id}`)} className="inline-flex min-h-11 items-center font-semibold text-accent-soft focus-ring">
              Open task
            </a>
            <a href={mhref(`/agents/${t.agent_id}`)} className="inline-flex min-h-11 items-center font-semibold text-accent-soft focus-ring">
              Chat with {name}
            </a>
          </div>
        </div>
      )}
    </li>
  );
}
