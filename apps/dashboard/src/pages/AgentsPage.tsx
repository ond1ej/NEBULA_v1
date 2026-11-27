import { useId, useMemo, useState } from 'react';
import { api, newIdempotencyKey } from '../api';
import { IconAgents, IconChat, IconMonitor, IconMoon, IconPause, IconPlay, IconPlus, IconSearch, IconSun, IconTrash } from '../components/icons';
import { DropdownMenu } from '../components/Menu';
import { Modal } from '../components/Modal';
import { providerLabel } from '../lib/providers';
import { BUSY_STATES, StatusPill } from '../components/StatusPill';
import { useToast } from '../components/Toast';
import {
  Avatar,
  agentAvatarOf,
  Button,
  ButtonLink,
  Checkbox,
  EmptyState,
  ErrorBanner,
  Input,
  LoadingCards,
  Mono,
  Notice,
  PageHeader,
  SegmentedControl,
} from '../components/ui';
import { useAction, useApi } from '../hooks/useApi';
import { isTaskLifecycleEvent, useLiveRefresh } from '../hooks/useEvents';
import { href, navigate } from '../hooks/useHashRoute';
import { relativeTime, shortId } from '../lib/format';
import type { Agent, Provider } from '../types';

const BUSY = new Set(['CREATING', 'DELETING']);

export function DeleteAgentDialog({ agent, onClose, onDeleted }: { agent: Agent | null; onClose: () => void; onDeleted: () => void }) {
  const toast = useToast();
  const [exportFirst, setExportFirst] = useState(true);
  const [busy, setBusy] = useState(false);
  const [key] = useState(() => newIdempotencyKey());

  const run = async () => {
    if (!agent) return;
    setBusy(true);
    try {
      const r = await api.agents.remove(agent.id, exportFirst, key);
      toast.success(`Agent ${agent.name} deleted`, r.export_path ? `Workspace exported to ${r.export_path}` : 'Its Linux account and files were removed.');
      onDeleted();
    } catch (e) {
      toast.error(e, 'Delete failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={agent !== null}
      title={agent ? `Delete agent “${agent.name}”?` : ''}
      onClose={onClose}
      size="sm"
      dismissible={!busy}
      footer={
        <>
          <Button onClick={onClose} disabled={busy} data-autofocus>
            Cancel
          </Button>
          <Button variant="danger" onClick={run} loading={busy}>
            {busy ? (exportFirst ? 'Exporting & deleting…' : 'Deleting…') : 'Delete agent'}
          </Button>
        </>
      }
    >
      {agent && (
        <div className="space-y-4">
          <p className="leading-relaxed text-muted">
            This stops the agent’s tasks and permanently removes its Linux account <Mono className="text-text">{agent.linux_user ?? '—'}</Mono>, its desktop session and all
            workspace files inside the VM. Telegram topics are archived. <strong className="text-text">This cannot be undone.</strong>
          </p>
          <Checkbox
            label="Export workspace first"
            description="Saves a .tar.gz archive of the workspace folder to the NEBULA exports folder on this Mac before deleting (can take several minutes)."
            checked={exportFirst}
            onChange={setExportFirst}
            disabled={busy}
          />
          {busy && <Notice tone="info">{exportFirst ? 'Exporting the workspace, then deleting the agent…' : 'Deleting the agent…'}</Notice>}
        </div>
      )}
    </Modal>
  );
}

export function AgentCard({
  agent,
  providers,
  onChanged,
  onDelete,
}: {
  agent: Agent;
  providers: Provider[];
  onChanged: () => void;
  onDelete: (a: Agent) => void;
}) {
  const { run, isPending } = useAction();
  const busy = BUSY.has(agent.state);
  const provider = providers.find((p) => p.id === agent.provider_id);
  const act = async (key: string, fn: () => Promise<Agent>, msg: string) => {
    const r = await run(key, fn, { success: msg });
    if (r) onChanged();
  };
  const sleeping = agent.state === 'SLEEP' || agent.state === 'STOPPED';
  const busyReason = busy ? `Agent is ${agent.state}` : null;

  return (
    <article className="group relative flex min-w-0 flex-col rounded-xl border border-border bg-panel shadow-card transition-colors hover:border-border-strong">
      <div className="flex items-start gap-3 p-4 pb-3 sm:p-5 sm:pb-3">
        <Avatar name={agent.name} id={agent.id} size="lg" avatar={agentAvatarOf(agent)} />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <h3 className="min-w-0 truncate text-[15px] font-semibold text-text">
              <a href={href(`/agents/${agent.id}`)} className="rounded focus-ring after:absolute after:inset-0 after:rounded-xl">
                {agent.name}
              </a>
            </h3>
            <StatusPill state={agent.state} pulse={BUSY_STATES.has(agent.state)} />
          </div>
          <p className="mt-0.5 line-clamp-2 min-h-[1.25rem] text-[13px] text-muted">{agent.description || <span className="text-subtle">No description</span>}</p>
        </div>
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 px-4 pb-4 text-[13px] sm:px-5">
        <dt className="text-subtle">Model</dt>
        <dd className="min-w-0 truncate text-text" title={agent.model_id ?? undefined}>
          {agent.model_id ?? <span className="text-subtle">Not set</span>}
          {provider && <span className="text-subtle"> · {providerLabel(provider)}</span>}
        </dd>
        <dt className="text-subtle">Desktop</dt>
        <dd className="min-w-0 truncate">
          <Mono>{agent.linux_user ?? '—'}</Mono> <Mono className="text-subtle">{agent.display_id ?? ''}</Mono>
        </dd>
        <dt className="text-subtle">Activity</dt>
        <dd className="min-w-0">
          {agent.current_task ? (
            <a className="relative z-[1] inline-flex items-center gap-2 rounded focus-ring" href={href(`/agents/${agent.id}/tasks?task=${agent.current_task.id}`)}>
              <StatusPill state={agent.current_task.state} pulse />
              <Mono>{shortId(agent.current_task.id)}</Mono>
            </a>
          ) : (
            <span className="text-muted">Idle · {agent.last_active_at ? `active ${relativeTime(agent.last_active_at)}` : 'never active'}</span>
          )}
        </dd>
      </dl>
      {agent.state === 'ERROR' && agent.last_error && (
        <p className="mx-4 mb-4 rounded-lg border border-danger/25 bg-danger/[0.07] px-3 py-2 text-xs text-danger sm:mx-5">{agent.last_error}</p>
      )}
      <div className="relative z-[1] mt-auto flex flex-wrap items-center gap-1.5 border-t border-border px-3 py-2.5 sm:px-4">
        <ButtonLink size="sm" variant="ghost" href={href(`/agents/${agent.id}/chat`)} icon={<IconChat />}>
          Chat
        </ButtonLink>
        <ButtonLink size="sm" variant="ghost" href={href(`/agents/${agent.id}/live`)} icon={<IconMonitor />}>
          Live
        </ButtonLink>
        {agent.state === 'PAUSED' ? (
          <Button size="sm" variant="ghost" icon={<IconPlay />} onClick={() => act('resume', () => api.agents.resume(agent.id), `${agent.name} resumed`)} loading={isPending('resume')}>
            Resume
          </Button>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            icon={<IconPause />}
            onClick={() => act('pause', () => api.agents.pause(agent.id), `${agent.name} paused`)}
            loading={isPending('pause')}
            disabledReason={busyReason}
          >
            Pause
          </Button>
        )}
        <span className="ml-auto">
          <DropdownMenu
            label={`More actions for ${agent.name}`}
            items={[
              sleeping
                ? { label: 'Wake desktop', icon: <IconSun />, onSelect: () => void act('wake', () => api.agents.wake(agent.id), `${agent.name} is awake`), disabled: busy, disabledReason: busyReason ?? undefined }
                : {
                    label: 'Put to sleep',
                    icon: <IconMoon />,
                    onSelect: () => void act('sleep', () => api.agents.sleep(agent.id), `${agent.name} is sleeping`),
                    disabled: busy || agent.state === 'ACTIVE',
                    disabledReason: busyReason ?? (agent.state === 'ACTIVE' ? 'Pause or stop the running task first' : undefined),
                  },
              { label: 'Open settings', icon: <IconAgents />, onSelect: () => navigate(`/agents/${agent.id}/settings`) },
              { label: 'Delete agent…', icon: <IconTrash />, danger: true, separatorBefore: true, onSelect: () => onDelete(agent), disabled: agent.state === 'DELETING', disabledReason: 'Already deleting' },
            ]}
          />
        </span>
      </div>
    </article>
  );
}

type Filter = 'all' | 'working' | 'sleeping' | 'attention';

export function AgentsPage() {
  const agents = useApi(() => api.agents.list(), []);
  const providers = useApi(() => api.providers.list(), []);
  const [toDelete, setToDelete] = useState<Agent | null>(null);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const searchId = useId();
  useLiveRefresh(agents.reload, (e) => e.type.startsWith('agent.') || isTaskLifecycleEvent(e));
  useLiveRefresh(providers.reload, (e) => e.type.startsWith('provider.'));

  const list = agents.data ?? [];
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return list.filter((a) => {
      if (needle && !`${a.name} ${a.description} ${a.model_id ?? ''}`.toLowerCase().includes(needle)) return false;
      if (filter === 'working') return a.state === 'ACTIVE' || a.current_task !== null;
      if (filter === 'sleeping') return a.state === 'SLEEP' || a.state === 'STOPPED' || a.state === 'IDLE';
      if (filter === 'attention') return a.state === 'ERROR' || a.state === 'PAUSED';
      return true;
    });
  }, [list, q, filter]);

  return (
    <>
      <PageHeader
        title="Agents"
        description="Each agent has its own Linux account, XFCE desktop and browser inside the shared Ubuntu VM."
        actions={
          <Button variant="primary" icon={<IconPlus />} onClick={() => navigate('/agents/new')}>
            Create Agent
          </Button>
        }
      />
      {agents.error ? (
        <div className="mb-4">
          <ErrorBanner error={agents.error} onRetry={agents.reload} />
        </div>
      ) : null}
      {list.length > 0 && (
        <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative w-full sm:max-w-xs">
            <label htmlFor={searchId} className="sr-only">
              Filter agents
            </label>
            <IconSearch className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-subtle" />
            <Input id={searchId} type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by name or model" className="pl-9" />
          </div>
          <SegmentedControl<Filter>
            label="Show agents"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: `All ${list.length}` },
              { value: 'working', label: 'Working' },
              { value: 'sleeping', label: 'Idle & asleep' },
              { value: 'attention', label: 'Needs attention' },
            ]}
          />
        </div>
      )}
      {!agents.data && agents.loading ? (
        <LoadingCards label="Loading agents…" />
      ) : agents.data && agents.data.length === 0 ? (
        <EmptyState
          icon={<IconAgents />}
          title="No agents yet"
          action={
            <Button variant="primary" icon={<IconPlus />} onClick={() => navigate('/agents/new')}>
              Create your first agent
            </Button>
          }
        >
          Creating an agent provisions a real Linux user, desktop and browser in the VM.
        </EmptyState>
      ) : shown.length === 0 && list.length > 0 ? (
        <EmptyState compact title="No agent matches this filter" action={<Button size="sm" onClick={() => { setQ(''); setFilter('all'); }}>Clear filter</Button>} />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {shown.map((a) => (
            <AgentCard key={a.id} agent={a} providers={providers.data ?? []} onChanged={agents.reload} onDelete={setToDelete} />
          ))}
        </div>
      )}
      <DeleteAgentDialog
        key={toDelete?.id ?? 'none'}
        agent={toDelete}
        onClose={() => setToDelete(null)}
        onDeleted={() => {
          setToDelete(null);
          agents.reload();
        }}
      />
    </>
  );
}
