// Conversation data logic (pure, unit-tested): merging pages into the per-conversation cache, optimistic messages,
// task status patches from live events, and scroll anchoring when older messages are prepended.
import type { ChatMessage, NebulaEvent } from '../../types';
import type { Attachment, Message, MessagePage, MessageTask } from '../types';
import type { ChatData } from './keys';

// ---------------------------------------------------------------- pages
const byTime = (a: Message, b: Message) => a.created_at - b.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function dedupe(items: Message[]): Message[] {
  const seen = new Map<string, Message>();
  for (const m of items) seen.set(m.id, m);
  return [...seen.values()].sort(byTime);
}

/**
 * The latest page replaces the newest part of the cache; older messages loaded earlier ("load earlier") stay.
 * `hasMore` is the page's unless older cached messages extend beyond it.
 */
export function mergeLatest(prev: ChatData | null, page: MessagePage): ChatData {
  if (!prev || prev.items.length === 0) return { items: dedupe(page.items), hasMore: page.has_more };
  if (page.items.length === 0) return { items: [], hasMore: false };
  const oldest = page.items[0].created_at;
  const ids = new Set(page.items.map((m) => m.id));
  const older = page.has_more ? prev.items.filter((m) => m.created_at < oldest && !ids.has(m.id)) : [];
  return { items: dedupe([...older, ...page.items]), hasMore: older.length ? prev.hasMore : page.has_more };
}

/** An older page (cursor `before` = oldest loaded created_at) goes in front. */
export function prependOlder(prev: ChatData | null, page: MessagePage): ChatData {
  if (!prev) return { items: dedupe(page.items), hasMore: page.has_more };
  return { items: dedupe([...page.items, ...prev.items]), hasMore: page.has_more };
}

/** Cursor for the next older page. */
export const olderCursor = (data: ChatData | null): number | undefined => data?.items[0]?.created_at;

// ---------------------------------------------------------------- live task status
const EMPTY_TASK = (id: string): MessageTask => ({ id, state: 'QUEUED', started_at: null, finished_at: null, failure_reason: null });

/** Task lifecycle event → the fields of the inline task status it changes (null: not a lifecycle event). */
export function taskPatchFromEvent(ev: Pick<NebulaEvent, 'type' | 'timestamp' | 'payload'>): Partial<MessageTask> | null {
  const at = typeof ev.timestamp === 'number' ? ev.timestamp : null;
  switch (ev.type) {
    case 'task.queued':
      return { state: 'QUEUED' };
    case 'task.started':
      return { state: 'EXECUTING', started_at: at };
    case 'task.resumed':
    case 'task.approval.resolved':
      return { state: 'EXECUTING' };
    case 'task.approval.requested':
      return { state: 'WAITING_APPROVAL' };
    case 'task.paused':
      return { state: 'PAUSED' };
    case 'task.completed':
      return { state: 'COMPLETED', finished_at: at };
    case 'task.failed': {
      const reason = ev.payload && typeof ev.payload.reason === 'string' ? ev.payload.reason : null;
      return { state: 'FAILED', finished_at: at, failure_reason: reason };
    }
    case 'task.cancelled':
      return { state: 'CANCELLED', finished_at: at };
    default:
      return null;
  }
}

const TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);

function patchOne(m: Message, taskId: string, patch: Partial<MessageTask>): Message {
  if (m.task_id !== taskId || m.role !== 'user') return m;
  const cur = m.task ?? EMPTY_TASK(taskId);
  // a late "started" never reopens a finished task (events may arrive out of order around a reconnect)
  if (TERMINAL.has(cur.state) && patch.state && !TERMINAL.has(patch.state)) return m;
  const next: MessageTask = { ...cur, ...patch, started_at: patch.started_at ?? cur.started_at };
  if (next.state === cur.state && next.finished_at === cur.finished_at && next.started_at === cur.started_at && next.failure_reason === cur.failure_reason) return m;
  return { ...m, task: next };
}

/** Applies a task patch to the message that created the task; returns the same object when nothing changed. */
export function patchTask(data: ChatData, taskId: string, patch: Partial<MessageTask>): ChatData {
  let changed = false;
  const items = data.items.map((m) => {
    const n = patchOne(m, taskId, patch);
    if (n !== m) changed = true;
    return n;
  });
  return changed ? { ...data, items } : data;
}

export const isTerminalTask = (state: string | null | undefined) => TERMINAL.has(state ?? '');

// ---------------------------------------------------------------- optimistic messages
export type UploadState = 'uploading' | 'processing' | 'ready' | 'error';

/** A file chosen in the composer (before / while uploading). */
export interface LocalAttachment {
  key: string;
  name: string;
  size: number;
  mime: string;
  kind: 'image' | 'video' | 'audio' | 'file';
  status: UploadState;
  /** 0..1 upload progress (XHR). */
  progress: number;
  attachment?: Attachment;
  error?: string;
  /** Recorded in the composer (voice message). */
  voice?: boolean;
  /** Local object URL (images / audio preview); revoked when the chip goes away. */
  previewUrl?: string;
}

export interface PendingMessage {
  client_id: string;
  content: string;
  attachments: LocalAttachment[];
  /** Local epoch seconds (display only; the server message replaces it). */
  created_at: number;
  status: 'sending' | 'failed' | 'sent';
  error?: string;
  /** The server's message once the send succeeded (kept until a refetch contains it). */
  message?: Message;
}

export type DisplayItem = { kind: 'message'; message: Message; local?: PendingMessage } | { kind: 'pending'; pending: PendingMessage };

/**
 * What the list renders: server messages, then optimistic ones not yet in a server page (matched by client_id or,
 * for the legacy endpoint without client_id, by the created task). Local attachments of a sent message are kept for
 * display when the server message carries none.
 */
export function visibleMessages(items: Message[], pending: PendingMessage[]): DisplayItem[] {
  const byClient = new Map(pending.map((p) => [p.client_id, p]));
  const byTask = new Map(pending.filter((p) => p.message?.task_id).map((p) => [p.message?.task_id as string, p]));
  const matched = new Set<string>();
  const out: DisplayItem[] = items.map((m) => {
    const local = (m.client_id && byClient.get(m.client_id)) || (m.role === 'user' && m.task_id ? byTask.get(m.task_id) : undefined);
    if (local) matched.add(local.client_id);
    return local ? { kind: 'message', message: m, local } : { kind: 'message', message: m };
  });
  const oldest = items.length ? items[0].created_at : -Infinity;
  for (const p of pending) {
    if (matched.has(p.client_id)) continue;
    // a sent message older than the loaded window belongs to an older page: not appended at the end
    if (p.message && p.message.created_at < oldest) continue;
    out.push(p.message ? { kind: 'message', message: p.message, local: p } : { kind: 'pending', pending: p });
  }
  return out;
}

/**
 * Pending entries that a server page now contains (safe to forget). Entries with local attachments are kept while the
 * server copy carries none (hosts that do not store attachment refs on the owner's message): they still show them.
 */
export function settledClientIds(items: Message[], pending: PendingMessage[]): string[] {
  const byClient = new Map(items.filter((m) => m.client_id).map((m) => [m.client_id as string, m]));
  const byTask = new Map(items.filter((m) => m.role === 'user' && m.task_id).map((m) => [m.task_id as string, m]));
  return pending
    .filter((p) => {
      if (p.status !== 'sent') return false;
      const server = byClient.get(p.client_id) ?? (p.message?.task_id ? byTask.get(p.message.task_id) : undefined);
      if (!server) return false;
      return p.attachments.length === 0 || server.attachments.length > 0;
    })
    .map((p) => p.client_id);
}

export function newClientId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// ---------------------------------------------------------------- legacy (GET /agents/{id}/messages)
export function fromLegacy(m: ChatMessage): Message {
  return {
    id: m.id,
    conversation_id: '',
    agent_id: m.agent_id,
    task_id: m.task_id,
    role: m.role,
    channel: m.channel,
    content: m.content,
    attachments: m.attachments ?? [],
    created_at: m.created_at,
    client_id: null,
    task: null,
  };
}

// ---------------------------------------------------------------- scroll anchoring
/**
 * After content was prepended above the viewport, the scrollTop that keeps the same message under the user's eyes:
 * the distance from the bottom stays constant.
 */
export function restoreScrollTop(prevScrollHeight: number, prevScrollTop: number, newScrollHeight: number): number {
  return Math.max(0, newScrollHeight - (prevScrollHeight - prevScrollTop));
}

/** Close enough to the bottom to follow new messages automatically. */
export const nearBottom = (el: { scrollHeight: number; scrollTop: number; clientHeight: number }, slack = 160) =>
  el.scrollHeight - el.scrollTop - el.clientHeight <= slack;
