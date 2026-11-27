// A conversation with one agent: fixed header and composer, only the message list scrolls (windowed, "load
// earlier" keeps the reading position), optimistic sending with idempotent retry, inline live task status, and the
// agent's Live Desktop one tap away. Works against the V3.2 conversation API and, on hosts without it, falls back to
// the agent's single chat (GET /agents/{id}/messages + POST /agents/{id}/tasks). Sign-in requests of the agent's tasks
// (Smart Authentication) appear as cards in the timeline (one request: GET /smart-auth/sessions?conversation_id=…,
// refreshed by this conversation's auth events) and open the sign-in sheet.
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useToast } from '../../components/Toast';
import { isTaskLifecycleEvent, useNebulaEvents } from '../../hooks/useEvents';
import { errorMessage, isApiError } from '../../lib/http';
import type { AgentDetail, NebulaEvent } from '../../types';
import { CONVERSATIONS_KEY, agentConvKey, convKey, legacyMsgsKey, msgsKey, type ChatData } from '../chat/keys';
import { Composer } from '../chat/Composer';
import { MessageView, PendingView } from '../chat/MessageView';
import {
  type DisplayItem,
  fromLegacy,
  mergeLatest,
  nearBottom,
  newClientId,
  olderCursor,
  patchTask,
  prependOlder,
  restoreScrollTop,
  settledClientIds,
  taskPatchFromEvent,
  visibleMessages,
  type LocalAttachment,
  type PendingMessage,
} from '../chat/model';
import { getPending, setPending, updatePending, usePending } from '../chat/pending';
import { useStepRecorder } from '../chat/TaskInline';
import { uploadAttachment } from '../chat/upload';
import { hasPermission, isAgentBot, useMini } from '../context';
import { dayKey, dayLabel } from '../format';
import { peekQuery, setQueryData, useActions, useQuery } from '../hooks';
import { IcBack, IcCompose, IcDesktop, IcMore, IcX } from '../icons';
import { goBack, mhref, navigate } from '../router';
import { haptic, liveViewportHeight, setVerticalSwipes } from '../telegram';
import type { AgentEnvironment, Conversation, Message } from '../types';
import type { AuthSession } from '../../features/smartauth/core/types';
import { isAuthEvent } from '../../features/smartauth/core/lib';
import { AuthRequestCard, AuthSheet, convSignInsKey } from '../signin';
import { agentAvatar, agentStatus, Avatar, Btn, cx, IconBtn, Sheet, SheetAction, Skeleton, Spinner, StatusDot } from '../uiKit';
import { ConfirmSheet } from '../uiExtra';
import { conversationsUnavailable } from './ChatsScreen';

/** Messages rendered at once; older ones on demand (from the cache first, then from the server). */
const WINDOW = 60;
const PAGE = 50;
const LEGACY_EVENTS = new Set(['task.queued', 'task.completed', 'task.failed', 'task.cancelled']);
/** Voice recordings waiting for (re)upload, by attachment key (memory only). */
const voiceFiles = new Map<string, File>();

export function ConversationScreen({ conversationId, agentId }: { conversationId?: string; agentId?: string }) {
  const { api } = useMini();
  const byAgent = useQuery<Conversation>(agentId ? agentConvKey(agentId) : null, (s) => api.agents.conversation(agentId as string, s));
  const conv = useQuery<Conversation>(conversationId ? convKey(conversationId) : null, (s) => api.conversations.get(conversationId as string, s), {
    refreshOn: (ev) => ev.type === 'conversation.message' && ev.payload?.conversation_id === conversationId && ev.payload?.role === 'assistant',
  });
  const legacy = Boolean(agentId) && byAgent.data === null && conversationsUnavailable(byAgent.error);
  const conversation = conversationId ? conv.data : byAgent.data;
  const theAgent = agentId ?? conversation?.agent_id ?? null;
  const convId = conversationId ?? byAgent.data?.id ?? null;

  // seed the per-id cache when the conversation was resolved through its agent (header, rename, archive)
  useEffect(() => {
    if (byAgent.data) setQueryData<Conversation>(convKey(byAgent.data.id), () => byAgent.data);
  }, [byAgent.data]);

  const failed = conversationId ? (conv.data ? null : conv.error) : byAgent.data || legacy ? null : byAgent.error;
  if (!theAgent || (!legacy && !convId)) {
    return <ChatFrame agentName={conversation?.agent_name ?? '…'} agentId={theAgent ?? ''} loading error={failed} onRetry={conversationId ? conv.reload : byAgent.reload} />;
  }
  return <ChatView key={legacy ? `legacy:${theAgent}` : convId} mode={legacy ? 'legacy' : 'conversation'} convId={convId} agentId={theAgent} conversation={conversation ?? null} />;
}

// ---------------------------------------------------------------- frame (loading / error before the chat exists)
function ChatFrame({ agentName, agentId, loading, error, onRetry }: { agentName: string; agentId: string; loading?: boolean; error?: unknown; onRetry?: () => void }) {
  const { inTelegram } = useMini();
  const missing = isApiError(error) && error.status === 404;
  return (
    <div className="mini-chat">
      <header className="mini-topbar mini-glass nb-hairline shrink-0">
        <div className="mx-auto flex min-h-13 max-w-2xl items-center gap-2 px-2">
          {!inTelegram && <IconBtn label="Back" icon={<IcBack />} onClick={() => goBack('/')} />}
          {agentId ? <Avatar name={agentName} id={agentId} size="sm" /> : <Skeleton className="size-9 rounded-full" />}
          <h1 className="truncate text-headline font-semibold text-text">{agentName}</h1>
        </div>
      </header>
      <div className="grid flex-1 place-items-center px-6 text-center">
        {error ? (
          <div>
            <p className="text-headline font-semibold text-text">{missing ? 'This conversation no longer exists' : 'Could not open the conversation'}</p>
            <p className="mt-1 text-subhead text-muted">{missing ? 'It may have been deleted on the Mac.' : errorMessage(error)}</p>
            <div className="mt-4 flex justify-center gap-2">
              {!missing && onRetry && (
                <Btn variant="tinted" onClick={onRetry}>
                  Try again
                </Btn>
              )}
              <a href={mhref('/')} className="inline-flex min-h-11 items-center rounded-xl px-4 text-body font-semibold text-accent-soft focus-ring">
                All chats
              </a>
            </div>
          </div>
        ) : loading ? (
          <Spinner label="Opening the conversation…" />
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- viewport (keyboard)
/** Keeps the chat inside the visual viewport: iOS keyboard (visualViewport) and Telegram viewportChanged. */
function useChatViewport(ref: RefObject<HTMLDivElement | null>, onResize: () => void) {
  const cb = useRef(onResize);
  cb.current = onResize;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const vv = window.visualViewport ?? null;
    let maxH = 0;
    const apply = () => {
      const h = liveViewportHeight();
      if (!h) return;
      maxH = Math.max(maxH, h);
      el.style.setProperty('--mini-chat-h', `${h}px`);
      el.style.setProperty('--mini-chat-top', `${vv ? Math.max(0, vv.offsetTop) : 0}px`);
      if (maxH - h > 120) el.dataset.keyboard = '1';
      else delete el.dataset.keyboard;
      cb.current();
    };
    apply();
    vv?.addEventListener('resize', apply);
    vv?.addEventListener('scroll', apply);
    window.addEventListener('resize', apply);
    const wa = window.Telegram?.WebApp;
    try {
      wa?.onEvent?.('viewportChanged', apply);
    } catch {
      // not in Telegram
    }
    return () => {
      vv?.removeEventListener('resize', apply);
      vv?.removeEventListener('scroll', apply);
      window.removeEventListener('resize', apply);
      try {
        wa?.offEvent?.('viewportChanged', apply);
      } catch {
        // ignore
      }
    };
  }, [ref]);
}

function friendly(e: unknown): string {
  if (isApiError(e)) {
    if (e.status === 0) return 'No connection';
    if (e.code === 'conversation_archived') return 'The conversation is archived';
    return e.message;
  }
  return errorMessage(e);
}

// ---------------------------------------------------------------- the chat
function ChatView({ mode, convId, agentId, conversation }: { mode: 'conversation' | 'legacy'; convId: string | null; agentId: string; conversation: Conversation | null }) {
  const ctx = useMini();
  const { api, client, inTelegram } = ctx;
  const toast = useToast();
  const isConv = mode === 'conversation' && convId !== null;
  const dataKey = isConv ? msgsKey(convId as string) : legacyMsgsKey(agentId);
  const pendingKey = isConv ? `c:${convId}` : `a:${agentId}`;

  const agent = useQuery<AgentDetail>(`agent:${agentId}`, (s) => api.agents.get(agentId, s), {
    refreshOn: (ev) => ev.agent_id === agentId && (ev.type.startsWith('agent.') || isTaskLifecycleEvent(ev)),
  });
  const msgs = useQuery<ChatData>(
    dataKey,
    isConv
      ? async (s) => mergeLatest(peekQuery<ChatData>(dataKey), await api.conversations.messages(convId as string, undefined, s))
      : async (s) => ({ items: (await api.agents.messages(agentId, s)).map(fromLegacy), hasMore: false }),
    isConv
      ? { refreshOn: (ev) => ev.type === 'conversation.message' && ev.payload?.conversation_id === convId }
      : { refreshOn: (ev) => ev.agent_id === agentId && LEGACY_EVENTS.has(ev.type), pollMs: 8_000 },
  );
  const pending = usePending(pendingKey);
  const data = msgs.data;
  const setMsgs = msgs.setData;
  useStepRecorder();

  // sign-in requests of this conversation's tasks (newest first from the host; shown in time order). An agent's own
  // bot cannot reach Smart Authentication at all (the owner answers in the main bot), so it never asks.
  const agentBot = isAgentBot(ctx);
  const signIns = useQuery<AuthSession[]>(isConv && !agentBot ? convSignInsKey(convId as string) : null, (s) => api.smartAuth.sessions({ conversationId: convId as string, limit: 10 }, s), {
    refreshOn: (ev) => isAuthEvent(ev) && ev.payload?.conversation_id === convId,
  });
  const [authOpen, setAuthOpen] = useState<AuthSession | null>(null);

  // Telegram must not minimise the app on a downward swipe in the message list.
  useEffect(() => {
    setVerticalSwipes(false);
    return () => setVerticalSwipes(true);
  }, []);

  // optimistic entries the server now has are forgotten
  useEffect(() => {
    if (!data) return;
    const done = settledClientIds(data.items, getPending(pendingKey));
    if (done.length) setPending(pendingKey, (xs) => xs.filter((p) => !done.includes(p.client_id)));
  }, [data, pendingKey]);

  // live task status: lifecycle events patch the message that created the task (no refetch per event)
  useNebulaEvents((ev: NebulaEvent) => {
    if (!ev.task_id) return;
    const patch = taskPatchFromEvent(ev);
    if (!patch) return;
    const id = ev.task_id;
    setMsgs((d) => (d ? patchTask(d, id, patch) : d));
    if (getPending(pendingKey).some((p) => p.message?.task_id === id)) {
      setPending(pendingKey, (xs) =>
        xs.map((p) => {
          if (!p.message || p.message.task_id !== id) return p;
          const next = patchTask({ items: [p.message], hasMore: false }, id, patch).items[0];
          return next === p.message ? p : { ...p, message: next };
        }),
      );
    }
  });

  // read marker: on open when there is something unread, and when a reply arrives while the chat is visible
  const markRead = useCallback(() => {
    if (!isConv) return;
    const id = convId as string;
    void api.conversations
      .markRead(id)
      .then(() => {
        setQueryData<Conversation[]>(CONVERSATIONS_KEY, (xs) => (xs ? xs.map((c) => (c.id === id ? { ...c, unread_count: 0 } : c)) : xs));
        setQueryData<Conversation>(convKey(id), (c) => (c ? { ...c, unread_count: 0 } : c));
      })
      .catch(() => undefined);
  }, [api, convId, isConv]);
  const readOnce = useRef(false);
  useEffect(() => {
    if (!readOnce.current && conversation && conversation.unread_count > 0) {
      readOnce.current = true;
      markRead();
    }
  }, [conversation, markRead]);
  const readTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useNebulaEvents((ev) => {
    if (!isConv || ev.type !== 'conversation.message' || ev.payload?.conversation_id !== convId || ev.payload?.role !== 'assistant') return;
    if (document.visibilityState === 'hidden') return;
    if (readTimer.current) clearTimeout(readTimer.current);
    readTimer.current = setTimeout(markRead, 1200);
  });
  useEffect(() => () => {
    if (readTimer.current) clearTimeout(readTimer.current);
  }, []);

  // ------------------------------------------------------------ sending
  const touchList = useCallback(
    (m: Message) => {
      if (!isConv) return;
      setQueryData<Conversation[]>(CONVERSATIONS_KEY, (xs) => {
        if (!xs) return xs;
        const next = xs.map((c) =>
          c.id === convId
            ? {
                ...c,
                last_message: { role: 'user', content: m.content.slice(0, 200), created_at: m.created_at },
                last_message_at: m.created_at,
                running_task: m.task ? { id: m.task.id, state: m.task.state } : c.running_task,
              }
            : c,
        );
        return next.sort((a, b) => (b.last_message_at ?? b.created_at) - (a.last_message_at ?? a.created_at));
      });
    },
    [convId, isConv],
  );

  const deliver = useCallback(
    async (clientId: string) => {
      const start = getPending(pendingKey).find((x) => x.client_id === clientId);
      if (!start) return;
      try {
        for (const a of start.attachments) {
          if (a.attachment) continue;
          const file = voiceFiles.get(a.key);
          if (!file) throw new Error('The recording is no longer available');
          const setAtt = (p: Partial<LocalAttachment>) =>
            updatePending(pendingKey, clientId, (x) => ({ ...x, attachments: x.attachments.map((y) => (y.key === a.key ? { ...y, ...p } : y)) }));
          setAtt({ status: 'uploading', progress: 0 });
          const att = await uploadAttachment(client, agentId, file, {
            onProgress: (l, t) => setAtt(t > 0 && l >= t ? { progress: 1, status: 'processing' } : { progress: t > 0 ? l / t : 0 }),
          });
          if (att.status === 'FAILED' || att.status === 'failed') throw new Error(att.error ?? 'The recording could not be processed');
          setAtt({ status: 'ready', attachment: att, progress: 1 });
          voiceFiles.delete(a.key);
        }
        const p = getPending(pendingKey).find((x) => x.client_id === clientId);
        if (!p) return;
        const ids = p.attachments.map((a) => a.attachment?.id).filter(Boolean) as string[];
        let message: Message;
        if (isConv) {
          const r = await api.conversations.send(convId as string, { content: p.content, client_id: clientId, attachment_ids: ids.length ? ids : undefined });
          const t = r.task;
          message = {
            ...r.message,
            task:
              r.message.task ??
              (t ? { id: t.id, state: t.state, started_at: t.started_at ?? null, finished_at: t.finished_at ?? null, failure_reason: t.failure_reason ?? null } : null),
          };
          setMsgs((d) => (d ? (d.items.some((x) => x.id === message.id) ? d : { ...d, items: [...d.items, message] }) : d));
        } else {
          const t = await api.agents.createTaskWithKey(agentId, p.content, ids, clientId);
          message = {
            id: `local-${clientId}`,
            conversation_id: '',
            agent_id: agentId,
            task_id: t.id,
            role: 'user',
            channel: 'web',
            content: p.content,
            attachments: [],
            created_at: p.created_at,
            client_id: clientId,
            task: { id: t.id, state: t.state, started_at: t.started_at ?? null, finished_at: t.finished_at ?? null, failure_reason: t.failure_reason ?? null },
          };
        }
        updatePending(pendingKey, clientId, (x) => ({ ...x, status: 'sent', error: undefined, message }));
        touchList(message);
      } catch (e) {
        updatePending(pendingKey, clientId, (x) => ({ ...x, status: 'failed', error: friendly(e) }));
        haptic('error');
      }
    },
    [api, client, agentId, convId, isConv, pendingKey, setMsgs, touchList],
  );

  const stick = useRef(true);
  const queue = useCallback(
    (content: string, attachments: LocalAttachment[]) => {
      const p: PendingMessage = { client_id: newClientId(), content, attachments, created_at: Date.now() / 1000, status: 'sending' };
      stick.current = true;
      setPending(pendingKey, (xs) => [...xs, p]);
      haptic('impact');
      void deliver(p.client_id);
    },
    [deliver, pendingKey],
  );

  const retry = useCallback(
    (clientId: string) => {
      updatePending(pendingKey, clientId, (x) => ({ ...x, status: 'sending', error: undefined }));
      haptic('impact');
      void deliver(clientId);
    },
    [deliver, pendingKey],
  );
  const discard = useCallback(
    (clientId: string) =>
      setPending(pendingKey, (xs) => {
        const gone = xs.find((x) => x.client_id === clientId);
        for (const a of gone?.attachments ?? []) {
          voiceFiles.delete(a.key);
          if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
        }
        return xs.filter((x) => x.client_id !== clientId);
      }),
    [pendingKey],
  );

  const sendVoice = useCallback(
    (file: File, durationMs: number) => {
      const key = `voice-${Date.now()}`;
      voiceFiles.set(key, file);
      const local: LocalAttachment = {
        key,
        name: file.name,
        size: file.size,
        mime: file.type,
        kind: 'audio',
        status: 'uploading',
        progress: 0,
        voice: true,
        previewUrl: typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : undefined,
      };
      queue(`Voice message (${Math.max(1, Math.round(durationMs / 1000))} s)`, [local]);
    },
    [queue],
  );

  // ------------------------------------------------------------ list, windowing, scroll
  const scroller = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const anchor = useRef<{ h: number; top: number } | null>(null);
  const [windowSize, setWindowSize] = useState(WINDOW);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const display = useMemo(() => visibleMessages(data?.items ?? [], pending), [data, pending]);
  const hidden = Math.max(0, display.length - windowSize);
  const shown = hidden ? display.slice(hidden) : display;
  const canLoadMore = hidden > 0 || Boolean(isConv && data?.hasMore);
  const timeline = useMemo(() => withSignIns(shown, signIns.data ?? [], !canLoadMore), [shown, signIns.data, canLoadMore]);

  useChatViewport(frame, () => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (anchor.current) {
      el.scrollTop = restoreScrollTop(anchor.current.h, anchor.current.top, el.scrollHeight);
      anchor.current = null;
      return;
    }
    if (stick.current) el.scrollTop = el.scrollHeight;
  }, [display, signIns.data]);

  const loadEarlier = useCallback(async () => {
    const el = scroller.current;
    if (loadingOlder) return;
    if (hidden > 0) {
      if (el) anchor.current = { h: el.scrollHeight, top: el.scrollTop };
      setWindowSize((w) => w + PAGE);
      return;
    }
    if (!isConv || !data?.hasMore) return;
    setLoadingOlder(true);
    try {
      const page = await api.conversations.messages(convId as string, olderCursor(data));
      const s = scroller.current;
      if (s) anchor.current = { h: s.scrollHeight, top: s.scrollTop };
      setMsgs((d) => prependOlder(d, page));
      setWindowSize((w) => w + page.items.length);
    } catch (e) {
      toast.error(e, 'Could not load earlier messages');
    } finally {
      setLoadingOlder(false);
    }
  }, [api, convId, data, hidden, isConv, loadingOlder, setMsgs, toast]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    stick.current = nearBottom(el);
    if (el.scrollTop < 64 && canLoadMore && !loadingOlder) void loadEarlier();
  };

  // ------------------------------------------------------------ header + menu
  const a = agent.data;
  const avatar = useMemo(() => agentAvatar(a), [a?.config]); // eslint-disable-line react-hooks/exhaustive-deps
  const agentName = a?.name ?? conversation?.agent_name ?? 'Agent';
  const st = agentStatus(a?.state ?? conversation?.agent_status);
  const running = Boolean(conversation?.running_task) || display.some((d) => d.kind === 'message' && d.message.task && !['COMPLETED', 'FAILED', 'CANCELLED'].includes(d.message.task.state));
  const title = conversation && conversation.title && conversation.title !== agentName ? conversation.title : null;
  const [menu, setMenu] = useState(false);

  const canSend = hasPermission(ctx, 'tasks');
  const blocked = !canSend
    ? 'This Mini App session may not send messages'
    : conversation?.archived
      ? 'This conversation is archived'
      : a && !a.model_id
        ? 'Choose an AI model for this agent in the Dashboard first'
        : a && ['CREATING', 'DELETING', 'ERROR'].includes(a.state)
          ? `${agentName} is ${agentStatus(a.state).label.toLowerCase()}`
          : null;

  return (
    <div ref={frame} className="mini-chat" data-testid="conversation">
      <header className="mini-topbar mini-glass nb-hairline z-10 shrink-0">
        <div className="mx-auto flex min-h-13 max-w-2xl items-center gap-1 px-2">
          {!inTelegram && <IconBtn label="Back" icon={<IcBack />} onClick={() => goBack('/')} />}
          <a href={mhref(`/agents/${agentId}/details`)} className="flex min-w-0 flex-1 items-center gap-2.5 rounded-xl px-1 py-1 focus-ring" aria-label={`${agentName}: agent details`}>
            <Avatar name={agentName} id={agentId} size="sm" avatar={avatar} />
            <span className="min-w-0">
              <h1 className="truncate text-headline leading-tight font-semibold text-text">{agentName}</h1>
              <span className="flex items-center gap-1.5 text-caption text-muted">
                <StatusDot tone={running ? 'accent' : st.tone} pulse={running} />
                <span className="truncate">
                  {running ? 'Working…' : st.label}
                  {title ? ` · ${title}` : ''}
                </span>
              </span>
            </span>
          </a>
          <IconBtn label="Conversation options" icon={<IcMore />} onClick={() => setMenu(true)} />
        </div>
      </header>

      <div ref={scroller} onScroll={onScroll} className="mini-chat-scroll mini-safe-x" onClick={() => selected && setSelected(null)}>
        <div className="mx-auto max-w-2xl pt-2 pb-3">
          {canLoadMore && (
            <div className="flex justify-center py-2">
              <Btn size="sm" variant="tinted" loading={loadingOlder} onClick={() => void loadEarlier()}>
                Load earlier messages
              </Btn>
            </div>
          )}
          {data === null ? (
            msgs.error ? (
              <div className="py-10 text-center">
                <p className="text-subhead text-muted">Could not load messages — {friendly(msgs.error)}</p>
                <Btn className="mt-3" variant="tinted" onClick={msgs.reload}>
                  Try again
                </Btn>
              </div>
            ) : (
              <MessagesSkeleton />
            )
          ) : timeline.length === 0 ? (
            <div className="flex flex-col items-center px-6 pt-16 text-center">
              <Avatar name={agentName} id={agentId} size="lg" avatar={avatar} />
              <p className="mt-3 text-headline font-semibold text-text">{agentName}</p>
              <p className="mt-1 max-w-xs text-subhead text-muted">Ask anything or give {agentName} a task. Progress, results, files and approvals appear right here.</p>
            </div>
          ) : (
            <ol aria-label={`Conversation with ${agentName}`}>
              {timeline.map((e, i) => {
                const at = e.at;
                const prev = timeline[i - 1];
                const prevAt = prev ? prev.at : 0;
                const newDay = !prev || dayKey(prevAt) !== dayKey(at);
                const daySep = newDay && (
                  <li className="sticky top-1 z-[1] my-2 flex justify-center" aria-hidden>
                    <span className="mini-glass rounded-full px-3 py-1 text-caption font-medium text-muted">{dayLabel(at)}</span>
                  </li>
                );
                if (e.kind === 'auth') {
                  return (
                    <Fragment key={`auth:${e.s.id}`}>
                      {daySep}
                      <AuthRequestCard s={e.s} onOpen={setAuthOpen} />
                    </Fragment>
                  );
                }
                const it = e.it;
                const m = it.kind === 'message' ? it.message : null;
                const role = m ? m.role : 'user';
                const prevRole = prev ? (prev.kind === 'auth' ? 'auth' : prev.it.kind === 'message' ? prev.it.message.role : 'user') : '';
                const first = newDay || prevRole !== role || at - prevAt > 300;
                const key = it.kind === 'pending' ? it.pending.client_id : (it.local?.client_id ?? it.message.client_id ?? it.message.id);
                return (
                  <Fragment key={key}>
                    {daySep}
                    {it.kind === 'pending' ? (
                      <PendingView p={it.pending} onRetry={retry} onDiscard={discard} />
                    ) : it.local && it.local.status === 'failed' ? (
                      <PendingView p={it.local} onRetry={retry} onDiscard={discard} />
                    ) : (
                      <MessageView message={it.message} local={it.local} agentName={agentName} agentId={agentId} agentAvatar={avatar} first={first} selected={selected === it.message.id} onSelect={setSelected} />
                    )}
                  </Fragment>
                );
              })}
            </ol>
          )}
        </div>
      </div>

      <Composer
        key={isConv ? convId : `agent:${agentId}`}
        draftId={isConv ? (convId as string) : `agent:${agentId}`}
        agentName={agentName}
        blocked={blocked}
        upload={(file, opts) => uploadAttachment(client, agentId, file, opts)}
        onSend={({ content, attachments }) => queue(content, attachments)}
        onSendVoice={sendVoice}
      />

      {menu && <OptionsSheet onClose={() => setMenu(false)} agent={a} agentId={agentId} agentName={agentName} conversation={isConv ? conversation : null} legacy={!isConv} />}
      {authOpen && <AuthSheet key={authOpen.id} sessionId={authOpen.id} seed={authOpen} onClose={() => setAuthOpen(null)} />}
    </div>
  );
}

type TimelineEntry = { kind: 'item'; it: DisplayItem; at: number } | { kind: 'auth'; s: AuthSession; at: number };

const itemAt = (it: DisplayItem) => (it.kind === 'message' ? it.message.created_at : it.pending.created_at);

/**
 * Messages in their display order with the sign-in cards slotted in by `created_at`. Cards older than the loaded
 * window stay hidden until earlier messages are loaded (`complete`: nothing older exists).
 */
function withSignIns(items: DisplayItem[], sessions: AuthSession[], complete: boolean): TimelineEntry[] {
  const firstAt = items.length ? itemAt(items[0]) : -Infinity;
  const auth = sessions
    .filter((s) => complete || s.created_at >= firstAt)
    .slice()
    .sort((a, b) => a.created_at - b.created_at)
    .map((s) => ({ kind: 'auth' as const, s, at: s.created_at }));
  const out: TimelineEntry[] = [];
  let j = 0;
  for (const it of items) {
    const at = itemAt(it);
    while (j < auth.length && auth[j].at < at) out.push(auth[j++]);
    out.push({ kind: 'item', it, at });
  }
  while (j < auth.length) out.push(auth[j++]);
  return out;
}

function MessagesSkeleton() {
  return (
    <div className="space-y-3 pt-4" role="status" aria-label="Loading messages">
      {[60, 38, 72, 45].map((w, i) => (
        <div key={i} className={cx('flex', i % 2 ? 'justify-end' : 'justify-start')}>
          <span aria-hidden className="nb-skel block h-10 rounded-bubble" style={{ width: `${w}%` }} />
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- conversation options
function OptionsSheet({
  onClose,
  agent,
  agentId,
  agentName,
  conversation,
  legacy,
}: {
  onClose: () => void;
  agent: AgentDetail | null;
  agentId: string;
  agentName: string;
  conversation: Conversation | null;
  legacy: boolean;
}) {
  const ctx = useMini();
  const { api } = ctx;
  const { run, isPending } = useActions();
  const env = useQuery<AgentEnvironment>(`agent-env:${agentId}`, (s) => api.agents.environment(agentId, s));
  const [rename, setRename] = useState(false);
  const [archive, setArchive] = useState(false);
  const desktopReason = !hasPermission(ctx, 'desktop')
    ? 'This Mini App session has no desktop permission'
    : env.data && !env.data.live_desktop
      ? `${agentName} runs on the Mac mini: no Live Desktop`
      : null;
  const notHere = 'Needs a newer NEBULA on the Mac';

  const newChat = async () => {
    const c = await run('new', () => api.conversations.create(agentId), { errorTitle: 'Could not start a conversation' });
    if (!c) return;
    setQueryData<Conversation>(convKey(c.id), () => c);
    setQueryData<Conversation[]>(CONVERSATIONS_KEY, (xs) => (xs ? [c, ...xs.filter((x) => x.id !== c.id)] : xs));
    onClose();
    navigate(`/chats/${c.id}`);
  };

  const setArchived = async (archived: boolean) => {
    if (!conversation) return;
    const c = await run('archive', () => api.conversations.update(conversation.id, { archived }), { success: archived ? 'Conversation archived' : 'Conversation restored' });
    if (!c) return;
    setQueryData<Conversation>(convKey(c.id), () => c);
    setQueryData<Conversation[]>(CONVERSATIONS_KEY, (xs) => (xs ? (archived ? xs.filter((x) => x.id !== c.id) : [c, ...xs.filter((x) => x.id !== c.id)]) : xs));
    setQueryData<Conversation[]>('conversations:archived', (xs) => (xs ? (archived ? [c, ...xs.filter((x) => x.id !== c.id)] : xs.filter((x) => x.id !== c.id)) : xs));
    setArchive(false);
    onClose();
    if (archived) navigate('/', { replace: true });
  };

  return (
    <>
      <Sheet open={!rename && !archive} title={agentName} description={conversation && conversation.title !== agentName ? conversation.title : agent ? agentStatus(agent.state).label : undefined} onClose={onClose}>
        <div className="pb-1">
          <SheetAction
            icon={<IcDesktop />}
            label="Live Desktop"
            note={desktopReason ?? (env.data ? 'Watch or take control' : 'Checking availability…')}
            disabled={Boolean(desktopReason)}
            href={desktopReason ? undefined : mhref(`/agents/${agentId}/desktop`)}
            onClick={onClose}
          />
          <SheetAction
            icon={<IcMore />}
            label={isAgentBot(ctx) ? 'Tasks' : 'Agent details'}
            note={isAgentBot(ctx) ? `What ${agentName} is doing and has done` : 'Status, tasks, memory, files, skills, settings'}
            href={mhref(`/agents/${agentId}/details`)}
            onClick={onClose}
          />
          <SheetAction icon={<IcCompose />} label="Rename conversation" note={legacy ? notHere : undefined} disabled={legacy || !conversation} onClick={() => setRename(true)} />
          {conversation?.archived ? (
            <SheetAction icon={<IcX />} label="Restore conversation" onClick={() => void setArchived(false)} />
          ) : (
            <SheetAction
              icon={<IcX />}
              label="Archive conversation"
              note={legacy ? notHere : conversation?.is_default ? 'The agent’s main chat comes back when you message it again' : undefined}
              disabled={legacy || !conversation}
              onClick={() => setArchive(true)}
            />
          )}
          <SheetAction icon={<IcCompose />} label="New conversation" note={legacy ? notHere : `Fresh chat with ${agentName}`} disabled={legacy || isPending('new')} onClick={() => void newChat()} />
        </div>
      </Sheet>
      {rename && conversation && <RenameSheet conversation={conversation} onClose={() => { setRename(false); onClose(); }} />}
      <ConfirmSheet
        open={archive}
        title="Archive this conversation?"
        confirmLabel="Archive"
        tone="danger"
        busy={isPending('archive')}
        onCancel={() => setArchive(false)}
        onConfirm={() => void setArchived(true)}
      >
        It disappears from Chats. Its messages and tasks are kept on your Mac.
      </ConfirmSheet>
    </>
  );
}

function RenameSheet({ conversation, onClose }: { conversation: Conversation; onClose: () => void }) {
  const { api } = useMini();
  const { run, isPending } = useActions();
  const [title, setTitle] = useState(conversation.title);
  const save = async () => {
    const t = title.trim();
    if (!t) return;
    const c = await run('rename', () => api.conversations.update(conversation.id, { title: t }), { success: 'Conversation renamed' });
    if (!c) return;
    setQueryData<Conversation>(convKey(c.id), () => c);
    setQueryData<Conversation[]>(CONVERSATIONS_KEY, (xs) => (xs ? xs.map((x) => (x.id === c.id ? c : x)) : xs));
    onClose();
  };
  return (
    <Sheet
      open
      title="Rename conversation"
      onClose={onClose}
      footer={
        <>
          <Btn className="flex-1" onClick={onClose}>
            Cancel
          </Btn>
          <Btn className="flex-1" variant="primary" loading={isPending('rename')} disabledReason={title.trim() ? null : 'Enter a title'} onClick={() => void save()}>
            Save
          </Btn>
        </>
      }
    >
      <label htmlFor="conv-title" className="mb-1.5 block text-footnote text-muted">
        Title
      </label>
      <input
        id="conv-title"
        data-autofocus
        value={title}
        maxLength={200}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && void save()}
        className="nb-field min-h-11 w-full rounded-xl bg-panel-2 px-3.5 text-body text-text outline-none"
      />
    </Sheet>
  );
}
