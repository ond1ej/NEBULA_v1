import { describe, expect, it } from 'vitest';
import type { Message } from '../types';
import type { ChatData } from './keys';
import { previewText } from './keys';
import {
  fromLegacy,
  mergeLatest,
  nearBottom,
  olderCursor,
  patchTask,
  prependOlder,
  restoreScrollTop,
  settledClientIds,
  taskPatchFromEvent,
  visibleMessages,
  type PendingMessage,
} from './model';

const m = (id: string, t: number, over: Partial<Message> = {}): Message => ({
  id,
  conversation_id: 'c1',
  agent_id: 'a1',
  task_id: null,
  role: 'assistant',
  channel: 'web',
  content: id,
  attachments: [],
  created_at: t,
  client_id: null,
  task: null,
  ...over,
});

describe('conversation pages', () => {
  it('a refreshed latest page keeps older messages loaded with "load earlier"', () => {
    const prev: ChatData = { items: [m('a', 1), m('b', 2), m('c', 3), m('d', 4)], hasMore: true };
    const latest = { items: [m('c', 3), m('d', 4), m('e', 5)], has_more: true };
    const merged = mergeLatest(prev, latest);
    expect(merged.items.map((x) => x.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(merged.hasMore).toBe(true);
    // a page that is the whole history replaces everything (deleted messages disappear)
    expect(mergeLatest(prev, { items: [m('b', 2), m('e', 5)], has_more: false }).items.map((x) => x.id)).toEqual(['b', 'e']);
    // first load
    expect(mergeLatest(null, latest)).toEqual({ items: latest.items, hasMore: true });
  });

  it('older pages go in front, deduplicated, with the cursor = oldest created_at', () => {
    const prev: ChatData = { items: [m('c', 3), m('d', 4)], hasMore: true };
    expect(olderCursor(prev)).toBe(3);
    const out = prependOlder(prev, { items: [m('a', 1), m('b', 2), m('c', 3)], has_more: false });
    expect(out.items.map((x) => x.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(out.hasMore).toBe(false);
  });

  it('loading older messages keeps the reading position (distance from the bottom stays constant)', () => {
    // 2000 px of content, scrolled to 100; 800 px are prepended
    expect(restoreScrollTop(2000, 100, 2800)).toBe(900);
    expect(restoreScrollTop(500, 0, 500)).toBe(0);
    expect(restoreScrollTop(500, 400, 300)).toBe(200);
    expect(nearBottom({ scrollHeight: 2000, scrollTop: 1500, clientHeight: 450 })).toBe(true);
    expect(nearBottom({ scrollHeight: 2000, scrollTop: 900, clientHeight: 450 })).toBe(false);
  });
});

describe('live task status', () => {
  const data: ChatData = { items: [m('u1', 1, { role: 'user', task_id: 't1', task: { id: 't1', state: 'QUEUED', started_at: null, finished_at: null, failure_reason: null } }), m('a1', 2)], hasMore: false };

  it('maps lifecycle events to the inline status (stage / step events are not lifecycle)', () => {
    expect(taskPatchFromEvent({ type: 'task.started', timestamp: 100, payload: {} })).toEqual({ state: 'EXECUTING', started_at: 100 });
    expect(taskPatchFromEvent({ type: 'task.completed', timestamp: 112, payload: {} })).toEqual({ state: 'COMPLETED', finished_at: 112 });
    expect(taskPatchFromEvent({ type: 'task.failed', timestamp: 9, payload: { reason: 'quota exceeded' } })).toEqual({ state: 'FAILED', finished_at: 9, failure_reason: 'quota exceeded' });
    expect(taskPatchFromEvent({ type: 'task.approval.requested', timestamp: 1, payload: {} })).toEqual({ state: 'WAITING_APPROVAL' });
    expect(taskPatchFromEvent({ type: 'task.stage', timestamp: 1, payload: { stage: 'tool' } })).toBeNull();
    expect(taskPatchFromEvent({ type: 'task.step', timestamp: 1, payload: {} })).toBeNull();
  });

  it('patches the message that created the task, never reopens a finished task, and is a no-op otherwise', () => {
    const started = patchTask(data, 't1', { state: 'EXECUTING', started_at: 100 });
    expect(started.items[0].task).toEqual({ id: 't1', state: 'EXECUTING', started_at: 100, finished_at: null, failure_reason: null });
    expect(started.items[1]).toBe(data.items[1]);
    const done = patchTask(started, 't1', { state: 'COMPLETED', finished_at: 112 });
    expect(done.items[0].task?.state).toBe('COMPLETED');
    expect(patchTask(done, 't1', { state: 'EXECUTING' })).toBe(done); // late event after the end
    expect(patchTask(data, 'other', { state: 'EXECUTING' })).toBe(data);
    // a user message whose task info is not loaded yet gets it from the event
    const bare: ChatData = { items: [m('u2', 1, { role: 'user', task_id: 't2' })], hasMore: false };
    expect(patchTask(bare, 't2', { state: 'EXECUTING', started_at: 5 }).items[0].task?.state).toBe('EXECUTING');
  });
});

describe('optimistic messages', () => {
  const pending = (over: Partial<PendingMessage>): PendingMessage => ({ client_id: 'k1', content: 'hi', attachments: [], created_at: 10, status: 'sending', ...over });

  it('show after the server messages until a page contains them (matched by client_id)', () => {
    const items = [m('a', 1)];
    const p = pending({});
    expect(visibleMessages(items, [p]).map((d) => d.kind)).toEqual(['message', 'pending']);
    // sent: shown as the server message, local attachments kept for display
    const sentMsg = m('u9', 11, { role: 'user', client_id: 'k1', content: 'hi' });
    const sent = pending({ status: 'sent', message: sentMsg });
    const before = visibleMessages(items, [sent]);
    expect(before.at(-1)).toEqual({ kind: 'message', message: sentMsg, local: sent });
    // the refetched page has it: one entry, not two, and the pending entry can be forgotten
    const after = visibleMessages([...items, sentMsg], [sent]);
    expect(after).toHaveLength(2);
    expect(after[1]).toEqual({ kind: 'message', message: sentMsg, local: sent });
    expect(settledClientIds([...items, sentMsg], [sent])).toEqual(['k1']);
    // with local attachments the entry stays while the server copy has none (they keep showing)
    const withFile = pending({ status: 'sent', message: sentMsg, attachments: [{ key: 'v', name: 'voice.ogg', size: 9, mime: 'audio/ogg', kind: 'audio', status: 'ready', progress: 1 }] });
    expect(settledClientIds([...items, sentMsg], [withFile])).toEqual([]);
    expect(settledClientIds([...items, { ...sentMsg, attachments: [{ id: 'att-v', name: 'voice.ogg' }] }], [withFile])).toEqual(['k1']);
    // failed messages stay until retried or discarded
    expect(settledClientIds(items, [pending({ status: 'failed' })])).toEqual([]);
  });

  it('legacy messages (no client_id) are matched by the created task', () => {
    const local = m('local-k1', 10, { role: 'user', task_id: 't5', client_id: 'k1' });
    const sent = pending({ status: 'sent', message: local });
    const server = fromLegacy({ id: 'srv', agent_id: 'a1', task_id: 't5', role: 'user', channel: 'web', content: 'hi', attachments: [], created_at: 10 });
    expect(visibleMessages([server], [sent])).toHaveLength(1);
    expect(settledClientIds([server], [sent])).toEqual(['k1']);
  });

  it('chat list previews drop Markdown markers', () => {
    expect(previewText('**Done.** See `out.csv` and [the report](https://x.example)\n\n```js\ncode\n```')).toBe('Done. See out.csv and the report [code]');
  });
});
