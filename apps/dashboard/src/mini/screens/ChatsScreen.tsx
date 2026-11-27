// Chats: the first screen. Conversations like a messenger (agent avatar, name + title, last message, time, unread,
// running task), search over agents and message content, and a new-conversation sheet. No monitoring cards here.
import { Suspense, useMemo, useState } from 'react';
import { lazyNamed } from '../../lib/lazy';
import { isApiError } from '../../lib/http';
import { useEventStatus, useNebulaEvents } from '../../hooks/useEvents';
import type { Agent, AgentAvatar, Health, NebulaEvent } from '../../types';
import { ConversationScreen } from '../chunks';
import { CONVERSATIONS_KEY, convKey, msgsKey, previewText, type ChatData } from '../chat/keys';
import { useMini } from '../context';
import { chatTime } from '../format';
import { prefetchQuery, setQueryData, useCachedQuery, useQuery, useTick } from '../hooks';
import { IcChats, IcCompose, IcSearch } from '../icons';
import { mhref } from '../router';
import type { Conversation } from '../types';
import { agentAvatar, agentStatus, Avatar, Btn, cx, Empty, ErrorState, IconBtn, SearchField, SkeletonList, StatusDot, Wordmark, type Tone } from '../ui';

// Search results and the new-conversation sheet load on first use (not part of the initial shell).
const extras = () => import('./ChatsExtras');
const SearchResults = lazyNamed(extras, 'SearchResults');
const NewChatSheet = lazyNamed(extras, 'NewChatSheet');

export { CONVERSATIONS_KEY };

const TERMINAL = new Set(['task.completed', 'task.failed', 'task.cancelled']);

/** The conversation API is missing (older host) or not on the gateway allow-list: fall back to one chat per agent. */
export function conversationsUnavailable(e: unknown): boolean {
  return isApiError(e) && (e.status === 404 || e.status === 405 || e.code === 'not_available_remotely');
}

/** Connection + host health in one dot (tap: Settings → System). */
function useSystemDot(): { tone: Tone; label: string } {
  const { api } = useMini();
  const events = useEventStatus();
  const health = useQuery<Health>('health', (s) => api.health(s), {
    refreshOn: (ev) => ev.type === 'system.health' || ev.type.startsWith('vm.') || ev.type === 'provider.state.changed',
  });
  if (health.error && isApiError(health.error) && health.error.status === 0) return { tone: 'danger', label: 'NEBULA is unreachable' };
  if (events === 'reconnecting' || events === 'connecting') return { tone: 'warning', label: 'Reconnecting live updates' };
  if (health.data && health.data.status !== 'ok') return { tone: 'warning', label: 'NEBULA is degraded' };
  if (health.data) return { tone: 'success', label: events === 'open' ? 'NEBULA is healthy · live' : 'NEBULA is healthy' };
  return { tone: 'neutral', label: 'Checking NEBULA…' };
}

export function ChatsScreen() {
  const { api } = useMini();
  useTick(60_000);
  const q = useQuery<Conversation[]>(CONVERSATIONS_KEY, (s) => api.conversations.list({}, s), {
    refreshOn: (ev) => ev.type === 'conversation.message' || ev.type === 'agent.deleted' || ev.type === 'agent.created',
  });
  const legacy = q.data === null && conversationsUnavailable(q.error);
  const agents = useQuery<Agent[]>('agents', (s) => api.agents.list(s), { enabled: legacy, refreshOn: (ev) => ev.type.startsWith('agent.') });
  // avatars only from an agents list another screen already loaded (never an extra request on Chats)
  const known = useCachedQuery<Agent[]>('agents');
  const avatars = useMemo(() => new Map((known ?? []).map((a) => [a.id, agentAvatar(a)])), [known]);

  // The running-task indicator follows task lifecycle events locally (no refetch per event).
  const patch = q.setData;
  useNebulaEvents((ev: NebulaEvent) => {
    if (!ev.task_id) return;
    if (TERMINAL.has(ev.type)) {
      patch((xs) => (xs ? xs.map((c) => (c.running_task?.id === ev.task_id ? { ...c, running_task: null } : c)) : xs));
    } else if (ev.type === 'task.started' || ev.type === 'task.paused' || ev.type === 'task.approval.requested') {
      const state = ev.type === 'task.started' ? 'EXECUTING' : ev.type === 'task.paused' ? 'PAUSED' : 'WAITING_APPROVAL';
      patch((xs) => (xs ? xs.map((c) => (c.running_task?.id === ev.task_id ? { ...c, running_task: { id: ev.task_id as string, state } } : c)) : xs));
    }
  });

  const dot = useSystemDot();
  const [searching, setSearching] = useState(false);
  const [term, setTerm] = useState('');
  const [compose, setCompose] = useState(false);

  return (
    <div className="mx-auto w-full max-w-2xl">
      <h1 className="sr-only">Chats</h1>
      <header className="mini-topbar mini-glass nb-hairline sticky top-0 z-30 -mx-4 px-2">
        {searching ? (
          <div className="flex min-h-13 items-center px-2">
            <div className="flex-1">
              <SearchField label="Search chats and messages" value={term} onChange={setTerm} placeholder="Search chats and messages" autoFocus onCancel={() => {
                setSearching(false);
                setTerm('');
              }} />
            </div>
          </div>
        ) : (
          <div className="flex min-h-13 items-center gap-1">
            <span className="flex-1 pl-2.5">
              <Wordmark className="text-body" />
            </span>
            <a href={mhref('/settings/system')} aria-label={`System status: ${dot.label}`} title={dot.label} className="nb-press grid size-11 place-items-center rounded-full focus-ring">
              <StatusDot tone={dot.tone} pulse={dot.tone === 'warning'} className="size-2.5" />
            </a>
            <IconBtn label="Search" icon={<IcSearch />} onPointerDown={() => void SearchResults.preload()} onClick={() => setSearching(true)} />
            <IconBtn label="New conversation" icon={<IcCompose />} onPointerDown={() => void NewChatSheet.preload()} onClick={() => setCompose(true)} />
          </div>
        )}
      </header>
      <div className="h-2" />

      {searching && term.trim().length >= 2 ? (
        <Suspense fallback={<SkeletonList rows={3} label="Searching…" />}>
          <SearchResults term={term.trim()} legacyAgents={legacy ? agents.data : null} />
        </Suspense>
      ) : searching ? (
        <p className="px-4 py-6 text-center text-subhead text-subtle">Search agents, chat titles and messages.</p>
      ) : legacy ? (
        agents.data ? (
          agents.data.length ? (
            <ul className="-mx-4" aria-label="Chats">
              {agents.data.map((a) => (
                <AgentChatRow key={a.id} agent={a} />
              ))}
            </ul>
          ) : (
            <NoChats onStart={() => setCompose(true)} />
          )
        ) : agents.error ? (
          <ErrorState error={agents.error} onRetry={agents.reload} />
        ) : (
          <SkeletonList rows={6} />
        )
      ) : q.data ? (
        q.data.length ? (
          <>
            <ul className="-mx-4" aria-label="Chats">
              {q.data.map((c) => (
                <ChatRow key={c.id} c={c} avatar={avatars.get(c.agent_id)} />
              ))}
            </ul>
            <a href={mhref('/archived')} className="mt-2 flex min-h-11 items-center justify-center text-subhead text-subtle focus-ring">
              Archived conversations
            </a>
          </>
        ) : (
          <NoChats onStart={() => setCompose(true)} />
        )
      ) : q.error && !legacy ? (
        <ErrorState error={q.error} onRetry={q.reload} />
      ) : (
        <SkeletonList rows={6} label="Loading chats…" />
      )}
      {compose && (
        <Suspense fallback={null}>
          <NewChatSheet legacy={legacy} onClose={() => setCompose(false)} />
        </Suspense>
      )}
    </div>
  );
}

function NoChats({ onStart }: { onStart: () => void }) {
  return (
    <Empty
      title="No conversations yet"
      icon={<IcChats />}
      action={
        <Btn variant="primary" icon={<IcCompose />} onClick={onStart}>
          Start a chat
        </Btn>
      }
    >
      Pick an agent and tell it what to do. Results, files and approvals show up right in the chat.
    </Empty>
  );
}

function openConversation(c: Conversation): void {
  setQueryData<Conversation>(convKey(c.id), (prev) => prev ?? c);
}

export function ChatRow({ c, avatar }: { c: Conversation; avatar?: AgentAvatar | null }) {
  const { api } = useMini();
  const unread = c.unread_count > 0;
  const preview = c.last_message ? `${c.last_message.role === 'user' ? 'You: ' : ''}${previewText(c.last_message.content)}` : 'No messages yet';
  const running = Boolean(c.running_task);
  const warm = () => {
    void ConversationScreen.preload();
    openConversation(c);
    prefetchQuery<ChatData>(msgsKey(c.id), (s) => api.conversations.messages(c.id, undefined, s).then((p) => ({ items: p.items, hasMore: p.has_more })));
  };
  return (
    <li>
      <a
        href={mhref(`/chats/${c.id}`)}
        onPointerDown={warm}
        onMouseEnter={() => void ConversationScreen.preload()}
        onClick={() => openConversation(c)}
        className="nb-row flex min-h-[76px] items-center gap-3 px-4 focus-ring"
        aria-label={`${c.agent_name}${c.title && c.title !== c.agent_name ? `, ${c.title}` : ''}${unread ? `, ${c.unread_count} unread` : ''}${running ? ', task running' : ''}: ${preview}, ${chatTime(c.last_message_at ?? c.updated_at)}`}
      >
        <Avatar
          name={c.agent_name}
          id={c.agent_id}
          avatar={avatar}
          badge={running ? <span className="block size-3.5 rounded-full bg-accent nb-pulse" data-testid="running-indicator" /> : undefined}
        />
        <span className="flex min-w-0 flex-1 flex-col self-stretch justify-center border-b border-border py-2.5">
          <span className="flex items-baseline gap-2">
            <span className="min-w-0 truncate">
              <span className="text-body font-semibold text-text">{c.agent_name}</span>
              {c.title && c.title !== c.agent_name && <span className="text-subhead text-muted"> · {c.title}</span>}
            </span>
            <span className={cx('ml-auto shrink-0 text-caption', unread ? 'font-semibold text-accent' : 'text-subtle')}>{chatTime(c.last_message_at ?? c.updated_at)}</span>
          </span>
          <span className="mt-0.5 flex items-start gap-2">
            <span className={cx('line-clamp-2 min-w-0 flex-1 text-subhead', unread ? 'text-text' : 'text-muted')} data-testid="chat-preview">
              {preview}
            </span>
            {unread && (
              <span className="mt-0.5 min-w-[22px] shrink-0 rounded-full bg-accent-fill px-1.5 text-center text-caption leading-[22px] font-semibold text-on-accent" data-testid="unread-badge">
                {c.unread_count > 99 ? '99+' : c.unread_count}
              </span>
            )}
          </span>
        </span>
      </a>
    </li>
  );
}

export function AgentChatRow({ agent: a }: { agent: Agent }) {
  const st = agentStatus(a.state);
  return (
    <li>
      <a href={mhref(`/agents/${a.id}`)} onPointerDown={() => void ConversationScreen.preload()} className="nb-row flex min-h-[76px] items-center gap-3 px-4 focus-ring">
        <Avatar name={a.name} id={a.id} avatar={agentAvatar(a)} badge={a.current_task ? <span className="block size-3.5 rounded-full bg-accent nb-pulse" data-testid="running-indicator" /> : undefined} />
        <span className="flex min-w-0 flex-1 flex-col self-stretch justify-center border-b border-border py-2.5">
          <span className="flex items-baseline gap-2">
            <span className="truncate text-body font-semibold text-text">{a.name}</span>
            <span className="ml-auto shrink-0 text-caption text-subtle">{chatTime(a.last_active_at)}</span>
          </span>
          <span className="mt-0.5 flex items-center gap-1.5 text-subhead text-muted">
            <StatusDot tone={st.tone} pulse={st.busy} />
            <span className="truncate">{st.label}{a.description ? ` · ${a.description}` : ''}</span>
          </span>
        </span>
      </a>
    </li>
  );
}

