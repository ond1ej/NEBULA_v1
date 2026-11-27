// Agent long-term memory: search, filter, create / edit / pin / share / delete, bulk clear, stats and settings.
import { useId, useState, type MouseEvent, type ReactNode } from 'react';
import { api } from '../api';
import { useAction, useApi } from '../hooks/useApi';
import { useDebounced } from '../hooks/useDebounced';
import { useLiveRefresh } from '../hooks/useEvents';
import { formatBytes, formatTime, relativeTime } from '../lib/format';
import { MEMORY_KINDS, type Agent, type MemoryBody, type MemoryEntry, type MemoryKind, type MemoryPatch, type Team } from '../types';
import { IconEdit, IconMemory, IconPin, IconPlus, IconSearch, IconShare, IconTrash } from './icons';
import { DropdownMenu, useContextMenu, type MenuItem } from './Menu';
import { ConfirmDialog, Drawer, Modal } from './Modal';
import { useToast } from './Toast';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  EmptyState,
  ErrorBanner,
  Field,
  IconButton,
  Input,
  LoadingCards,
  Notice,
  SegmentedControl,
  Select,
  Skeleton,
  Switch,
  Textarea,
  type Tone,
} from './ui';

export const KIND_LABEL: Record<string, string> = {
  fact: 'Fact',
  note: 'Note',
  decision: 'Decision',
  preference: 'Preference',
  episode: 'Episode',
  project: 'Project',
};

export const KIND_HINT: Record<string, string> = {
  fact: 'Durable knowledge about the world or the owner’s setup.',
  note: 'A working note the agent can look up later.',
  decision: 'Something that was decided and should stay consistent.',
  preference: 'How the owner wants things done (owner-only; always used first).',
  episode: 'What happened in a finished task (written automatically when auto-save is on).',
  project: 'Knowledge about one project or team.',
};

const TRUST: Record<string, { label: string; tone: Tone; title: string }> = {
  owner: { label: 'Owner', tone: 'success', title: 'Written or edited by you' },
  agent: { label: 'Agent', tone: 'neutral', title: 'Written by the agent' },
  system: { label: 'System', tone: 'info', title: 'Written by NEBULA (task episodes, team results)' },
  web: { label: 'Quarantined', tone: 'warn', title: 'Looked like instructions from untrusted content: searchable, never injected into prompts automatically' },
};

export const MAX_VALUE = 4000;

/** Only the fields that changed (PATCH body). */
export function memoryPatch(entry: MemoryEntry, draft: MemoryBody): MemoryPatch {
  const p: MemoryPatch = {};
  if (draft.key !== entry.key) p.key = draft.key;
  if (draft.value !== entry.value) p.value = draft.value;
  if (draft.kind !== entry.kind) p.kind = draft.kind;
  if (draft.tags !== (entry.tags ?? '')) p.tags = draft.tags;
  if (draft.importance !== entry.importance) p.importance = draft.importance;
  if (draft.pinned !== Boolean(entry.pinned)) p.pinned = draft.pinned;
  if ((draft.project || null) !== (entry.project || null)) p.project = draft.project || null;
  if (draft.scope !== entry.scope) p.scope = draft.scope;
  const before = [...(entry.shared_with ?? [])].sort().join(',');
  const after = [...draft.shared_with].sort().join(',');
  if (before !== after) p.shared_with = draft.shared_with;
  return p;
}

function Importance({ value }: { value: number }) {
  return (
    <span className="inline-flex items-center gap-0.5" role="img" aria-label={`Importance ${value} of 5`} title={`Importance ${value} of 5`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <span key={i} aria-hidden className={`h-2.5 w-1 rounded-full ${i <= value ? 'bg-accent-soft' : 'bg-panel-3'}`} />
      ))}
    </span>
  );
}

function ShareTargets({
  value,
  onChange,
  agents,
  teams,
  selfId,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  agents: Agent[];
  teams: Team[];
  selfId: string;
}) {
  const toggle = (id: string, on: boolean) => onChange(on ? [...new Set([...value, id])] : value.filter((x) => x !== id));
  const all = value.includes('*');
  return (
    <fieldset className="space-y-3">
      <legend className="mb-1 text-[13px] font-medium text-text">Share with</legend>
      <Checkbox label="Every agent" description="Visible to all current and future agents." checked={all} onChange={(v) => toggle('*', v)} />
      {!all && (
        <>
          {teams.length > 0 && (
            <div>
              <p className="mb-1.5 text-2xs font-semibold tracking-wider text-subtle uppercase">Teams</p>
              <div className="grid gap-2 sm:grid-cols-2">
                {teams.map((t) => (
                  <Checkbox key={t.id} label={t.name} description={`${t.members.length} member(s)`} checked={value.includes(`team:${t.id}`)} onChange={(v) => toggle(`team:${t.id}`, v)} />
                ))}
              </div>
            </div>
          )}
          <div>
            <p className="mb-1.5 text-2xs font-semibold tracking-wider text-subtle uppercase">Agents</p>
            {agents.filter((a) => a.id !== selfId).length === 0 ? (
              <p className="text-xs text-muted">No other agents.</p>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                {agents
                  .filter((a) => a.id !== selfId)
                  .map((a) => (
                    <Checkbox key={a.id} label={a.name} checked={value.includes(a.id)} onChange={(v) => toggle(a.id, v)} />
                  ))}
              </div>
            )}
          </div>
        </>
      )}
    </fieldset>
  );
}

function shareLabel(ids: string[] | undefined, agents: Agent[], teams: Team[]): string {
  if (!ids || ids.length === 0) return 'nobody yet';
  if (ids.includes('*')) return 'every agent';
  return ids
    .map((i) => (i.startsWith('team:') ? `team ${teams.find((t) => `team:${t.id}` === i)?.name ?? i.slice(5, 13)}` : (agents.find((a) => a.id === i)?.name ?? i.slice(0, 8))))
    .join(', ');
}

const EMPTY: MemoryBody = { key: '', value: '', kind: 'fact', tags: '', importance: 3, pinned: false, project: null, scope: 'private', shared_with: [] };

function MemoryEditor({
  open,
  entry,
  agent,
  agents,
  teams,
  onClose,
  onSaved,
}: {
  open: boolean;
  entry: MemoryEntry | null;
  agent: Agent;
  agents: Agent[];
  teams: Team[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const ids = { key: useId(), value: useId(), kind: useId(), tags: useId(), project: useId() };
  const { run, isPending } = useAction();
  const [d, setD] = useState<MemoryBody>(() =>
    entry
      ? {
          key: entry.key,
          value: entry.value,
          kind: (MEMORY_KINDS as readonly string[]).includes(entry.kind) ? (entry.kind as MemoryKind) : 'fact',
          tags: entry.tags ?? '',
          importance: entry.importance ?? 3,
          pinned: Boolean(entry.pinned),
          project: entry.project ?? null,
          scope: entry.scope === 'shared' ? 'shared' : 'private',
          shared_with: entry.shared_with ?? [],
        }
      : EMPTY,
  );
  const set = <K extends keyof MemoryBody>(k: K, v: MemoryBody[K]) => setD((x) => ({ ...x, [k]: v }));
  const patch = entry ? memoryPatch(entry, d) : null;
  const invalid = !d.key.trim() ? 'A key is required' : !d.value.trim() ? 'A value is required' : d.scope === 'shared' && d.shared_with.length === 0 ? 'Choose who to share with' : null;
  const unchanged = entry && patch && Object.keys(patch).length === 0 ? 'No changes' : null;

  const save = async () => {
    const body = { ...d, key: d.key.trim(), value: d.value.trim(), tags: d.tags.trim(), project: d.project?.trim() || null };
    const r = entry
      ? await run('save', () => api.memory.update(agent.id, entry.id, memoryPatch(entry, body)), { success: 'Memory entry saved', errorTitle: 'Not saved' })
      : await run('save', () => api.memory.create(agent.id, body), { success: 'Memory entry stored', errorTitle: 'Not stored' });
    if (r) onSaved();
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      dismissible={!isPending('save')}
      title={entry ? 'Edit memory entry' : `New memory for ${agent.name}`}
      description="Never store passwords, tokens or card numbers here — NEBULA refuses them; secrets belong in the Keychain."
      footer={
        <>
          <Button onClick={onClose} disabled={isPending('save')}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} loading={isPending('save')} disabledReason={invalid ?? unchanged}>
            {entry ? 'Save changes' : 'Store entry'}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {entry?.trust === 'web' && (
          <Notice tone="warn" title="Quarantined entry">
            Saving marks this entry as owner-trusted, so it may then be added to the agent’s context automatically. Check the text first.
          </Notice>
        )}
        <Field htmlFor={ids.key} label="Key" required hint="A short, searchable title.">
          <Input id={ids.key} value={d.key} maxLength={200} onChange={(e) => set('key', e.target.value)} data-autofocus />
        </Field>
        <Field htmlFor={ids.value} label="Content" required aside={`${d.value.length}/${MAX_VALUE}`}>
          <Textarea id={ids.value} rows={6} value={d.value} maxLength={MAX_VALUE} onChange={(e) => set('value', e.target.value)} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field htmlFor={ids.kind} label="Kind" hint={KIND_HINT[d.kind]}>
            <Select id={ids.kind} value={d.kind} onChange={(e) => set('kind', e.target.value as MemoryKind)}>
              {MEMORY_KINDS.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </Select>
          </Field>
          <div className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium text-text" id={`${ids.kind}-imp`}>
              Importance
            </span>
            <SegmentedControl
              label="Importance"
              value={String(d.importance)}
              onChange={(v) => set('importance', Number(v))}
              options={['1', '2', '3', '4', '5'].map((v) => ({ value: v, label: v }))}
            />
            <p className="text-xs text-muted">Important and pinned entries are recalled first and pruned last.</p>
          </div>
          <Field htmlFor={ids.tags} label="Tags" hint="Comma separated, optional.">
            <Input id={ids.tags} value={d.tags} maxLength={400} onChange={(e) => set('tags', e.target.value)} placeholder="invoices, finance" />
          </Field>
          <Field htmlFor={ids.project} label="Project" hint="Optional: recalled for tasks of this project / team.">
            <Input id={ids.project} value={d.project ?? ''} maxLength={128} onChange={(e) => set('project', e.target.value || null)} />
          </Field>
        </div>
        <Switch checked={d.pinned} onChange={(v) => set('pinned', v)} label="Pinned" description="Pinned entries are never pruned automatically." />
        <div className="space-y-3 rounded-xl border border-border p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[13px] font-medium text-text">Visibility</span>
            <SegmentedControl
              label="Visibility"
              size="sm"
              value={d.scope}
              onChange={(v) => set('scope', v)}
              options={[
                { value: 'private', label: 'Private' },
                { value: 'shared', label: 'Shared' },
              ]}
            />
          </div>
          {d.scope === 'shared' ? (
            <ShareTargets value={d.shared_with} onChange={(v) => set('shared_with', v)} agents={agents} teams={teams} selfId={agent.id} />
          ) : (
            <p className="text-xs text-muted">Only {agent.name} can recall this entry.</p>
          )}
        </div>
      </div>
    </Drawer>
  );
}

function ShareDialog({
  entry,
  agent,
  agents,
  teams,
  onClose,
  onSaved,
}: {
  entry: MemoryEntry;
  agent: Agent;
  agents: Agent[];
  teams: Team[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { run, isPending } = useAction();
  const [scope, setScope] = useState<'private' | 'shared'>(entry.scope === 'shared' ? 'shared' : 'private');
  const [targets, setTargets] = useState<string[]>(entry.shared_with ?? []);
  const save = async () => {
    const r = await run('share', () => api.memory.update(agent.id, entry.id, { scope, shared_with: scope === 'shared' ? targets : [] }), {
      success: scope === 'shared' ? 'Sharing updated' : 'Entry is private again',
      errorTitle: 'Sharing not changed',
    });
    if (r) onSaved();
  };
  return (
    <Modal
      open
      title="Share memory entry"
      description={entry.key}
      onClose={onClose}
      dismissible={!isPending('share')}
      footer={
        <>
          <Button onClick={onClose} disabled={isPending('share')}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} loading={isPending('share')} disabledReason={scope === 'shared' && targets.length === 0 ? 'Choose who to share with' : null}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <SegmentedControl
          label="Visibility"
          value={scope}
          onChange={setScope}
          options={[
            { value: 'private', label: `Private to ${agent.name}` },
            { value: 'shared', label: 'Shared' },
          ]}
        />
        {scope === 'shared' && <ShareTargets value={targets} onChange={setTargets} agents={agents} teams={teams} selfId={agent.id} />}
        {entry.trust === 'web' && <Notice tone="warn">This entry is quarantined. Changing it marks it as owner-trusted.</Notice>}
      </div>
    </Modal>
  );
}

function MemoryCard({
  m,
  own,
  sourceAgent,
  sharedWith,
  menu,
  onContext,
  onPin,
  onEdit,
  pinning,
}: {
  m: MemoryEntry;
  own: boolean;
  sourceAgent?: string;
  sharedWith: string;
  menu: MenuItem[];
  onContext: (e: MouseEvent) => void;
  onPin: () => void;
  onEdit: () => void;
  pinning: boolean;
}) {
  const [open, setOpen] = useState(false);
  const trust = TRUST[m.trust] ?? { label: m.trust, tone: 'neutral' as Tone, title: '' };
  const long = m.value.length > 280 || m.value.split('\n').length > 5;
  const tags = (m.tags ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  return (
    <article onContextMenu={own ? onContext : undefined} className={`flex min-w-0 flex-col rounded-xl border bg-panel shadow-card ${m.pinned ? 'border-accent/30' : 'border-border'}`}>
      <div className="flex items-start gap-3 px-4 pt-3.5">
        <div className="min-w-0 flex-1">
          <h3 className="flex min-w-0 items-center gap-1.5 text-sm font-medium text-text">
            {m.pinned && <IconPin className="size-3.5 shrink-0 text-accent-soft" aria-label="Pinned" />}
            <span className="min-w-0 break-words">{m.key}</span>
          </h3>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Badge tone="accent">{KIND_LABEL[m.kind] ?? m.kind}</Badge>
            <Badge tone={trust.tone} title={trust.title}>
              {trust.label}
            </Badge>
            {m.scope === 'shared' && (
              <Badge tone="info" icon={<IconShare />} title={`Shared with ${sharedWith}`}>
                Shared
              </Badge>
            )}
            {m.project && <Badge>{m.project}</Badge>}
            <Importance value={m.importance ?? 3} />
          </div>
        </div>
        {own && (
          <div className="-mr-1.5 flex shrink-0 items-center">
            <IconButton
              size="sm"
              label={m.pinned ? 'Unpin entry' : 'Pin entry'}
              icon={<IconPin className={`size-4 ${m.pinned ? 'text-accent-soft' : ''}`} />}
              onClick={onPin}
              loading={pinning}
              aria-pressed={Boolean(m.pinned)}
            />
            <IconButton size="sm" label="Edit entry" icon={<IconEdit className="size-4" />} onClick={onEdit} />
            <DropdownMenu label={`More actions for ${m.key}`} items={menu} />
          </div>
        )}
      </div>
      <div className="px-4 pt-2.5 pb-3">
        <p className={`text-[13px] leading-relaxed break-words whitespace-pre-wrap text-muted ${long && !open ? 'line-clamp-5' : ''}`}>{m.value}</p>
        {long && (
          <button type="button" onClick={() => setOpen((o) => !o)} className="mt-1 rounded text-xs text-accent-soft hover:underline focus-ring">
            {open ? 'Show less' : 'Show more'}
          </button>
        )}
        {tags.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {tags.map((t) => (
              <span key={t} className="rounded-md bg-white/[0.04] px-1.5 py-0.5 font-mono text-2xs text-muted">
                #{t}
              </span>
            ))}
          </div>
        )}
      </div>
      <p className="mt-auto flex flex-wrap gap-x-2 gap-y-0.5 border-t border-border px-4 py-2 text-2xs text-subtle">
        {sourceAgent && <span className="text-info">from {sourceAgent}</span>}
        <span>{m.source}</span>
        <span aria-hidden>·</span>
        <span title={formatTime(m.updated_at)}>updated {relativeTime(m.updated_at)}</span>
        <span aria-hidden>·</span>
        <span>
          used {m.use_count ?? 0}×{m.score !== undefined && m.score !== 0 ? ` · score ${Number(m.score).toFixed(2)}` : ''}
        </span>
      </p>
    </article>
  );
}

function StatTile({ label, value, tone }: { label: string; value: ReactNode; tone?: 'warn' }) {
  return (
    <div className="min-w-0 rounded-xl border border-border bg-panel px-3.5 py-3">
      <p className="truncate text-2xs font-medium text-subtle">{label}</p>
      <p className={`mt-1 text-lg font-semibold tabular-nums ${tone === 'warn' ? 'text-warn' : 'text-text'}`}>{value}</p>
    </div>
  );
}

export function MemoryManager({ agent, onAgentChanged }: { agent: Agent; onAgentChanged?: () => void }) {
  const toast = useToast();
  const searchId = useId();
  const kindId = useId();
  const [draft, setDraft] = useState('');
  const q = useDebounced(draft.trim(), 350);
  const [kind, setKind] = useState('');
  const [includeShared, setIncludeShared] = useState(false);
  const entries = useApi(() => api.memory.list(agent.id, { q: q || undefined, kind: kind || undefined, shared: includeShared && Boolean(q), limit: 200 }), [agent.id, q, kind, includeShared]);
  const stats = useApi(() => api.memory.stats(agent.id), [agent.id]);
  const semantic = useApi(() => api.memory.semantic(), []);
  const agentsQ = useApi(() => api.agents.list(), []);
  const teamsQ = useApi(() => api.teams.list(), []);
  const { run, isPending } = useAction();
  const [editor, setEditor] = useState<{ entry: MemoryEntry | null } | null>(null);
  const [share, setShare] = useState<MemoryEntry | null>(null);
  const [toDelete, setToDelete] = useState<MemoryEntry | null>(null);
  const [confirmTrust, setConfirmTrust] = useState<MemoryEntry | null>(null);
  const [clearOpen, setClearOpen] = useState(false);
  const [clearKind, setClearKind] = useState('');
  const ctx = useContextMenu('Memory entry actions');

  const reloadAll = () => {
    entries.reload();
    stats.reload();
  };
  useLiveRefresh(reloadAll, (ev) => ev.type === 'memory.changed' && ev.agent_id === agent.id, 600);

  const agents = agentsQ.data ?? [];
  const teams = teamsQ.data ?? [];
  const st = stats.data;
  const list = entries.data ?? [];
  const autoSave = st ? st.auto_save : agent.config?.memory_auto_save !== false;

  const pin = async (m: MemoryEntry, force = false) => {
    if (m.trust === 'web' && !force) {
      setConfirmTrust(m);
      return;
    }
    const r = await run(`pin-${m.id}`, () => api.memory.update(agent.id, m.id, { pinned: !m.pinned }), { success: m.pinned ? 'Unpinned' : 'Pinned', errorTitle: 'Pin not changed' });
    if (r) reloadAll();
  };

  const itemsFor = (m: MemoryEntry): MenuItem[] => [
    { label: m.pinned ? 'Unpin' : 'Pin', icon: <IconPin />, onSelect: () => void pin(m) },
    { label: 'Edit…', icon: <IconEdit />, onSelect: () => setEditor({ entry: m }) },
    { label: 'Share…', icon: <IconShare />, onSelect: () => setShare(m) },
    { label: 'Delete…', icon: <IconTrash />, danger: true, separatorBefore: true, onSelect: () => setToDelete(m) },
  ];

  const setAutoSave = async (v: boolean) => {
    const r = await run('autosave', () => api.agentConfig.patch(agent.id, { memory_auto_save: v }), {
      success: v ? 'Automatic memory is on' : 'Automatic memory is off',
      errorTitle: 'Setting not saved',
    });
    if (r) {
      stats.reload();
      onAgentChanged?.();
    }
  };

  const setSemantic = async (v: boolean) => {
    const model = semantic.data?.configured?.model || semantic.data?.model || 'nomic-embed-text';
    const r = await run('semantic', () => api.memory.setSemantic(v, model), {
      success: v ? `Semantic search on (${model})` : 'Semantic search off — full-text search stays active',
      errorTitle: 'Semantic search not changed',
    });
    if (r) semantic.reload();
  };

  const kinds = Object.entries(st?.by_kind ?? {}).sort((a, b) => b[1] - a[1]);

  return (
    <div className="space-y-5">
      {/* stats */}
      {stats.error && !st ? (
        <ErrorBanner error={stats.error} onRetry={stats.reload} title="Memory statistics unavailable" />
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {!st ? (
            Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-[66px] rounded-xl" />)
          ) : (
            <>
              <StatTile label="Entries" value={<>{st.total}<span className="text-xs font-normal text-subtle"> / {st.cap}</span></>} />
              <StatTile label="Pinned" value={st.pinned} />
              <StatTile label="Shared" value={st.shared} />
              <StatTile label="Quarantined" value={st.quarantined} tone={st.quarantined ? 'warn' : undefined} />
              <StatTile label="Stored text" value={formatBytes(st.bytes)} />
            </>
          )}
        </div>
      )}

      {/* settings */}
      <Card title="Memory settings" icon={<IconMemory />}>
        <div className="grid gap-5 md:grid-cols-2">
          <Switch
            checked={autoSave}
            onChange={setAutoSave}
            loading={isPending('autosave')}
            disabled={!st}
            label={`Automatic memory for ${agent.name}`}
            description="Stores one episode per finished task and the owner preferences you state in chat (“remember that…”). Turning it off stops new automatic entries; existing ones stay."
          />
          <div>
            {semantic.error && !semantic.data ? (
              <ErrorBanner error={semantic.error} onRetry={semantic.reload} title="Semantic search status unavailable" />
            ) : (
              <Switch
                checked={semantic.data?.enabled ?? false}
                onChange={setSemantic}
                loading={isPending('semantic') || semantic.loading}
                disabled={!semantic.data}
                label="Semantic search (all agents)"
                description={
                  semantic.data ? (
                    <>
                      {semantic.data.enabled ? `Using local Ollama embeddings (${semantic.data.model}). ` : `Off — ranking uses ${semantic.data.fallback}. `}
                      {semantic.data.model_installed === false && !semantic.data.enabled && (
                        <span className="text-warn">The embedding model is not installed in Ollama (ollama pull {semantic.data.configured?.model || 'nomic-embed-text'}). </span>
                      )}
                      Embeddings never leave this Mac.
                    </>
                  ) : (
                    'Loading status…'
                  )
                }
              />
            )}
          </div>
        </div>
      </Card>

      {/* toolbar */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
        <div className="relative min-w-0 flex-1">
          <label htmlFor={searchId} className="mb-1.5 block text-[13px] font-medium text-text">
            Search memory
          </label>
          <IconSearch className="pointer-events-none absolute bottom-2.5 left-3 size-4 text-subtle touch:bottom-3.5" />
          <Input id={searchId} type="search" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Words of 3+ letters (full-text, ranked)" className="pl-9" />
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-40">
            <label htmlFor={kindId} className="mb-1.5 block text-[13px] font-medium text-text">
              Kind
            </label>
            <Select id={kindId} value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="">All kinds</option>
              {MEMORY_KINDS.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                  {st?.by_kind?.[k] ? ` (${st.by_kind[k]})` : ''}
                </option>
              ))}
            </Select>
          </div>
          <Button variant="primary" icon={<IconPlus />} onClick={() => setEditor({ entry: null })}>
            New entry
          </Button>
          <DropdownMenu
            label="Bulk actions"
            size="md"
            variant="secondary"
            items={[{ label: 'Clear entries…', icon: <IconTrash />, danger: true, onSelect: () => setClearOpen(true), disabled: !st || st.total === 0, disabledReason: 'Nothing to clear' }]}
          />
        </div>
      </div>
      <div className="-mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
        <Checkbox
          label="Include entries shared with this agent"
          description={q ? undefined : 'Applies to search results.'}
          checked={includeShared}
          onChange={setIncludeShared}
        />
        {kinds.length > 0 && (
          <div className="flex flex-wrap gap-1.5" aria-label="Entries by kind">
            {kinds.map(([k, n]) => (
              <button
                key={k}
                type="button"
                onClick={() => setKind(kind === k ? '' : k)}
                aria-pressed={kind === k}
                className={`inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs transition-colors focus-ring touch:h-9 ${
                  kind === k ? 'border-accent/50 bg-accent/15 text-text' : 'border-border text-muted hover:text-text'
                }`}
              >
                {KIND_LABEL[k] ?? k} <span className="text-subtle tabular-nums">{n}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* list */}
      {entries.error ? <ErrorBanner error={entries.error} onRetry={entries.reload} /> : null}
      {!entries.data && entries.loading ? (
        <LoadingCards count={4} className="grid gap-3 lg:grid-cols-2" label="Loading memory…" />
      ) : list.length === 0 ? (
        <EmptyState
          icon={<IconMemory />}
          title={q || kind ? 'No matching entries' : 'No memory yet'}
          action={
            !q && !kind ? (
              <Button variant="primary" icon={<IconPlus />} onClick={() => setEditor({ entry: null })}>
                Add the first entry
              </Button>
            ) : (
              <Button
                onClick={() => {
                  setDraft('');
                  setKind('');
                }}
              >
                Clear search
              </Button>
            )
          }
        >
          {q || kind ? 'Try other words or another kind.' : `${agent.name} stores knowledge here while it works; you can add facts and preferences yourself.`}
        </EmptyState>
      ) : (
        <>
          <p className="text-xs text-muted" aria-live="polite">
            {list.length} {list.length === 1 ? 'entry' : 'entries'}
            {q ? ` for “${q}”` : ''}
            {list.length >= 200 ? ' (first 200)' : ''}
          </p>
          <div className="grid gap-3 lg:grid-cols-2">
            {list.map((m) => {
              const own = m.agent_id === agent.id;
              return (
                <MemoryCard
                  key={m.id}
                  m={m}
                  own={own}
                  sourceAgent={own ? undefined : (agents.find((a) => a.id === m.agent_id)?.name ?? 'another agent')}
                  sharedWith={shareLabel(m.shared_with, agents, teams)}
                  menu={itemsFor(m)}
                  onContext={(e) => ctx.open(e, itemsFor(m))}
                  onPin={() => void pin(m)}
                  onEdit={() => setEditor({ entry: m })}
                  pinning={isPending(`pin-${m.id}`)}
                />
              );
            })}
          </div>
        </>
      )}
      {ctx.element}

      {editor && (
        <MemoryEditor
          key={editor.entry?.id ?? 'new'}
          open
          entry={editor.entry}
          agent={agent}
          agents={agents}
          teams={teams}
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null);
            reloadAll();
          }}
        />
      )}
      {share && (
        <ShareDialog
          entry={share}
          agent={agent}
          agents={agents}
          teams={teams}
          onClose={() => setShare(null)}
          onSaved={() => {
            setShare(null);
            reloadAll();
          }}
        />
      )}
      <ConfirmDialog
        open={toDelete !== null}
        title="Delete this memory entry?"
        confirmLabel="Delete entry"
        onCancel={() => setToDelete(null)}
        onConfirm={async () => {
          if (!toDelete) return;
          const r = await run('del', () => api.memory.remove(agent.id, toDelete.id), {
            success: (res) => (res.deleted ? 'Memory entry deleted' : 'Entry was already gone'),
          });
          if (r) {
            setToDelete(null);
            reloadAll();
          }
        }}
      >
        <p>
          <strong className="break-words">{toDelete?.key}</strong> is removed permanently from {agent.name}’s memory. This cannot be undone.
        </p>
      </ConfirmDialog>
      <ConfirmDialog
        open={confirmTrust !== null}
        title="Pin a quarantined entry?"
        confirmLabel={confirmTrust?.pinned ? 'Unpin' : 'Pin and trust'}
        destructive={false}
        onCancel={() => setConfirmTrust(null)}
        onConfirm={async () => {
          if (!confirmTrust) return;
          const m = confirmTrust;
          setConfirmTrust(null);
          await pin(m, true);
        }}
      >
        <p>This entry was quarantined because it looked like instructions from untrusted content. Changing it marks it as owner-trusted, so it may be added to the agent’s context automatically.</p>
      </ConfirmDialog>
      <ConfirmDialog
        open={clearOpen}
        title="Clear memory entries?"
        confirmLabel={clearKind ? `Delete all ${KIND_LABEL[clearKind]?.toLowerCase() ?? clearKind} entries` : 'Delete all entries'}
        onCancel={() => setClearOpen(false)}
        onConfirm={async () => {
          const r = await run('clear', () => api.memory.clear(agent.id, clearKind || undefined), { success: (res) => `${res.deleted} entr${res.deleted === 1 ? 'y' : 'ies'} deleted` });
          if (r) {
            setClearOpen(false);
            reloadAll();
            toast.info('Memory cleared', clearKind ? `Kind: ${KIND_LABEL[clearKind] ?? clearKind}` : 'All kinds');
          }
        }}
      >
        <div className="space-y-3">
          <Field htmlFor={`${kindId}-clear`} label="Which entries">
            <Select id={`${kindId}-clear`} value={clearKind} onChange={(e) => setClearKind(e.target.value)}>
              <option value="">All kinds ({st?.total ?? 0})</option>
              {MEMORY_KINDS.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]} ({st?.by_kind?.[k] ?? 0})
                </option>
              ))}
            </Select>
          </Field>
          <p>
            Pinned entries are deleted too. This permanently removes {clearKind ? `every ${KIND_LABEL[clearKind]?.toLowerCase()} entry` : 'every entry'} of <strong>{agent.name}</strong> and cannot be undone.
          </p>
        </div>
      </ConfirmDialog>
    </div>
  );
}
