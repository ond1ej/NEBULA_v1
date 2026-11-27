// Command Center: one screen with everything that is happening on this Mac (GET /overview + live events).
import { useMemo, useState, type ReactNode } from 'react';
import { api } from '../api';
import { ApprovalCard, OwnerApprovalCard, useApprovals } from '../components/Approval';
import {
  IconAgents,
  IconArrowRight,
  IconBell,
  IconCalendar,
  IconCheckCircle,
  IconCpu,
  IconMemory,
  IconMonitor,
  IconPlus,
  IconProviders,
  IconResources,
  IconSchedules,
  IconTasks,
  IconTeams,
  IconWorkflows,
} from '../components/icons';
import { LanAddressLine } from '../components/LanAccess';
import { providerLabel } from '../lib/providers';
import { BUSY_STATES, StatusPill, toneFor } from '../components/StatusPill';
import { TONE_DOT } from '../components/tone';
import {
  Avatar,
  Badge,
  Button,
  ButtonLink,
  Card,
  EmptyState,
  ErrorBanner,
  LoadingRows,
  Meter,
  Notice,
  PageHeader,
  Skeleton,
  Stat,
  StatusDot,
  TextLink,
  usageTone,
} from '../components/ui';
import { useApi, useNow } from '../hooks/useApi';
import { useLiveRefresh, useNebulaEvents } from '../hooks/useEvents';
import { href, navigate } from '../hooks/useHashRoute';
import { useHealth } from '../hooks/useHealth';
import { OnboardingChecklist } from '../features/onboarding/OnboardingChecklist';
import { readDismissed, writeDismissed } from '../features/onboarding/storage';
import { LiveTaskCard } from '../features/taskcards/LiveTaskCard';
import type { LiveTask } from '../features/taskcards/lifecycle';
import { describeEvent, FEED_NOISE } from '../lib/events';
import { formatBytes, formatTime, relativeTime } from '../lib/format';
import type { NebulaEvent, OverviewData } from '../types';

const REFRESH_TYPES = ['task.', 'team.', 'schedule.', 'workflow.', 'agent.', 'provider.', 'owner.approval.', 'vm.state.changed', 'resource.pressure.changed', 'resource.alert'];
/** Per-step / per-stage progress and streamed text: shown live by the cards, they never change the overview data. */
const NO_REFRESH = new Set(['task.step', 'task.message', 'task.stage', 'workflow.step']);
const refreshesOverview = (e: NebulaEvent) => !NO_REFRESH.has(e.type) && REFRESH_TYPES.some((t) => e.type.startsWith(t));

function ListRow({ children, link }: { children: ReactNode; link?: string }) {
  const cls = 'flex min-w-0 items-start gap-3 px-4 py-3 sm:px-5';
  return (
    <li className="border-b border-border/60 last:border-0">
      {link ? (
        <a href={link} className={`${cls} transition-colors hover:bg-white/[0.02] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-soft`}>
          {children}
        </a>
      ) : (
        <div className={cls}>{children}</div>
      )}
    </li>
  );
}

function CardLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <a href={to} className="inline-flex items-center gap-1 rounded text-xs font-medium text-muted transition-colors hover:text-text focus-ring">
      {children}
      <IconArrowRight className="size-3.5" />
    </a>
  );
}

type FeedEvent = Omit<NebulaEvent, 'id'>;

export function OverviewPage() {
  // Events refresh the overview; the poll keeps host CPU / memory current (30 s while the stream is live).
  const ov = useApi(() => api.overview(), [], { pollMs: 15_000, livePollMs: 30_000 });
  const lan = useApi(() => api.system.lan(), []);
  const { health } = useHealth();
  const approvals = useApprovals();
  const [live, setLive] = useState<FeedEvent[]>([]);
  const [checklistHidden, setChecklistHidden] = useState(readDismissed);
  useNow(30_000); // keep relative times fresh

  useLiveRefresh(ov.reload, refreshesOverview, 1000);
  useNebulaEvents((e) => {
    if (FEED_NOISE.has(e.type)) return;
    setLive((xs) => (xs.some((x) => x.sequence === e.sequence) ? xs : [e, ...xs].slice(0, 40)));
  });

  const d = ov.data;
  const agentName = (id: string) => d?.agents.find((a) => a.id === id)?.name;
  const feed = useMemo(() => {
    const seen = new Set<number>();
    return [...live, ...[...(d?.recent_events ?? [])].reverse()]
      .filter((e) => !FEED_NOISE.has(e.type))
      .filter((e) => (seen.has(e.sequence) ? false : (seen.add(e.sequence), true)))
      .sort((a, b) => b.sequence - a.sequence)
      .slice(0, 14);
  }, [live, d?.recent_events]);

  const res = d?.resources;
  const host = res?.host;
  const guest = res?.guest;
  const activeAgents = d?.agents.filter((a) => a.status === 'ACTIVE').length ?? 0;
  const vmState = health?.vm.state ?? null;
  const memPct = host?.memory_used_percent ?? null;
  const runningCards = useMemo<LiveTask[]>(
    () =>
      (d?.running_tasks ?? []).slice(0, 6).map((t) => ({
        id: t.id,
        agent_id: t.agent_id,
        agent_name: t.agent_name,
        prompt: t.prompt,
        state: t.state,
        current_step: t.current_step,
        max_steps: 0, // not in /overview; each card loads the full task once
        started_at: t.started_at,
        source_channel: t.source_channel,
      })),
    [d?.running_tasks],
  );

  return (
    <>
      <PageHeader
        title="Command Center"
        description="Live state of this Mac, the shared Ubuntu VM, your agents and every automation."
        actions={
          <>
            {checklistHidden && (
              <Button
                variant="ghost"
                onClick={() => {
                  writeDismissed(false);
                  setChecklistHidden(false);
                }}
              >
                Setup checklist
              </Button>
            )}
            <ButtonLink href={href("/schedules?new=1")} icon={<IconCalendar />}>
              New schedule
            </ButtonLink>
            <Button variant="primary" icon={<IconPlus />} onClick={() => navigate('/agents/new')}>
              Create Agent
            </Button>
          </>
        }
      />

      {ov.error && !d ? (
        <div className="mb-5">
          <ErrorBanner error={ov.error} onRetry={ov.reload} title="Command Center data unavailable" />
        </div>
      ) : null}

      {d && !checklistHidden && (
        <OnboardingChecklist
          overview={d}
          onDismiss={() => {
            writeDismissed(true);
            setChecklistHidden(true);
          }}
        />
      )}

      {approvals.count > 0 && (
        <div className="mb-5">
          <Notice
            tone="warn"
            title={`${approvals.count} ${approvals.count === 1 ? 'request is' : 'requests are'} waiting for your decision`}
            action={
              <Button size="sm" variant="primary" icon={<IconBell />} onClick={approvals.openPanel}>
                Review approvals
              </Button>
            }
          >
            {approvals.tasks.length > 0 && `${approvals.tasks.length} agent action${approvals.tasks.length === 1 ? '' : 's'}`}
            {approvals.tasks.length > 0 && approvals.owner.length > 0 && ' · '}
            {approvals.owner.length > 0 && `${approvals.owner.length} automation request${approvals.owner.length === 1 ? '' : 's'}`}
            . The work stays paused until you approve or deny.
          </Notice>
        </div>
      )}

      {/* KPI row */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        {!d ? (
          Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="rounded-xl border border-border bg-panel px-4 py-3.5">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="mt-3 h-6 w-14" />
              <Skeleton className="mt-3 h-3 w-24" />
            </div>
          ))
        ) : (
          <>
            <Stat
              label="System"
              icon={<IconMonitor />}
              tone={toneFor(vmState ?? 'unknown')}
              value={<span className="text-lg capitalize">{vmState ?? '—'}</span>}
              hint={guest ? `Guest ${guest.status}${guest.mem_available_mb != null ? ` · ${guest.mem_available_mb} MB free` : ''}` : 'Guest status unknown'}
              href={href('/system')}
            />
            <Stat label="Active agents" icon={<IconAgents />} value={`${activeAgents}/${d.agents.length}`} hint={`${res?.active_workers ?? 0} worker(s) · limit ${res?.limits.max_active_effective ?? '—'}`} href={href('/agents')} />
            <Stat label="Running tasks" icon={<IconTasks />} value={d.running_tasks.length} hint={`${res?.queue_length ?? 0} queued for resources`} href={href('/tasks')} />
            <Stat label="Team runs" icon={<IconTeams />} value={d.active_team_runs.length} hint={`${d.workflow_runs_active} workflow run(s) active`} href={href('/teams')} />
            <Stat
              label="Approvals"
              icon={<IconBell />}
              tone={approvals.count ? 'warn' : undefined}
              value={approvals.loaded ? approvals.count : d.approvals_pending}
              hint={approvals.count ? 'Waiting for you' : 'Nothing waiting'}
              onClick={approvals.openPanel}
            />
            <Stat
              label="Mac memory"
              icon={<IconCpu />}
              tone={host?.memory_pressure ? toneFor(host.memory_pressure) : undefined}
              value={memPct != null ? `${Math.round(memPct)}%` : '—'}
              hint={host ? `Pressure ${host.memory_pressure}${host.cpu_percent != null ? ` · CPU ${Math.round(host.cpu_percent)}%` : ''}` : 'First sample pending'}
              href={href('/resources')}
            />
          </>
        )}
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-3">
        {/* ---------------------------------------------------------------- main column */}
        <div className="min-w-0 space-y-5 lg:col-span-2">
          <Card
            title="Running tasks"
            subtitle="Live task cards — the same controls you get in Telegram"
            icon={<IconTasks />}
            actions={
              <>
                {d && d.running_tasks.length > 0 && <Badge tone="accent">{d.running_tasks.length}</Badge>}
                <CardLink to={href('/tasks')}>All tasks</CardLink>
              </>
            }
            padded={false}
          >
            {!d ? (
              <div className="p-5">
                <LoadingRows rows={3} />
              </div>
            ) : d.running_tasks.length === 0 ? (
              <p className="px-5 py-6 text-sm text-muted">No task is queued or running. Send one from an agent’s chat, a team run or a schedule.</p>
            ) : (
              <div className="p-3 sm:p-4">
                <ul className="grid gap-3 md:grid-cols-2" aria-label="Running tasks">
                  {runningCards.map((t) => (
                    <li key={t.id} className="min-w-0">
                      <LiveTaskCard task={t} onChanged={ov.reload} />
                    </li>
                  ))}
                </ul>
                {d.running_tasks.length > runningCards.length && (
                  <p className="mt-3 text-center text-xs text-muted">
                    +{d.running_tasks.length - runningCards.length} more — <TextLink href={href('/tasks')}>see all tasks</TextLink>
                  </p>
                )}
              </div>
            )}
          </Card>

          <div className="grid gap-5 xl:grid-cols-2">
            <Card title="Active team runs" icon={<IconTeams />} actions={<CardLink to={href('/teams')}>Teams</CardLink>} padded={false}>
              {!d ? (
                <div className="p-5">
                  <LoadingRows rows={2} />
                </div>
              ) : d.active_team_runs.length === 0 ? (
                <p className="px-5 py-6 text-sm text-muted">No team is collaborating right now.</p>
              ) : (
                <ul>
                  {d.active_team_runs.map((r) => (
                    <ListRow key={r.id} link={href(`/teams/${r.team_id}/runs/${r.id}`)}>
                      <span className="mt-1.5">
                        <StatusDot tone="info" pulse label="Running" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-text">{r.team_name}</p>
                        <p className="truncate text-sm text-muted">{r.prompt}</p>
                      </div>
                      <span className="shrink-0 text-xs text-subtle">{relativeTime(r.created_at)}</span>
                    </ListRow>
                  ))}
                </ul>
              )}
            </Card>

            <Card title="Recent results" icon={<IconCheckCircle />} padded={false}>
              {!d ? (
                <div className="p-5">
                  <LoadingRows rows={3} />
                </div>
              ) : d.recent_results.length === 0 ? (
                <p className="px-5 py-6 text-sm text-muted">Finished tasks appear here with their summary.</p>
              ) : (
                <ul>
                  {d.recent_results.map((r) => (
                    <ListRow key={r.id} link={href(`/agents/${r.agent_id}/tasks?task=${r.id}`)}>
                      <span className="mt-1.5">
                        <StatusDot tone={r.state === 'COMPLETED' ? 'success' : 'danger'} label={r.state} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
                          <span className="font-medium text-text">{r.agent_name}</span>
                          <span className="text-xs text-subtle">{relativeTime(r.finished_at)}</span>
                        </p>
                        <p className="truncate text-sm text-muted">{r.prompt}</p>
                        {(r.summary || r.failure_reason) && (
                          <p className={`mt-0.5 line-clamp-2 text-xs ${r.state === 'FAILED' ? 'text-danger' : 'text-subtle'}`}>{r.summary || r.failure_reason}</p>
                        )}
                      </div>
                    </ListRow>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          <Card title="Activity" icon={<IconResources />} subtitle="Live from the event stream" padded={false}>
            {!d && feed.length === 0 ? (
              <div className="p-5">
                <LoadingRows rows={4} />
              </div>
            ) : feed.length === 0 ? (
              <p className="px-5 py-6 text-sm text-muted">No events yet.</p>
            ) : (
              <ol aria-label="Recent events" className="max-h-[420px] overflow-y-auto">
                {feed.map((e) => {
                  const v = describeEvent(e, agentName);
                  return (
                    <li key={e.sequence} className="border-b border-border/60 last:border-0">
                      {v.link ? (
                        <a href={v.link} className="flex items-start gap-3 px-4 py-2.5 transition-colors hover:bg-white/[0.02] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-soft sm:px-5">
                          <FeedLine v={v} ts={e.timestamp} />
                        </a>
                      ) : (
                        <div className="flex items-start gap-3 px-4 py-2.5 sm:px-5">
                          <FeedLine v={v} ts={e.timestamp} />
                        </div>
                      )}
                    </li>
                  );
                })}
              </ol>
            )}
          </Card>
        </div>

        {/* ---------------------------------------------------------------- side column */}
        <div className="min-w-0 space-y-5">
          <Card
            title="Resources"
            icon={<IconCpu />}
            actions={
              <>
                {res?.limits.profile && <Badge tone="accent">{res.limits.profile}</Badge>}
                <CardLink to={href('/resources')}>Monitor</CardLink>
              </>
            }
          >
            {!d ? (
              <LoadingRows rows={4} />
            ) : !host ? (
              <p className="text-sm text-muted">The resource manager has not taken its first sample yet (every 20 s).</p>
            ) : (
              <div className="space-y-4">
                <MeterRow label="Mac memory" value={host.memory_used_percent} detail={`${formatBytes(host.memory_total_bytes - host.memory_available_bytes)} of ${formatBytes(host.memory_total_bytes)}`} />
                <MeterRow label="Mac CPU" value={host.cpu_percent} detail={host.cpu_count ? `${host.cpu_count} cores` : undefined} />
                {guest?.mem_total_mb ? (
                  <MeterRow
                    label="VM memory"
                    value={guest.mem_available_mb != null ? 100 - (guest.mem_available_mb / guest.mem_total_mb) * 100 : null}
                    detail={`${guest.mem_available_mb ?? '—'} MB free of ${guest.mem_total_mb} MB`}
                  />
                ) : (
                  <p className="text-xs text-muted">VM: {guest?.status ?? 'unknown'}{guest?.detail ? ` — ${guest.detail}` : ''}</p>
                )}
                <dl className="grid grid-cols-3 gap-2 border-t border-border pt-3 text-center">
                  <MiniStat label="Swap" value={host.swap_used_mb != null ? `${Math.round(host.swap_used_mb)} MB` : '—'} />
                  <MiniStat label="Workers" value={`${res?.active_workers ?? 0}/${res?.limits.max_active_effective ?? '—'}`} />
                  <MiniStat label="Queue" value={String(res?.queue_length ?? 0)} />
                </dl>
                {res && res.limits.constraints.length > 0 && <p className="text-xs text-warn">Limited by: {res.limits.constraints.join('; ')}</p>}
              </div>
            )}
          </Card>

          {(approvals.tasks.length > 0 || approvals.owner.length > 0) && (
            <Card title="Waiting for you" icon={<IconBell />} actions={<Button size="xs" variant="ghost" onClick={approvals.openPanel}>Open all</Button>}>
              <div className="space-y-3">
                {approvals.tasks.slice(0, 2).map((a) => (
                  <ApprovalCard key={a.id} approval={a} agentName={agentName(a.agent_id)} compact onResolved={approvals.reload} />
                ))}
                {approvals.owner.slice(0, 2).map((a) => (
                  <OwnerApprovalCard key={a.id} approval={a} compact onResolved={approvals.reload} />
                ))}
              </div>
            </Card>
          )}

          <Card title="Upcoming schedules" icon={<IconSchedules />} actions={<CardLink to={href('/schedules?view=calendar')}>Calendar</CardLink>} padded={false}>
            {!d ? (
              <div className="p-5">
                <LoadingRows rows={3} />
              </div>
            ) : d.upcoming_schedules.length === 0 ? (
              <div className="px-5 py-5 text-sm text-muted">
                Nothing scheduled. <TextLink href={href('/schedules?new=1')}>Create a schedule</TextLink>
              </div>
            ) : (
              <ul>
                {d.upcoming_schedules.map((s) => (
                  <ListRow key={s.id} link={href(`/schedules/${s.id}`)}>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-text">{s.name}</p>
                      <p className="text-xs text-subtle" title={formatTime(s.next_run_at)}>
                        {relativeTime(s.next_run_at)} · {formatTime(s.next_run_at)}
                      </p>
                    </div>
                    <Badge>{s.target_type}</Badge>
                  </ListRow>
                ))}
              </ul>
            )}
          </Card>

          <AgentsCard data={d} />

          <Card title="AI providers" icon={<IconProviders />} actions={<CardLink to={href('/providers')}>Manage</CardLink>} padded={false}>
            {!d ? (
              <div className="p-5">
                <LoadingRows rows={3} />
              </div>
            ) : (
              <ul>
                {d.providers.map((p) => {
                  const t = toneFor(p.state);
                  return (
                    <li key={p.id} className="flex items-center gap-3 border-b border-border/60 px-4 py-2.5 last:border-0 sm:px-5">
                      <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${TONE_DOT[t]}`} />
                      <span className="min-w-0 flex-1 truncate text-sm text-text">{providerLabel(p)}</span>
                      <span className={`shrink-0 text-xs ${t === 'success' ? 'text-muted' : t === 'neutral' ? 'text-subtle' : t === 'warn' ? 'text-warn' : 'text-danger'}`}>{p.state}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          <Card title="Quick actions" icon={<IconPlus />} padded={false}>
            <div className="grid grid-cols-2 gap-px overflow-hidden rounded-b-xl bg-border">
              <QuickAction to={href('/agents/new')} icon={<IconAgents />} label="Create agent" />
              <QuickAction to={href('/teams?new=1')} icon={<IconTeams />} label="New team" />
              <QuickAction to={href('/schedules?new=1')} icon={<IconSchedules />} label="New schedule" />
              <QuickAction to={href('/workflows')} icon={<IconWorkflows />} label="Workflows" />
              <QuickAction to={href('/memory')} icon={<IconMemory />} label="Memory" />
              <QuickAction to={href('/resources')} icon={<IconResources />} label="Resources" />
            </div>
          </Card>

          <Card title="Access from other devices" actions={<CardLink to={href('/settings')}>LAN settings</CardLink>}>
            {lan.error && !lan.data ? <ErrorBanner error={lan.error} onRetry={lan.reload} /> : lan.data ? <LanAddressLine status={lan.data} /> : <LoadingRows rows={1} />}
            <p className="mt-3 text-xs text-subtle">Telegram bot: {d ? (d.telegram.polling ? 'polling' : 'not polling') : '—'}</p>
          </Card>
        </div>
      </div>
    </>
  );
}

function FeedLine({ v, ts }: { v: ReturnType<typeof describeEvent>; ts: number }) {
  return (
    <>
      <span aria-hidden className={`mt-1.5 size-1.5 shrink-0 rounded-full ${TONE_DOT[v.tone]}`} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] text-text">{v.title}</p>
        {v.detail && <p className="truncate text-xs text-subtle">{v.detail}</p>}
      </div>
      <time className="shrink-0 text-2xs text-subtle tabular-nums" dateTime={new Date(ts * 1000).toISOString()} title={formatTime(ts)}>
        {relativeTime(ts)}
      </time>
    </>
  );
}

function MeterRow({ label, value, detail }: { label: string; value: number | null | undefined; detail?: string }) {
  const v = value ?? null;
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2 text-xs">
        <span className="text-muted">{label}</span>
        <span className="text-text tabular-nums">{v != null ? `${Math.round(v)}%` : '—'}</span>
      </div>
      <Meter value={v ?? 0} label={`${label} used`} tone={usageTone(v)} size="sm" />
      {detail && <p className="mt-1 text-2xs text-subtle">{detail}</p>}
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-2xs text-subtle">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium text-text tabular-nums">{value}</dd>
    </div>
  );
}

function QuickAction({ to, icon, label }: { to: string; icon: ReactNode; label: string }) {
  return (
    <a href={to} className="flex min-h-12 items-center gap-2.5 bg-panel px-4 py-3 text-[13px] font-medium text-muted transition-colors hover:bg-panel-2 hover:text-text focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-soft [&>svg]:size-4">
      {icon}
      {label}
    </a>
  );
}

function AgentsCard({ data }: { data: OverviewData | null }) {
  return (
    <Card title="Agents" icon={<IconAgents />} actions={<CardLink to={href('/agents')}>All agents</CardLink>} padded={false}>
      {!data ? (
        <div className="p-5">
          <LoadingRows rows={3} />
        </div>
      ) : data.agents.length === 0 ? (
        <div className="p-4">
          <EmptyState compact title="No agents yet" action={<ButtonLink size="sm" variant="primary" href={href('/agents/new')}>Create agent</ButtonLink>} />
        </div>
      ) : (
        <ul>
          {data.agents.slice(0, 8).map((a) => (
            <ListRow key={a.id} link={href(`/agents/${a.id}`)}>
              <Avatar name={a.name} id={a.id} size="sm" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-text">{a.name}</p>
                <p className="truncate text-xs text-subtle">{a.model_id ?? 'no model'} · {a.last_active_at ? `active ${relativeTime(a.last_active_at)}` : 'never active'}</p>
              </div>
              <StatusPill state={a.status} pulse={BUSY_STATES.has(a.status)} />
            </ListRow>
          ))}
        </ul>
      )}
    </Card>
  );
}
