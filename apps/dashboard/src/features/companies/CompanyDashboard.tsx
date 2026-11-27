// Company dashboard (#/companies/<id>/<tab>): header + tabs Overview, Organization, Projects, Employees,
// Activity, Knowledge, Files, Settings.
import { useMemo, useState } from 'react';
import { ApiError } from '../../api';
import {
  IconActivity,
  IconApprovals,
  IconCompanies,
  IconFiles,
  IconGraph,
  IconMemory,
  IconOverview,
  IconPlus,
  IconResources,
  IconSettings,
  IconTasks,
  IconUser,
} from '../../components/icons';
import { BUSY_STATES, StatusPill } from '../../components/StatusPill';
import {
  Badge,
  Button,
  ButtonLink,
  Card,
  EmptyState,
  ErrorBanner,
  Field,
  LoadingRows,
  Meter,
  Notice,
  PageHeader,
  Select,
  Skeleton,
  Stat,
  Tabs,
  TextLink,
  usageTone,
} from '../../components/ui';
import { useApi } from '../../hooks/useApi';
import { useLiveRefresh } from '../../hooks/useEvents';
import { href, navigate } from '../../hooks/useHashRoute';
import { formatTime, relativeTime } from '../../lib/format';
import type { NebulaEvent } from '../../types';
import { EnvBadge } from '../environment/EnvBadge';
import { FileManager } from '../files/FileManager';
import { hostApi } from '../environment/api';
import { ActivityFeed } from './ActivityFeed';
import { ApprovalRow } from './ApprovalRow';
import { companiesApi } from './api';
import { CompanyEmployees } from './CompanyEmployees';
import { CompanyKnowledge } from './CompanyKnowledge';
import { CompanyProjects } from './CompanyProjects';
import { CompanySettings } from './CompanySettings';
import { LIFECYCLE_TONE, pct, RUN_ACTIVE } from './lib';
import { OrgChart, OrgMemberDrawer } from './OrgChart';
import type { CompanyDetail, OrgNode } from './types';

export const COMPANY_TABS = [
  { id: 'overview', label: 'Overview', icon: <IconOverview /> },
  { id: 'org', label: 'Organization', icon: <IconGraph /> },
  { id: 'projects', label: 'Projects', icon: <IconTasks /> },
  { id: 'employees', label: 'Employees', icon: <IconUser /> },
  { id: 'activity', label: 'Activity', icon: <IconActivity /> },
  { id: 'knowledge', label: 'Knowledge', icon: <IconMemory /> },
  { id: 'files', label: 'Files', icon: <IconFiles /> },
  { id: 'settings', label: 'Settings', icon: <IconSettings /> },
] as const;
export type CompanyTab = (typeof COMPANY_TABS)[number]['id'];

/** Events that concern this company (payload.company_id), or one of its employees' environments. */
export function companyEventMatch(companyId: string, memberIds: Set<string>) {
  return (ev: NebulaEvent) => {
    const p = (ev.payload ?? {}) as { company_id?: unknown; ref?: { company_id?: unknown } };
    if (ev.type.startsWith('company.')) return p.company_id === companyId;
    if (ev.type === 'environment.changed') return Boolean(ev.agent_id && memberIds.has(ev.agent_id));
    if (ev.type.startsWith('owner.approval.')) return p.ref?.company_id === companyId;
    if (ev.type === 'agent.state.changed') return Boolean(ev.agent_id && memberIds.has(ev.agent_id));
    return false;
  };
}

function Overview({ co, reload }: { co: CompanyDetail; reload: () => void }) {
  const reports = useApi((s) => companiesApi.knowledge(co.id, { kind: 'report' }, s), [co.id, co.stats.runs_active]);
  const projectName = (id: string) => co.projects.find((p) => p.id === id)?.name ?? 'deleted project';
  const total = co.budget.max_model_calls_total;
  const used = co.stats.model_calls_used;
  const usedPct = pct(used, total);
  const parallelPct = pct(co.stats.running_items, co.resource_policy.max_parallel) ?? 0;
  const onHost = co.members.filter((m) => m.environment_effective?.env === 'host').length;
  const lifecycles = co.members.reduce<Record<string, number>>((acc, m) => ({ ...acc, [m.lifecycle]: (acc[m.lifecycle] ?? 0) + 1 }), {});
  const runs = [...co.recent_runs].sort((a, b) => Number(RUN_ACTIVE.has(b.state)) - Number(RUN_ACTIVE.has(a.state)) || b.created_at - a.created_at);
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Employees" value={co.stats.members} icon={<IconUser />} hint={`${lifecycles.RUNNING ?? 0} working now`} href={href(`/companies/${co.id}/employees`)} />
        <Stat label="Projects" value={co.stats.projects} icon={<IconTasks />} hint={`${co.projects.filter((p) => p.status === 'ACTIVE').length} active`} href={href(`/companies/${co.id}/projects`)} />
        <Stat label="Active runs" value={co.stats.runs_active} icon={<IconActivity />} tone={co.stats.runs_active ? 'accent' : undefined} hint={`${co.stats.open_items} open work items`} />
        <Stat
          label="Pending approvals"
          value={co.pending_approvals.length}
          icon={<IconApprovals />}
          tone={co.pending_approvals.length ? 'warn' : undefined}
          hint={co.pending_approvals.length ? 'CEO plans wait for you' : 'Nothing waiting'}
        />
      </div>

      {co.pending_approvals.length > 0 && (
        <Card title="Waiting for your approval" icon={<IconApprovals />} subtitle="The CEO planned these runs; nothing starts until you decide.">
          <ul className="space-y-3">
            {co.pending_approvals.map((a) => (
              <ApprovalRow key={a.id} a={a} onDone={reload} />
            ))}
          </ul>
        </Card>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="AI budget" icon={<IconResources />} subtitle="AI requests (model calls) used by all company runs.">
          <div className="flex items-end justify-between gap-3">
            <p className="text-2xl font-semibold text-text tabular-nums">
              {used}
              {total ? <span className="text-base font-normal text-muted"> / {total}</span> : null}
            </p>
            <span className="text-xs text-muted">{total ? `${Math.max(0, total - used)} left` : 'no total limit'}</span>
          </div>
          {usedPct !== null && (
            <div className="mt-2">
              <Meter value={usedPct} label="Company AI budget used" tone={usageTone(usedPct)} />
            </div>
          )}
          {usedPct !== null && usedPct >= 100 && <p className="mt-2 text-xs text-danger">Budget exhausted: new runs are refused.</p>}
          <p className="mt-3 text-xs text-muted">Each run may use up to {co.budget.max_model_calls_per_run} AI requests (projects can override).</p>
        </Card>
        <Card title="Resources" icon={<IconResources />} subtitle="Parallel work and where employees run.">
          <div className="mb-1 flex justify-between text-xs">
            <span className="text-muted">Work items running</span>
            <span className="text-text tabular-nums">
              {co.stats.running_items} / {co.resource_policy.max_parallel} allowed in parallel
            </span>
          </div>
          <Meter value={parallelPct} label="Parallel work in use" tone={parallelPct >= 100 ? 'warn' : 'accent'} />
          <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-muted">
            <EnvBadge env="host" />
            <span className="tabular-nums">{onHost}</span>
            <EnvBadge env="vm" />
            <span className="tabular-nums">{co.members.length - onHost}</span>
          </div>
          {co.members.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {Object.entries(lifecycles).map(([l, n]) => (
                <Badge key={l} tone={LIFECYCLE_TONE[l] ?? 'neutral'} dot>
                  {n} {l.toLowerCase()}
                </Badge>
              ))}
            </div>
          )}
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Runs" icon={<IconActivity />} subtitle="Active first, then the most recent." padded={false}>
          {runs.length === 0 ? (
            <div className="p-4 sm:p-5">
              <EmptyState compact title="No runs yet" action={co.projects.length ? <ButtonLink size="sm" href={href(`/companies/${co.id}/projects/${co.projects[0].id}`)}>Open a project</ButtonLink> : undefined}>
                Start a run from a project to turn an objective into work items.
              </EmptyState>
            </div>
          ) : (
            <ul className="divide-y divide-border/70">
              {runs.slice(0, 8).map((r) => (
                <li key={r.id}>
                  <a href={href(`/companies/${co.id}/runs/${r.id}`)} className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-white/[0.02] focus-ring sm:px-5">
                    <StatusPill state={r.state} pulse={BUSY_STATES.has(r.state)} />
                    <span className="min-w-0 flex-1 truncate text-sm text-text">{projectName(r.project_id)}</span>
                    <span className="shrink-0 text-xs text-subtle" title={formatTime(r.created_at)}>
                      {relativeTime(r.created_at)}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card
          title="Results"
          icon={<IconMemory />}
          subtitle="Run reports saved to the company knowledge."
          actions={<TextLink href={href(`/companies/${co.id}/knowledge`)}>All knowledge</TextLink>}
        >
          {reports.error ? (
            <ErrorBanner error={reports.error} onRetry={reports.reload} />
          ) : !reports.data ? (
            <LoadingRows rows={3} />
          ) : reports.data.length === 0 ? (
            <p className="text-sm text-muted">Reports appear here when runs finish.</p>
          ) : (
            <ul className="space-y-3">
              {reports.data.slice(0, 4).map((k) => (
                <li key={k.id} className="min-w-0">
                  <p className="truncate text-sm font-medium text-text">{k.title}</p>
                  <p className="mt-0.5 line-clamp-2 text-xs whitespace-pre-line text-muted">{k.content}</p>
                  <p className="mt-0.5 text-2xs text-subtle">{relativeTime(k.created_at)}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}

function OrgTab({ co, version }: { co: CompanyDetail; version: number }) {
  const org = useApi((s) => companiesApi.org(co.id, s), [co.id, version]);
  const [sel, setSel] = useState<OrgNode | null>(null);
  const nodes = org.data?.nodes ?? [];
  const current = sel ? (nodes.find((n) => n.agent_id === sel.agent_id) ?? sel) : null;
  return (
    <Card
      title="Organization chart"
      icon={<IconGraph />}
      subtitle="Reporting lines with the CEO at the top. Select an employee for details."
      actions={
        <ButtonLink size="sm" href={href(`/companies/${co.id}/employees`)}>
          Edit employees
        </ButtonLink>
      }
    >
      {org.error ? (
        <ErrorBanner error={org.error} onRetry={org.reload} />
      ) : !org.data ? (
        <div className="flex justify-center gap-4 py-6">
          <Skeleton className="h-36 w-60 rounded-xl" />
        </div>
      ) : (
        <OrgChart nodes={nodes} selectedId={current?.agent_id ?? null} onSelect={setSel} />
      )}
      <OrgMemberDrawer node={current} nodes={nodes} onClose={() => setSel(null)} />
    </Card>
  );
}

function ActivityTab({ co, version }: { co: CompanyDetail; version: number }) {
  const [project, setProject] = useState('');
  const [kind, setKind] = useState('');
  const [limit, setLimit] = useState(100);
  const feed = useApi((s) => companiesApi.activity(co.id, { project_id: project || undefined, limit }, s), [co.id, project, limit, version]);
  const names = useMemo(() => new Map(co.members.map((m) => [m.agent_id, m.agent_name])), [co.members]);
  const items = (feed.data ?? []).filter((a) => !kind || a.kind === kind);
  const kinds = [...new Set((feed.data ?? []).map((a) => a.kind))].sort();
  return (
    <Card title="Activity" icon={<IconActivity />} subtitle="Live feed of plans, assignments, hand-overs, transfers, results and failures.">
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:max-w-xl">
        <Field htmlFor="co-act-project" label="Project">
          <Select id="co-act-project" value={project} onChange={(e) => setProject(e.target.value)}>
            <option value="">All projects</option>
            {co.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field htmlFor="co-act-kind" label="Kind">
          <Select id="co-act-kind" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">Everything</option>
            {kinds.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {feed.error ? (
        <ErrorBanner error={feed.error} onRetry={feed.reload} />
      ) : !feed.data ? (
        <LoadingRows label="Loading activity…" />
      ) : (
        <>
          <ActivityFeed
            items={items}
            companyId={co.id}
            agentName={(id) => names.get(id) ?? null}
            projectName={(id) => co.projects.find((p) => p.id === id)?.name ?? null}
            emptyText={project || kind ? 'Nothing matches these filters.' : 'Activity appears as soon as the company works.'}
          />
          {(feed.data?.length ?? 0) >= limit && limit < 500 && (
            <div className="mt-4 flex justify-center">
              <Button size="sm" onClick={() => setLimit((l) => Math.min(500, l + 200))}>
                Show older activity
              </Button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

export function CompanyDashboard({ companyId, tab, query }: { companyId: string; tab: string; query: URLSearchParams }) {
  const company = useApi((s) => companiesApi.get(companyId, s), [companyId]);
  const roots = useApi((s) => hostApi.roots(s), []);
  const [version, setVersion] = useState(0);
  const memberIds = useMemo(() => new Set((company.data?.members ?? []).map((m) => m.agent_id)), [company.data]);
  useLiveRefresh(
    () => {
      company.reload();
      setVersion((v) => v + 1);
    },
    companyEventMatch(companyId, memberIds),
    800,
  );
  const active: CompanyTab = (COMPANY_TABS.find((t) => t.id === tab)?.id ?? 'overview') as CompanyTab;
  const co = company.data;

  if (!co) {
    if (company.error instanceof ApiError && company.error.status === 404)
      return (
        <EmptyState icon={<IconCompanies />} title="Company not found" action={<ButtonLink href={href('/companies')}>Back to companies</ButtonLink>}>
          It may have been deleted.
        </EmptyState>
      );
    return company.error ? (
      <ErrorBanner error={company.error} onRetry={company.reload} />
    ) : (
      <div className="space-y-4" role="status" aria-label="Loading company…">
        <Skeleton className="h-3 w-40" />
        <Skeleton className="h-7 w-72" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-72 w-full rounded-xl" />
      </div>
    );
  }

  const root = roots.data?.find((r) => r.id === co.default_root_id);
  const tabs = COMPANY_TABS.map((t) => ({
    ...t,
    badge:
      t.id === 'overview' && co.pending_approvals.length ? (
        <Badge tone="warn">{co.pending_approvals.length}</Badge>
      ) : t.id === 'projects' ? (
        <span className="text-xs text-subtle tabular-nums">{co.projects.length}</span>
      ) : t.id === 'employees' ? (
        <span className="text-xs text-subtle tabular-nums">{co.members.length}</span>
      ) : undefined,
  }));

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'AI Companies', href: href('/companies') }, { label: co.name }]}
        icon={
          <span aria-hidden className="grid size-11 shrink-0 place-items-center rounded-xl border border-accent/35 bg-accent/15 text-accent-soft">
            <IconCompanies className="size-5" />
          </span>
        }
        title={co.name}
        meta={
          <>
            <StatusPill state={co.status} />
            <EnvBadge env={co.default_environment} source="company" rootLabel={root ? `${root.name} (${root.path})` : null} showSource />
            {co.industry && <Badge>{co.industry}</Badge>}
            {co.stats.runs_active > 0 && (
              <Badge tone="accent" dot>
                {co.stats.runs_active} active {co.stats.runs_active === 1 ? 'run' : 'runs'}
              </Badge>
            )}
          </>
        }
        description={co.objective || co.description || undefined}
        actions={
          <Button variant="primary" icon={<IconPlus />} onClick={() => navigate(`/companies/${co.id}/projects?new=1`)}>
            New project
          </Button>
        }
      />
      {company.error ? (
        <div className="mb-4">
          <ErrorBanner error={company.error} onRetry={company.reload} title="Refresh failed" />
        </div>
      ) : null}
      {co.status !== 'ACTIVE' && (
        <div className="mb-4">
          <Notice tone="warn" title={`The company is ${String(co.status).toLowerCase()}`}>
            New runs are refused until it is active again. Change the status in <TextLink href={href(`/companies/${co.id}/settings`)}>Settings</TextLink>.
          </Notice>
        </div>
      )}
      <Tabs label="Company sections" tabs={tabs} active={active} hrefFor={(id) => href(`/companies/${co.id}/${id}`)} />
      {active === 'overview' && <Overview co={co} reload={company.reload} />}
      {active === 'org' && <OrgTab co={co} version={version} />}
      {active === 'projects' && <CompanyProjects co={co} roots={roots.data} onRootAdded={() => roots.reload()} openNew={query.get('new') === '1'} />}
      {active === 'employees' && <CompanyEmployees key={co.updated_at} co={co} onSaved={(c) => company.setData(() => c)} />}
      {active === 'activity' && <ActivityTab co={co} version={version} />}
      {active === 'knowledge' && <CompanyKnowledge co={co} version={version} />}
      {active === 'files' && (
        <div className="space-y-3">
          <p className="text-sm text-muted">
            The shared company folder in the Ubuntu VM. VM employees of {co.name} read and write it; host projects keep their files in the authorised Mac folder (see each project’s Files).
          </p>
          <FileManager root={`company:${co.id}`} />
        </div>
      )}
      {active === 'settings' && <CompanySettings key={co.updated_at} co={co} roots={roots.data} onRootAdded={() => roots.reload()} onSaved={(c) => company.setData(() => c)} />}
    </>
  );
}
