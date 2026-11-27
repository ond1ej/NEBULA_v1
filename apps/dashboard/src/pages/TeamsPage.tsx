// Teams (multi-agent collaboration): list, editor, detail with runs, run detail with collaboration graph.
import { useEffect, useId, useMemo, useState } from 'react';
import { ApiError, api } from '../api';
import { CollabGraph } from '../components/CollabGraph';
import { IconArrowLeft, IconArrowRight, IconChevronDown, IconEdit, IconFiles, IconGraph, IconPlay, IconPlus, IconStar, IconStop, IconTeams, IconTrash, IconX } from '../components/icons';
import { DropdownMenu } from '../components/Menu';
import { ConfirmDialog, Drawer, Modal } from '../components/Modal';
import { BUSY_STATES, StatusPill } from '../components/StatusPill';
import {
  Avatar,
  Badge,
  Button,
  ButtonLink,
  Card,
  Checkbox,
  EmptyState,
  ErrorBanner,
  Field,
  IconButton,
  Input,
  KeyValue,
  LoadingCards,
  LoadingRows,
  Meter,
  Mono,
  Notice,
  PageHeader,
  SegmentedControl,
  Select,
  Switch,
  Textarea,
} from '../components/ui';
import { useAction, useApi, useNow, useVisiblePoll } from '../hooks/useApi';
import { isTaskLifecycleEvent, useLiveRefresh } from '../hooks/useEvents';
import { href, navigate } from '../hooks/useHashRoute';
import { formatDuration, formatTime, relativeTime, shortId } from '../lib/format';
import type { Agent, AgentMessage, Team, TeamBody, TeamMode, TeamSubtask } from '../types';

const MODE_TEXT: Record<string, string> = {
  sequential: 'Members work one after another in the listed order; each one receives the previous member’s result.',
  parallel: 'Every member except the lead works at the same time; the lead then reviews and combines the results.',
};

interface MemberDraft {
  key: string;
  agent_id: string;
  role: string;
  instructions: string;
}

let k = 0;
const nk = () => `m${++k}`;

/** Validation shared by the editor (exported for tests). */
export function validateTeam(name: string, members: MemberDraft[], lead: string): string | null {
  if (!name.trim()) return 'Give the team a name';
  if (name.trim().length > 64) return 'Name: at most 64 characters';
  if (members.length === 0) return 'Add at least one member';
  if (members.length > 8) return 'At most 8 members per team';
  if (members.some((m) => !m.agent_id)) return 'Choose an agent for every member';
  if (new Set(members.map((m) => m.agent_id)).size !== members.length) return 'An agent can appear only once';
  if (members.some((m) => !m.role.trim())) return 'Give every member a role';
  if (lead && !members.some((m) => m.agent_id === lead)) return 'The lead must be a member';
  return null;
}

export function TeamEditor({ team, agents, onClose, onSaved }: { team: Team | null; agents: Agent[]; onClose: () => void; onSaved: (t: Team) => void }) {
  const ids = { name: useId(), desc: useId(), lead: useId(), depth: useId(), subs: useId() };
  const { run, isPending } = useAction();
  const [name, setName] = useState(team?.name ?? '');
  const [description, setDescription] = useState(team?.description ?? '');
  const [mode, setMode] = useState<TeamMode>((team?.mode as TeamMode) ?? 'sequential');
  const [members, setMembers] = useState<MemberDraft[]>(
    () => (team?.members ?? []).sort((a, b) => a.position - b.position).map((m) => ({ key: nk(), agent_id: m.agent_id, role: m.role, instructions: m.instructions })),
  );
  const [lead, setLead] = useState(team?.lead_agent_id ?? '');
  const [depth, setDepth] = useState(String(team?.max_delegation_depth ?? 1));
  const [maxSubs, setMaxSubs] = useState(String(team?.max_subtasks ?? 8));
  const [shareMemory, setShareMemory] = useState(team?.share_memory ?? true);
  const [adding, setAdding] = useState('');

  const effectiveLead = lead && members.some((m) => m.agent_id === lead) ? lead : (members[0]?.agent_id ?? '');
  const dn = Number(depth);
  const sn = Number(maxSubs);
  const invalid =
    validateTeam(name, members, effectiveLead) ??
    (!Number.isInteger(dn) || dn < 0 || dn > 3 ? 'Delegation depth: 0–3' : !Number.isInteger(sn) || sn < 1 || sn > 20 ? 'Max subtasks: 1–20' : null);
  const free = agents.filter((a) => !members.some((m) => m.agent_id === a.id) && a.state !== 'DELETING');
  const agentName = (id: string) => agents.find((a) => a.id === id)?.name ?? shortId(id);

  const update = (key: string, patch: Partial<MemberDraft>) => setMembers((xs) => xs.map((m) => (m.key === key ? { ...m, ...patch } : m)));
  const move = (i: number, d: -1 | 1) =>
    setMembers((xs) => {
      const n = [...xs];
      const j = i + d;
      if (j < 0 || j >= n.length) return xs;
      [n[i], n[j]] = [n[j], n[i]];
      return n;
    });

  const save = async () => {
    const body: TeamBody = {
      name: name.trim(),
      description: description.trim(),
      lead_agent_id: effectiveLead || null,
      mode,
      max_delegation_depth: dn,
      max_subtasks: sn,
      share_memory: shareMemory,
      members: members.map((m, i) => ({ agent_id: m.agent_id, role: m.role.trim(), instructions: m.instructions.trim(), position: i })),
    };
    const r = team
      ? await run('save', () => api.teams.update(team.id, body), { success: 'Team saved', errorTitle: 'Team not saved' })
      : await run('save', () => api.teams.create(body), { success: `Team ${body.name} created`, errorTitle: 'Team not created' });
    if (r) onSaved(r);
  };

  return (
    <Drawer
      open
      onClose={onClose}
      dismissible={!isPending('save')}
      width="lg"
      title={team ? `Edit ${team.name}` : 'New team'}
      description="A team runs one goal across several agents. Every subtask is an ordinary agent task with its own approvals."
      footer={
        <>
          <Button onClick={onClose} disabled={isPending('save')}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} loading={isPending('save')} disabledReason={invalid}>
            {team ? 'Save team' : 'Create team'}
          </Button>
        </>
      }
    >
      <div className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field htmlFor={ids.name} label="Name" required>
            <Input id={ids.name} value={name} maxLength={64} onChange={(e) => setName(e.target.value)} placeholder="e.g. Research squad" data-autofocus />
          </Field>
          <Field htmlFor={ids.desc} label="Description">
            <Input id={ids.desc} value={description} maxLength={2000} onChange={(e) => setDescription(e.target.value)} placeholder="What this team is for" />
          </Field>
        </div>
        <div className="space-y-2">
          <span className="text-[13px] font-medium text-text">Collaboration</span>
          <SegmentedControl<TeamMode>
            label="Collaboration mode"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'sequential', label: 'Sequential pipeline' },
              { value: 'parallel', label: 'Parallel + lead review' },
            ]}
          />
          <p className="text-xs text-muted">{MODE_TEXT[mode]}</p>
        </div>

        <section>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-[13px] font-medium text-text">
              Members <span className="text-subtle">({members.length}/8)</span>
            </h3>
          </div>
          {members.length === 0 && <p className="mb-3 text-sm text-muted">Add agents below. In sequential mode the order is the pipeline order.</p>}
          <ol className="space-y-3">
            {members.map((m, i) => (
              <li key={m.key} className="rounded-xl border border-border bg-panel p-3.5">
                <div className="flex items-start gap-3">
                  <span className="mt-2 grid size-6 shrink-0 place-items-center rounded-md bg-panel-3 text-2xs font-semibold text-muted tabular-nums">{i + 1}</span>
                  <div className="grid min-w-0 flex-1 gap-3 sm:grid-cols-2">
                    <Field htmlFor={`${m.key}-a`} label="Agent">
                      <Select id={`${m.key}-a`} value={m.agent_id} onChange={(e) => update(m.key, { agent_id: e.target.value })}>
                        <option value={m.agent_id}>{agentName(m.agent_id)}</option>
                        {free.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field htmlFor={`${m.key}-r`} label="Role">
                      <Input id={`${m.key}-r`} value={m.role} maxLength={64} onChange={(e) => update(m.key, { role: e.target.value })} placeholder="researcher, writer, reviewer…" />
                    </Field>
                    <div className="sm:col-span-2">
                      <Field htmlFor={`${m.key}-i`} label="Role instructions" hint="Given to this member in every team run.">
                        <Textarea id={`${m.key}-i`} rows={2} maxLength={2000} value={m.instructions} onChange={(e) => update(m.key, { instructions: e.target.value })} />
                      </Field>
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-col gap-1">
                    <IconButton size="sm" label={`Move ${agentName(m.agent_id)} up`} icon={<IconChevronDown className="size-4 rotate-180" />} disabled={i === 0} onClick={() => move(i, -1)} />
                    <IconButton size="sm" label={`Move ${agentName(m.agent_id)} down`} icon={<IconChevronDown className="size-4" />} disabled={i === members.length - 1} onClick={() => move(i, 1)} />
                    <IconButton size="sm" label={`Remove ${agentName(m.agent_id)}`} icon={<IconX className="size-4" />} onClick={() => setMembers((xs) => xs.filter((x) => x.key !== m.key))} />
                  </div>
                </div>
                {effectiveLead === m.agent_id && (
                  <p className="mt-2 ml-9 inline-flex items-center gap-1 text-2xs text-accent-soft">
                    <IconStar className="size-3" /> Team lead
                  </p>
                )}
              </li>
            ))}
          </ol>
          {members.length < 8 && (
            <div className="mt-3 flex flex-col gap-2 sm:flex-row">
              <label htmlFor={`${ids.name}-add`} className="sr-only">
                Agent to add
              </label>
              <Select id={`${ids.name}-add`} value={adding} onChange={(e) => setAdding(e.target.value)} className="sm:max-w-xs" disabled={free.length === 0}>
                <option value="">{free.length ? 'Choose an agent…' : 'Every agent is already a member'}</option>
                {free.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                    {!a.model_id ? ' (no model)' : ''}
                  </option>
                ))}
              </Select>
              <Button
                icon={<IconPlus />}
                disabledReason={!adding ? 'Choose an agent first' : null}
                onClick={() => {
                  setMembers((xs) => [...xs, { key: nk(), agent_id: adding, role: xs.length === 0 ? 'lead' : 'member', instructions: '' }]);
                  setAdding('');
                }}
              >
                Add member
              </Button>
            </div>
          )}
        </section>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field htmlFor={ids.lead} label="Lead" hint={mode === 'parallel' ? 'Reviews and combines the others’ results.' : 'May delegate extra subtasks.'}>
            <Select id={ids.lead} value={effectiveLead} onChange={(e) => setLead(e.target.value)} disabled={members.length === 0}>
              {members.map((m) => (
                <option key={m.key} value={m.agent_id}>
                  {agentName(m.agent_id)} · {m.role || 'member'}
                </option>
              ))}
            </Select>
          </Field>
          <Field htmlFor={ids.depth} label="Max delegation depth" hint="0 disables delegation (0–3).">
            <Input id={ids.depth} type="number" min={0} max={3} value={depth} onChange={(e) => setDepth(e.target.value)} />
          </Field>
          <Field htmlFor={ids.subs} label="Max subtasks per run" hint="Hard cap incl. delegated ones (1–20).">
            <Input id={ids.subs} type="number" min={1} max={20} value={maxSubs} onChange={(e) => setMaxSubs(e.target.value)} />
          </Field>
        </div>
        <Switch
          checked={shareMemory}
          onChange={setShareMemory}
          label="Share run results in team memory"
          description="The final summary of every run is stored as project memory shared with all members."
        />
      </div>
    </Drawer>
  );
}

function StartRunDialog({ team, onClose }: { team: Team; onClose: () => void }) {
  const ids = { p: useId(), m: useId() };
  const [prompt, setPrompt] = useState('');
  const [calls, setCalls] = useState('');
  const { run, isPending } = useAction();
  const n = Number(calls);
  const invalid = !prompt.trim() ? 'Describe the goal first' : calls && (!Number.isInteger(n) || n < 1 || n > 100) ? 'Model-call budget: 1–100' : null;
  return (
    <Modal
      open
      onClose={onClose}
      dismissible={!isPending('run')}
      title={`Start a run of ${team.name}`}
      description={MODE_TEXT[team.mode]}
      footer={
        <>
          <Button onClick={onClose} disabled={isPending('run')}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon={<IconPlay />}
            loading={isPending('run')}
            disabledReason={invalid}
            onClick={async () => {
              const r = await run('run', () => api.teams.startRun(team.id, prompt.trim(), calls ? n : null), { success: 'Team run started', errorTitle: 'Run not started' });
              if (r) navigate(`/teams/${team.id}/runs/${r.id}`);
            }}
          >
            Start run
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field htmlFor={ids.p} label="Goal" required>
          <Textarea id={ids.p} rows={5} maxLength={20000} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="What should the team achieve?" data-autofocus />
        </Field>
        <Field htmlFor={ids.m} label="Model-call budget per subtask (optional)" hint="Caps each subtask’s steps (1–100). Empty uses the default task budget.">
          <Input id={ids.m} type="number" min={1} max={100} value={calls} onChange={(e) => setCalls(e.target.value)} className="sm:w-40" />
        </Field>
        <p className="text-xs text-muted">Every member needs an AI model; the host refuses the run otherwise. Each subtask is a normal agent task and asks for approval before sensitive actions.</p>
      </div>
    </Modal>
  );
}

function DeleteTeamDialog({ team, onClose, onDeleted }: { team: Team; onClose: () => void; onDeleted: () => void }) {
  const [files, setFiles] = useState(false);
  const { run } = useAction();
  return (
    <ConfirmDialog
      open
      title={`Delete team ${team.name}?`}
      confirmLabel={files ? 'Delete team and files' : 'Delete team'}
      onCancel={onClose}
      onConfirm={async () => {
        const r = await run('del', () => api.teams.remove(team.id, files), { success: `Team ${team.name} deleted`, errorTitle: 'Team not deleted' });
        if (r) onDeleted();
      }}
    >
      <p>The team, its members list and its run history are removed. The agents themselves are not affected. A running team run must be cancelled first.</p>
      <Checkbox
        label="Also delete the team’s shared files"
        description={team.shared_path ? `Removes ${team.shared_path} inside the VM. This cannot be undone.` : 'Removes the shared folder inside the VM.'}
        checked={files}
        onChange={setFiles}
      />
    </ConfirmDialog>
  );
}

function MemberStack({ team }: { team: Team }) {
  return (
    <div className="flex items-center">
      <div className="flex -space-x-1.5">
        {team.members.slice(0, 5).map((m) => (
          <span key={m.agent_id} title={`${m.agent_name ?? m.agent_id} · ${m.role}`} className="rounded-lg ring-2 ring-panel">
            <Avatar name={m.agent_name ?? '?'} id={m.agent_id} size="sm" />
          </span>
        ))}
      </div>
      {team.members.length > 5 && <span className="ml-2 text-xs text-subtle">+{team.members.length - 5}</span>}
    </div>
  );
}

export function TeamsPage({ query }: { query: URLSearchParams }) {
  const teams = useApi(() => api.teams.list(), []);
  const agents = useApi(() => api.agents.list(), []);
  const [editing, setEditing] = useState<Team | 'new' | null>(query.get('new') ? 'new' : null);
  const [starting, setStarting] = useState<Team | null>(null);
  const [deleting, setDeleting] = useState<Team | null>(null);
  useLiveRefresh(teams.reload, (e) => e.type.startsWith('team.run.'), 800);
  useEffect(() => {
    if (query.get('new')) navigate('/teams', { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const list = teams.data ?? [];
  return (
    <>
      <PageHeader
        title="Teams"
        description="Several agents working on one goal: a sequential pipeline or parallel work reviewed by a lead, with a shared folder and shared memory."
        actions={
          <Button variant="primary" icon={<IconPlus />} onClick={() => setEditing('new')} disabledReason={agents.data && agents.data.length === 0 ? 'Create an agent first' : null}>
            New team
          </Button>
        }
      />
      {teams.error ? (
        <div className="mb-4">
          <ErrorBanner error={teams.error} onRetry={teams.reload} />
        </div>
      ) : null}
      {!teams.data && teams.loading ? (
        <LoadingCards label="Loading teams…" />
      ) : list.length === 0 ? (
        <EmptyState
          icon={<IconTeams />}
          title="No teams yet"
          action={
            <Button variant="primary" icon={<IconPlus />} onClick={() => setEditing('new')}>
              Create a team
            </Button>
          }
        >
          A team turns one goal into subtasks for its members, hands results from one agent to the next and keeps a full collaboration log.
        </EmptyState>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {list.map((t) => {
            const lead = t.members.find((m) => m.agent_id === t.lead_agent_id);
            return (
              <article key={t.id} className="relative flex min-w-0 flex-col rounded-xl border border-border bg-panel shadow-card transition-colors hover:border-border-strong">
                <div className="p-4 pb-3 sm:p-5 sm:pb-3">
                  <div className="flex items-start justify-between gap-3">
                    <h3 className="min-w-0 truncate text-[15px] font-semibold text-text">
                      <a href={href(`/teams/${t.id}`)} className="rounded focus-ring after:absolute after:inset-0 after:rounded-xl">
                        {t.name}
                      </a>
                    </h3>
                    <Badge tone="accent">{t.mode}</Badge>
                  </div>
                  <p className="mt-1 line-clamp-2 min-h-[1.25rem] text-[13px] text-muted">{t.description || <span className="text-subtle">No description</span>}</p>
                  <div className="mt-4 flex items-center justify-between gap-3">
                    <MemberStack team={t} />
                    <span className="truncate text-xs text-subtle">{lead ? `lead ${lead.agent_name}` : ''}</span>
                  </div>
                </div>
                <div className="relative z-[1] mt-auto flex items-center gap-2 border-t border-border px-3 py-2.5 sm:px-4">
                  {t.last_run ? (
                    <a href={href(`/teams/${t.id}/runs/${t.last_run.id}`)} className="inline-flex min-w-0 items-center gap-2 rounded text-xs text-muted focus-ring">
                      <StatusPill state={t.last_run.state} pulse={t.last_run.state === 'RUNNING'} />
                      <span className="truncate">{relativeTime(t.last_run.created_at)}</span>
                    </a>
                  ) : (
                    <span className="text-xs text-subtle">Never run</span>
                  )}
                  <span className="ml-auto flex items-center gap-1">
                    <Button size="sm" variant="ghost" icon={<IconPlay />} onClick={() => setStarting(t)}>
                      Run
                    </Button>
                    <DropdownMenu
                      label={`More actions for ${t.name}`}
                      items={[
                        { label: 'Edit…', icon: <IconEdit />, onSelect: () => setEditing(t) },
                        { label: 'Delete…', icon: <IconTrash />, danger: true, separatorBefore: true, onSelect: () => setDeleting(t) },
                      ]}
                    />
                  </span>
                </div>
              </article>
            );
          })}
        </div>
      )}
      {editing && (
        <TeamEditor
          team={editing === 'new' ? null : editing}
          agents={agents.data ?? []}
          onClose={() => setEditing(null)}
          onSaved={(t) => {
            setEditing(null);
            teams.reload();
            if (editing === 'new') navigate(`/teams/${t.id}`);
          }}
        />
      )}
      {starting && <StartRunDialog team={starting} onClose={() => setStarting(null)} />}
      {deleting && (
        <DeleteTeamDialog
          team={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            setDeleting(null);
            teams.reload();
          }}
        />
      )}
    </>
  );
}

export function TeamDetailPage({ teamId }: { teamId: string }) {
  const team = useApi(() => api.teams.get(teamId), [teamId]);
  const runs = useApi(() => api.teams.runs(teamId, 50), [teamId]);
  const agents = useApi(() => api.agents.list(), []);
  const [editing, setEditing] = useState(false);
  const [starting, setStarting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  useLiveRefresh(runs.reload, (e) => e.type.startsWith('team.run.') && e.payload.team_id === teamId, 500);
  const t = team.data;

  if (!t) {
    if (team.error instanceof ApiError && team.error.status === 404)
      return (
        <EmptyState title="Team not found" action={<ButtonLink href={href('/teams')}>Back to teams</ButtonLink>}>
          It may have been deleted.
        </EmptyState>
      );
    return team.error ? <ErrorBanner error={team.error} onRetry={team.reload} /> : <LoadingCards count={2} className="grid gap-4 md:grid-cols-2" label="Loading team…" />;
  }
  const running = (runs.data ?? []).some((r) => r.state === 'RUNNING');

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Teams', href: href('/teams') }, { label: t.name }]}
        title={t.name}
        meta={
          <>
            <Badge tone="accent">{t.mode}</Badge>
            <Badge>{t.members.length} member(s)</Badge>
            {t.share_memory && <Badge>shared memory</Badge>}
          </>
        }
        description={t.description || undefined}
        actions={
          <>
            <Button icon={<IconEdit />} onClick={() => setEditing(true)}>
              Edit
            </Button>
            <Button variant="danger" icon={<IconTrash />} onClick={() => setDeleting(true)} disabledReason={running ? 'Cancel the running run first' : null}>
              Delete
            </Button>
            <Button variant="primary" icon={<IconPlay />} onClick={() => setStarting(true)}>
              Start run
            </Button>
          </>
        }
      />
      <div className="grid gap-5 lg:grid-cols-3">
        <Card title="Members" icon={<IconTeams />} className="lg:col-span-2" padded={false}>
          <ol>
            {[...t.members]
              .sort((a, b) => a.position - b.position)
              .map((m, i) => (
                <li key={m.agent_id} className="flex items-start gap-3 border-b border-border/60 px-4 py-3.5 last:border-0 sm:px-5">
                  <span className="mt-2 w-4 shrink-0 text-right text-2xs text-subtle tabular-nums">{i + 1}</span>
                  <Avatar name={m.agent_name ?? '?'} id={m.agent_id} />
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2">
                      <a href={href(`/agents/${m.agent_id}`)} className="rounded text-sm font-medium text-text hover:underline focus-ring">
                        {m.agent_name ?? shortId(m.agent_id)}
                      </a>
                      <Badge>{m.role}</Badge>
                      {m.agent_id === t.lead_agent_id && (
                        <Badge tone="accent" icon={<IconStar />}>
                          lead
                        </Badge>
                      )}
                      {m.agent_status && <StatusPill state={m.agent_status} />}
                    </p>
                    {m.instructions ? <p className="mt-1 text-[13px] whitespace-pre-wrap text-muted">{m.instructions}</p> : <p className="mt-1 text-xs text-subtle">No role instructions.</p>}
                  </div>
                </li>
              ))}
          </ol>
        </Card>
        <Card title="Settings">
          <KeyValue
            items={[
              ['Mode', t.mode],
              ['Lead', t.members.find((m) => m.agent_id === t.lead_agent_id)?.agent_name ?? '—'],
              ['Delegation depth', String(t.max_delegation_depth)],
              ['Max subtasks', String(t.max_subtasks)],
              ['Shared memory', t.share_memory ? 'on' : 'off'],
              ['Shared folder', t.shared_path ? <Mono key="p" className="break-all">{t.shared_path}</Mono> : '—'],
              ['Created', formatTime(t.created_at)],
            ]}
          />
          <p className="mt-3 text-xs text-muted">{MODE_TEXT[t.mode]}</p>
          <ButtonLink size="sm" className="mt-3" href={href('/files')} icon={<IconFiles />}>
            Browse shared files
          </ButtonLink>
        </Card>
      </div>

      <h2 className="mt-8 mb-3 text-sm font-semibold text-text">Runs</h2>
      {runs.error ? <ErrorBanner error={runs.error} onRetry={runs.reload} /> : null}
      {!runs.data ? (
        <div className="rounded-xl border border-border bg-panel p-5">
          <LoadingRows label="Loading runs…" />
        </div>
      ) : runs.data.length === 0 ? (
        <EmptyState compact title="No runs yet" action={<Button variant="primary" icon={<IconPlay />} onClick={() => setStarting(true)}>Start the first run</Button>} />
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-panel shadow-card">
          {runs.data.map((r) => (
            <li key={r.id}>
              <a href={href(`/teams/${t.id}/runs/${r.id}`)} className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-white/[0.02] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-soft sm:px-5">
                <StatusPill state={r.state} pulse={r.state === 'RUNNING'} />
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-2 text-sm text-text">{r.prompt}</p>
                  <p className="mt-0.5 text-xs text-subtle">
                    {formatTime(r.created_at)} · via {r.source}
                    {r.finished_at ? ` · took ${formatDuration(r.finished_at - r.created_at)}` : ''}
                    {r.error ? ` · ${r.error}` : ''}
                  </p>
                </div>
                <IconArrowRight className="mt-1 size-4 shrink-0 text-subtle" />
              </a>
            </li>
          ))}
        </ul>
      )}

      {editing && (
        <TeamEditor
          team={t}
          agents={agents.data ?? []}
          onClose={() => setEditing(false)}
          onSaved={(n) => {
            setEditing(false);
            team.setData(() => n);
          }}
        />
      )}
      {starting && <StartRunDialog team={t} onClose={() => setStarting(false)} />}
      {deleting && <DeleteTeamDialog team={t} onClose={() => setDeleting(false)} onDeleted={() => navigate('/teams')} />}
    </>
  );
}

const MSG_TONE: Record<string, 'info' | 'accent' | 'success' | 'danger' | 'neutral' | 'warn'> = {
  handoff: 'info',
  delegate: 'accent',
  result: 'success',
  failure: 'danger',
  review: 'warn',
  system: 'neutral',
};

function MessageLog({ messages, name }: { messages: AgentMessage[]; name: (id: string | null) => string }) {
  if (messages.length === 0) return <p className="text-sm text-muted">No messages yet.</p>;
  return (
    <ol className="relative space-y-4 before:absolute before:top-2 before:bottom-2 before:left-[5px] before:w-px before:bg-border">
      {messages.map((m) => (
        <li key={m.id} className="relative pl-6">
          <span aria-hidden className={`absolute top-1.5 left-0 size-[11px] rounded-full border-2 border-panel ${m.kind === 'failure' ? 'bg-danger' : m.kind === 'result' ? 'bg-success' : m.kind === 'delegate' ? 'bg-accent-soft' : m.kind === 'handoff' ? 'bg-info' : 'bg-subtle'}`} />
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Badge tone={MSG_TONE[m.kind] ?? 'neutral'}>{m.kind}</Badge>
            {(m.from_agent_id || m.to_agent_id) && (
              <span className="text-muted">
                {m.from_agent_id ? name(m.from_agent_id) : 'NEBULA'}
                {m.to_agent_id ? ` → ${name(m.to_agent_id)}` : ''}
              </span>
            )}
            <time className="ml-auto text-2xs text-subtle" title={formatTime(m.created_at)}>
              {relativeTime(m.created_at)}
            </time>
          </div>
          <p className="mt-1 text-[13px] leading-relaxed break-words whitespace-pre-wrap text-text">{m.content}</p>
        </li>
      ))}
    </ol>
  );
}

function SubtaskItem({ s, open, onToggle }: { s: TeamSubtask; open: boolean; onToggle: () => void }) {
  return (
    <li id={`sub-${s.id}`} className={`rounded-xl border bg-panel ${open ? 'border-accent/35' : 'border-border'}`}>
      <button type="button" onClick={onToggle} aria-expanded={open} className="flex w-full items-start gap-3 rounded-xl px-4 py-3 text-left focus-ring">
        <Avatar name={s.agent_name ?? '?'} id={s.agent_id} size="sm" />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium text-text">{s.title}</span>
            <StatusPill state={s.state} pulse={BUSY_STATES.has(s.state)} />
          </p>
          <p className="mt-0.5 text-xs text-subtle">
            {s.agent_name ?? shortId(s.agent_id)} · attempt {s.attempts}/{s.max_attempts}
            {s.depth ? ` · delegation depth ${s.depth}` : ''}
          </p>
        </div>
        <IconChevronDown className={`mt-1 size-4 shrink-0 text-subtle transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="space-y-3 border-t border-border px-4 py-3 text-[13px]">
          {s.parent_subtask_id && !['lead', 'aggregate'].includes(s.parent_subtask_id) && (
            <div>
              <p className="text-2xs font-semibold tracking-wider text-subtle uppercase">Delegated subtask</p>
              <p className="mt-1 whitespace-pre-wrap text-muted">{s.prompt}</p>
            </div>
          )}
          {s.result_summary ? (
            <div>
              <p className="text-2xs font-semibold tracking-wider text-subtle uppercase">Result</p>
              <p className={`mt-1 whitespace-pre-wrap ${s.state === 'FAILED' ? 'text-danger' : 'text-text'}`}>{s.result_summary}</p>
            </div>
          ) : (
            <p className="text-muted">No result yet.</p>
          )}
          {s.artifacts.length > 0 && (
            <ul className="space-y-1">
              {s.artifacts.map((a, i) => (
                <li key={i} className="flex min-w-0 gap-2 text-xs">
                  <Badge>{a.type}</Badge>
                  <span className="min-w-0 break-all text-text">{a.value}</span>
                </li>
              ))}
            </ul>
          )}
          {s.task_id && (
            <ButtonLink size="sm" href={href(`/agents/${s.agent_id}/tasks?task=${s.task_id}`)}>
              Open task {shortId(s.task_id)}
            </ButtonLink>
          )}
        </div>
      )}
    </li>
  );
}

export function TeamRunPage({ teamId, runId }: { teamId: string; runId: string }) {
  const runQ = useApi(() => api.teams.run(runId), [runId]);
  const r = runQ.data;
  const [selected, setSelected] = useState<string | null>(null);
  const [cancel, setCancel] = useState(false);
  const { run } = useAction();
  useNow(30_000);
  const taskIds = useMemo(() => new Set((r?.subtasks ?? []).map((s) => s.task_id).filter(Boolean) as string[]), [r?.subtasks]);
  useLiveRefresh(
    runQ.reload,
    (e) =>
      ((e.type === 'team.run.completed' || e.type === 'team.run.failed') && e.payload.run_id === runId) ||
      e.type === 'team.subtask.changed' ||
      (e.task_id !== null && taskIds.has(e.task_id) && isTaskLifecycleEvent(e)),
    500,
  );
  useVisiblePoll(runQ.reload, r?.state === 'RUNNING' ? 10_000 : null);

  if (!r) {
    if (runQ.error instanceof ApiError && runQ.error.status === 404)
      return (
        <EmptyState title="Team run not found" action={<ButtonLink href={href(`/teams/${teamId}`)}>Back to the team</ButtonLink>}>
          It may have been deleted with its team.
        </EmptyState>
      );
    return runQ.error ? <ErrorBanner error={runQ.error} onRetry={runQ.reload} /> : <LoadingCards count={2} className="grid gap-4 md:grid-cols-2" label="Loading team run…" />;
  }

  const names = new Map(r.subtasks.map((s) => [s.agent_id, s.agent_name ?? shortId(s.agent_id)]));
  const name = (id: string | null) => (id ? (names.get(id) ?? shortId(id)) : 'NEBULA');
  const done = r.subtasks.filter((s) => ['COMPLETED', 'FAILED', 'SKIPPED', 'CANCELLED'].includes(s.state)).length;
  const completed = r.subtasks.filter((s) => s.state === 'COMPLETED').length;
  const artifacts = r.result?.artifacts ?? [];

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Teams', href: href('/teams') }, { label: r.team_name ?? 'Team', href: href(`/teams/${teamId}`) }, { label: `Run ${shortId(r.id)}` }]}
        title={<span className="line-clamp-2">{r.prompt}</span>}
        meta={
          <>
            <StatusPill state={r.state} pulse={r.state === 'RUNNING'} />
            <span className="text-xs text-muted">
              started {relativeTime(r.created_at)} via {r.source}
              {r.finished_at ? ` · took ${formatDuration(r.finished_at - r.created_at)}` : ''}
            </span>
            {r.max_model_calls ? <Badge>budget {r.max_model_calls} calls</Badge> : null}
          </>
        }
        actions={
          <>
            <ButtonLink href={href(`/teams/${teamId}`)} icon={<IconArrowLeft />}>
              Team
            </ButtonLink>
            {r.state === 'RUNNING' && (
              <Button variant="danger" icon={<IconStop />} onClick={() => setCancel(true)}>
                Cancel run
              </Button>
            )}
          </>
        }
      />
      {runQ.error ? (
        <div className="mb-4">
          <ErrorBanner error={runQ.error} onRetry={runQ.reload} title="Refresh failed" />
        </div>
      ) : null}

      <div className="grid gap-5 xl:grid-cols-3">
        <div className="min-w-0 space-y-5 xl:col-span-2">
          <Card
            title="Collaboration graph"
            icon={<IconGraph />}
            subtitle={`${done} of ${r.subtasks.length} subtasks finished · ${completed} completed`}
          >
            <div className="mb-4">
              <Meter value={r.subtasks.length ? (done / r.subtasks.length) * 100 : 0} label="Subtasks finished" tone={r.state === 'FAILED' ? 'danger' : r.state === 'COMPLETED' ? 'success' : 'accent'} />
            </div>
            <CollabGraph
              subtasks={r.subtasks}
              selected={selected}
              onSelect={(id) => {
                setSelected(id);
                document.getElementById(`sub-${id}`)?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
              }}
            />
          </Card>
          <section>
            <h2 className="mb-3 text-sm font-semibold text-text">Subtasks</h2>
            <ul className="space-y-2">
              {r.subtasks.map((s) => (
                <SubtaskItem key={s.id} s={s} open={selected === s.id} onToggle={() => setSelected(selected === s.id ? null : s.id)} />
              ))}
            </ul>
          </section>
          {(r.result || r.error) && (
            <Card title="Result" icon={<IconFiles />}>
              {r.error && (
                <div className="mb-3">
                  <Notice tone="danger" title="Problems">
                    {r.error}
                  </Notice>
                </div>
              )}
              {r.result?.summary && <p className="text-[13px] leading-relaxed whitespace-pre-wrap text-text">{r.result.summary}</p>}
              {artifacts.length > 0 && (
                <div className="mt-4">
                  <p className="mb-2 text-2xs font-semibold tracking-wider text-subtle uppercase">Artifacts ({artifacts.length})</p>
                  <ul className="space-y-1.5">
                    {artifacts.map((a, i) => (
                      <li key={i} className="flex min-w-0 gap-2 text-[13px]">
                        <Badge>{a.type}</Badge>
                        {a.type === 'url' && /^https?:\/\//.test(a.value) ? (
                          <a href={a.value} target="_blank" rel="noopener noreferrer" className="min-w-0 break-all text-accent-soft hover:underline">
                            {a.value}
                          </a>
                        ) : (
                          <Mono className="min-w-0 break-all text-text">{a.value}</Mono>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {r.result?.shared_path && (
                <p className="mt-3 text-xs text-muted">
                  Shared folder: <Mono>{r.result.shared_path}</Mono> —{' '}
                  <a className="rounded text-accent-soft hover:underline focus-ring" href={href('/files')}>
                    open in Files
                  </a>
                </p>
              )}
            </Card>
          )}
        </div>
        <Card title="Message history" subtitle="Hand-offs, delegations, results and failures" className="h-fit xl:sticky xl:top-20">
          <div className="max-h-[70vh] overflow-y-auto pr-1">
            <MessageLog messages={r.messages} name={name} />
          </div>
        </Card>
      </div>
      <Card title="Goal" className="mt-5">
        <p className="text-[13px] leading-relaxed whitespace-pre-wrap text-text">{r.prompt}</p>
      </Card>

      <ConfirmDialog
        open={cancel}
        title="Cancel this team run?"
        confirmLabel="Cancel run"
        busyText="Cancelling…"
        onCancel={() => setCancel(false)}
        onConfirm={async () => {
          const res = await run('cancel', () => api.teams.cancelRun(r.id), { success: 'Team run cancelled', errorTitle: 'Cancel failed' });
          if (res) {
            setCancel(false);
            runQ.setData(() => res);
          }
        }}
      >
        <p>Running subtasks are stopped at their next safe point, pending ones are cancelled. Results already produced stay available.</p>
      </ConfirmDialog>
    </>
  );
}
