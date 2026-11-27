// Chats extras loaded on first use: search over chats and message content, and the new-conversation sheet.
import { useEffect, useMemo, useState } from 'react';
import type { Agent } from '../../types';
import { ConversationScreen } from '../chunks';
import { CONVERSATIONS_KEY, convKey } from '../chat/keys';
import { hasPermission, useMini } from '../context';
import { chatTime } from '../format';
import { setQueryData, useActions, useQuery } from '../hooks';
import { mhref, navigate } from '../router';
import type { Conversation, SearchResult } from '../types';
import { agentAvatar, agentStatus, Avatar, ErrorState, Screen, SearchField, Sheet, SkeletonList, StatusDot } from '../uiKit';
import { AgentChatRow, ChatRow } from './ChatsScreen';

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Archived conversations (GET /conversations?archived=true); open one to read or restore it. */
export function ArchivedScreen() {
  const { api } = useMini();
  const q = useQuery<Conversation[]>('conversations:archived', (s) => api.conversations.list({ archived: true }, s));
  return (
    <Screen title="Archived">
      {q.data ? (
        q.data.length ? (
          <ul className="-mx-4" aria-label="Archived conversations">
            {q.data.map((c) => (
              <ChatRow key={c.id} c={c} />
            ))}
          </ul>
        ) : (
          <p className="py-10 text-center text-subhead text-subtle">No archived conversations.</p>
        )
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={q.reload} />
      ) : (
        <SkeletonList rows={3} />
      )}
    </Screen>
  );
}

export function SearchResults({ term, legacyAgents }: { term: string; legacyAgents: Agent[] | null }) {
  const { api } = useMini();
  const debounced = useDebounced(term, 250);
  const res = useQuery<SearchResult>(legacyAgents ? null : `search:${debounced}`, (s) => api.conversations.search(debounced, s));
  if (legacyAgents) {
    const t = term.toLowerCase();
    const hits = legacyAgents.filter((a) => `${a.name} ${a.description} ${a.model_id ?? ''}`.toLowerCase().includes(t));
    return hits.length ? (
      <ul className="-mx-4" aria-label="Search results">
        {hits.map((a) => (
          <AgentChatRow key={a.id} agent={a} />
        ))}
      </ul>
    ) : (
      <p className="px-4 py-6 text-center text-subhead text-subtle">No agents match “{term}”.</p>
    );
  }
  if (!res.data) return res.error ? <ErrorState error={res.error} onRetry={res.reload} /> : <SkeletonList rows={3} label="Searching…" />;
  const { conversations, messages } = res.data;
  if (!conversations.length && !messages.length) return <p className="px-4 py-6 text-center text-subhead text-subtle">Nothing found for “{debounced}”.</p>;
  return (
    <div aria-label="Search results">
      {conversations.length > 0 && (
        <section className="mb-4">
          <h2 className="px-1 pb-1 text-footnote font-medium tracking-wide text-subtle uppercase">Chats</h2>
          <ul className="-mx-4">
            {conversations.map((c) => (
              <ChatRow key={c.id} c={c} />
            ))}
          </ul>
        </section>
      )}
      {messages.length > 0 && (
        <section>
          <h2 className="px-1 pb-1 text-footnote font-medium tracking-wide text-subtle uppercase">Messages</h2>
          <ul className="-mx-4">
            {messages.map((m) => (
              <li key={m.message_id}>
                <a href={mhref(`/chats/${m.conversation_id}`)} onPointerDown={() => void ConversationScreen.preload()} className="nb-row flex items-start gap-3 px-4 py-2.5 focus-ring">
                  <Avatar name={m.agent_name} id={m.agent_id} size="sm" />
                  <span className="min-w-0 flex-1 border-b border-border pb-2.5">
                    <span className="flex items-baseline gap-2">
                      <span className="truncate text-subhead font-semibold text-text">{m.agent_name}</span>
                      <span className="ml-auto shrink-0 text-caption text-subtle">{chatTime(m.created_at)}</span>
                    </span>
                    <span className="mt-0.5 line-clamp-2 text-subhead text-muted">
                      {m.role === 'user' ? 'You: ' : ''}
                      <Highlight text={m.snippet} term={debounced} />
                    </span>
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Highlight({ text, term }: { text: string; term: string }) {
  const i = text.toLowerCase().indexOf(term.toLowerCase());
  if (i < 0 || !term) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark className="rounded bg-accent/15 px-0.5 text-text">{text.slice(i, i + term.length)}</mark>
      {text.slice(i + term.length)}
    </>
  );
}

/** Pick an agent → creates a conversation → opens it. */
export function NewChatSheet({ legacy, onClose }: { legacy: boolean; onClose: () => void }) {
  const ctx = useMini();
  const { api } = ctx;
  const { run, isPending } = useActions();
  const agents = useQuery<Agent[]>('agents', (s) => api.agents.list(s));
  const [filter, setFilter] = useState('');
  const list = useMemo(() => {
    const t = filter.trim().toLowerCase();
    return (agents.data ?? []).filter((a) => !t || `${a.name} ${a.description}`.toLowerCase().includes(t));
  }, [agents.data, filter]);
  const canSend = hasPermission(ctx, 'tasks');
  const start = async (a: Agent) => {
    if (legacy) {
      onClose();
      navigate(`/agents/${a.id}`);
      return;
    }
    const c = await run(`new:${a.id}`, () => api.conversations.create(a.id), { errorTitle: 'Could not start a conversation' });
    if (!c) return;
    setQueryData<Conversation>(convKey(c.id), () => c);
    setQueryData<Conversation[]>(CONVERSATIONS_KEY, (xs) => (xs ? [c, ...xs.filter((x) => x.id !== c.id)] : xs));
    onClose();
    navigate(`/chats/${c.id}`);
  };
  return (
    <Sheet open title="New conversation" description={canSend ? 'Choose who you want to talk to.' : 'This Mini App session may not create tasks.'} onClose={onClose}>
      {(agents.data?.length ?? 0) > 6 && (
        <div className="mb-2">
          <SearchField label="Filter agents" value={filter} onChange={setFilter} placeholder="Filter agents" />
        </div>
      )}
      {agents.data ? (
        list.length ? (
          <ul aria-label="Agents">
            {list.map((a) => {
              const st = agentStatus(a.state);
              return (
                <li key={a.id}>
                  <button
                    type="button"
                    disabled={!canSend || isPending(`new:${a.id}`)}
                    onPointerDown={() => void ConversationScreen.preload()}
                    onClick={() => void start(a)}
                    className="nb-row flex min-h-14 w-full items-center gap-3 rounded-xl px-2 text-left focus-ring disabled:opacity-50"
                  >
                    <Avatar name={a.name} id={a.id} size="sm" avatar={agentAvatar(a)} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-body font-medium text-text">{a.name}</span>
                      <span className="flex items-center gap-1.5 text-footnote text-muted">
                        <StatusDot tone={st.tone} pulse={st.busy} />
                        <span className="truncate">{a.model_id ? `${st.label} · ${a.model_id}` : `${st.label} · no AI model`}</span>
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="py-6 text-center text-subhead text-subtle">{filter ? 'No agent matches.' : 'No agents yet — create one in the NEBULA Dashboard.'}</p>
        )
      ) : agents.error ? (
        <ErrorState error={agents.error} onRetry={agents.reload} />
      ) : (
        <SkeletonList rows={3} />
      )}
    </Sheet>
  );
}
