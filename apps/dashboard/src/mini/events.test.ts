import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiError, installFetch, type RecordedCall } from '../test/fetchMock';
import type { NebulaEvent } from '../types';
import { MiniClient } from './client';
import { SseParser, StreamEventHub } from './events';

const enc = new TextEncoder();

function sse(chunks: string[], call: RecordedCall): Response {
  const body = new ReadableStream<Uint8Array>({
    start(ctrl) {
      for (const c of chunks) ctrl.enqueue(enc.encode(c));
      call.init.signal?.addEventListener('abort', () => {
        try {
          ctrl.error(new DOMException('aborted', 'AbortError'));
        } catch {
          // already closed
        }
      });
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

const ev = (sequence: number, type: string, payload: Record<string, unknown> = {}): string =>
  `id: ${sequence}\nevent: ${type}\ndata: ${JSON.stringify({ id: `e${sequence}`, sequence, type, agent_id: 'a1', task_id: null, timestamp: 1, payload })}\n\n`;

describe('SseParser', () => {
  it('parses named events split across chunks, multi-line data and ignores comments / retry', () => {
    const got: { event: string; data: string; id: string | null }[] = [];
    const p = new SseParser((m) => got.push(m));
    p.push('retry: 3000\n\n: keepalive\n\nid: 5\nevent: task.st');
    p.push('arted\ndata: {"a":');
    p.push('1}\r\n\r\ndata: line1\ndata: line2\n\n');
    expect(got).toEqual([
      { event: 'task.started', data: '{"a":1}', id: '5' },
      { event: 'message', data: 'line1\nline2', id: '5' },
    ]);
  });
});

describe('StreamEventHub (Bearer mode: fetch-streamed SSE)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('streams /api/v1/events with the Bearer token, dispatches events and reports open', async () => {
    const { calls } = installFetch({ 'GET /api/v1/events': (c) => sse(['retry: 3000\n\n', ev(1, 'task.started'), ev(2, 'live.control.changed', { holder: 'agent' })], c) });
    const hub = new StreamEventHub(new MiniClient({ mode: 'telegram', token: 'tok-1' }));
    const seen: NebulaEvent[] = [];
    hub.subscribe((e) => seen.push(e));
    const statuses: string[] = [];
    hub.onStatus((s) => statuses.push(s));
    hub.start();
    await vi.waitFor(() => expect(seen).toHaveLength(2));
    expect(seen.map((e) => e.type)).toEqual(['task.started', 'live.control.changed']);
    expect(hub.status).toBe('open');
    expect(statuses).toContain('connecting');
    expect(calls[0].headers.authorization).toBe('Bearer tok-1');
    expect(calls[0].headers.accept).toBe('text/event-stream');
    expect(calls[0].init.credentials).toBe('omit');
    expect(hub.lastSequence).toBe(2);
    hub.stop();
    expect(hub.status).toBe('idle');
  });

  it('resumes with ?since=<last sequence> after the stream ends', async () => {
    let n = 0;
    const { calls } = installFetch({
      'GET /api/v1/events': (c) => {
        n += 1;
        if (n === 1) {
          // first stream delivers one event and closes
          return new Response(enc.encode(ev(7, 'task.completed')), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
        }
        return sse([': keepalive\n\n'], c);
      },
    });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const hub = new StreamEventHub(new MiniClient({ mode: 'telegram', token: 't' }));
      hub.start();
      await vi.waitFor(() => expect(hub.lastSequence).toBe(7));
      await vi.advanceTimersByTimeAsync(1_500);
      await vi.waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(2));
      expect(calls[1].url).toBe('/api/v1/events?since=7');
      hub.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a 401 invalidates the Mini App session and stops streaming', async () => {
    installFetch({ 'GET /api/v1/events': () => apiError(401, 'unauthenticated', 'Mini App session required') });
    const client = new MiniClient({ mode: 'telegram', token: 't' });
    const expired = vi.fn();
    client.onUnauthorized(expired);
    const hub = new StreamEventHub(client);
    hub.start();
    await vi.waitFor(() => expect(expired).toHaveBeenCalledTimes(1));
    expect(hub.status).toBe('idle');
  });
});
