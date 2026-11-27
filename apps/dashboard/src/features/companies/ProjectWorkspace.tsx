// Project workspace (#/companies/<id>/projects/<pid>/<tab>, run view #/companies/<id>/runs/<rid>):
// overview + milestones, run controls + task board, activity timeline, files, git status, execution environment
// per employee (inheritance chain), resource/budget usage and results.
import { useMemo, useState, type ReactNode } from 'react';
import { ApiError } from '../../api';
import {
  IconActivity,
  IconCheckCircle,
  IconEdit,
  IconEnvironment,
  IconFiles,
  IconGitHub,
  IconGrid,
  IconOverview,
  IconPause,
  IconPlay,
  IconRefresh,
  IconStop,
  IconTasks,
  IconTrash,
} from '../../components/icons';
import { DropdownMenu } from '../../components/Menu';
import { ConfirmDialog } from '../../components/Modal';
import { BUSY_STATES, StatusPill } from '../../components/StatusPill';
import {
  Avatar,
  Badge,
  Button,
  ButtonLink,
  Card,
  Checkbox,
  EmptyState,
  ErrorBanner,
  IconButton,
  KeyValue,
  LoadingRows,
  Meter,
  Mono,
  Notice,
  PageHeader,
  SegmentedControl,
  Select,
  Skeleton,
  Switch,
  Tabs,
  TextLink,
  usageTone,
} from '../../components/ui';
import { useAction, useApi } from '../../hooks/useApi';
import { useLiveRefresh } from '../../hooks/useEvents';
import { href, navigate } from '../../hooks/useHashRoute';
import { formatTime, relativeTime } from '../../lib/format';
import type { NebulaEvent } from '../../types';
import { hostApi } from '../environment/api';
import { COMPANY_LEVELS, EnvBadge, EnvChain, ENV_LONG } from '../environment/EnvBadge';
import type { HostRoot } from '../environment/types';
import { FileManager } from '../files/FileManager';
import { ActivityFeed } from './ActivityFeed';
import { companiesApi, projectsApi, runsApi } from './api';
import { ApprovalRow } from './ApprovalRow';
import { groupWorkItems, parseGitChange, pct, RUN_ACTIVE } from './lib';
import { ProjectForm } from './ProjectForm';
import { runBlocker, StartRunDialog } from './StartRunDialog';
import { ArtifactList, TaskBoard } from './TaskBoard';
import type { CompanyDetail, ProjectDetail, RunDetail } from './types';

export const PROJECT_TABS = [
  { id: 'overview', label: 'Overview', icon: <IconOverview /> },
  { id: 'board', label: 'Task board', icon: <IconGrid /> },
  { id: 'activity', label: 'Activity', icon: <IconActivity /> },
  { id: 'files', label: 'Files', icon: <IconFiles /> },
  { id: 'git', label: 'Git', icon: <IconGitHub /> },
  { id: 'environment', label: 'Environment', icon: <IconEnvironment /> },
  { id: 'results', label: 'Results', icon: <IconCheckCircle /> },
] as const;
export type ProjectTab = (typeof PROJECT_TABS)[number]['id'];

function rootProblem(env: string, rootId: string | null, roots: HostRoot[] | null): string | null {
  if (env !== 'host') return null;
  if (!rootId) return 'No authorised host folder';
  if (!roots) return null;
  const r = roots.find((x) => x.id === rootId);
  if (!r) return 'Host folder access was revoked';
  if (!r.enabled) return 'Host folder is disabled';
  if (r.exists === false) return 'Host folder no longer exists';
  return null;
}

// ---------------------------------------------------------------- run bar
function RunBar({
  co,
  project,
  run,
  runId,
  onSelect,
  onChanged,
}: {
  co: CompanyDetail;
  project: ProjectDetail;
  run: RunDetail | null;
  runId: string;
  onSelect: (id: string) => void;
  onChanged: (r: RunDetail) => void;
}) {
  const { run: act, isPending } = useAction();
  const [cancelling, setCancelling] = useState(false);
  const used = run?.model_calls_used ?? 0;
  const budget = run?.max_model_calls ?? null;
  const usedPct = pct(used, budget);
  const approval = run ? co.pending_approvals.find((a) => (a.ref as { run_id?: string })?.run_id === run.id) : undefined;
  const completedN = run ? run.items.filter((i) => i.state === 'COMPLETED').length : 0;
  const failedN = run ? run.items.filter((i) => i.state === 'FAILED').length : 0;
  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-3 rounded-xl border border-border bg-panel p-3 shadow-card sm:p-4 lg:flex-row lg:items-center">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <Select aria-label="Run" value={runId} onChange={(e) => onSelect(e.target.value)} className="min-w-0 flex-1 basis-64 lg:max-w-md">
            {project.runs.map((r) => (
              <option key={r.id} value={r.id}>
                {r.state.toLowerCase().replace('_', ' ')} · {r.objective.slice(0, 70)} · {relativeTime(r.created_at)}
              </option>
            ))}
          </Select>
          {run ? (
            <>
              <StatusPill state={run.state} pulse={BUSY_STATES.has(run.state)} />
              <Badge title={run.planner === 'ceo' ? 'The CEO planned the work items' : 'Deterministic template plan'}>{run.planner === 'ceo' ? 'CEO plan' : 'template plan'}</Badge>
              <span className="text-xs text-muted tabular-nums">
                {completedN}/{run.items.length} completed
                {failedN ? ` · ${failedN} failed` : ''}
              </span>
            </>
          ) : (
            <Skeleton className="h-5 w-32" />
          )}
        </div>
        {run && (
          <div className="flex flex-wrap items-center gap-3">
            <div className="w-40 min-w-0" title="AI requests used by this run">
              <div className="mb-1 flex justify-between text-2xs text-muted">
                <span>AI requests</span>
                <span className="tabular-nums">
                  {used}
                  {budget ? ` / ${budget}` : ''}
                </span>
              </div>
              <Meter value={usedPct ?? 0} label="Run AI budget used" tone={usageTone(usedPct)} size="sm" />
            </div>
            {run.state === 'RUNNING' && (
              <Button
                size="sm"
                icon={<IconPause />}
                loading={isPending('pause')}
                onClick={async () => {
                  const r = await act('pause', () => runsApi.pause(run.id), { success: 'Run paused' });
                  if (r) onChanged(r);
                }}
              >
                Pause
              </Button>
            )}
            {run.state === 'PAUSED' && (
              <Button
                size="sm"
                icon={<IconPlay />}
                loading={isPending('resume')}
                onClick={async () => {
                  const r = await act('resume', () => runsApi.resume(run.id), { success: 'Run resumed' });
                  if (r) onChanged(r);
                }}
              >
                Resume
              </Button>
            )}
            {RUN_ACTIVE.has(run.state) && (
              <Button size="sm" variant="danger" icon={<IconStop />} onClick={() => setCancelling(true)}>
                Cancel run
              </Button>
            )}
          </div>
        )}
      </div>
      {run?.state === 'AWAITING_APPROVAL' && (
        <Notice tone="warn" title="The CEO’s plan waits for your approval">
          {approval ? (
            <ul className="mt-2">
              <ApprovalRow a={approval} onDone={() => onChanged(run)} />
            </ul>
          ) : (
            <>
              Approve or deny it in the <TextLink href={href('/approvals')}>Approval Center</TextLink>.
            </>
          )}
        </Notice>
      )}
      {run?.state === 'PLANNING' && run.planner === 'ceo' && <Notice tone="info">The CEO is planning the work items. They appear on the board when the plan is submitted.</Notice>}
      {run?.error && run.state === 'FAILED' && (
        <Notice tone="danger" title="Run failed">
          <span className="break-words">{run.error}</span>
        </Notice>
      )}
      <ConfirmDialog
        open={cancelling}
        title="Cancel this run?"
        confirmLabel="Cancel run"
        busyText="Cancelling…"
        onCancel={() => setCancelling(false)}
        onConfirm={async () => {
          if (!run) return;
          const r = await act('cancel', () => runsApi.cancel(run.id), { success: 'Run cancelled', errorTitle: 'Run not cancelled' });
          if (r) {
            onChanged(r);
            setCancelling(false);
          }
        }}
      >
        <p>Running work items are stopped and every pending item is cancelled. Results already delivered are kept. Failed or cancelled items can be retried later.</p>
      </ConfirmDialog>
    </div>
  );
}

// ---------------------------------------------------------------- tabs
function OverviewTab({ co, p, run, onProject }: { co: CompanyDetail; p: ProjectDetail; run: RunDetail | null; onProject: (p: ProjectDetail) => void }) {
  const { run: act, isPending } = useAction();
  const done = p.milestones.filter((m) => m.done).length;
  const toggle = async (id: string, v: boolean) => {
    const milestones = p.milestones.map((m) => (m.id === id ? { ...m, done: v } : m));
    const r = await act(`ms-${id}`, () => projectsApi.update(p.id, { milestones }), { errorTitle: 'Milestone not updated' });
    if (r) onProject(r);
  };
  const env = p.environment ?? co.default_environment;
  const vmPath = co.workspace_dir && p.vm_dir ? `/srv/nebula/shared/${co.workspace_dir}/${p.vm_dir}` : null;
  const total = co.budget.max_model_calls_total;
  const coPct = pct(co.stats.model_calls_used, total);
  const running = run ? run.items.filter((i) => i.state === 'RUNNING').length : 0;
  const runPct = pct(run?.model_calls_used ?? 0, run?.max_model_calls);
  const groups = run ? groupWorkItems(run.items) : [];
  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
      <div className="min-w-0 space-y-5">
        <Card title="About" icon={<IconTasks />}>
          {p.objective && <p className="mb-2 text-sm whitespace-pre-wrap text-text">{p.objective}</p>}
          {p.description && <p className="mb-4 text-sm whitespace-pre-wrap text-muted">{p.description}</p>}
          <KeyValue
            items={[
              ['Status', <StatusPill key="s" state={p.status} />],
              [
                'Environment',
                <EnvBadge
                  key="e"
                  env={env}
                  source={p.environment ? 'project' : 'company'}
                  chain={[{ level: 'company', env: co.default_environment }, ...(p.environment ? [{ level: 'project', env: p.environment }] : [])]}
                  showSource
                />,
              ],
              ['Mac folder', p.root ? <span key="r" className="break-all">{p.root.name} · <Mono>{p.root.path}</Mono></span> : p.host_root_id ? <span className="text-warn">revoked or unavailable</span> : '—'],
              ['VM folder', vmPath ? <Mono key="v" className="break-all">{vmPath}</Mono> : '—'],
              ['Git', p.git?.remote || p.git?.branch ? <Mono key="g" className="break-all">{[p.git.remote, p.git.branch].filter(Boolean).join(' · ')}</Mono> : 'not configured'],
              ['Employees', `${p.members.length} assigned`],
              ['Created', formatTime(p.created_at)],
            ]}
          />
        </Card>
        <Card
          title="Milestones"
          subtitle={p.milestones.length ? `${done} of ${p.milestones.length} done` : undefined}
          icon={<IconCheckCircle />}
        >
          {p.milestones.length === 0 ? (
            <p className="text-sm text-muted">No milestones. Add them with “Edit project”.</p>
          ) : (
            <>
              <Meter value={(done / p.milestones.length) * 100} label="Milestones done" tone="success" size="sm" />
              <ul className="mt-3 space-y-2">
                {p.milestones.map((m) => (
                  <li key={m.id} className="flex items-start justify-between gap-3">
                    <Checkbox
                      checked={m.done}
                      disabled={isPending(`ms-${m.id}`)}
                      onChange={(v) => void toggle(m.id, v)}
                      label={<span className={m.done ? 'text-muted line-through' : ''}>{m.title}</span>}
                    />
                    {m.due && <span className="shrink-0 text-xs text-subtle">due {m.due}</span>}
                  </li>
                ))}
              </ul>
            </>
          )}
        </Card>
      </div>
      <div className="min-w-0 space-y-5">
        <Card title="Resources & budget" icon={<IconActivity />}>
          <div className="space-y-4">
            <div>
              <div className="mb-1 flex justify-between text-xs">
                <span className="text-muted">Selected run · AI requests</span>
                <span className="text-text tabular-nums">
                  {run ? `${run.model_calls_used}${run.max_model_calls ? ` / ${run.max_model_calls}` : ''}` : '—'}
                </span>
              </div>
              <Meter value={runPct ?? 0} label="Run AI budget used" tone={usageTone(runPct)} size="sm" />
            </div>
            <div>
              <div className="mb-1 flex justify-between text-xs">
                <span className="text-muted">Company · AI requests</span>
                <span className="text-text tabular-nums">
                  {co.stats.model_calls_used}
                  {total ? ` / ${total}` : ' (no total limit)'}
                </span>
              </div>
              {coPct !== null && <Meter value={coPct} label="Company AI budget used" tone={usageTone(coPct)} size="sm" />}
            </div>
            <div>
              <div className="mb-1 flex justify-between text-xs">
                <span className="text-muted">Parallel work (this run)</span>
                <span className="text-text tabular-nums">
                  {running} / {co.resource_policy.max_parallel}
                </span>
              </div>
              <Meter value={pct(running, co.resource_policy.max_parallel) ?? 0} label="Parallel work in use" size="sm" />
            </div>
          </div>
        </Card>
        <Card title="Selected run" icon={<IconGrid />}>
          {!run ? (
            <p className="text-sm text-muted">No run selected.</p>
          ) : (
            <div className="space-y-3">
              <p className="text-sm break-words text-text">{run.objective}</p>
              <div className="flex flex-wrap gap-1.5">
                {groups
                  .filter((g) => g.items.length)
                  .map((g) => (
                    <Badge key={g.id} tone={g.tone} dot>
                      {g.items.length} {g.label.toLowerCase()}
                    </Badge>
                  ))}
              </div>
              <p className="text-xs text-subtle">
                Started {relativeTime(run.created_at)}
                {run.finished_at ? ` · finished ${relativeTime(run.finished_at)}` : ''}
              </p>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

function GitTab({ p }: { p: ProjectDetail }) {
  const git = useApi((s) => projectsApi.git(p.id, s), [p.id]);
  const g = git.data;
  const changes = (g?.changes ?? []).map(parseGitChange);
  return (
    <Card
      title="Git status"
      icon={<IconGitHub />}
      subtitle={g?.environment === 'host' ? 'Read live from the authorised Mac folder (read-only, sandboxed, network off).' : undefined}
      actions={<IconButton size="sm" variant="secondary" label="Refresh git status" icon={<IconRefresh />} loading={git.loading && !!g} onClick={git.reload} />}
    >
      {git.error ? (
        <ErrorBanner error={git.error} onRetry={git.reload} />
      ) : !g ? (
        <LoadingRows label="Reading git status…" />
      ) : g.repository === true ? (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="accent" icon={<IconGitHub />}>
              {g.branch ?? 'detached'}
            </Badge>
            {g.clean ? <Badge tone="success">clean working tree</Badge> : <Badge tone="warn">{changes.length} uncommitted change(s)</Badge>}
            {p.root && <Mono className="break-all">{p.root.path}</Mono>}
          </div>
          {g.error && <Notice tone="warn">git reported: {g.error}</Notice>}
          {changes.length > 0 && (
            <div>
              <p className="mb-2 text-xs font-medium text-muted">Changes</p>
              <ul className="max-h-72 space-y-1 overflow-y-auto rounded-lg border border-border bg-input p-2.5">
                {changes.map((c, i) => (
                  <li key={`${c.path}-${i}`} className="flex min-w-0 items-center gap-2 text-xs">
                    <span className="w-6 shrink-0 font-mono text-warn">{c.code}</span>
                    <Mono className="min-w-0 break-all text-text">{c.path}</Mono>
                    <span className="ml-auto shrink-0 text-subtle">{c.label}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div>
            <p className="mb-2 text-xs font-medium text-muted">Recent commits</p>
            {g.recent_commits && g.recent_commits.length ? (
              <ul className="divide-y divide-border/70 rounded-lg border border-border">
                {g.recent_commits.map((c) => (
                  <li key={c.hash} className="flex min-w-0 items-center gap-3 px-3 py-2 text-sm">
                    <Mono className="shrink-0 text-accent-soft">{c.hash}</Mono>
                    <span className="min-w-0 flex-1 truncate text-text" title={c.subject}>
                      {c.subject}
                    </span>
                    <span className="shrink-0 text-xs text-subtle">{c.date}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted">No commits yet.</p>
            )}
          </div>
          {(g.config?.remote || g.config?.branch) && <p className="text-xs text-subtle">Configured: {[g.config.remote, g.config.branch].filter(Boolean).join(' · ')}</p>}
        </div>
      ) : (
        <EmptyState compact icon={<IconGitHub />} title={g.environment === 'host' && g.repository === false ? 'No git repository in the Mac folder' : 'No repository linked'}>
          {g.environment === 'host' && g.repository === false ? (
            <>
              {p.root ? <Mono className="break-all">{p.root.path}</Mono> : 'The folder'} is not a git repository. An employee can run <code>git init</code> there, or initialise it yourself.
            </>
          ) : g.error ? (
            <span className="text-danger">{g.error}</span>
          ) : (
            <>
              {g.note ?? 'This project has no Mac folder, so there is no repository NEBULA can read.'}
              {(g.config?.remote || g.config?.branch) && (
                <span className="mt-1 block text-xs">Configured: {[g.config.remote, g.config.branch].filter(Boolean).join(' · ')}</span>
              )}
            </>
          )}
        </EmptyState>
      )}
    </Card>
  );
}

function EnvironmentTab({ co, p, roots }: { co: CompanyDetail; p: ProjectDetail; roots: HostRoot[] | null }) {
  const byAgent = new Map(co.members.map((m) => [m.agent_id, m]));
  const rootLabel = (id: string | null) => {
    const r = id ? roots?.find((x) => x.id === id) : null;
    return r ? `${r.name} (${r.path})` : null;
  };
  return (
    <Card
      title="Execution environment per employee"
      icon={<IconEnvironment />}
      subtitle="Resolved for this project: company default → project → employee override → project assignment. The most specific level wins."
    >
      <div className="mb-5 flex flex-wrap items-center gap-2 text-xs text-muted">
        <span>Company default</span>
        <EnvBadge env={co.default_environment} />
        <span className="ml-2">Project</span>
        {p.environment ? <EnvBadge env={p.environment} /> : <Badge>inherits</Badge>}
        {p.root && (
          <span className="ml-2 break-all">
            Mac folder <Mono>{p.root.path}</Mono>
          </span>
        )}
      </div>
      {p.members.length === 0 ? (
        <EmptyState compact title="Nobody is assigned">
          Assign employees with “Edit project”.
        </EmptyState>
      ) : (
        <ul className="space-y-3" aria-label="Employees and their environments">
          {p.members.map((pm) => {
            const m = byAgent.get(pm.agent_id);
            const eff = pm.environment_effective;
            const problem = rootProblem(eff.env, eff.root_id, roots);
            return (
              <li key={pm.agent_id} className="rounded-xl border border-border bg-panel-2 p-3 sm:p-4">
                <div className="flex flex-wrap items-center gap-3">
                  <Avatar name={pm.agent_name} id={pm.agent_id} size="sm" />
                  <div className="min-w-0 flex-1">
                    <TextLink href={href(`/agents/${pm.agent_id}`)} className="font-medium">
                      {pm.agent_name}
                    </TextLink>
                    <p className="text-xs text-muted">{m?.role_title ?? pm.role_key}</p>
                  </div>
                  <EnvBadge env={eff.env} source={eff.source} chain={eff.chain} rootLabel={rootLabel(eff.root_id)} size="md" showSource />
                  {problem ? (
                    <Badge tone="danger" dot>
                      {problem}
                    </Badge>
                  ) : (
                    <Badge tone="success" dot>
                      ready
                    </Badge>
                  )}
                </div>
                <div className="mt-3">
                  <EnvChain chain={eff.chain} levels={COMPANY_LEVELS} label={`Environment chain of ${pm.agent_name}`} />
                </div>
                {eff.env === 'host' && eff.root_id && <p className="mt-2 text-xs break-all text-muted">Works in {rootLabel(eff.root_id) ?? 'an unknown folder'}</p>}
              </li>
            );
          })}
        </ul>
      )}
      <p className="mt-4 text-xs text-subtle">
        {ENV_LONG.host}: files, terminal, git and developer tools in the authorised folder. {ENV_LONG.vm}: own Linux user with desktop and browser. Results are transferred between environments automatically
        when colleagues hand over work.
      </p>
    </Card>
  );
}

function ResultsTab({ run }: { run: RunDetail | null }) {
  if (!run) return <EmptyState title="No run selected">Start a run to see results here.</EmptyState>;
  const r = run.result;
  if (!r) {
    const done = run.items.filter((i) => i.state === 'COMPLETED' && i.result_summary);
    return (
      <Card title="Results so far" icon={<IconCheckCircle />} subtitle="The final report appears when the run finishes.">
        {done.length === 0 ? (
          <p className="text-sm text-muted">No work item has finished yet.</p>
        ) : (
          <ul className="space-y-4">
            {done.map((i) => (
              <li key={i.id}>
                <p className="text-sm font-medium text-text">
                  {i.title} <span className="text-xs font-normal text-muted">· {i.agent_name}</span>
                </p>
                <p className="mt-1 text-[13px] break-words whitespace-pre-wrap text-muted">{i.result_summary}</p>
                {i.artifacts.length > 0 && (
                  <div className="mt-1.5">
                    <ArtifactList artifacts={i.artifacts} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    );
  }
  return (
    <div className="space-y-5">
      <Card
        title={r.ceo_report ? 'CEO report' : 'Run summary'}
        icon={<IconCheckCircle />}
        actions={
          <>
            <StatusPill state={run.state} />
            <Badge>{r.model_calls} AI requests</Badge>
          </>
        }
      >
        <p className="text-sm leading-relaxed break-words whitespace-pre-wrap text-text">{r.summary || 'No summary.'}</p>
        {!r.ceo_report && <p className="mt-3 text-xs text-subtle">No CEO review in this run: the summary lists every work item’s result.</p>}
      </Card>
      <div className="grid gap-5 lg:grid-cols-2">
        <Card title={`Artifacts (${r.artifacts.length})`} icon={<IconFiles />}>
          {r.artifacts.length ? <ArtifactList artifacts={r.artifacts} /> : <p className="text-sm text-muted">No verified artifacts.</p>}
        </Card>
        <Card title="Work items" icon={<IconGrid />}>
          <ul className="space-y-2">
            {r.items.map((i, n) => (
              <li key={`${i.title}-${n}`} className="flex flex-wrap items-center gap-2 text-sm">
                <StatusPill state={i.state} />
                <span className="min-w-0 flex-1 truncate text-text">{i.title}</span>
                {i.environment && <EnvBadge env={i.environment} />}
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}

function ActivityTab({ co, p, runId }: { co: CompanyDetail; p: ProjectDetail; runId: string | null }) {
  const [onlyRun, setOnlyRun] = useState(false);
  const feed = useApi((s) => companiesApi.activity(co.id, { project_id: p.id, limit: 300 }, s), [co.id, p.id]);
  useLiveRefresh(feed.reload, (ev) => ev.type === 'company.activity' && (ev.payload as { project_id?: string })?.project_id === p.id, 500);
  const names = useMemo(() => new Map(co.members.map((m) => [m.agent_id, m.agent_name])), [co.members]);
  const items = (feed.data ?? []).filter((a) => !onlyRun || a.run_id === runId);
  return (
    <Card
      title="Activity timeline"
      icon={<IconActivity />}
      actions={runId ? <Switch checked={onlyRun} onChange={setOnlyRun} label="Selected run only" /> : undefined}
    >
      {feed.error ? (
        <ErrorBanner error={feed.error} onRetry={feed.reload} />
      ) : !feed.data ? (
        <LoadingRows label="Loading activity…" />
      ) : (
        <ActivityFeed items={items} companyId={co.id} agentName={(id) => names.get(id) ?? null} showProject={false} emptyText="Activity appears when the project runs." />
      )}
    </Card>
  );
}

function FilesTab({ co, p }: { co: CompanyDetail; p: ProjectDetail }) {
  const hasHost = Boolean(p.host_root_id && p.root);
  const [where, setWhere] = useState<'host' | 'vm'>(hasHost ? 'host' : 'vm');
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        {hasHost && (
          <SegmentedControl<'host' | 'vm'>
            label="Project files location"
            value={where}
            onChange={setWhere}
            options={[
              { value: 'host', label: 'Mac project folder' },
              { value: 'vm', label: 'Company folder (VM)' },
            ]}
          />
        )}
        <p className="text-xs text-muted">
          {where === 'host' && p.root ? (
            <>
              Authorised folder <Mono className="break-all">{p.root.path}</Mono>
            </>
          ) : (
            <>Project folder inside the shared company folder in the VM{p.vm_dir ? ` (${p.vm_dir})` : ''}.</>
          )}
        </p>
      </div>
      {where === 'host' && p.host_root_id ? (
        <FileManager key="host" root={`host:${p.host_root_id}`} />
      ) : (
        <FileManager key="vm" root={`company:${co.id}`} initialPath={p.vm_dir ?? undefined} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- page
export function ProjectWorkspace({
  companyId,
  projectId,
  tab,
  runId: routeRunId,
  query,
}: {
  companyId: string;
  projectId: string;
  tab?: string;
  runId?: string | null;
  query: URLSearchParams;
}) {
  const project = useApi((s) => projectsApi.get(projectId, s), [projectId]);
  const company = useApi((s) => companiesApi.get(companyId, s), [companyId]);
  const roots = useApi((s) => hostApi.roots(s), []);
  const explicitRun = routeRunId ?? query.get('run');
  const runId = explicitRun ?? project.data?.runs[0]?.id ?? null;
  const runActive = (r: RunDetail | null) => Boolean(r && RUN_ACTIVE.has(r.state));
  const runQ = useApi((s) => (runId ? runsApi.get(runId, s) : Promise.resolve(null)), [runId]);
  const [starting, setStarting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const { run: act } = useAction();
  const [retrying, setRetrying] = useState<string | null>(null);

  const match = (ev: NebulaEvent) => {
    const pl = (ev.payload ?? {}) as { project_id?: string; run_id?: string; ref?: { run_id?: string } };
    if (ev.type.startsWith('company.')) return pl.project_id === projectId || (runId !== null && pl.run_id === runId);
    if (ev.type.startsWith('owner.approval.')) return Boolean(runId && pl.ref?.run_id === runId);
    return false;
  };
  useLiveRefresh(
    () => {
      project.reload();
      runQ.reload();
    },
    match,
    500,
  );
  useLiveRefresh(company.reload, (ev) => ev.type === 'company.run.started' || ev.type === 'company.run.finished' || ev.type.startsWith('owner.approval.') || ev.type === 'company.updated', 1000);

  const active: ProjectTab = (PROJECT_TABS.find((t) => t.id === tab)?.id ?? (routeRunId ? 'board' : 'overview')) as ProjectTab;
  const p = project.data;
  const co = company.data;
  const run = runQ.data && runQ.data.id === runId ? runQ.data : null;

  if (!p || !co) {
    const err = project.error ?? company.error;
    if (err instanceof ApiError && err.status === 404)
      return (
        <EmptyState title="Project not found" action={<ButtonLink href={href(`/companies/${companyId}/projects`)}>Back to projects</ButtonLink>}>
          It may have been deleted.
        </EmptyState>
      );
    return err ? (
      <ErrorBanner
        error={err}
        onRetry={() => {
          project.reload();
          company.reload();
        }}
      />
    ) : (
      <div className="space-y-4" role="status" aria-label="Loading project…">
        <Skeleton className="h-3 w-56" />
        <Skeleton className="h-7 w-72" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-72 w-full rounded-xl" />
      </div>
    );
  }
  if (p.company_id !== co.id)
    return (
      <EmptyState title="Project belongs to another company" action={<ButtonLink href={href(`/companies/${p.company_id}/projects/${p.id}`)}>Open it there</ButtonLink>}>
        The link is outdated.
      </EmptyState>
    );

  const runParam = explicitRun ? `?run=${encodeURIComponent(explicitRun)}` : '';
  const selectRun = (id: string) => navigate(`/companies/${co.id}/projects/${p.id}/${active}?run=${encodeURIComponent(id)}`, { replace: true });
  const blocker = runBlocker(co, p);
  const env = p.environment ?? co.default_environment;
  const roleTitle = (k: string) => co.roles.find((r) => r.key === k)?.title ?? k;
  const showRunBar = (active === 'board' || active === 'overview' || active === 'results') && p.runs.length > 0 && runId;
  const startButton = (
    <Button variant="primary" icon={<IconPlay />} onClick={() => setStarting(true)} disabledReason={blocker}>
      Start run
    </Button>
  );
  let body: ReactNode = null;
  if (active === 'overview') body = <OverviewTab co={co} p={p} run={run} onProject={(np) => project.setData(() => np)} />;
  else if (active === 'board')
    body =
      p.runs.length === 0 ? (
        <EmptyState icon={<IconGrid />} title="No runs yet" action={startButton}>
          A run turns an objective into work items for the assigned employees.
        </EmptyState>
      ) : !run ? (
        runQ.error ? (
          <ErrorBanner error={runQ.error} onRetry={runQ.reload} />
        ) : (
          <LoadingRows label="Loading run…" />
        )
      ) : run.items.length === 0 ? (
        <EmptyState compact icon={<IconGrid />} title="No work items yet">
          {run.state === 'PLANNING' ? 'The CEO is still planning.' : 'This run has no work items.'}
        </EmptyState>
      ) : (
        <TaskBoard
          run={run}
          roleTitle={roleTitle}
          retryingId={retrying}
          onRetry={async (it) => {
            setRetrying(it.id);
            const r = await act(`retry-${it.id}`, () => runsApi.retryItem(it.id), { success: `${it.title}: retrying`, errorTitle: 'Retry failed' });
            setRetrying(null);
            if (r) {
              runQ.setData(() => r);
              project.reload();
            }
          }}
        />
      );
  else if (active === 'activity') body = <ActivityTab co={co} p={p} runId={runId} />;
  else if (active === 'files') body = <FilesTab co={co} p={p} />;
  else if (active === 'git') body = <GitTab p={p} />;
  else if (active === 'environment') body = <EnvironmentTab co={co} p={p} roots={roots.data} />;
  else if (active === 'results') body = <ResultsTab run={run} />;

  return (
    <>
      <PageHeader
        breadcrumbs={[
          { label: 'AI Companies', href: href('/companies') },
          { label: co.name, href: href(`/companies/${co.id}`) },
          { label: 'Projects', href: href(`/companies/${co.id}/projects`) },
          { label: p.name },
        ]}
        title={p.name}
        meta={
          <>
            <StatusPill state={p.status} />
            <EnvBadge
              env={env}
              source={p.environment ? 'project' : 'company'}
              chain={[{ level: 'company', env: co.default_environment }, ...(p.environment ? [{ level: 'project', env: p.environment }] : [])]}
              rootLabel={p.root ? `${p.root.name} (${p.root.path})` : null}
              showSource
            />
            {run && runActive(run) && (
              <Badge tone="accent" dot>
                run {run.state.toLowerCase().replace('_', ' ')}
              </Badge>
            )}
            <span className="text-xs text-muted">{p.members.length} employee(s)</span>
          </>
        }
        description={p.objective || p.description || undefined}
        actions={
          <>
            <Button icon={<IconEdit />} onClick={() => setEditing(true)}>
              Edit project
            </Button>
            {startButton}
            <DropdownMenu
              label={`More actions for ${p.name}`}
              items={[
                {
                  label: 'Delete project…',
                  icon: <IconTrash />,
                  danger: true,
                  disabled: p.runs.some((r) => RUN_ACTIVE.has(r.state)),
                  disabledReason: 'Cancel the active run first',
                  onSelect: () => setDeleting(true),
                },
              ]}
            />
          </>
        }
      />
      {project.error ? (
        <div className="mb-4">
          <ErrorBanner error={project.error} onRetry={project.reload} title="Refresh failed" />
        </div>
      ) : null}
      <Tabs label="Project sections" tabs={[...PROJECT_TABS]} active={active} hrefFor={(id) => href(`/companies/${co.id}/projects/${p.id}/${id}${runParam}`)} />
      {showRunBar && (
        <div className="mb-5">
          <RunBar
            co={co}
            project={p}
            run={run}
            runId={runId}
            onSelect={selectRun}
            onChanged={(r) => {
              runQ.setData(() => r);
              project.reload();
              company.reload();
            }}
          />
        </div>
      )}
      {body}
      {starting && (
        <StartRunDialog
          co={co}
          project={p}
          onClose={() => setStarting(false)}
          onStarted={(r) => {
            setStarting(false);
            project.reload();
            company.reload();
            navigate(`/companies/${co.id}/projects/${p.id}/board?run=${encodeURIComponent(r.id)}`);
          }}
        />
      )}
      {editing && (
        <ProjectForm
          co={co}
          project={p}
          roots={roots.data}
          onRootAdded={() => roots.reload()}
          onClose={() => setEditing(false)}
          onSaved={(np) => {
            setEditing(false);
            project.setData(() => np);
            company.reload();
          }}
        />
      )}
      <ConfirmDialog
        open={deleting}
        title={`Delete project ${p.name}?`}
        confirmLabel="Delete project"
        busyText="Deleting…"
        onCancel={() => setDeleting(false)}
        onConfirm={async () => {
          const r = await act('delete', () => projectsApi.remove(p.id), { success: `${p.name} deleted`, errorTitle: 'Project not deleted' });
          if (r) {
            setDeleting(false);
            navigate(`/companies/${co.id}/projects`);
          }
        }}
      >
        <p>The project, its runs and its activity are removed. Files are kept — both the Mac folder and the company folder in the VM.</p>
      </ConfirmDialog>
    </>
  );
}

/** #/companies/<id>/runs/<rid>: resolves the run's project and shows it in the project workspace. */
export function RunRoute({ companyId, runId, tab, query }: { companyId: string; runId: string; tab?: string; query: URLSearchParams }) {
  const run = useApi((s) => runsApi.get(runId, s), [runId]);
  if (!run.data)
    return run.error ? (
      run.error instanceof ApiError && run.error.status === 404 ? (
        <EmptyState title="Run not found" action={<ButtonLink href={href(`/companies/${companyId}`)}>Back to the company</ButtonLink>}>
          It may have been deleted with its project.
        </EmptyState>
      ) : (
        <ErrorBanner error={run.error} onRetry={run.reload} />
      )
    ) : (
      <LoadingRows label="Loading run…" />
    );
  return <ProjectWorkspace key={run.data.project_id} companyId={run.data.company_id || companyId} projectId={run.data.project_id} runId={runId} tab={tab} query={query} />;
}
