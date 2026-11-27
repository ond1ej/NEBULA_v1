// Projects tab: project cards + create dialog.
import { useEffect, useState } from 'react';
import { IconFiles, IconPlus, IconTasks, IconUser } from '../../components/icons';
import { BUSY_STATES, StatusPill } from '../../components/StatusPill';
import { Button, EmptyState, Meter } from '../../components/ui';
import { href, navigate } from '../../hooks/useHashRoute';
import { relativeTime } from '../../lib/format';
import { EnvBadge } from '../environment/EnvBadge';
import type { HostRoot } from '../environment/types';
import { ProjectForm } from './ProjectForm';
import type { CompanyDetail, Project } from './types';

function ProjectCard({ co, p, roots }: { co: CompanyDetail; p: Project; roots: HostRoot[] | null }) {
  const lastRun = co.recent_runs.filter((r) => r.project_id === p.id).sort((a, b) => b.created_at - a.created_at)[0];
  const done = p.milestones.filter((m) => m.done).length;
  const root = roots?.find((r) => r.id === (p.host_root_id ?? ''));
  const env = p.environment ?? co.default_environment;
  return (
    <article className="relative flex min-w-0 flex-col rounded-xl border border-border bg-panel shadow-card transition-colors hover:border-border-strong">
      <div className="p-4 pb-3 sm:p-5 sm:pb-3">
        <div className="flex items-start justify-between gap-3">
          <h3 className="min-w-0 truncate text-[15px] font-semibold text-text">
            <a href={href(`/companies/${co.id}/projects/${p.id}`)} className="rounded focus-ring after:absolute after:inset-0 after:rounded-xl">
              {p.name}
            </a>
          </h3>
          <StatusPill state={p.status} />
        </div>
        <p className="mt-1 line-clamp-2 min-h-[2.5rem] text-[13px] text-muted">{p.objective || p.description || <span className="text-subtle">No objective</span>}</p>
        <div className="relative z-[1] mt-3 flex flex-wrap items-center gap-2">
          <EnvBadge
            env={env}
            source={p.environment ? 'project' : 'company'}
            chain={[{ level: 'company', env: co.default_environment }, ...(p.environment ? [{ level: 'project', env: p.environment }] : [])]}
            showSource
          />
          {root && (
            <span className="inline-flex min-w-0 items-center gap-1 text-xs text-muted" title={root.path}>
              <IconFiles className="size-3.5 shrink-0 text-subtle" />
              <span className="truncate">{root.name}</span>
            </span>
          )}
        </div>
        {p.milestones.length > 0 && (
          <div className="mt-3">
            <div className="mb-1 flex justify-between text-xs text-muted">
              <span>Milestones</span>
              <span className="tabular-nums">
                {done} / {p.milestones.length}
              </span>
            </div>
            <Meter value={(done / p.milestones.length) * 100} label={`${p.name} milestones done`} tone="success" size="sm" />
          </div>
        )}
      </div>
      <div className="mt-auto flex items-center gap-3 border-t border-border px-4 py-2.5 text-xs text-muted sm:px-5">
        {lastRun ? (
          <span className="flex min-w-0 items-center gap-2">
            <StatusPill state={lastRun.state} pulse={BUSY_STATES.has(lastRun.state)} />
            <span className="truncate">last run {relativeTime(lastRun.created_at)}</span>
          </span>
        ) : (
          <span className="text-subtle">Never run</span>
        )}
      </div>
    </article>
  );
}

export function CompanyProjects({ co, roots, onRootAdded, openNew }: { co: CompanyDetail; roots: HostRoot[] | null; onRootAdded: () => void; openNew: boolean }) {
  const [creating, setCreating] = useState(openNew);
  useEffect(() => {
    if (openNew) navigate(`/companies/${co.id}/projects`, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">Each project has its own objective, environment, repository, milestones and assigned employees.</p>
        <Button variant="primary" icon={<IconPlus />} onClick={() => setCreating(true)}>
          New project
        </Button>
      </div>
      {co.projects.length === 0 ? (
        <EmptyState
          icon={<IconTasks />}
          title="No projects yet"
          action={
            <Button variant="primary" icon={<IconPlus />} onClick={() => setCreating(true)}>
              Create a project
            </Button>
          }
        >
          {co.members.length === 0 ? (
            <span className="inline-flex items-center gap-1.5">
              <IconUser className="size-4" /> Add employees first, then create a project and start a run.
            </span>
          ) : (
            'A project turns objectives into runs: work items for your employees with dependencies, hand-overs and a final report.'
          )}
        </EmptyState>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {co.projects.map((p) => (
            <ProjectCard key={p.id} co={co} p={p} roots={roots} />
          ))}
        </div>
      )}
      {creating && (
        <ProjectForm
          co={co}
          roots={roots}
          onRootAdded={onRootAdded}
          onClose={() => setCreating(false)}
          onSaved={(p) => {
            setCreating(false);
            navigate(`/companies/${co.id}/projects/${p.id}`);
          }}
        />
      )}
    </div>
  );
}
