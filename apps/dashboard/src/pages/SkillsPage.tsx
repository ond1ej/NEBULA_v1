// Skills & plugins: catalog, plugin install/uninstall, compatibility, usage audit, permission matrix, GitHub token.
import { useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from '../api';
import { IconCheck, IconGitHub, IconKey, IconPackage, IconRefresh, IconSearch, IconShield, IconSkills, IconTrash, IconUpload, IconX } from '../components/icons';
import { DropdownMenu } from '../components/Menu';
import { ConfirmDialog, Drawer } from '../components/Modal';
import { StatusPill } from '../components/StatusPill';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  DataTable,
  EmptyState,
  ErrorBanner,
  Field,
  Input,
  KeyValue,
  LoadingCards,
  LoadingRows,
  Mono,
  Notice,
  PageHeader,
  SegmentedControl,
  Switch,
  TabBar,
  TabPanel,
  type Column,
} from '../components/ui';
import { useAction, useApi } from '../hooks/useApi';
import { useLiveRefresh } from '../hooks/useEvents';
import { href, navigate } from '../hooks/useHashRoute';
import { formatBytes, formatTime, relativeTime, shortId } from '../lib/format';
import type { PermissionMatrixTool, Skill, SkillCompatibility, SkillUsage } from '../types';

type Tab = 'catalog' | 'permissions' | 'usage' | 'integrations';

export function skillTools(s: Pick<Skill, 'manifest'>): { name: string; description?: string; level?: string }[] {
  const tools = s.manifest?.tools ?? [];
  const levels = s.manifest?.permissions?.levels ?? {};
  return tools.map((t) => (typeof t === 'string' ? { name: t, level: levels[t] } : { name: t.name, description: t.description, level: s.manifest?.permissions?.min_level }));
}

function levelLabel(l: string | undefined) {
  return l ? l.replace('_', ' ').toLowerCase() : '—';
}

function SkillCard({
  s,
  compat,
  onDetails,
  onUninstall,
  onChanged,
}: {
  s: Skill;
  compat?: { ok: boolean; missing: string[] };
  onDetails: () => void;
  onUninstall: () => void;
  onChanged: (s: Skill) => void;
}) {
  const { run, isPending } = useAction();
  const tools = skillTools(s);
  const deps = s.manifest?.dependencies?.guest ?? [];
  const risks = s.manifest?.permissions?.risk_categories ?? [];
  const toggle = async (v: boolean) => {
    const r = await run('en', () => api.skills.setEnabled(s.id, v), { success: `${s.name} ${v ? 'enabled' : 'disabled'}`, errorTitle: 'Skill not changed' });
    if (r) onChanged({ ...s, ...r });
  };
  return (
    <article className={`flex min-w-0 flex-col rounded-xl border bg-panel shadow-card ${s.enabled ? 'border-border' : 'border-border opacity-75'}`}>
      <div className="flex items-start gap-3 p-4 pb-3">
        <span aria-hidden className={`grid size-9 shrink-0 place-items-center rounded-lg border ${s.kind === 'builtin' ? 'border-border bg-panel-2 text-muted' : 'border-accent/30 bg-accent/10 text-accent-soft'}`}>
          {s.kind === 'builtin' ? <IconSkills className="size-4" /> : <IconPackage className="size-4" />}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="flex flex-wrap items-center gap-x-2 text-sm font-semibold text-text">
            <button type="button" onClick={onDetails} className="rounded text-left hover:underline focus-ring">
              {s.name}
            </button>
            <span className="font-mono text-2xs font-normal text-subtle">v{s.version}</span>
          </h3>
          <div className="mt-1 flex flex-wrap gap-1.5">
            <Badge tone={s.kind === 'builtin' ? 'neutral' : 'accent'}>{s.kind === 'builtin' ? 'Built-in' : 'Plugin'}</Badge>
            <Badge title="Minimum agent permission level">needs {levelLabel(s.manifest?.permissions?.min_level)}</Badge>
            {compat && (compat.ok ? <Badge tone="success" icon={<IconCheck />}>VM ready</Badge> : <Badge tone="warn">missing {compat.missing.join(', ')}</Badge>)}
          </div>
        </div>
        <Switch hideLabel label={`${s.name} enabled`} checked={s.enabled} onChange={toggle} loading={isPending('en')} />
      </div>
      <p className="px-4 text-[13px] text-muted">{s.description}</p>
      <div className="mt-3 flex flex-wrap gap-1 px-4">
        {tools.slice(0, 6).map((t) => (
          <span key={t.name} className="rounded-md bg-white/[0.04] px-1.5 py-0.5 font-mono text-2xs text-muted">
            {t.name}
          </span>
        ))}
        {tools.length > 6 && <span className="px-1 py-0.5 text-2xs text-subtle">+{tools.length - 6} more</span>}
      </div>
      {(deps.length > 0 || risks.length > 0) && (
        <p className="mt-2.5 px-4 text-2xs text-subtle">
          {deps.length > 0 && <>VM needs: {deps.join(', ')}</>}
          {deps.length > 0 && risks.length > 0 && ' · '}
          {risks.length > 0 && <span className="text-warn">asks approval for: {risks.join(', ').replace(/_/g, ' ')}</span>}
        </p>
      )}
      <div className="mt-auto flex items-center gap-2 border-t border-border px-4 py-2.5 pt-2.5 text-2xs text-subtle">
        <span className="mr-auto">
          {s.assigned_agents} agent(s) · used {s.usage_count}×
        </span>
        <Button size="xs" variant="ghost" onClick={onDetails}>
          Details
        </Button>
        {s.kind === 'plugin' && (
          <DropdownMenu label={`More actions for ${s.name}`} items={[{ label: 'Uninstall plugin…', icon: <IconTrash />, danger: true, onSelect: onUninstall }]} />
        )}
      </div>
    </article>
  );
}

function SkillDrawer({ skillId, onClose, agentName }: { skillId: string; onClose: () => void; agentName: (id: string | null) => string }) {
  const d = useApi(() => api.skills.get(skillId), [skillId]);
  const s = d.data;
  return (
    <Drawer open onClose={onClose} title={s ? s.name : 'Skill'} description={s?.description} width="lg">
      {d.error && !s ? (
        <ErrorBanner error={d.error} onRetry={d.reload} />
      ) : !s ? (
        <LoadingRows label="Loading skill…" />
      ) : (
        <div className="space-y-6">
          <KeyValue
            items={[
              ['Kind', s.kind === 'builtin' ? 'Built-in' : 'Plugin (runs only inside the Ubuntu VM as the agent’s Linux user)'],
              ['Version', <Mono key="v">{s.version}</Mono>],
              ['Enabled', s.enabled ? 'Yes' : 'No'],
              ['Required level', levelLabel(s.manifest?.permissions?.min_level)],
              ['VM dependencies', (s.manifest?.dependencies?.guest ?? []).join(', ') || 'none'],
              ...(s.manifest?.dependencies?.nebula ? ([['NEBULA version', s.manifest.dependencies.nebula]] as [string, string][]) : []),
              ...(s.manifest?.entrypoint ? ([['Entrypoint', <Mono key="e">{s.manifest.entrypoint}</Mono>]] as [string, ReactNode][]) : []),
              ...(s.manifest?.timeout_s ? ([['Timeout', `${s.manifest.timeout_s} s per call`]] as [string, string][]) : []),
              ...(s.manifest?.security?.network !== undefined ? ([['Network access', s.manifest.security.network ? 'Yes' : 'No']] as [string, string][]) : []),
              ...(s.checksum ? ([['SHA-256', <Mono key="c" className="break-all text-2xs">{s.checksum}</Mono>]] as [string, ReactNode][]) : []),
              ['Installed', formatTime(s.installed_at)],
              ['Updated', formatTime(s.updated_at)],
            ]}
          />
          {(s.manifest?.permissions?.risk_categories ?? []).length > 0 && (
            <Notice tone="warn" title="Always asks for approval">
              {(s.manifest?.permissions?.risk_categories ?? []).join(', ').replace(/_/g, ' ')}
            </Notice>
          )}
          <section>
            <h3 className="mb-2 text-2xs font-semibold tracking-wider text-subtle uppercase">Tools ({skillTools(s).length})</h3>
            <ul className="divide-y divide-border rounded-xl border border-border">
              {skillTools(s).map((t) => (
                <li key={t.name} className="flex flex-wrap items-start gap-2 px-3 py-2">
                  <Mono className="text-text">{t.name}</Mono>
                  {t.level && <Badge>{levelLabel(t.level)}</Badge>}
                  {t.description && <p className="w-full text-xs text-muted">{t.description}</p>}
                </li>
              ))}
            </ul>
          </section>
          <section>
            <h3 className="mb-2 text-2xs font-semibold tracking-wider text-subtle uppercase">Recent usage</h3>
            {s.usage.length === 0 ? (
              <p className="text-sm text-muted">Not used yet.</p>
            ) : (
              <ul className="space-y-1.5">
                {s.usage.slice(0, 30).map((u) => (
                  <li key={u.id} className="flex flex-wrap items-center gap-2 text-xs">
                    <StatusPill state={u.status} />
                    <Mono className="text-text">{u.tool}</Mono>
                    <span className="text-muted">{agentName(u.agent_id)}</span>
                    <span className="ml-auto text-subtle">{relativeTime(u.ts)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </Drawer>
  );
}

function Catalog({ agentName }: { agentName: (id: string | null) => string }) {
  const skills = useApi(() => api.skills.list(), []);
  useLiveRefresh(skills.reload, (e) => e.type === 'skill.changed', 400);
  const [compat, setCompat] = useState<SkillCompatibility | null>(null);
  const [compatError, setCompatError] = useState<unknown>(null);
  const { run, isPending } = useAction();
  const [filter, setFilter] = useState<'all' | 'builtin' | 'plugin'>('all');
  const [q, setQ] = useState('');
  const [detail, setDetail] = useState<string | null>(null);
  const [uninstall, setUninstall] = useState<Skill | null>(null);
  const [upload, setUpload] = useState<File | null>(null);
  const [downgrade, setDowngrade] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const searchId = useId();

  const list = useMemo(() => {
    const n = q.trim().toLowerCase();
    return (skills.data ?? []).filter((s) => (filter === 'all' || (filter === 'builtin' ? s.kind === 'builtin' : s.kind !== 'builtin')) && (!n || `${s.name} ${s.description} ${s.id}`.toLowerCase().includes(n)));
  }, [skills.data, filter, q]);

  const check = async () => {
    setCompatError(null);
    try {
      setCompat(await api.skills.compatibility());
    } catch (e) {
      setCompatError(e);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-center">
        <div className="relative w-full md:max-w-xs">
          <label htmlFor={searchId} className="sr-only">
            Filter skills
          </label>
          <IconSearch className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-subtle" />
          <Input id={searchId} type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter skills" className="pl-9" />
        </div>
        <SegmentedControl
          label="Skill kind"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'All' },
            { value: 'builtin', label: 'Built-in' },
            { value: 'plugin', label: 'Plugins' },
          ]}
        />
        <div className="flex flex-wrap gap-2 md:ml-auto">
          <Button icon={<IconRefresh />} onClick={() => void run('compat', check)} loading={isPending('compat')}>
            Check VM compatibility
          </Button>
          <Button variant="primary" icon={<IconUpload />} onClick={() => fileRef.current?.click()}>
            Install plugin
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".zip,application/zip"
            className="sr-only"
            tabIndex={-1}
            aria-label="Plugin archive (.zip)"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              e.target.value = '';
              if (f) setUpload(f);
            }}
          />
        </div>
      </div>
      {compatError ? <ErrorBanner error={compatError} title="Compatibility check failed (is the VM running?)" onRetry={() => void check()} /> : null}
      {compat && (
        <p className="text-xs text-muted">
          VM capabilities checked:{' '}
          {Object.entries(compat.capabilities)
            .filter(([, v]) => typeof v === 'boolean' || typeof v === 'string')
            .slice(0, 12)
            .map(([k, v]) => `${k} ${v === true ? '✓' : v === false ? '✗' : String(v)}`)
            .join(' · ')}
        </p>
      )}
      {skills.error ? <ErrorBanner error={skills.error} onRetry={skills.reload} /> : null}
      {!skills.data && skills.loading ? (
        <LoadingCards count={6} label="Loading skills…" />
      ) : list.length === 0 ? (
        <EmptyState icon={<IconSkills />} title={q || filter !== 'all' ? 'No skill matches' : 'No skills registered'}>
          {filter === 'plugin' ? 'Install a plugin from a local .zip archive. Plugins are never downloaded automatically.' : 'Try another filter.'}
        </EmptyState>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {list.map((s) => (
            <SkillCard
              key={s.id}
              s={s}
              compat={compat?.skills[s.id]}
              onDetails={() => setDetail(s.id)}
              onUninstall={() => setUninstall(s)}
              onChanged={(n) => skills.setData((xs) => (xs ? xs.map((x) => (x.id === n.id ? { ...x, ...n } : x)) : xs))}
            />
          ))}
        </div>
      )}
      {detail && <SkillDrawer skillId={detail} onClose={() => setDetail(null)} agentName={agentName} />}
      <ConfirmDialog
        open={upload !== null}
        title="Install this plugin?"
        confirmLabel="Install plugin"
        destructive={false}
        busyText="Validating & installing…"
        onCancel={() => {
          setUpload(null);
          setDowngrade(false);
        }}
        onConfirm={async () => {
          if (!upload) return;
          const r = await run('install', () => api.skills.installPlugin(upload, downgrade), {
            success: (p) => `Plugin ${p.name} ${p.version} installed`,
            errorTitle: 'Plugin rejected',
          });
          if (r) {
            setUpload(null);
            setDowngrade(false);
            skills.reload();
          }
        }}
      >
        <p>
          <strong>{upload?.name}</strong> ({formatBytes(upload?.size)}) is validated (manifest, paths, size, checksum) and then copied into the Ubuntu VM. Plugin code only ever runs there, as
          the calling agent’s unprivileged Linux user, and every tool still goes through the approval policy.
        </p>
        <Notice tone="warn">Only install plugins you trust. NEBULA does not sandbox a plugin beyond the agent’s own Linux account.</Notice>
        <Checkbox label="Allow installing an older or equal version" checked={downgrade} onChange={setDowngrade} />
      </ConfirmDialog>
      <ConfirmDialog
        open={uninstall !== null}
        title={`Uninstall ${uninstall?.name ?? 'plugin'}?`}
        confirmLabel="Uninstall"
        onCancel={() => setUninstall(null)}
        onConfirm={async () => {
          if (!uninstall) return;
          const r = await run('uninstall', () => api.skills.uninstallPlugin(uninstall.id), { success: `${uninstall.name} uninstalled`, errorTitle: 'Uninstall failed' });
          if (r) {
            setUninstall(null);
            skills.reload();
          }
        }}
      >
        <p>The plugin files are removed from the VM and every agent loses its tools. Its usage history stays in the audit log.</p>
      </ConfirmDialog>
    </div>
  );
}

const Yes = () => (
  <span className="inline-flex text-success" role="img" aria-label="Allowed">
    <IconCheck className="size-4" />
  </span>
);
const No = () => (
  <span className="inline-flex text-subtle/70" role="img" aria-label="Not allowed">
    <IconX className="size-4" />
  </span>
);

function Permissions() {
  const m = useApi(() => api.skills.permissionMatrix(), []);
  const [q, setQ] = useState('');
  const id = useId();
  if (m.error && !m.data) return <ErrorBanner error={m.error} onRetry={m.reload} />;
  if (!m.data)
    return (
      <div className="rounded-xl border border-border bg-panel p-5">
        <LoadingRows rows={6} label="Loading the permission matrix…" />
      </div>
    );
  const data = m.data;
  const levels = data.levels;
  const n = q.trim().toLowerCase();
  const rows = data.tools.filter((t) => !n || `${t.tool} ${t.description} ${t.skills.join(' ')}`.toLowerCase().includes(n));
  const columns: Column<PermissionMatrixTool>[] = [
    {
      key: 'tool',
      header: 'Tool',
      mobile: 'title',
      className: 'max-w-[320px]',
      cell: (t) => (
        <div className="min-w-0">
          <Mono className="text-text">{t.tool}</Mono>
          <p className="mt-0.5 line-clamp-2 text-xs text-muted">{t.description}</p>
        </div>
      ),
    },
    ...levels.map((lv) => ({
      key: lv,
      header: levelLabel(lv),
      align: 'right' as const,
      headerClassName: 'text-center',
      className: 'text-center w-24',
      cell: (t: PermissionMatrixTool) => (t.levels[lv] ? <Yes /> : <No />),
    })),
    { key: 'skills', header: 'Skill', cell: (t) => (t.skills.length ? t.skills.join(', ') : <span className="text-subtle">core</span>) },
    {
      key: 'flags',
      header: 'Approval',
      className: 'max-w-[260px]',
      cell: (t) => (
        <div className="flex flex-wrap gap-1">
          {t.always_approve && <Badge tone="warn">always asks</Badge>}
          {t.approval_when && <span className="text-xs text-muted">{t.approval_when}</span>}
          {t.side_effect && <Badge>side effect</Badge>}
          {t.gui && <Badge>desktop</Badge>}
          {!t.always_approve && !t.approval_when && !t.side_effect && !t.gui && <span className="text-xs text-subtle">—</span>}
        </div>
      ),
    },
  ];
  return (
    <div className="space-y-5">
      <Notice tone="info" title="How permissions work">
        <ul className="list-inside list-disc space-y-1">
          {data.rules.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      </Notice>
      <div className="grid gap-3 md:grid-cols-3">
        {levels.map((lv) => (
          <div key={lv} className="rounded-xl border border-border bg-panel p-4 shadow-card">
            <p className="flex items-center gap-2 text-sm font-semibold text-text">
              <IconShield className="size-4 text-subtle" />
              {levelLabel(lv)}
            </p>
            <p className="mt-1 text-xs text-muted">{data.tools.filter((t) => t.levels[lv]).length} tools allowed</p>
            <p className="mt-2 font-mono text-2xs text-subtle">{(data.level_permissions[lv] ?? []).join(', ')}</p>
          </div>
        ))}
      </div>
      <div className="relative w-full md:max-w-xs">
        <label htmlFor={id} className="sr-only">
          Filter tools
        </label>
        <IconSearch className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-subtle" />
        <Input id={id} type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Filter ${data.tools.length} tools`} className="pl-9" />
      </div>
      <DataTable label="Permission matrix" columns={columns} rows={rows} rowKey={(t) => t.tool} minWidth={860} dense />
    </div>
  );
}

function Usage({ agentName }: { agentName: (id: string | null) => string }) {
  const u = useApi(() => api.skills.usage(undefined, 200), []);
  if (u.error && !u.data) return <ErrorBanner error={u.error} onRetry={u.reload} />;
  if (!u.data)
    return (
      <div className="rounded-xl border border-border bg-panel p-5">
        <LoadingRows label="Loading usage…" />
      </div>
    );
  if (u.data.length === 0) return <EmptyState title="No skill usage recorded yet">Every tool call an agent makes through a skill is logged here.</EmptyState>;
  const columns: Column<SkillUsage>[] = [
    { key: 'ts', header: 'Time', mobile: 'subtitle', className: 'whitespace-nowrap text-xs text-muted', cell: (r) => <span title={formatTime(r.ts)}>{relativeTime(r.ts)}</span> },
    { key: 'tool', header: 'Tool', mobile: 'title', cell: (r) => <Mono className="text-text">{r.tool}</Mono> },
    { key: 'skill', header: 'Skill', cell: (r) => r.skill_id },
    { key: 'agent', header: 'Agent', cell: (r) => agentName(r.agent_id) },
    {
      key: 'task',
      header: 'Task',
      cell: (r) =>
        r.task_id && r.agent_id ? (
          <a className="rounded font-mono text-xs text-accent-soft hover:underline focus-ring" href={href(`/agents/${r.agent_id}/tasks?task=${r.task_id}`)}>
            {shortId(r.task_id)}
          </a>
        ) : (
          '—'
        ),
    },
    { key: 'status', header: 'Result', mobile: 'aside', cell: (r) => <StatusPill state={r.status} /> },
  ];
  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button size="sm" icon={<IconRefresh />} onClick={u.reload} loading={u.loading}>
          Refresh
        </Button>
      </div>
      <DataTable label="Skill usage audit" columns={columns} rows={u.data} rowKey={(r) => String(r.id)} minWidth={720} dense />
    </div>
  );
}

function Integrations() {
  const id = useId();
  const [token, setToken] = useState('');
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [state, setState] = useState<'unknown' | 'set' | 'removed'>('unknown');
  const { run, isPending } = useAction();
  const invalid = token.trim().length < 10 ? 'Paste a token (at least 10 characters)' : null;
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card title="GitHub token" icon={<IconGitHub />} subtitle="Used by the GitHub skill for writes and private repositories. Public reads work without it.">
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            if (invalid) return;
            const r = await run('gh', () => api.skills.setGithubToken(token.trim()), { success: 'GitHub token stored in the Keychain', errorTitle: 'Token not stored' });
            if (r) {
              setToken('');
              setState('set');
            }
          }}
        >
          <Field htmlFor={id} label="Personal access token" hint="Stored in the macOS Keychain on this Mac. Prefer a fine-grained token limited to the repositories the agents need.">
            <Input id={id} type="password" autoComplete="off" spellCheck={false} value={token} onChange={(e) => setToken(e.target.value)} placeholder="github_pat_…" />
          </Field>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" variant="primary" icon={<IconKey />} loading={isPending('gh')} disabledReason={invalid}>
              Save token
            </Button>
            <Button variant="danger" icon={<IconTrash />} onClick={() => setConfirmRemove(true)}>
              Remove token
            </Button>
          </div>
          <p className="text-xs text-muted">
            {state === 'set'
              ? 'A token is stored.'
              : state === 'removed'
                ? 'No token is stored.'
                : 'The host does not report whether a token is already stored; saving replaces any existing one.'}{' '}
            Pushes and other writes still ask for your approval.
          </p>
        </form>
      </Card>
      <Card title="Plugin policy" icon={<IconShield />}>
        <ul className="list-inside list-disc space-y-1.5 text-sm text-muted">
          <li>Plugins are installed only from a .zip you upload; NEBULA never downloads code on its own.</li>
          <li>Archives are validated: manifest schema, safe paths, no symlinks, at most 5 MiB / 200 files, SHA-256 recorded.</li>
          <li>Plugin code runs only inside the Ubuntu VM as the calling agent’s Linux user, never on macOS.</li>
          <li>Plugins that use the network require ADVANCED agents; declared risk categories always ask for approval.</li>
        </ul>
        <Button className="mt-4" onClick={() => navigate('/skills?tab=catalog')} icon={<IconUpload />}>
          Go to the catalog
        </Button>
      </Card>
      <ConfirmDialog
        open={confirmRemove}
        title="Remove the GitHub token?"
        confirmLabel="Remove token"
        onCancel={() => setConfirmRemove(false)}
        onConfirm={async () => {
          const r = await run('ghdel', () => api.skills.removeGithubToken(), { success: 'GitHub token removed', errorTitle: 'Token not removed' });
          if (r) {
            setConfirmRemove(false);
            setState('removed');
          }
        }}
      >
        <p>The token is deleted from the Keychain. The GitHub skill falls back to public, read-only access.</p>
      </ConfirmDialog>
    </div>
  );
}

export function SkillsPage({ query }: { query: URLSearchParams }) {
  const tab = (['catalog', 'permissions', 'usage', 'integrations'].includes(query.get('tab') ?? '') ? query.get('tab') : 'catalog') as Tab;
  const agents = useApi(() => api.agents.list(), []);
  const agentName = (aid: string | null) => (aid ? (agents.data?.find((a) => a.id === aid)?.name ?? shortId(aid)) : '—');
  const prefix = 'skills';
  return (
    <>
      <PageHeader
        title="Skills"
        description="What agents can do: built-in skills map to real tools, plugins add your own. Assign skills per agent on the agent’s Skills tab."
      />
      <TabBar<Tab>
        label="Skills sections"
        idPrefix={prefix}
        active={tab}
        onChange={(t) => navigate(`/skills${t === 'catalog' ? '' : `?tab=${t}`}`, { replace: true })}
        tabs={[
          { id: 'catalog', label: 'Catalog', icon: <IconSkills /> },
          { id: 'permissions', label: 'Permission matrix', icon: <IconShield /> },
          { id: 'usage', label: 'Usage audit' },
          { id: 'integrations', label: 'Integrations', icon: <IconGitHub /> },
        ]}
      />
      <TabPanel id={tab} idPrefix={prefix}>
        {tab === 'catalog' && <Catalog agentName={agentName} />}
        {tab === 'permissions' && <Permissions />}
        {tab === 'usage' && <Usage agentName={agentName} />}
        {tab === 'integrations' && <Integrations />}
      </TabPanel>
    </>
  );
}
