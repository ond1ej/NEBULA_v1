// Host Permissions Manager (#/host): authorised project folders, detected developer tools, sandbox status,
// the honest "no host GUI control" notice and the audit log of every command agents ran natively on the Mac.
import { useId, useMemo, useState } from 'react';
import { api } from '../../api';
import { IconAlert, IconEdit, IconHost, IconLock, IconPlus, IconRefresh, IconShield, IconTerminal, IconTrash } from '../../components/icons';
import { ConfirmDialog, Drawer } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import {
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  ErrorBanner,
  Field,
  IconButton,
  Input,
  LoadingRows,
  Mono,
  Notice,
  PageHeader,
  Select,
  Stat,
  Switch,
  TextLink,
  type Column,
  type Tone,
} from '../../components/ui';
import { useAction, useApi } from '../../hooks/useApi';
import { useLiveRefresh } from '../../hooks/useEvents';
import { href } from '../../hooks/useHashRoute';
import { formatTime, relativeTime } from '../../lib/format';
import { hostApi, type SelfTestResult } from '../environment/api';
import type { HostCommand, HostRoot, HostTool, RootMode } from '../environment/types';
import { FolderPicker, RootOptionsFields } from './FolderPicker';

export const COMMAND_TONE: Record<string, Tone> = { ok: 'success', error: 'danger', denied: 'warn', timeout: 'warn' };

function toolsText(r: HostRoot): string {
  return r.allowed_tools.length ? r.allowed_tools.join(', ') : 'All detected tools';
}

function EditRootDrawer({ root, detected, onClose, onSaved }: { root: HostRoot; detected: Record<string, HostTool> | null; onClose: () => void; onSaved: (r: HostRoot) => void }) {
  const nameId = useId();
  const { run, isPending } = useAction();
  const [name, setName] = useState(root.name);
  const [mode, setMode] = useState<RootMode>(root.mode === 'read_only' ? 'read_only' : 'read_write');
  const [network, setNetwork] = useState(root.allow_network);
  const [tools, setTools] = useState<string[]>(root.allowed_tools);
  const [enabled, setEnabled] = useState(root.enabled);
  const save = async () => {
    const r = await run('save', () => hostApi.patchRoot(root.id, { name: name.trim(), mode, allow_network: network, allowed_tools: tools, enabled }), {
      success: `${name.trim()} updated`,
      errorTitle: 'Folder not updated',
    });
    if (r) onSaved(r);
  };
  return (
    <Drawer
      open
      onClose={onClose}
      dismissible={!isPending('save')}
      title={`Edit ${root.name}`}
      description={<span className="break-all font-mono text-xs">{root.path}</span>}
      footer={
        <>
          <Button onClick={onClose} disabled={isPending('save')}>
            Cancel
          </Button>
          <Button variant="primary" loading={isPending('save')} disabledReason={!name.trim() ? 'Name is required' : null} onClick={save}>
            Save changes
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <Field htmlFor={nameId} label="Display name" required>
          <Input id={nameId} value={name} maxLength={128} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Switch checked={enabled} onChange={setEnabled} label="Enabled" description="Disabled folders stay authorised but no agent can work in them until you enable them again." />
        <RootOptionsFields mode={mode} setMode={setMode} network={network} setNetwork={setNetwork} tools={tools} setTools={setTools} detected={detected} />
      </div>
    </Drawer>
  );
}

function ToolsCard({ tools, loading, error, onRefresh, refreshing }: { tools: Record<string, HostTool> | null; loading: boolean; error: unknown; onRefresh: () => void; refreshing: boolean }) {
  const entries = Object.entries(tools ?? {}).sort(([a, x], [b, y]) => Number(y.available) - Number(x.available) || a.localeCompare(b));
  const found = entries.filter(([, t]) => t.available).length;
  return (
    <Card
      title="Detected developer tools"
      subtitle="Found on this Mac (never installed by NEBULA). Host agents can only run tools that exist here."
      icon={<IconTerminal />}
      actions={
        <>
          {tools && <Badge tone="neutral">{found} of {entries.length} found</Badge>}
          <Button size="sm" icon={<IconRefresh />} loading={refreshing} onClick={onRefresh}>
            Re-detect
          </Button>
        </>
      }
    >
      {error ? (
        <ErrorBanner error={error} onRetry={onRefresh} />
      ) : !tools && loading ? (
        <LoadingRows label="Detecting developer tools…" />
      ) : (
        <ul aria-label="Developer tools" className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {entries.map(([n, t]) => (
            <li key={n} className={`min-w-0 rounded-lg border px-3 py-2.5 ${t.available ? 'border-border bg-panel-2' : 'border-dashed border-border bg-transparent'}`}>
              <div className="flex items-center justify-between gap-2">
                <span className={`font-mono text-[13px] ${t.available ? 'text-text' : 'text-subtle'}`}>{n}</span>
                {t.available ? (
                  <Badge tone="success" dot>
                    found
                  </Badge>
                ) : (
                  <Badge>not installed</Badge>
                )}
              </div>
              {t.available && <p className="mt-1 truncate text-xs text-muted" title={t.version ?? undefined}>{t.version ?? 'version unknown'}</p>}
              {t.path && <p className="truncate font-mono text-2xs text-subtle" title={t.path}>{t.path}</p>}
              {t.note && (
                <p className="mt-1.5 flex gap-1.5 text-2xs leading-4 text-warn">
                  <IconAlert className="mt-px size-3 shrink-0" />
                  <span>{t.note}</span>
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function CommandLog({ roots }: { roots: HostRoot[] }) {
  const ids = { root: useId(), agent: useId() };
  const [rootId, setRootId] = useState('');
  const [agentId, setAgentId] = useState('');
  const [limit, setLimit] = useState(100);
  const agents = useApi(() => api.agents.list(), []);
  const cmds = useApi((s) => hostApi.commands({ root_id: rootId || undefined, agent_id: agentId || undefined, limit }, s), [rootId, agentId, limit]);
  useLiveRefresh(cmds.reload, (ev) => ev.type === 'task.step' || ev.type === 'task.completed' || ev.type === 'task.failed', 1500);
  const agentName = useMemo(() => new Map((agents.data ?? []).map((a) => [a.id, a.name])), [agents.data]);
  const rootName = useMemo(() => new Map(roots.map((r) => [r.id, r.name])), [roots]);
  const rows = cmds.data ?? [];
  const cols: Column<HostCommand>[] = [
    {
      key: 'cmd',
      header: 'Command',
      mobile: 'title',
      cell: (c) => (
        <div className="min-w-0">
          <code className="block font-mono text-[12.5px] break-all text-text">{c.command || '—'}</code>
          {c.detail && <p className="mt-0.5 text-xs break-words text-danger">{c.detail}</p>}
        </div>
      ),
    },
    { key: 'status', header: 'Status', mobile: 'aside', cell: (c) => <Badge tone={COMMAND_TONE[c.status] ?? 'neutral'} dot>{c.status}{c.exit_code !== null && c.exit_code !== 0 ? ` · exit ${c.exit_code}` : ''}</Badge> },
    { key: 'tool', header: 'Tool', cell: (c) => <Mono>{c.tool}</Mono> },
    {
      key: 'agent',
      header: 'Agent',
      cell: (c) => (c.agent_id ? <TextLink href={href(`/agents/${c.agent_id}${c.task_id ? `/tasks?task=${c.task_id}` : ''}`)}>{agentName.get(c.agent_id) ?? c.agent_id.slice(0, 8)}</TextLink> : '—'),
    },
    { key: 'root', header: 'Folder', cell: (c) => (c.root_id ? (rootName.get(c.root_id) ?? <span className="text-subtle">revoked folder</span>) : '—') },
    { key: 'cwd', header: 'Directory', mobile: 'hidden', cell: (c) => <Mono className="break-all">{c.cwd ?? '.'}</Mono> },
    { key: 'dur', header: 'Duration', align: 'right', cell: (c) => <span className="tabular-nums">{c.duration_ms !== null ? `${(c.duration_ms / 1000).toFixed(c.duration_ms < 10_000 ? 2 : 0)} s` : '—'}</span> },
    { key: 'ts', header: 'When', mobile: 'subtitle', cell: (c) => <span title={formatTime(c.ts)}>{relativeTime(c.ts)}</span> },
  ];
  return (
    <Card
      title="Host command log"
      subtitle="Every command, script and file change agents executed natively on the Mac (newest first)."
      icon={<IconShield />}
      actions={
        <IconButton label="Refresh command log" icon={<IconRefresh />} size="sm" variant="secondary" loading={cmds.loading && !!cmds.data} onClick={cmds.reload} />
      }
    >
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:max-w-2xl">
        <Field htmlFor={ids.root} label="Folder">
          <Select id={ids.root} value={rootId} onChange={(e) => setRootId(e.target.value)}>
            <option value="">All folders</option>
            {roots.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field htmlFor={ids.agent} label="Agent">
          <Select id={ids.agent} value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            <option value="">All agents</option>
            {(agents.data ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {cmds.error ? (
        <ErrorBanner error={cmds.error} onRetry={cmds.reload} />
      ) : !cmds.data && cmds.loading ? (
        <LoadingRows label="Loading command log…" />
      ) : rows.length === 0 ? (
        <EmptyState compact icon={<IconTerminal />} title={rootId || agentId ? 'No commands match these filters' : 'No host commands yet'}>
          Commands appear here as soon as an agent works on the Mac.
        </EmptyState>
      ) : (
        <>
          <DataTable label="Host command log" columns={cols} rows={rows} rowKey={(c) => String(c.id)} minWidth={880} dense />
          {rows.length >= limit && limit < 500 && (
            <div className="mt-3 flex justify-center">
              <Button size="sm" onClick={() => setLimit((l) => Math.min(500, l + 200))}>
                Show older commands
              </Button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

export function HostAccess() {
  const toast = useToast();
  const roots = useApi((s) => hostApi.roots(s), []);
  const tools = useApi((s) => hostApi.tools(false, s), []);
  const { run, isPending } = useAction();
  const [picking, setPicking] = useState(false);
  const [editing, setEditing] = useState<HostRoot | null>(null);
  const [revoking, setRevoking] = useState<HostRoot | null>(null);
  const [selftest, setSelftest] = useState<{ root: HostRoot; result: SelfTestResult } | null>(null);
  const runSelftest = async (r: HostRoot) => {
    const res = await run(`st-${r.id}`, () => hostApi.selftest(r.id));
    if (res) setSelftest({ root: r, result: res });
  };
  const [redetecting, setRedetecting] = useState(false);

  const list = roots.data ?? [];
  const detected = tools.data?.tools ?? null;
  const enabledCount = list.filter((r) => r.enabled).length;
  const gui = tools.data?.gui_control;
  const sandbox = tools.data?.sandbox;

  const redetect = async () => {
    setRedetecting(true);
    try {
      const r = await hostApi.tools(true);
      tools.setData(() => r);
    } catch (e) {
      toast.error(e, 'Tool detection failed');
    } finally {
      setRedetecting(false);
    }
  };
  const replace = (r: HostRoot) => roots.setData((xs) => (xs ? xs.map((x) => (x.id === r.id ? { ...x, ...r } : x)) : xs));
  const toggle = async (r: HostRoot, enabled: boolean) => {
    const res = await run(`en-${r.id}`, () => hostApi.patchRoot(r.id, { enabled }), { success: `${r.name} ${enabled ? 'enabled' : 'disabled'}` });
    if (res) replace(res);
  };

  const cols: Column<HostRoot>[] = [
    {
      key: 'folder',
      header: 'Folder',
      mobile: 'title',
      cell: (r) => (
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-text">{r.name}</span>
            {r.exists === false && (
              <Badge tone="danger" icon={<IconAlert />}>
                missing on disk
              </Badge>
            )}
          </div>
          <Mono className="mt-0.5 block break-all">{r.path}</Mono>
        </div>
      ),
    },
    { key: 'mode', header: 'Access', cell: (r) => <Badge tone={r.mode === 'read_only' ? 'warn' : 'neutral'}>{r.mode === 'read_only' ? 'read-only' : 'read-write'}</Badge> },
    { key: 'net', header: 'Network', cell: (r) => <Badge tone={r.allow_network ? 'info' : 'neutral'}>{r.allow_network ? 'on' : 'off'}</Badge> },
    { key: 'tools', header: 'Allowed tools', cell: (r) => <span className={`text-xs ${r.allowed_tools.length ? 'font-mono text-text' : 'text-muted'}`}>{toolsText(r)}</span> },
    {
      key: 'enabled',
      header: 'Enabled',
      mobile: 'aside',
      cell: (r) => <Switch hideLabel checked={r.enabled} loading={isPending(`en-${r.id}`)} onChange={(v) => void toggle(r, v)} label={`${r.enabled ? 'Disable' : 'Enable'} ${r.name}`} />,
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (r) => (
        <div className="flex justify-end gap-1">
          <IconButton size="sm" label={`Run sandbox self-test for ${r.name}`} icon={<IconShield />} loading={isPending(`st-${r.id}`)} onClick={() => void runSelftest(r)} />
          <IconButton size="sm" label={`Edit ${r.name}`} icon={<IconEdit />} onClick={() => setEditing(r)} />
          <IconButton size="sm" label={`Revoke access to ${r.name}`} icon={<IconTrash />} className="hover:text-danger" onClick={() => setRevoking(r)} />
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        icon={
          <span aria-hidden className="grid size-10 place-items-center rounded-xl border border-accent/35 bg-accent/15 text-accent-soft">
            <IconHost className="size-5" />
          </span>
        }
        title="Host Access"
        description="Project folders on this Mac that host agents may work in, the developer tools they can use, and every command they ran. Everything else on your Mac stays out of reach."
        actions={
          <Button variant="primary" icon={<IconPlus />} onClick={() => setPicking(true)}>
            Authorise folder
          </Button>
        }
      />

      <div className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-3">
          <Stat
            label="macOS sandbox"
            icon={<IconLock />}
            tone={sandbox === undefined ? 'neutral' : sandbox ? 'success' : 'danger'}
            value={sandbox === undefined ? '…' : sandbox ? 'Active' : 'Unavailable'}
            hint={sandbox === false ? 'Host execution is blocked' : 'Every command is confined to its folder'}
          />
          <Stat label="Authorised folders" icon={<IconHost />} value={roots.data ? `${enabledCount} / ${list.length}` : '…'} hint="enabled / total" />
          <Stat
            label="Developer tools"
            icon={<IconTerminal />}
            value={detected ? Object.values(detected).filter((t) => t.available).length : '…'}
            hint="detected on this Mac"
          />
        </div>

        {sandbox === false && (
          <Notice tone="danger" title="macOS sandbox is unavailable">
            NEBULA only runs host commands inside <code>/usr/bin/sandbox-exec</code>. Until it is available, host agents cannot work.
          </Notice>
        )}
        <Notice tone="warn" title="Host GUI control is not available">
          {gui?.detail ??
            'Host agents work through files, terminal, git and developer tools only. Mouse, keyboard and screen control of macOS is not part of NEBULA; graphical work runs on the Ubuntu VM desktop.'}
          {gui && (
            <span className="mt-1.5 block text-xs text-subtle">
              Accessibility: {gui.accessibility.replace(/_/g, ' ')} · Screen Recording: {gui.screen_recording.replace(/_/g, ' ')}
            </span>
          )}
        </Notice>

        <Card
          title="Authorised project folders"
          subtitle="Revoking access never deletes the folder or its files."
          icon={<IconLock />}
          padded={false}
          bodyClassName="p-3 sm:p-4"
          actions={
            <Button size="sm" icon={<IconPlus />} onClick={() => setPicking(true)}>
              Add folder
            </Button>
          }
        >
          {roots.error ? (
            <ErrorBanner error={roots.error} onRetry={roots.reload} />
          ) : !roots.data && roots.loading ? (
            <LoadingRows label="Loading authorised folders…" />
          ) : list.length === 0 ? (
            <EmptyState
              compact
              icon={<IconHost />}
              title="No folders authorised yet"
              action={
                <Button variant="primary" icon={<IconPlus />} onClick={() => setPicking(true)}>
                  Choose a folder
                </Button>
              }
            >
              Authorise a project folder to let agents (or company projects) work natively on the Mac with your toolchains.
            </EmptyState>
          ) : (
            <DataTable label="Authorised project folders" columns={cols} rows={list} rowKey={(r) => r.id} minWidth={760} className="!shadow-none" />
          )}
        </Card>

        <ToolsCard tools={detected} loading={tools.loading} error={tools.error} onRefresh={redetect} refreshing={redetecting} />

        <CommandLog roots={list} />
      </div>

      <FolderPicker
        open={picking}
        existing={list}
        detected={detected}
        onClose={() => setPicking(false)}
        onAdded={(r) => {
          setPicking(false);
          roots.setData((xs) => [...(xs ?? []), { ...r, exists: true }]);
          roots.reload();
        }}
      />
      {editing && (
        <EditRootDrawer
          root={editing}
          detected={detected}
          onClose={() => setEditing(null)}
          onSaved={(r) => {
            setEditing(null);
            replace(r);
          }}
        />
      )}
      <Drawer open={!!selftest} onClose={() => setSelftest(null)} title={selftest ? `Sandbox self-test · ${selftest.root.name}` : ''}>
        {selftest && (
          <div className="space-y-3">
            <Badge tone={selftest.result.passed ? 'success' : 'danger'}>{selftest.result.passed ? 'All probes passed' : 'Some probes failed'}</Badge>
            <ul className="space-y-1.5">
              {selftest.result.probes.map((p) => (
                <li key={p.probe} className="flex items-start justify-between gap-3 rounded-lg border border-border/60 px-3 py-2 text-sm">
                  <span className="min-w-0">
                    <span className="font-medium text-text">{p.probe.replace(/_/g, ' ')}</span>
                    {p.output ? <Mono className="mt-0.5 block truncate text-xs text-muted">{p.output}</Mono> : null}
                  </span>
                  <Badge tone={p.passed ? 'success' : 'danger'}>{p.passed ? 'pass' : 'fail'}</Badge>
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted">"deny …" probes pass when the sandbox blocks the access.</p>
          </div>
        )}
      </Drawer>
      <ConfirmDialog
        open={revoking !== null}
        title={revoking ? `Revoke access to ${revoking.name}?` : ''}
        confirmLabel="Revoke access"
        busyText="Revoking…"
        onCancel={() => setRevoking(null)}
        onConfirm={async () => {
          if (!revoking) return;
          const r = await run('revoke', () => hostApi.revokeRoot(revoking.id), { errorTitle: 'Access not revoked' });
          if (r) {
            toast.success(
              `Access to ${revoking.name} revoked`,
              r.projects_unlinked.length ? `Projects unlinked: ${r.projects_unlinked.join(', ')}. The folder was not touched.` : 'The folder and its files were not touched.',
            );
            roots.setData((xs) => (xs ? xs.filter((x) => x.id !== revoking.id) : xs));
            setRevoking(null);
          }
        }}
      >
        {revoking && (
          <>
            <p>
              Agents lose access to <strong className="break-all">{revoking.path}</strong> immediately.
            </p>
            <p>
              <strong>The folder and its files are never deleted.</strong> Company projects that use this folder are unlinked, and agents whose own setting points at it stop working on the host until you
              pick another folder.
            </p>
          </>
        )}
      </ConfirmDialog>
    </>
  );
}
