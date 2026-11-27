// Agent details: overview (status, model, environment, current task, quick actions) and its sections as their own
// pages — tasks, memory, files, skills and security (permissions, vault access). Settings have their own screen
// (AgentSettingsScreen, #/agents/<id>/settings).
import { useState } from 'react';
import { StatusPill, BUSY_STATES } from '../../components/StatusPill';
import { TaskStageLine } from '../../components/TaskStage';
import { isTaskLifecycleEvent, useNebulaEvents } from '../../hooks/useEvents';
import { formatTime, relativeTime, shortId } from '../../lib/format';
import { applyStepEvent } from '../../lib/taskRows';
import type { AgentDetail, AgentSkill, MemoryEntry, Task } from '../../types';
import { useMini } from '../context';
import { useQuery } from '../hooks';
import { IcChats, IcDesktop, IcMore } from '../icons';
import { mhref } from '../router';
import type { AgentEnvironment } from '../types';
import { agentAvatar, agentStatus, Avatar, Btn, Card, Clamp, Empty, ErrorState, Glyph, IconBtn, List, Pill, QueryView, Row, Screen, SearchField, Section, SkeletonList, StatusDot, tapLinkClass } from '../uiKit';
import { EnvBadge, KV, Notice, OwnerNote } from '../uiExtra';
import { AgentActionsSheet, roleOf } from './AgentsScreen';
import { FileBrowser } from './FilesScreen';
import { IconFiles, IconKey, IconMemory, IconSettings, IconShield, IconSkills, IconTasks } from '../../components/icons';

export function envOf(agent: { config?: unknown }, env: AgentEnvironment | null | undefined): 'host' | 'vm' {
  if (env) return env.effective.env;
  const cfg = (agent.config ?? {}) as { execution?: { env?: string } };
  return cfg.execution?.env === 'host' ? 'host' : 'vm';
}

const SECTIONS: Record<string, string> = {
  details: 'Details',
  tasks: 'Tasks',
  memory: 'Memory',
  files: 'Files',
  skills: 'Skills',
  security: 'Permissions',
};

export function AgentDetailScreen({ agentId, section, query }: { agentId: string; section: string; query: URLSearchParams }) {
  const { api } = useMini();
  // the header shows the agent's state and current task state: per-step / per-stage progress does not change them
  const mine = (ev: { agent_id: string | null; type: string }) => ev.agent_id === agentId && (ev.type.startsWith('agent.') || isTaskLifecycleEvent(ev) || ev.type === 'environment.changed');
  const agent = useQuery<AgentDetail>(`agent:${agentId}`, (s) => api.agents.get(agentId, s), { refreshOn: mine });
  const env = useQuery<AgentEnvironment>(`agent-env:${agentId}`, (s) => api.agents.environment(agentId, s), {
    refreshOn: (ev) => ev.agent_id === agentId && ev.type === 'environment.changed',
  });
  const [sheet, setSheet] = useState(false);
  const active = SECTIONS[section] ? section : 'details';
  const a = agent.data;

  const title = active === 'details' ? (a?.name ?? 'Agent') : SECTIONS[active];
  return (
    <Screen
      title={title}
      subtitle={active !== 'details' && a ? a.name : undefined}
      actions={a ? <IconBtn label="Agent actions" icon={<IcMore />} onClick={() => setSheet(true)} /> : undefined}
    >
      {!a ? (
        agent.error ? (
          <ErrorState error={agent.error} onRetry={agent.reload} />
        ) : (
          <SkeletonList rows={3} />
        )
      ) : (
        <>
          {active === 'details' && <Overview agent={a} env={env.data} />}
          {active === 'tasks' && <TasksSection agentId={agentId} />}
          {active === 'memory' && <MemorySection agentId={agentId} />}
          {active === 'files' && (
            <FileBrowser
              root={`agent:${agentId}`}
              rootLabel={`${a.name} workspace`}
              path={query.get('path') || '.'}
              hrefFor={(p) => mhref(`/agents/${agentId}/files${p && p !== '.' ? `?path=${encodeURIComponent(p)}` : ''}`)}
            />
          )}
          {active === 'skills' && <SkillsSection agentId={agentId} env={env.data} />}
          {active === 'security' && <SecuritySection agent={a} />}
        </>
      )}
      {sheet && a && <AgentActionsSheet agent={a} onClose={() => setSheet(false)} onChanged={agent.reload} />}
    </Screen>
  );
}

// ---------------------------------------------------------------- overview
function Overview({ agent: a, env }: { agent: AgentDetail; env: AgentEnvironment | null }) {
  const e = envOf(a, env);
  const st = agentStatus(a.state);
  return (
    <>
      <div className="mb-5 flex flex-col items-center text-center">
        <Avatar name={a.name} id={a.id} size="lg" avatar={agentAvatar(a)} />
        <p className="mt-2 text-title font-semibold text-text">{a.name}</p>
        <p className="mt-0.5 text-subhead text-muted">{roleOf(a)}</p>
        <p className="mt-2 flex flex-wrap items-center justify-center gap-1.5">
          <Pill tone={st.tone}>
            <StatusDot tone={st.tone} pulse={st.busy} /> {st.label}
          </Pill>
          <EnvBadge env={e} />
          <Pill>{a.model_id ?? 'no AI model'}</Pill>
        </p>
        <div className="mt-4 grid w-full max-w-sm grid-cols-2 gap-2">
          <a href={mhref(`/agents/${a.id}`)} className={tapLinkClass('tinted', 'w-full')}>
            <IcChats /> Chat
          </a>
          {e === 'host' ? (
            <Btn variant="secondary" icon={<IcDesktop />} disabledReason="Runs on the Mac mini: no Live Desktop" className="w-full">
              Desktop
            </Btn>
          ) : (
            <a href={mhref(`/agents/${a.id}/desktop`)} className={tapLinkClass('tinted', 'w-full')}>
              <IcDesktop /> Desktop
            </a>
          )}
        </div>
      </div>

      {a.current_task && (
        <Section title="Current task">
          <List>
            <Row
              href={mhref(`/tasks/${a.current_task.id}`)}
              title={<TaskStageLine taskId={a.current_task.id} state={a.current_task.state} className="max-w-full" />}
              subtitle={`Task ${shortId(a.current_task.id)}`}
              trailing={<StatusPill state={a.current_task.state} pulse={BUSY_STATES.has(a.current_task.state)} />}
            />
          </List>
        </Section>
      )}
      {a.last_error && (
        <Notice tone="danger" title="Last error" className="mb-6">
          {a.last_error}
        </Notice>
      )}

      <Section>
        <List>
          <Row href={mhref(`/agents/${a.id}/tasks`)} leading={<Glyph><IconTasks /></Glyph>} title="Tasks" />
          <Row href={mhref(`/agents/${a.id}/memory`)} leading={<Glyph tone="info"><IconMemory /></Glyph>} title="Memory" />
          <Row href={mhref(`/agents/${a.id}/files`)} leading={<Glyph tone="success"><IconFiles /></Glyph>} title="Files" />
          <Row href={mhref(`/agents/${a.id}/skills`)} leading={<Glyph tone="warning"><IconSkills /></Glyph>} title="Skills" />
        </List>
      </Section>
      <Section>
        <List>
          <Row href={mhref(`/agents/${a.id}/settings`)} leading={<Glyph tone="neutral"><IconSettings /></Glyph>} title="Settings" subtitle="Name, avatar, model, instructions, capabilities" />
          <Row href={mhref(`/agents/${a.id}/security`)} leading={<Glyph tone="danger"><IconShield /></Glyph>} title="Permissions" value={a.permission_level.toLowerCase().replace(/_/g, ' ')} />
          <Row href={mhref(`/agents/${a.id}/vault`)} leading={<Glyph tone="accent"><IconKey /></Glyph>} title="Password Vault access" />
        </List>
      </Section>
      {a.description && (
        <Section title="About">
          <Card>
            <p className="text-subhead whitespace-pre-wrap text-muted [overflow-wrap:anywhere]">{a.description}</p>
          </Card>
        </Section>
      )}
      <p className="px-4 text-footnote text-subtle">
        Last active {relativeTime(a.last_active_at)} · created {formatTime(a.created_at)}
      </p>
    </>
  );
}

// ---------------------------------------------------------------- tasks
export function TasksSection({ agentId }: { agentId: string }) {
  const { api } = useMini();
  const q = useQuery<Task[]>(`agent-tasks:${agentId}`, (s) => api.agents.tasks(agentId, s), {
    refreshOn: (ev) => ev.agent_id === agentId && isTaskLifecycleEvent(ev),
  });
  const setTasks = q.setData;
  useNebulaEvents((ev) => {
    if (ev.type === 'task.step' && ev.agent_id === agentId) setTasks((xs) => applyStepEvent(xs, ev));
  });
  return (
    <QueryView q={q} isEmpty={(d) => d.length === 0} empty={<Empty title="No tasks yet">Tasks you send in the chat appear here.</Empty>}>
      {(tasks) => (
        <List>
          {tasks.map((t) => (
            <Row
              key={t.id}
              href={mhref(`/tasks/${t.id}`)}
              title={<Clamp lines={1}>{t.prompt}</Clamp>}
              subtitle={`${relativeTime(t.created_at)} · step ${t.current_step}/${t.max_steps} · via ${t.source_channel}`}
              trailing={<StatusPill state={t.state} pulse={BUSY_STATES.has(t.state)} />}
            />
          ))}
        </List>
      )}
    </QueryView>
  );
}

// ---------------------------------------------------------------- memory
function MemorySection({ agentId }: { agentId: string }) {
  const { api } = useMini();
  const [q, setQ] = useState('');
  const [applied, setApplied] = useState('');
  const mem = useQuery<MemoryEntry[]>(`memory:${agentId}:${applied}`, (s) => api.agents.memory(agentId, applied || undefined, s), {
    refreshOn: (ev) => ev.agent_id === agentId && ev.type === 'memory.changed',
  });
  return (
    <div>
      <form
        className="mb-3"
        onSubmit={(e) => {
          e.preventDefault();
          setApplied(q.trim());
        }}
      >
        <SearchField label="Search memory" value={q} onChange={(v) => {
          setQ(v);
          if (!v) setApplied('');
        }} placeholder="Search memory" />
        <button type="submit" className="sr-only">
          Search
        </button>
      </form>
      <OwnerNote className="mb-3" to={`/admin/agents/${agentId}/memory`} link="Edit or delete memories in Administration">
        Read-only here — edit or delete memories in the Dashboard.
      </OwnerNote>
      <QueryView q={mem} isEmpty={(d) => d.length === 0} empty={<Empty title={applied ? 'No matching memories' : 'No memories yet'} />}>
        {(items) => (
          <ul className="space-y-2">
            {items.map((m) => (
              <li key={m.id} className="rounded-card bg-panel p-4">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="min-w-0 flex-1 truncate text-body font-medium text-text">{m.key}</span>
                  <Pill>{m.kind}</Pill>
                  {m.pinned && <Pill tone="accent">pinned</Pill>}
                  {m.scope === 'shared' && <Pill tone="info">shared</Pill>}
                </div>
                <p className="mt-1 text-subhead whitespace-pre-wrap text-muted [overflow-wrap:anywhere]">
                  <Clamp lines={4}>{m.value}</Clamp>
                </p>
                <p className="mt-1 text-caption text-subtle">
                  {m.trust} · {m.source} · updated {relativeTime(m.updated_at)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </QueryView>
    </div>
  );
}

// ---------------------------------------------------------------- skills
function SkillsSection({ agentId, env }: { agentId: string; env: AgentEnvironment | null }) {
  const { api } = useMini();
  const q = useQuery<AgentSkill[]>(`skills:${agentId}`, (s) => api.agents.skills(agentId, s), { refreshOn: (ev) => ev.type === 'skill.changed' });
  const unavailable = new Set(env?.skills_unavailable_here ?? []);
  return (
    <QueryView q={q} isEmpty={(d) => d.length === 0} empty={<Empty title="No skills" />}>
      {(skills) => {
        const sorted = [...skills].sort((x, y) => Number(y.assigned) - Number(x.assigned) || x.name.localeCompare(y.name));
        return (
          <>
            <List>
              {sorted.map((s) => (
                <Row
                  key={s.id}
                  title={s.name}
                  subtitle={<Clamp>{s.description || s.id}</Clamp>}
                  trailing={
                    <>
                      {unavailable.has(s.id) && <Pill tone="warning">not on Mac mini</Pill>}
                      {s.assigned ? <Pill tone={s.enabled ? 'success' : 'neutral'}>{s.enabled ? 'on' : 'disabled'}</Pill> : <Pill>off</Pill>}
                    </>
                  }
                  chevron={false}
                />
              ))}
            </List>
            <OwnerNote className="mt-2" to={`/admin/agents/${agentId}/skills`} link="Assign skills in Administration">
              Assign skills in the NEBULA Dashboard.
            </OwnerNote>
          </>
        );
      }}
    </QueryView>
  );
}

// ---------------------------------------------------------------- security
function SecuritySection({ agent }: { agent: AgentDetail }) {
  const catalog = Object.entries(agent.permission_catalog ?? {});
  return (
    <div>
      <Section title="Permission level">
        <Card>
          <KV
            items={[
              ['Level', agent.permission_level.toLowerCase().replace(/_/g, ' ')],
              ['Granted permissions', agent.permissions.length ? agent.permissions.join(', ') : 'level defaults'],
              ['Tools available', String(agent.tools?.length ?? 0)],
            ]}
          />
        </Card>
      </Section>
      {catalog.length > 0 && (
        <Section title="What each level allows">
          <List>
            {catalog.map(([level, perms]) => (
              <Row key={level} title={level.toLowerCase().replace(/_/g, ' ')} subtitle={<Clamp lines={3}>{perms.join(', ') || '—'}</Clamp>} chevron={false} />
            ))}
          </List>
        </Section>
      )}
      <Section title="Password Vault">
        <List>
          <Row href={mhref(`/agents/${agent.id}/vault`)} leading={<Glyph><IconKey /></Glyph>} title="Vault access" subtitle="Credentials this agent may use, approvals, recent use" />
        </List>
      </Section>
      <OwnerNote to={`/admin/agents/${agent.id}/security`} link="Change permissions in Administration">
        Change permissions in the local NEBULA Dashboard. The Mini App can only view them.
      </OwnerNote>
    </div>
  );
}
