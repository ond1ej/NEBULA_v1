import { memo, useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import { api, artifactUrl, newIdempotencyKey } from '../../api';
import { ApprovalCard, useApprovals } from '../../components/Approval';
import { StatusPill } from '../../components/StatusPill';
import { TaskStageLine } from '../../components/TaskStage';
import { StepRow, TaskActions, isTerminal } from '../../components/TaskDetail';
import { useToast } from '../../components/Toast';
import { Avatar, Button, ErrorBanner, IconButton, Kbd, Mono, Skeleton, Textarea } from '../../components/ui';
import { attachmentsApi, MAX_ATTACHMENT_BYTES, type Attachment } from '../../features/attachments/api';
import { AttachmentStrip, PendingChip } from '../../features/attachments/AttachmentChip';
import { IconPaperclip } from '../../features/attachments/icons';
import { namePasted, useAttachmentUploads } from '../../features/attachments/useAttachmentUploads';
import { AgentSignIns } from '../../features/smartauth/SignIns';
import { useApi } from '../../hooks/useApi';
import { isTaskLifecycleEvent, useLiveRefresh, useNebulaEvents } from '../../hooks/useEvents';
import { href } from '../../hooks/useHashRoute';
import { useAuthedUrl } from '../../lib/authedUrl';
import { formatBytes, formatTime, shortId } from '../../lib/format';
import type { Agent, ChatMessage, NebulaEvent, Task } from '../../types';

/** Conversation items rendered at once; older ones load on demand ("Show earlier"). */
export const CHAT_WINDOW = 150;

type LiveItem =
  | { kind: 'text'; id: string; ts: number; taskId: string | null; text: string }
  | {
      kind: 'step';
      id: string;
      ts: number;
      taskId: string | null;
      step: { seq: number; tool_type: string; result_status: string; result_summary: string | null; screenshot_ref: string | null; elapsed_ms: number | null };
    }
  | { kind: 'note'; id: string; ts: number; taskId: string | null; text: string; tone: 'info' | 'warn' | 'danger' | 'success' };

type TimelineItem = { kind: 'message'; id: string; ts: number; msg: ChatMessage } | LiveItem;

export function describeStepKind(p: Record<string, unknown>): { text: string; tone: 'info' | 'warn' | 'danger' } {
  const detail = typeof p.detail === 'string' ? p.detail : '';
  switch (p.kind) {
    case 'waiting_for_resources':
      return { text: `Waiting for resources${detail ? `: ${detail}` : ''}`, tone: 'warn' };
    case 'waking_desktop':
      return { text: 'Waking the agent desktop…', tone: 'info' };
    case 'provider_retry':
      return { text: `Provider temporarily unavailable, retrying in ${String(p.retry_in_s ?? '?')} s${detail ? ` (${detail})` : ''}`, tone: 'warn' };
    case 'waiting_for_control_release':
      return { text: 'Waiting: a viewer holds desktop control. Release control on the Live Desktop tab to continue.', tone: 'warn' };
    default:
      return {
        text: `${p.provider_id ? `Provider ${String(p.provider_id)}: ` : ''}${String(p.kind ?? 'status')}${detail ? ` — ${detail}` : ''}`,
        tone: 'danger',
      };
  }
}

const STATE_NOTES: Record<string, { text: string; tone: 'info' | 'warn' | 'danger' | 'success' }> = {
  'task.started': { text: 'Task started', tone: 'info' },
  'task.paused': { text: 'Task paused', tone: 'warn' },
  'task.resumed': { text: 'Task resumed', tone: 'info' },
  'task.completed': { text: 'Task completed', tone: 'success' },
  'task.failed': { text: 'Task failed', tone: 'danger' },
  'task.cancelled': { text: 'Task cancelled', tone: 'warn' },
};

function liveItemFromEvent(ev: NebulaEvent): LiveItem | null {
  const p = ev.payload;
  if (ev.type === 'task.message' && typeof p.text === 'string') {
    return { kind: 'text', id: ev.id, ts: ev.timestamp, taskId: ev.task_id, text: p.text };
  }
  if (ev.type === 'task.step') {
    if (typeof p.seq === 'number' && typeof p.tool === 'string') {
      return {
        kind: 'step',
        id: ev.id,
        ts: ev.timestamp,
        taskId: ev.task_id,
        step: {
          seq: p.seq,
          tool_type: p.tool,
          result_status: String(p.status ?? ''),
          result_summary: typeof p.summary === 'string' ? p.summary : null,
          screenshot_ref: typeof p.screenshot_ref === 'string' ? p.screenshot_ref : null,
          elapsed_ms: typeof p.elapsed_ms === 'number' ? p.elapsed_ms : null,
        },
      };
    }
    const d = describeStepKind(p);
    return { kind: 'note', id: ev.id, ts: ev.timestamp, taskId: ev.task_id, ...d };
  }
  if (ev.type === 'provider.quota' && ev.task_id) {
    return { kind: 'note', id: ev.id, ts: ev.timestamp, taskId: ev.task_id, text: `Quota reached on ${String(p.provider_id ?? 'provider')}: ${String(p.detail ?? '')}. The task waits (WAITING_PROVIDER).`, tone: 'warn' };
  }
  const note = STATE_NOTES[ev.type];
  if (note) {
    const reason = typeof p.reason === 'string' && p.reason ? `: ${p.reason}` : '';
    return { kind: 'note', id: ev.id, ts: ev.timestamp, taskId: ev.task_id, text: `${note.text}${ev.type === 'task.completed' ? '' : reason}`, tone: note.tone };
  }
  return null;
}

const NOTE_CLS = {
  info: 'text-info',
  warn: 'text-warn',
  danger: 'text-danger',
  success: 'text-success',
};

const NOTE_DOT = {
  info: 'bg-info',
  warn: 'bg-warn',
  danger: 'bg-danger',
  success: 'bg-success',
};

/** `initialPrompt` pre-fills the composer (the first-run checklist offers a harmless sample task); nothing is sent until the owner presses Send. */
export function ChatTab({ agent, initialPrompt }: { agent: Agent; initialPrompt?: string }) {
  const toast = useToast();
  const messages = useApi(() => api.agents.messages(agent.id, 200), [agent.id]);
  const tasks = useApi(() => api.agents.tasks(agent.id, 50), [agent.id]);
  // Pending approvals come from the app-wide provider (already loaded and kept live by events): no extra request.
  const approvals = useApprovals();
  const attachments = useApi((s) => attachmentsApi.list(agent.id, undefined, s), [agent.id]);
  const uploads = useAttachmentUploads(agent.id);
  const [live, setLive] = useState<LiveItem[]>([]);
  const [prompt, setPrompt] = useState(initialPrompt ?? '');
  const [sending, setSending] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const bottom = useRef<HTMLDivElement>(null);

  useNebulaEvents((ev) => {
    if (ev.agent_id !== agent.id) return;
    const item = liveItemFromEvent(ev);
    if (item) setLive((xs) => (xs.some((x) => x.id === item.id) ? xs : [...xs, item].slice(-400)));
  });
  useLiveRefresh(tasks.reload, (ev) => ev.agent_id === agent.id && isTaskLifecycleEvent(ev));
  useLiveRefresh(messages.reload, (ev) => ev.agent_id === agent.id && (ev.type === 'task.completed' || ev.type === 'task.queued'));
  // attachments get linked to tasks on send; vision use is recorded when the task runs
  useLiveRefresh(
    attachments.reload,
    (ev) => ev.agent_id === agent.id && ['attachment.processed', 'task.queued', 'task.started', 'task.completed', 'task.failed'].includes(ev.type),
    600,
  );

  const taskById = useMemo(() => new Map((tasks.data ?? []).map((t) => [t.id, t] as const)), [tasks.data]);
  const attsByTask = useMemo(() => {
    const m = new Map<string, Attachment[]>();
    for (const a of attachments.data ?? []) {
      if (!a.task_id) continue;
      const xs = m.get(a.task_id) ?? [];
      xs.push(a);
      m.set(a.task_id, xs);
    }
    for (const xs of m.values()) xs.sort((a, b) => a.created_at - b.created_at);
    return m;
  }, [attachments.data]);
  const pending = useMemo(() => approvals.tasks.filter((a) => a.agent_id === agent.id), [approvals.tasks, agent.id]);
  const [windowSize, setWindowSize] = useState(CHAT_WINDOW);

  const timeline = useMemo<TimelineItem[]>(() => {
    const items: TimelineItem[] = (messages.data ?? []).map((m) => ({ kind: 'message', id: m.id, ts: m.created_at, msg: m }));
    // persisted history (prompts + final summaries) merged with this session's streamed texts, steps and notes
    for (const l of live) items.push(l);
    return items.sort((a, b) => a.ts - b.ts);
  }, [messages.data, live]);

  const hiddenCount = Math.max(0, timeline.length - windowSize);
  const visible = hiddenCount ? timeline.slice(hiddenCount) : timeline;
  const lastId = timeline.at(-1)?.id;

  useEffect(() => {
    bottom.current?.scrollIntoView?.({ block: 'end' });
  }, [lastId, timeline.length, pending.length]);

  const blocked =
    ['CREATING', 'DELETING', 'ERROR'].includes(agent.state)
      ? `Agent is ${agent.state}`
      : !agent.provider_id || !agent.model_id
        ? 'Choose an AI provider and model in the Settings tab first'
        : null;

  const send = async () => {
    const text = prompt.trim();
    if (!text || sending || blocked || uploads.uploading) return;
    setSending(true);
    try {
      const ids = uploads.readyIds;
      const t = ids.length > 0 ? await attachmentsApi.createTask(agent.id, text, ids, newIdempotencyKey()) : await api.agents.createTask(agent.id, text, newIdempotencyKey());
      setPrompt('');
      uploads.clear();
      toast.success(`Task ${shortId(t.id)} queued${ids.length ? ` with ${ids.length} attachment${ids.length === 1 ? '' : 's'}` : ''}`);
      messages.reload();
      tasks.reload();
      if (ids.length) attachments.reload();
    } catch (e) {
      toast.error(e, 'Could not send the task');
    } finally {
      setSending(false);
    }
  };

  const addFiles = (files: File[]) => {
    if (blocked) {
      toast.warn('Attachments are unavailable', blocked);
      return;
    }
    uploads.add(files);
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length === 0) return;
    if (!e.clipboardData.getData('text/plain')) e.preventDefault();
    addFiles(files.map(namePasted));
  };

  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
  const dropHandlers = {
    onDragEnter: (e: DragEvent<HTMLDivElement>) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth.current += 1;
      setDragging(true);
    },
    onDragOver: (e: DragEvent<HTMLDivElement>) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = blocked ? 'none' : 'copy';
    },
    onDragLeave: (e: DragEvent<HTMLDivElement>) => {
      if (!hasFiles(e)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragging(false);
    },
    onDrop: (e: DragEvent<HTMLDivElement>) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      addFiles(Array.from(e.dataTransfer.files));
    },
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void send();
    }
  };

  const latestOpen: Task | undefined = (tasks.data ?? []).find((t) => !isTerminal(t.state));

  return (
    <div className="flex flex-col gap-4">
      {latestOpen && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-accent/25 bg-accent/[0.05] px-4 py-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
            <span className="text-muted">Current task</span>
            <a className="rounded font-mono text-xs text-text underline decoration-subtle/60 underline-offset-2 focus-ring" href={href(`/agents/${agent.id}/tasks?task=${latestOpen.id}`)}>
              {shortId(latestOpen.id)}
            </a>
            <StatusPill state={latestOpen.state} pulse />
            <span className="text-xs text-subtle tabular-nums">
              step {latestOpen.current_step} · budget {latestOpen.max_steps}
            </span>
            <TaskStageLine taskId={latestOpen.id} state={latestOpen.state} startedAt={latestOpen.started_at} className="text-xs text-text" />
          </div>
          <TaskActions task={latestOpen} onChanged={() => tasks.reload()} />
        </div>
      )}

      <div className="relative overflow-hidden rounded-xl border border-border bg-panel shadow-card" {...dropHandlers}>
        {dragging && (
          <div aria-hidden className="pointer-events-none absolute inset-0 z-10 grid place-items-center rounded-xl border-2 border-dashed border-accent/60 bg-bg/80 backdrop-blur-[1px]">
            <div className="text-center">
              <IconPaperclip className="mx-auto size-6 text-accent-soft" />
              <p className="mt-2 text-sm font-medium text-text">Drop files to attach</p>
              <p className="text-xs text-muted">Images, PDFs, documents, audio, video, ZIP · up to {formatBytes(MAX_ATTACHMENT_BYTES, 0)} each</p>
            </div>
          </div>
        )}
        <div ref={scroller} className="h-[min(62vh,640px)] min-h-[320px] space-y-4 overflow-y-auto overscroll-contain px-3 py-4 sm:px-5" aria-live="polite" aria-label="Conversation">
          {messages.error ? <ErrorBanner error={messages.error} onRetry={messages.reload} title="Could not load chat history" /> : null}
          {!messages.data && messages.loading ? (
            <div className="space-y-4" aria-hidden>
              <Skeleton className="ml-auto h-12 w-2/3 rounded-2xl" />
              <Skeleton className="h-20 w-3/4 rounded-2xl" />
              <Skeleton className="ml-auto h-10 w-1/2 rounded-2xl" />
              <span className="sr-only" role="status">
                Loading history…
              </span>
            </div>
          ) : timeline.length === 0 ? (
            <div className="grid h-full place-items-center text-center">
              <div className="max-w-sm">
                <Avatar name={agent.name} id={agent.id} size="lg" className="mx-auto" />
                <p className="mt-3 text-sm font-medium text-text">No messages yet</p>
                <p className="mt-1 text-sm text-muted">Describe a task for {agent.name} below. Steps, screenshots and approval requests stream here in real time.</p>
              </div>
            </div>
          ) : (
            <>
              {hiddenCount > 0 && (
                <div className="flex justify-center">
                  <Button size="xs" variant="ghost" onClick={() => setWindowSize((n) => n + CHAT_WINDOW)}>
                    Show {Math.min(CHAT_WINDOW, hiddenCount)} earlier ({hiddenCount} hidden)
                  </Button>
                </div>
              )}
              {visible.map((it) => (
                <ChatItem key={it.id} it={it} agent={agent} task={it.kind === 'message' && it.msg.task_id ? taskById.get(it.msg.task_id) : undefined} atts={it.kind === 'message' && it.msg.task_id ? attsByTask.get(it.msg.task_id) : undefined} />
              ))}
            </>
          )}
          {pending.map((a) => (
            <ApprovalCard key={a.id} approval={a} agentName={agent.name} onResolved={() => approvals.reload()} />
          ))}
          <AgentSignIns agentId={agent.id} />
          <div ref={bottom} />
        </div>

        <form
          className="border-t border-border bg-panel-2/40 p-3"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          {uploads.items.length > 0 && (
            <ul className="mb-2 flex flex-wrap gap-2 px-1" aria-label="Attachments for the next task">
              {uploads.items.map((it) => (
                <PendingChip key={it.key} item={it} onRemove={() => uploads.remove(it.key)} />
              ))}
            </ul>
          )}
          <label htmlFor="chat-prompt" className="sr-only">
            Task for {agent.name}
          </label>
          <Textarea
            id="chat-prompt"
            rows={3}
            value={prompt}
            maxLength={20000}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={onKey}
            onPaste={onPaste}
            placeholder={blocked ?? `Describe a task for ${agent.name}…`}
            disabled={Boolean(blocked) || sending}
            className="resize-y border-0 bg-transparent shadow-none focus-visible:ring-0"
          />
          <div className="mt-2 flex flex-wrap items-center justify-between gap-3 px-1">
            <div className="flex min-w-0 items-center gap-2">
              <input
                ref={fileInput}
                type="file"
                multiple
                hidden
                aria-hidden
                tabIndex={-1}
                onChange={(e) => {
                  addFiles(Array.from(e.target.files ?? []));
                  e.target.value = '';
                }}
              />
              <IconButton label="Attach files" icon={<IconPaperclip />} onClick={() => fileInput.current?.click()} disabledReason={blocked} />
              <p className="hidden text-xs text-subtle sm:block">
                <Kbd>⌘</Kbd> <Kbd>Enter</Kbd> to send · drop or paste files to attach
              </p>
            </div>
            <Button
              type="submit"
              variant="primary"
              className="ml-auto"
              icon={<IconSend />}
              loading={sending}
              disabledReason={blocked ?? (uploads.uploading ? 'Wait until the uploads finish' : !prompt.trim() ? (uploads.ready.length ? 'Describe what to do with the attachments' : 'Write a task first') : null)}
            >
              Send{uploads.ready.length ? ` (${uploads.ready.length})` : ''}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

const NO_ATTS: Attachment[] = [];

/** One conversation item; memoised so a streamed step re-renders only the new row, not the whole history. */
const ChatItem = memo(function ChatItem({ it, agent, task, atts }: { it: TimelineItem; agent: Agent; task: Task | undefined; atts: Attachment[] | undefined }) {
  if (it.kind === 'message') {
    const m = it.msg;
    const t = task;
    const mine = m.role === 'user';
    return (
      <div className={`flex gap-2.5 ${mine ? 'justify-end' : 'justify-start'}`}>
        {!mine && <Avatar name={agent.name} id={agent.id} size="sm" className="mt-5 hidden sm:inline-grid" />}
        <div className={`flex max-w-[88%] min-w-0 flex-col sm:max-w-[78%] ${mine ? 'items-end' : 'items-start'}`}>
          <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1 px-1 text-2xs text-subtle">
            <span className="font-medium text-muted">{mine ? 'You' : m.channel === 'system' ? `${agent.name} · result` : agent.name}</span>
            {m.channel !== 'web' && m.channel !== 'system' && <span>via {m.channel}</span>}
            <span>{formatTime(m.created_at)}</span>
            {mine && t && (
              <a href={href(`/agents/${agent.id}/tasks?task=${t.id}`)} className="inline-flex items-center gap-1 rounded focus-ring">
                <Mono className="text-[10px]">{shortId(t.id)}</Mono>
                <StatusPill state={t.state} />
              </a>
            )}
          </div>
          <div
            className={`max-w-full min-w-0 rounded-2xl px-4 py-2.5 ${
              mine ? 'rounded-tr-md bg-accent/[0.18] text-text ring-1 ring-accent/25 ring-inset' : 'rounded-tl-md border border-border bg-panel-2 text-text'
            }`}
          >
            <p className="text-sm leading-relaxed break-words whitespace-pre-wrap">{m.content}</p>
            {mine && t?.failure_reason && isTerminal(t.state) && <p className="mt-1.5 text-xs text-danger">Failure: {t.failure_reason}</p>}
            {mine && m.task_id && <AttachmentStrip atts={atts ?? NO_ATTS} className="mt-2" />}
            {m.attachments?.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {m.attachments
                  .filter((a) => typeof a === 'string' && a.endsWith('.png'))
                  .slice(-4)
                  .map((a) => (
                    <ChatScreenshot key={a} refPath={a} />
                  ))}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }
  if (it.kind === 'text') {
    return (
      <div className="flex justify-start gap-2.5">
        <Avatar name={agent.name} id={agent.id} size="sm" className="mt-5 hidden sm:inline-grid" />
        <div className="flex max-w-[88%] min-w-0 flex-col sm:max-w-[78%]">
          <div className="mb-1 flex items-center gap-2 px-1 text-2xs text-subtle">
            <span className="font-medium text-muted">{agent.name}</span>
            {it.taskId && <Mono className="text-[10px]">{shortId(it.taskId)}</Mono>}
            <span>{formatTime(it.ts)}</span>
          </div>
          <div className="rounded-2xl rounded-tl-md border border-border bg-panel-2 px-4 py-2.5">
            <p className="text-sm leading-relaxed break-words whitespace-pre-wrap text-text">{it.text}</p>
          </div>
        </div>
      </div>
    );
  }
  if (it.kind === 'step') {
    return (
      <ul className="max-w-[88%] list-none sm:ml-10 sm:max-w-[78%]">
        <StepRow step={it.step} />
      </ul>
    );
  }
  return (
    <p className={`flex items-start gap-2 text-xs sm:ml-10 ${NOTE_CLS[it.tone]}`}>
      <span aria-hidden className={`mt-1.5 size-1.5 shrink-0 rounded-full ${NOTE_DOT[it.tone]}`} />
      <span className="min-w-0">
        {it.taskId && <Mono className="mr-1.5 text-[10px]">{shortId(it.taskId)}</Mono>}
        {it.text}
      </span>
    </p>
  );
});

function IconSend() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden className="size-4">
      <path d="M5 12h13M12 5l7 7-7 7" />
    </svg>
  );
}

/** A task screenshot in the chat (an object URL when the session uses a Bearer token, see lib/authedUrl). */
function ChatScreenshot({ refPath }: { refPath: string }) {
  const url = useAuthedUrl(artifactUrl(refPath));
  if (!url) return <span role="img" aria-label="Task screenshot" className="block h-24 w-36 animate-pulse-soft rounded-lg border border-border bg-panel-2" />;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className="rounded-lg focus-ring">
      <img src={url} alt="Task screenshot" loading="lazy" className="max-h-32 rounded-lg border border-border" />
    </a>
  );
}
