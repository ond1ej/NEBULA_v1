import { afterEach, describe, expect, it, vi } from 'vitest';
import { EVENT_TYPES, EventHub } from './useEvents';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  listeners = new Map<string, ((e: MessageEvent) => void)[]>();
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  closed = false;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  emit(type: string, data: unknown) {
    for (const fn of this.listeners.get(type) ?? []) fn(new MessageEvent(type, { data: JSON.stringify(data) }));
  }
  close() {
    this.closed = true;
  }
}

const ev = (sequence: number, type = 'task.message') => ({ id: `e${sequence}`, sequence, type, agent_id: 'a', task_id: 't', timestamp: 1, payload: {} });

describe('EventHub (SSE)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    FakeEventSource.instances = [];
  });

  it('listens to every named event type, dedupes by sequence and resumes with ?since=', () => {
    vi.useFakeTimers();
    vi.stubGlobal('EventSource', FakeEventSource);
    const hub = new EventHub();
    const seen: number[] = [];
    hub.subscribe((e) => seen.push(e.sequence));
    hub.start();

    const es = FakeEventSource.instances[0];
    expect(es.url).toBe('/api/v1/events');
    for (const t of EVENT_TYPES) expect(es.listeners.has(t)).toBe(true);

    es.onopen?.();
    expect(hub.status).toBe('open');
    es.emit('task.message', ev(5));
    es.emit('task.step', ev(6, 'task.step'));
    es.emit('task.step', ev(6, 'task.step')); // duplicate
    expect(seen).toEqual([5, 6]);

    es.onerror?.();
    expect(es.closed).toBe(true);
    expect(hub.status).toBe('reconnecting');
    vi.advanceTimersByTime(1000);
    const es2 = FakeEventSource.instances[1];
    expect(es2.url).toBe('/api/v1/events?since=6');
    es2.emit('task.completed', ev(7, 'task.completed'));
    expect(seen).toEqual([5, 6, 7]);
    hub.stop();
    expect(es2.closed).toBe(true);
  });
});
