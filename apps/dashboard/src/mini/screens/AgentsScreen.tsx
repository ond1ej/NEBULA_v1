// Agents: searchable list (avatar, name, role, status, model, current task). Tap opens the agent's conversation;
// the ··· button or a long press opens every agent action (details, settings, permissions, vault, files, memory,
// Live Desktop, pause / resume, sleep / wake, and Delete — for the owner (me.admin) in the administration area, for
// everyone else only in the local Dashboard).
// V3.2.2: the main bot's owner (`agents` permission) creates agents here: the + button opens #/agents/new, the
// creator sheet (its own lazy chunk, loaded on first use).
import { Suspense, useMemo, useRef, useState } from 'react';
import { isTaskLifecycleEvent } from '../../hooks/useEvents';
import { lazyNamed } from '../../lib/lazy';
import type { Agent } from '../../types';
import { ConversationScreen } from '../chunks';
import { hasPermission, isAdmin, useMini } from '../context';
import { useActions, useQuery } from '../hooks';
import { IcAgents, IcChats, IcDesktop, IcMore, IcPlus, IcX } from '../icons';
import { goBack, mhref, navigate, useMiniRoute } from '../router';
import { haptic } from '../telegram';
import type { AgentEnvironment } from '../types';
import { agentAvatar, agentStatus, Avatar, Btn, Empty, IconBtn, QueryView, Screen, SearchField, Sheet, SheetAction, Spinner, StatusDot } from '../uiKit';
import { Notice } from '../uiExtra';
import {
  IconFiles,
  IconKey,
  IconMemory,
  IconPause,
  IconPlay,
  IconPower,
  IconSettings,
  IconShield,
  IconStop,
  IconSun,
  IconTrash,
  IconUser,
} from '../../components/icons';

const isAgentEvent = (ev: { type: string }) => ev.type.startsWith('agent.') || isTaskLifecycleEvent(ev) || ev.type === 'environment.changed';

const AgentCreatorSheet = lazyNamed(() => import('./AgentCreator'), 'AgentCreatorSheet');

export const OWNER_ONLY_NOTE = 'Creating and changing agents needs the NEBULA owner account.';

/** First line of the description, short: the agent's role. */
export function roleOf(a: Agent): string {
  const first = (a.description ?? '').split('\n')[0].trim();
  if (first) return first.length > 60 ? `${first.slice(0, 57)}…` : first;
  return a.task_type && a.task_type !== 'general' ? a.task_type.replace(/_/g, ' ') : 'General agent';
}

export function AgentsScreen({ creating = false }: { creating?: boolean }) {
  const ctx = useMini();
  const { api } = ctx;
  const canCreate = hasPermission(ctx, 'agents');
  const route = useMiniRoute();
  const pickDesktop = route.query.get('desktop') === '1';
  const q = useQuery<Agent[]>('agents', (s) => api.agents.list(s), { refreshOn: isAgentEvent });
  const [term, setTerm] = useState('');
  const [sheet, setSheet] = useState<Agent | null>(null);
  const list = useMemo(() => {
    const t = term.trim().toLowerCase();
    const xs = q.data ?? [];
    return t ? xs.filter((a) => `${a.name} ${a.description} ${a.model_id ?? ''} ${a.provider_id ?? ''}`.toLowerCase().includes(t)) : xs;
  }, [q.data, term]);

  const openCreator = () => {
    haptic('impact');
    navigate('/agents/new');
  };
  const closeCreator = () => goBack('/agents');
  return (
    <Screen
      large
      title={pickDesktop ? 'Live Desktops' : 'Agents'}
      subtitle={pickDesktop ? 'Choose an agent running in the Ubuntu VM.' : undefined}
      actions={canCreate && !pickDesktop ? <IconBtn label="New agent" icon={<IcPlus />} onPointerDown={() => void AgentCreatorSheet.preload()} onClick={openCreator} /> : undefined}
    >
      <div className="mb-3">
        <SearchField label="Search agents" value={term} onChange={setTerm} placeholder="Search agents" />
      </div>
      <QueryView
        q={q}
        isEmpty={(d) => d.length === 0}
        empty={
          canCreate ? (
            <Empty
              title="No agents yet"
              icon={<IcAgents />}
              action={
                <Btn variant="primary" icon={<IcPlus />} onPointerDown={() => void AgentCreatorSheet.preload()} onClick={openCreator}>
                  New agent
                </Btn>
              }
            >
              Create your first AI agent: its own desktop and browser in the Ubuntu VM.
            </Empty>
          ) : (
            <Empty title="No agents yet" icon={<IcAgents />}>
              Create agents in the NEBULA Dashboard on your Mac mini.
            </Empty>
          )
        }
      >
        {() =>
          list.length ? (
            <ul className="overflow-hidden rounded-card bg-panel" aria-label="Agents">
              {list.map((a) => (
                <AgentRow key={a.id} agent={a} desktopFirst={pickDesktop} onMore={() => setSheet(a)} />
              ))}
            </ul>
          ) : (
            <p className="py-8 text-center text-subhead text-subtle">No agent matches “{term}”.</p>
          )
        }
      </QueryView>
      {sheet && <AgentActionsSheet agent={sheet} onClose={() => setSheet(null)} onChanged={q.reload} />}
      {creating &&
        (canCreate ? (
          <Suspense
            fallback={
              <Sheet open title="Create Agent" description="Configure your new AI assistant." onClose={closeCreator}>
                <div className="grid place-items-center py-10">
                  <Spinner label="Loading…" />
                </div>
              </Sheet>
            }
          >
            <AgentCreatorSheet onClose={closeCreator} onCreated={q.reload} />
          </Suspense>
        ) : (
          <Sheet open title="Create Agent" onClose={closeCreator}>
            <Notice tone="warning" className="mb-2">
              {OWNER_ONLY_NOTE} Create agents in the NEBULA Dashboard on your Mac.
            </Notice>
          </Sheet>
        ))}
    </Screen>
  );
}

function AgentRow({ agent: a, desktopFirst, onMore }: { agent: Agent; desktopFirst: boolean; onMore: () => void }) {
  const st = agentStatus(a.state);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressed = useRef(false);
  const href = mhref(desktopFirst ? `/agents/${a.id}/desktop` : `/agents/${a.id}`);
  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  return (
    <li className="group/row flex items-center">
      <a
        href={href}
        onPointerDown={() => {
          if (!desktopFirst) void ConversationScreen.preload();
          longPressed.current = false;
          timer.current = setTimeout(() => {
            longPressed.current = true;
            haptic('selection');
            onMore();
          }, 500);
        }}
        onPointerUp={cancel}
        onPointerLeave={cancel}
        onPointerCancel={cancel}
        onClick={(e) => {
          if (longPressed.current) e.preventDefault();
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          onMore();
        }}
        className="nb-row flex min-w-0 flex-1 items-center gap-3 py-0 pl-4 focus-ring"
      >
        <Avatar name={a.name} id={a.id} avatar={agentAvatar(a)} badge={a.current_task ? <span className="block size-3.5 rounded-full bg-accent nb-pulse" /> : undefined} />
        <span className="min-w-0 flex-1 self-stretch border-b border-border py-3 group-last/row:border-b-0">
          <span className="flex items-center gap-2">
            <span className="truncate text-body font-semibold text-text">{a.name}</span>
          </span>
          <span className="block truncate text-footnote text-muted">{roleOf(a)}</span>
          <span className="mt-0.5 flex items-center gap-1.5 text-caption text-muted">
            <StatusDot tone={st.tone} pulse={st.busy} />
            <span className="shrink-0">{a.current_task ? 'Working on a task' : st.label}</span>
            <span className="text-subtle">·</span>
            <span className="truncate text-subtle">{a.model_id ?? 'no AI model'}</span>
          </span>
        </span>
      </a>
      <span className="self-stretch border-b border-border pr-1 group-last/row:border-b-0 flex items-center">
        <IconBtn label={`More actions for ${a.name}`} icon={<IcMore />} tone="muted" onClick={onMore} />
      </span>
    </li>
  );
}

/** Every action on one agent (also used by the agent details screen). */
export function AgentActionsSheet({ agent: a, onClose, onChanged }: { agent: Agent; onClose: () => void; onChanged: () => void }) {
  const ctx = useMini();
  const { api } = ctx;
  const { run, isPending } = useActions();
  const env = useQuery<AgentEnvironment>(`agent-env:${a.id}`, (s) => api.agents.environment(a.id, s));
  const task = a.current_task;
  const sleeping = a.state === 'SLEEP' || a.state === 'STOPPED';
  const paused = a.state === 'PAUSED';
  const canCommand = hasPermission(ctx, 'commands');
  const noCommand = canCommand ? null : 'This session may not control agents';
  const desktopReason = !hasPermission(ctx, 'desktop') ? 'No desktop permission in this session' : env.data && !env.data.live_desktop ? 'Runs on the Mac mini: no Live Desktop' : null;
  const go = (to: string) => {
    onClose();
    navigate(to);
  };
  const act = async (key: string, fn: () => Promise<unknown>, success: string) => {
    if ((await run(key, fn, { success })) !== undefined) {
      onChanged();
      onClose();
    }
  };
  const st = agentStatus(a.state);
  return (
    <Sheet open title={a.name} description={`${st.label}${a.model_id ? ` · ${a.model_id}` : ''}`} onClose={onClose}>
      <div className="pb-1">
        <SheetAction icon={<IcChats />} label="Open chat" onClick={() => go(`/agents/${a.id}`)} />
        <SheetAction icon={<IconUser />} label="Details" note="Status, tasks, environment" onClick={() => go(`/agents/${a.id}/details`)} />
        <SheetAction icon={<IconSettings />} label="Settings" note="Name, avatar, model, instructions, capabilities" onClick={() => go(`/agents/${a.id}/settings`)} />
        <SheetAction icon={<IconShield />} label="Permissions" onClick={() => go(`/agents/${a.id}/security`)} />
        <SheetAction icon={<IconKey />} label="Password Vault access" onClick={() => go(`/agents/${a.id}/vault`)} />
        <SheetAction icon={<IconFiles />} label="Files" onClick={() => go(`/agents/${a.id}/files`)} />
        <SheetAction icon={<IconMemory />} label="Memory" onClick={() => go(`/agents/${a.id}/memory`)} />
        <SheetAction icon={<IcDesktop />} label="Live Desktop" note={desktopReason ?? undefined} disabled={Boolean(desktopReason)} onClick={() => go(`/agents/${a.id}/desktop`)} />
        <div className="my-1.5 h-px bg-border" />
        {sleeping ? (
          <SheetAction icon={<IconSun />} label={isPending('wake') ? 'Waking…' : 'Wake'} note={noCommand ?? undefined} disabled={!canCommand || isPending('wake')} onClick={() => void act('wake', () => api.agents.wake(a.id), `${a.name} is waking up`)} />
        ) : (
          <SheetAction icon={<IconPower />} label={isPending('sleep') ? 'Putting to sleep…' : 'Sleep'} note={noCommand ?? 'Frees its memory and desktop'} disabled={!canCommand || isPending('sleep')} onClick={() => void act('sleep', () => api.agents.sleep(a.id), `${a.name} is going to sleep`)} />
        )}
        {!sleeping &&
          (paused ? (
            <SheetAction icon={<IconPlay />} label="Resume" note={noCommand ?? undefined} disabled={!canCommand || isPending('resume')} onClick={() => void act('resume', () => api.agents.resume(a.id), `${a.name} resumed`)} />
          ) : (
            <SheetAction icon={<IconPause />} label="Pause" note={noCommand ?? undefined} disabled={!canCommand || isPending('pause')} onClick={() => void act('pause', () => api.agents.pause(a.id), `${a.name} paused`)} />
          ))}
        {task && (
          <>
            {task.state === 'PAUSED' ? (
              <SheetAction icon={<IconPlay />} label="Resume current task" disabled={!canCommand} onClick={() => void act('tresume', () => api.tasks.resume(task.id), 'Task resumed')} />
            ) : (
              <SheetAction icon={<IconPause />} label="Pause current task" disabled={!canCommand} onClick={() => void act('tpause', () => api.tasks.pause(task.id), 'Pause requested')} />
            )}
            <SheetAction icon={<IconStop />} label="Stop current task" destructive disabled={!canCommand} onClick={() => void act('stop', () => api.tasks.stop(task.id), 'Task stop requested')} />
          </>
        )}
        {isAdmin(ctx) ? (
          <SheetAction icon={<IconTrash />} label="Delete agent" note="Opens the agent’s settings in Administration" destructive onClick={() => go(`/admin/agents/${a.id}/settings`)} />
        ) : (
          <SheetAction icon={<IconTrash />} label="Delete agent" note="Only in the local Dashboard" destructive disabled />
        )}
        <SheetAction icon={<IcX />} label="Cancel" onClick={onClose} />
      </div>
    </Sheet>
  );
}
