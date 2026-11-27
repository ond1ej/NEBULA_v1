import { useState } from 'react';
import { ConfirmDialog, Modal } from '../../components/Modal';
import { IconCheck, IconPause, IconPlay, IconRefresh, IconStop, IconX } from '../../components/icons';
import { BUSY_STATES, StatusPill } from '../../components/StatusPill';
import { Avatar, Badge, Field, KeyValue, Meter, Select, Textarea, usageTone } from '../../components/ui';
import { formatTime, relativeTime, shortId } from '../../lib/format';
import { canDecide, hasPermission, useMini } from '../context';
import { useActions, useQuery } from '../hooks';
import { mhref, navigate } from '../router';
import type { CompanyActivity, CompanyDetail, CompanyOrg, CompanyProject, CompanyRun, OrgNode } from '../types';
import { Card, Clamp, Empty, List, QueryView, Row, Screen, Section, TapButton } from '../uiKit';
import { EnvBadge, envLabel, ScreenTabs, Tile } from '../uiExtra';

type CoTab = 'overview' | 'org' | 'projects' | 'runs' | 'activity';
const TABS: { id: CoTab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'org', label: 'Org chart' },
  { id: 'projects', label: 'Projects' },
  { id: 'runs', label: 'Runs' },
  { id: 'activity', label: 'Activity' },
];
const ACTIVE_RUN = new Set(['PLANNING', 'RUNNING', 'AWAITING_APPROVAL', 'PAUSED']);
const companyEvent = (id: string) => (ev: { type: string; payload: Record<string, unknown> }) =>
  ev.type.startsWith('company.') && (!ev.payload.company_id || ev.payload.company_id === id);

export function CompanyDetailScreen({ companyId, tab }: { companyId: string; tab: string }) {
  const { api } = useMini();
  const q = useQuery<CompanyDetail>(`company:${companyId}`, (s) => api.companies.get(companyId, s), {
    refreshOn: (ev) => companyEvent(companyId)(ev) || ev.type.includes('approval'),
  });
  const active: CoTab = (TABS.some((t) => t.id === tab) ? tab : 'overview') as CoTab;
  const c = q.data;
  return (
    <Screen title={c?.name ?? 'Company'} subtitle={c ? `${c.industry || 'AI company'} · ${c.status.toLowerCase()}` : undefined}>
      <ScreenTabs
        label="Company sections"
        tabs={TABS.map((t) => (t.id === 'overview' && c && c.pending_approvals.length ? { ...t, badge: <Badge tone="warn">{c.pending_approvals.length}</Badge> } : t))}
        active={active}
        hrefFor={(id) => mhref(`/companies/${companyId}/${id}`)}
      />
      <QueryView q={q}>
        {(co) => (
          <>
            {active === 'overview' && <Overview co={co} onChanged={q.reload} />}
            {active === 'org' && <OrgTab companyId={companyId} />}
            {active === 'projects' && <ProjectsTab co={co} onChanged={q.reload} />}
            {active === 'runs' && <RunsTab co={co} />}
            {active === 'activity' && <ActivityTab companyId={companyId} />}
          </>
        )}
      </QueryView>
    </Screen>
  );
}

function Overview({ co, onChanged }: { co: CompanyDetail; onChanged: () => void }) {
  const ctx = useMini();
  const { run, isPending } = useActions();
  const total = co.budget.max_model_calls_total ?? null;
  const used = co.stats.model_calls_used;
  const pct = total ? (used / total) * 100 : null;
  const envs = co.members.reduce<Record<string, number>>((acc, m) => {
    const e = m.environment_effective?.env ?? 'vm';
    acc[e] = (acc[e] ?? 0) + 1;
    return acc;
  }, {});
  return (
    <>
      {co.objective && (
        <Card className="mb-4">
          <p className="text-xs font-semibold text-muted">Objective</p>
          <p className="mt-1 text-[14px] whitespace-pre-wrap text-text [overflow-wrap:anywhere]">{co.objective}</p>
        </Card>
      )}
      <div className="mb-4 grid grid-cols-2 gap-2">
        <Tile label="Employees" value={co.stats.members} hint={`${co.members.filter((m) => m.lifecycle === 'RUNNING').length} working now`} />
        <Tile label="Projects" value={co.stats.projects} hint={`${co.stats.runs_active} active run${co.stats.runs_active === 1 ? '' : 's'}`} />
        <Tile label="Work items" value={`${co.stats.running_items} running`} hint={`${co.stats.open_items} open`} />
        <Tile label="AI requests used" value={used} hint={total ? `of ${total} total budget` : `${co.budget.max_model_calls_per_run ?? 30} per run, no total cap`} tone={pct !== null && pct >= 90 ? 'danger' : pct !== null && pct >= 75 ? 'warn' : undefined} />
      </div>
      {pct !== null && (
        <div className="mb-4 px-1">
          <Meter value={pct} label="Company AI budget used" tone={usageTone(pct)} size="sm" />
        </div>
      )}
      {co.pending_approvals.length > 0 && (
        <Section title="Pending approvals">
          <div className="space-y-2">
            {co.pending_approvals.map((a) => (
              <Card key={a.id} className="border-warn/40">
                <Badge tone="warn">{a.kind.replace(/_/g, ' ')}</Badge>
                <p className="mt-1.5 text-[14px] whitespace-pre-wrap text-text [overflow-wrap:anywhere]">{a.summary}</p>
                <p className="mt-1 text-[11px] text-subtle">expires {relativeTime(a.expires_at)}</p>
                {canDecide(ctx) && (
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <TapButton
                      variant="danger"
                      icon={<IconX />}
                      loading={isPending(`no:${a.id}`)}
                      onClick={async () => {
                        if ((await run(`no:${a.id}`, () => ctx.api.approvals.resolveOwner(a.id, 'denied'), { success: 'Plan rejected' })) !== undefined) onChanged();
                      }}
                    >
                      Reject
                    </TapButton>
                    <TapButton
                      variant="primary"
                      icon={<IconCheck />}
                      loading={isPending(`ok:${a.id}`)}
                      onClick={async () => {
                        if ((await run(`ok:${a.id}`, () => ctx.api.approvals.resolveOwner(a.id, 'approved'), { success: 'Plan approved' })) !== undefined) onChanged();
                      }}
                    >
                      Approve
                    </TapButton>
                  </div>
                )}
              </Card>
            ))}
          </div>
        </Section>
      )}
      <Section title="Environments">
        <Card>
          <KeyValue
            items={[
              ['Default', <EnvBadge key="d" env={co.default_environment} />],
              ['Employees', Object.entries(envs).map(([e, n]) => `${n} on ${envLabel(e)}`).join(' · ') || '—'],
              ['Parallel work', `up to ${co.resource_policy?.max_parallel ?? 2} items`],
              ['Plan approval', co.approval_policy?.plan_approval ? 'required' : 'not required'],
              ['CEO review', co.approval_policy?.ceo_review ? 'on' : 'off'],
            ]}
          />
        </Card>
      </Section>
      {co.recent_runs.length > 0 && (
        <Section title="Latest runs">
          <RunList runs={co.recent_runs.slice(0, 3)} projects={co.projects} />
        </Section>
      )}
    </>
  );
}

function RunList({ runs, projects }: { runs: CompanyDetail['recent_runs']; projects: CompanyProject[] }) {
  const names = new Map(projects.map((p) => [p.id, p.name]));
  return (
    <List>
      {runs.map((r) => (
        <Row
          key={r.id}
          href={mhref(`/company-runs/${r.id}`)}
          title={names.get(r.project_id) ?? `Project ${shortId(r.project_id)}`}
          subtitle={`Run ${shortId(r.id)} · ${relativeTime(r.created_at)}`}
          trailing={<StatusPill state={r.state} pulse={BUSY_STATES.has(r.state)} />}
        />
      ))}
    </List>
  );
}

// ---------------------------------------------------------------- org chart
function OrgTab({ companyId }: { companyId: string }) {
  const { api } = useMini();
  const q = useQuery<CompanyOrg>(`company-org:${companyId}`, (s) => api.companies.org(companyId, s), {
    refreshOn: (ev) => companyEvent(companyId)(ev) || ev.type.startsWith('agent.'),
  });
  return (
    <QueryView q={q} isEmpty={(d) => d.nodes.length === 0} empty={<Empty title="No employees yet">Add agents with roles in the Dashboard.</Empty>}>
      {(org) => {
        const ids = new Set(org.nodes.map((n) => n.agent_id));
        const children = new Map<string | null, OrgNode[]>();
        for (const n of org.nodes) {
          const parent = n.reports_to && ids.has(n.reports_to) && n.reports_to !== n.agent_id ? n.reports_to : null;
          children.set(parent, [...(children.get(parent) ?? []), n]);
        }
        const out: { node: OrgNode; depth: number }[] = [];
        const seen = new Set<string>();
        const walk = (parent: string | null, depth: number) => {
          for (const n of children.get(parent) ?? []) {
            if (seen.has(n.agent_id)) continue;
            seen.add(n.agent_id);
            out.push({ node: n, depth });
            walk(n.agent_id, depth + 1);
          }
        };
        walk(null, 0);
        for (const n of org.nodes) if (!seen.has(n.agent_id)) out.push({ node: n, depth: 0 });
        return (
          <ol className="space-y-2" aria-label="Organisation chart">
            {out.map(({ node: n, depth }) => (
              <li key={n.agent_id} style={{ marginLeft: `${Math.min(depth, 4) * 14}px` }} className={depth ? 'border-l border-border pl-2.5' : ''}>
                <a href={mhref(`/agents/${n.agent_id}`)} className="flex min-h-14 items-start gap-3 rounded-card bg-panel p-3 active:bg-panel-3 focus-ring">
                  <Avatar name={n.name} id={n.agent_id} />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="truncate text-[14px] font-semibold text-text">{n.name}</span>
                      <Badge tone={n.role_key === 'ceo' ? 'accent' : 'neutral'}>{n.title || n.role}</Badge>
                    </span>
                    <span className="mt-1 flex flex-wrap items-center gap-1.5">
                      <StatusPill state={n.lifecycle} pulse={n.lifecycle === 'RUNNING'} />
                      <EnvBadge env={n.environment?.env} />
                      {n.model && <span className="truncate text-[11px] text-subtle">{n.model}</span>}
                    </span>
                    {n.current_item && (
                      <span className="mt-1 block text-[12px] text-muted">
                        Working on: <Clamp lines={1}>{n.current_item.title}</Clamp>
                      </span>
                    )}
                  </span>
                </a>
              </li>
            ))}
          </ol>
        );
      }}
    </QueryView>
  );
}

// ---------------------------------------------------------------- projects
function ProjectsTab({ co, onChanged }: { co: CompanyDetail; onChanged: () => void }) {
  const ctx = useMini();
  const [start, setStart] = useState<CompanyProject | null>(null);
  const activeRun = (p: CompanyProject) => co.recent_runs.find((r) => r.project_id === p.id && ACTIVE_RUN.has(r.state));
  if (co.projects.length === 0) return <Empty title="No projects yet">Create projects (with their folder and team) in the Dashboard.</Empty>;
  return (
    <>
      <ul className="space-y-2.5">
        {co.projects.map((p) => {
          const r = activeRun(p);
          return (
            <li key={p.id}>
              <Card>
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[15px] font-semibold text-text">{p.name}</p>
                    <Clamp lines={2} className="mt-0.5 text-[12.5px] text-muted">
                      {p.objective || p.description || 'No objective'}
                    </Clamp>
                  </div>
                  <StatusPill state={p.status} />
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <EnvBadge env={p.environment ?? co.default_environment} />
                  {r && (
                    <a href={mhref(`/company-runs/${r.id}`)} className="inline-flex min-h-11 items-center gap-1 text-[12px] text-accent-soft underline-offset-2 focus-ring">
                      run {shortId(r.id)} <StatusPill state={r.state} pulse={BUSY_STATES.has(r.state)} />
                    </a>
                  )}
                </div>
                {hasPermission(ctx, 'companies') && (
                  <TapButton
                    variant={r ? 'secondary' : 'primary'}
                    icon={<IconPlay />}
                    className="mt-3 w-full"
                    disabledReason={r ? 'This project already has an active run' : ['ARCHIVED', 'COMPLETED', 'PAUSED'].includes(p.status) ? `Project is ${p.status.toLowerCase()}` : co.status !== 'ACTIVE' ? `Company is ${co.status.toLowerCase()}` : null}
                    onClick={() => setStart(p)}
                  >
                    Start a run
                  </TapButton>
                )}
              </Card>
            </li>
          );
        })}
      </ul>
      {start && (
        <StartRunSheet
          project={start}
          onClose={() => setStart(null)}
          onStarted={(run) => {
            setStart(null);
            onChanged();
            navigate(`/company-runs/${run.id}`);
          }}
        />
      )}
    </>
  );
}

function StartRunSheet({ project, onClose, onStarted }: { project: CompanyProject; onClose: () => void; onStarted: (r: CompanyRun) => void }) {
  const { api } = useMini();
  const { run, isPending } = useActions();
  const [objective, setObjective] = useState(project.objective ?? '');
  const [planner, setPlanner] = useState<'template' | 'ceo'>('template');
  const submit = async () => {
    const r = await run('start', () => api.companies.startRun(project.id, objective.trim(), planner), { success: 'Run started', errorTitle: 'Could not start the run' });
    if (r) onStarted(r);
  };
  return (
    <Modal
      open
      title={`Start a run · ${project.name}`}
      onClose={onClose}
      dismissible={!isPending('start')}
      footer={
        <>
          <TapButton onClick={onClose}>Cancel</TapButton>
          <TapButton variant="primary" icon={<IconPlay />} loading={isPending('start')} disabledReason={objective.trim() ? null : 'Describe the objective'} onClick={submit}>
            Start run
          </TapButton>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Objective" htmlFor="run-objective" hint="What should the company deliver in this run?">
          <Textarea id="run-objective" rows={4} value={objective} onChange={(e) => setObjective(e.target.value)} maxLength={8000} />
        </Field>
        <Field label="Planning" htmlFor="run-planner" hint={planner === 'ceo' ? 'The CEO agent plans the work items (uses AI requests).' : 'One work item per assigned employee, ordered by role. No AI planning cost.'}>
          <Select id="run-planner" value={planner} onChange={(e) => setPlanner(e.target.value as 'template' | 'ceo')} className="min-h-11">
            <option value="template">Template plan</option>
            <option value="ceo">CEO plans the work</option>
          </Select>
        </Field>
      </div>
    </Modal>
  );
}

function RunsTab({ co }: { co: CompanyDetail }) {
  if (co.recent_runs.length === 0) return <Empty title="No runs yet">Start a run from a project.</Empty>;
  return <RunList runs={co.recent_runs} projects={co.projects} />;
}

function ActivityTab({ companyId }: { companyId: string }) {
  const { api } = useMini();
  const q = useQuery<CompanyActivity[]>(`company-activity:${companyId}`, (s) => api.companies.activity(companyId, s), {
    refreshOn: companyEvent(companyId),
  });
  return (
    <QueryView q={q} isEmpty={(d) => d.length === 0} empty={<Empty title="No activity yet" />}>
      {(items) => <ActivityList items={items} />}
    </QueryView>
  );
}

function ActivityList({ items }: { items: CompanyActivity[] }) {
  return (
    <ol className="space-y-2">
      {items.map((a) => (
        <li key={a.id} className="rounded-card bg-panel px-3 py-2.5">
          <div className="flex items-center gap-1.5">
            <Badge tone={a.kind === 'error' || a.kind === 'failed' ? 'danger' : a.kind === 'run' ? 'accent' : 'neutral'}>{a.kind}</Badge>
            <span className="ml-auto text-[11px] text-subtle" title={formatTime(a.ts)}>
              {relativeTime(a.ts)}
            </span>
          </div>
          <p className="mt-1 text-[13px] whitespace-pre-wrap text-text [overflow-wrap:anywhere]">
            <Clamp lines={4}>{a.content}</Clamp>
          </p>
        </li>
      ))}
    </ol>
  );
}

// ---------------------------------------------------------------- run detail
export function CompanyRunScreen({ runId }: { runId: string }) {
  const ctx = useMini();
  const { api } = ctx;
  const { run, isPending } = useActions();
  const q = useQuery<CompanyRun>(`company-run:${runId}`, (s) => api.companies.run(runId, s), {
    refreshOn: (ev) => ev.type.startsWith('company.') && (!ev.payload.run_id || ev.payload.run_id === runId),
    pollMs: 10_000,
  });
  const [cancel, setCancel] = useState(false);
  const r = q.data;
  const canAct = hasPermission(ctx, 'companies');
  const act = async (action: 'pause' | 'resume' | 'cancel') => {
    const res = await run(action, () => api.companies.runAction(runId, action), { success: action === 'pause' ? 'Run paused' : action === 'resume' ? 'Run resumed' : 'Run cancelled' });
    if (res !== undefined) q.reload();
    return res;
  };
  return (
    <Screen title={r ? `Run ${shortId(r.id)}` : 'Company run'} subtitle={r ? `${r.planner} plan · ${r.source}` : undefined}>
      <QueryView q={q}>
        {(run_) => {
          const done = run_.items.filter((i) => i.state === 'COMPLETED' || i.state === 'SKIPPED').length;
          const pct = run_.items.length ? (done / run_.items.length) * 100 : 0;
          const budgetPct = run_.max_model_calls ? (run_.model_calls_used / run_.max_model_calls) * 100 : 0;
          const activeRun = ACTIVE_RUN.has(run_.state);
          return (
            <>
              <Card className="mb-4">
                <div className="mb-2 flex items-center gap-2">
                  <StatusPill state={run_.state} pulse={BUSY_STATES.has(run_.state)} />
                  <a className="ml-auto inline-flex min-h-11 items-center text-[12.5px] text-accent-soft focus-ring" href={mhref(`/companies/${run_.company_id}`)}>
                    Company
                  </a>
                </div>
                <p className="text-[14px] whitespace-pre-wrap text-text [overflow-wrap:anywhere]">{run_.objective}</p>
                {run_.error && <p className="mt-2 text-[13px] text-danger">{run_.error}</p>}
                <div className="mt-3 space-y-2.5">
                  <div>
                    <div className="mb-1 flex justify-between text-xs text-muted">
                      <span>Progress</span>
                      <span className="tabular-nums">
                        {done}/{run_.items.length} items
                      </span>
                    </div>
                    <Meter value={pct} label="Run progress" tone="success" size="sm" />
                  </div>
                  <div>
                    <div className="mb-1 flex justify-between text-xs text-muted">
                      <span>AI budget</span>
                      <span className="tabular-nums">
                        {run_.model_calls_used}/{run_.max_model_calls} requests
                      </span>
                    </div>
                    <Meter value={budgetPct} label="Run AI budget used" tone={usageTone(budgetPct)} size="sm" />
                  </div>
                </div>
              </Card>
              {canAct && activeRun && (
                <div className="mb-4 grid grid-cols-2 gap-2">
                  {run_.state === 'PAUSED' ? (
                    <TapButton icon={<IconPlay />} loading={isPending('resume')} onClick={() => act('resume')}>
                      Resume run
                    </TapButton>
                  ) : (
                    <TapButton icon={<IconPause />} loading={isPending('pause')} onClick={() => act('pause')}>
                      Pause run
                    </TapButton>
                  )}
                  <TapButton variant="danger" icon={<IconStop />} onClick={() => setCancel(true)}>
                    Cancel run
                  </TapButton>
                </div>
              )}
              <Section title="Work items">
                {run_.items.length === 0 ? (
                  <p className="px-1 text-sm text-muted">{run_.state === 'PLANNING' ? 'The CEO is planning the work…' : 'No work items.'}</p>
                ) : (
                  <ol className="space-y-2">
                    {run_.items.map((it) => (
                      <li key={it.id} className="rounded-card bg-panel p-3">
                        <div className="flex items-start gap-2">
                          <div className="min-w-0 flex-1">
                            <p className="text-[14px] font-medium text-text [overflow-wrap:anywhere]">{it.title}</p>
                            <p className="mt-0.5 text-[12px] text-muted">
                              {it.agent_name ?? 'unassigned'}
                              {it.role_key ? ` · ${it.role_key.replace(/_/g, ' ')}` : ''} · {envLabel(it.environment)}
                              {it.attempts > 1 ? ` · attempt ${it.attempts}/${it.max_attempts}` : ''}
                            </p>
                          </div>
                          <StatusPill state={it.state} pulse={BUSY_STATES.has(it.state)} />
                        </div>
                        {it.result_summary && <Clamp lines={3} className="mt-1.5 text-[12.5px] text-muted">{it.result_summary}</Clamp>}
                        <div className="mt-2 flex flex-wrap gap-2">
                          {it.task_id && (
                            <a href={mhref(`/tasks/${it.task_id}`)} className="inline-flex min-h-11 items-center rounded-lg px-1 text-[12.5px] text-accent-soft focus-ring">
                              Open task {shortId(it.task_id)}
                            </a>
                          )}
                          {canAct && (it.state === 'FAILED' || it.state === 'CANCELLED') && (
                            <TapButton
                              size="sm"
                              icon={<IconRefresh />}
                              loading={isPending(`retry:${it.id}`)}
                              onClick={async () => {
                                if ((await run(`retry:${it.id}`, () => api.companies.retryItem(it.id), { success: 'Item queued again' })) !== undefined) q.reload();
                              }}
                            >
                              Retry item
                            </TapButton>
                          )}
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
              </Section>
              {run_.result && Object.keys(run_.result).length > 0 && (
                <Section title="Result">
                  <Card>
                    <p className="text-[13.5px] whitespace-pre-wrap text-text [overflow-wrap:anywhere]">
                      {typeof run_.result.summary === 'string' ? run_.result.summary : JSON.stringify(run_.result, null, 2)}
                    </p>
                  </Card>
                </Section>
              )}
              {run_.activity.length > 0 && (
                <Section title="Activity">
                  <ActivityList items={[...run_.activity].reverse().slice(0, 30)} />
                </Section>
              )}
            </>
          );
        }}
      </QueryView>
      <ConfirmDialog
        open={cancel}
        title="Cancel this run?"
        confirmLabel="Cancel run"
        busyText="Cancelling…"
        onCancel={() => setCancel(false)}
        onConfirm={async () => {
          if ((await act('cancel')) !== undefined) setCancel(false);
        }}
      >
        <p>Running work items are stopped. Finished results and files are kept.</p>
      </ConfirmDialog>
    </Screen>
  );
}
