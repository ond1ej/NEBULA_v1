// AI Companies list (#/companies).
import { IconCompanies, IconPlus, IconTasks, IconUser } from '../../components/icons';
import { StatusPill } from '../../components/StatusPill';
import { Badge, ButtonLink, EmptyState, ErrorBanner, LoadingCards, PageHeader, StatusDot } from '../../components/ui';
import { useApi } from '../../hooks/useApi';
import { useLiveRefresh } from '../../hooks/useEvents';
import { href } from '../../hooks/useHashRoute';
import { EnvBadge } from '../environment/EnvBadge';
import { companiesApi } from './api';
import type { CompanySummary } from './types';

function CompanyCard({ c }: { c: CompanySummary }) {
  return (
    <article className="relative flex min-w-0 flex-col rounded-xl border border-border bg-panel shadow-card transition-colors hover:border-border-strong">
      <div className="p-4 pb-3 sm:p-5 sm:pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-lg border border-accent/30 bg-accent/10 text-accent-soft">
              <IconCompanies className="size-4" />
            </span>
            <div className="min-w-0">
              <h3 className="truncate text-[15px] font-semibold text-text">
                <a href={href(`/companies/${c.id}`)} className="rounded focus-ring after:absolute after:inset-0 after:rounded-xl">
                  {c.name}
                </a>
              </h3>
              <p className="truncate text-xs text-subtle">{c.industry || 'No industry set'}</p>
            </div>
          </div>
          {c.status !== 'ACTIVE' && <StatusPill state={c.status} />}
        </div>
        <p className="mt-3 line-clamp-2 min-h-[2.5rem] text-[13px] text-muted">{c.objective || c.description || <span className="text-subtle">No objective set</span>}</p>
      </div>
      <div className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border px-4 py-3 text-xs text-muted sm:px-5">
        <span className="relative z-[1]">
          <EnvBadge env={c.default_environment} source="company" />
        </span>
        <span className="flex items-center gap-1.5" title="Employees">
          <IconUser className="size-3.5 text-subtle" />
          {c.member_count} {c.member_count === 1 ? 'employee' : 'employees'}
        </span>
        <span className="flex items-center gap-1.5" title="Projects">
          <IconTasks className="size-3.5 text-subtle" />
          {c.project_count} {c.project_count === 1 ? 'project' : 'projects'}
        </span>
        <span className="ml-auto flex items-center gap-1.5">
          {c.active_runs > 0 ? (
            <>
              <StatusDot tone="accent" pulse label="Runs in progress" />
              <Badge tone="accent">{c.active_runs} active {c.active_runs === 1 ? 'run' : 'runs'}</Badge>
            </>
          ) : (
            <span className="text-subtle">No active runs</span>
          )}
        </span>
      </div>
    </article>
  );
}

export function CompaniesList() {
  const list = useApi((s) => companiesApi.list(s), []);
  useLiveRefresh(list.reload, (ev) => ev.type.startsWith('company.') && ev.type !== 'company.activity' && ev.type !== 'company.item.changed', 600);
  const rows = list.data ?? [];
  return (
    <>
      <PageHeader
        title="AI Companies"
        description="Organisations of your agents: roles and reporting lines, projects with real work items, budgets, approvals and execution environments on the Mac or the Ubuntu VM."
        actions={
          <ButtonLink href={href('/companies/new')} variant="primary" icon={<IconPlus />}>
            New company
          </ButtonLink>
        }
      />
      {list.error ? (
        <div className="mb-4">
          <ErrorBanner error={list.error} onRetry={list.reload} />
        </div>
      ) : null}
      {!list.data && list.loading ? (
        <LoadingCards label="Loading companies…" />
      ) : rows.length === 0 && !list.error ? (
        <EmptyState
          icon={<IconCompanies />}
          title="No companies yet"
          action={
            <ButtonLink href={href('/companies/new')} variant="primary" icon={<IconPlus />}>
              Found your first company
            </ButtonLink>
          }
        >
          A company assigns your agents to roles (CEO, developers, QA…), runs projects as dependent work items and reports results back to you.
        </EmptyState>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {rows.map((c) => (
            <CompanyCard key={c.id} c={c} />
          ))}
        </div>
      )}
    </>
  );
}
