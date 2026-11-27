// Server-Sent Events from GET /api/v1/events.
//
// The host emits *named* events (`event: <type>`), so a plain `onmessage` handler would never fire:
// we register a listener per known type. The host resumes from `?since=<sequence>` (it ignores the
// standard Last-Event-ID header), so on any error we close the EventSource ourselves and reopen
// with the last sequence we saw instead of relying on the browser's automatic reconnect.
// EventSource can only authenticate with the session cookie: with a Bearer transport (the Telegram Mini App) this hub
// stays idle and the Mini App provides its own streaming hub (mini/events.ts) through <EventsProvider hub=…>.
import { createContext, createElement, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { buildUrl, getTransport } from '../lib/http';
import { taskStagesFor } from '../lib/taskStages';
import type { NebulaEvent } from '../types';

/** Mirrors EVENT_TYPES in apps/host-api/nebula_host/events.py. */
export const EVENT_TYPES = [
  'agent.created',
  'agent.state.changed',
  'agent.deleted',
  'task.queued',
  'task.started',
  'task.step',
  'task.approval.requested',
  'task.approval.resolved',
  'task.paused',
  'task.resumed',
  'task.completed',
  'task.failed',
  'task.cancelled',
  'task.message',
  'vm.state.changed',
  'provider.quota',
  'provider.state.changed',
  'telegram.paired',
  'telegram.pairing.pending',
  'live.viewer.joined',
  'live.viewer.left',
  'live.control.changed',
  'install.progress',
  'system.health',
  // V2
  'team.run.started',
  'team.run.completed',
  'team.run.failed',
  'team.subtask.changed',
  'schedule.run.started',
  'schedule.run.finished',
  'workflow.run.started',
  'workflow.step',
  'workflow.run.finished',
  'owner.approval.requested',
  'owner.approval.resolved',
  'resource.alert',
  'file.created',
  'memory.changed',
  'skill.changed',
  // V3
  'company.created',
  'company.updated',
  'company.activity',
  'company.run.started',
  'company.run.finished',
  'company.item.changed',
  'environment.changed',
  'bot.state.changed',
  'attachment.processed',
  'remote.state.changed',
  // performance update: live execution stage of a running task, memory pressure transitions
  'task.stage',
  'resource.pressure.changed',
  // V3.2: Password Vault (metadata only — never a secret)
  'vault.status.changed',
  'vault.access',
  // V3.2.1: Smart Authentication (state + metadata only — never a password, code, token or cookie)
  'auth.session.updated',
  'auth.request',
  // V4.0: paired NEBULA apps for iPhone / Mac (metadata only)
  'app.device.changed',
] as const;

export type EventStatus = 'idle' | 'connecting' | 'open' | 'reconnecting';
type Listener = (ev: NebulaEvent) => void;
type StatusListener = (s: EventStatus) => void;

export class EventHub {
  private es: EventSource | null = null;
  private lastSeq: number | null = null;
  private listeners = new Set<Listener>();
  private statusListeners = new Set<StatusListener>();
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private running = false;
  status: EventStatus = 'idle';

  start(): void {
    if (this.running) return;
    this.running = true;
    this.open();
  }

  stop(): void {
    this.running = false;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.es?.close();
    this.es = null;
    this.setStatus('idle');
  }

  get lastSequence(): number | null {
    return this.lastSeq;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onStatus(fn: StatusListener): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  private setStatus(s: EventStatus): void {
    if (this.status === s) return;
    this.status = s;
    for (const l of [...this.statusListeners]) l(s);
  }

  private open(): void {
    if (!this.running || typeof EventSource === 'undefined' || getTransport().kind !== 'cookie') return;
    const url = buildUrl('/events', this.lastSeq !== null ? { since: this.lastSeq } : undefined);
    this.setStatus(this.attempts === 0 ? 'connecting' : 'reconnecting');
    const es = new EventSource(url, { withCredentials: true });
    this.es = es;
    const handler = (e: MessageEvent) => this.handle(e);
    for (const t of EVENT_TYPES) es.addEventListener(t, handler as EventListener);
    es.onmessage = handler; // unnamed events, if the host ever sends any
    es.onopen = () => {
      this.attempts = 0;
      this.setStatus('open');
    };
    es.onerror = () => {
      es.close();
      if (this.es === es) this.es = null;
      if (!this.running) return;
      this.attempts += 1;
      this.setStatus('reconnecting');
      const delay = Math.min(15_000, 1_000 * 2 ** Math.min(this.attempts - 1, 4));
      this.retryTimer = setTimeout(() => this.open(), delay);
    };
  }

  /** Exposed for tests. */
  handle(e: MessageEvent): void {
    let ev: NebulaEvent;
    try {
      ev = JSON.parse(String(e.data)) as NebulaEvent;
    } catch (err) {
      console.warn('NEBULA: malformed SSE event ignored', err, e.data);
      return;
    }
    if (typeof ev.sequence === 'number') {
      if (this.lastSeq !== null && ev.sequence <= this.lastSeq) return; // duplicate after resume
      this.lastSeq = ev.sequence;
    }
    for (const l of [...this.listeners]) {
      try {
        l(ev);
      } catch (err) {
        console.error('NEBULA: event listener failed', err);
      }
    }
  }
}

const HubContext = createContext<EventHub | null>(null);

export function EventsProvider({ children, hub }: { children: ReactNode; hub?: EventHub }) {
  const [h] = useState(() => {
    const created = hub ?? new EventHub();
    taskStagesFor(created); // record task.stage from the first event on, before any card mounts
    return created;
  });
  useEffect(() => {
    h.start();
    return () => h.stop();
  }, [h]);
  return createElement(HubContext.Provider, { value: h }, children);
}

export function useEventHub(): EventHub | null {
  return useContext(HubContext);
}

/** Subscribe to every SSE event; `handler` may change between renders. */
export function useNebulaEvents(handler: Listener): void {
  const hub = useContext(HubContext);
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!hub) return;
    return hub.subscribe((ev) => ref.current(ev));
  }, [hub]);
}

export function useEventStatus(): EventStatus {
  const hub = useContext(HubContext);
  const [s, setS] = useState<EventStatus>(hub?.status ?? 'idle');
  useEffect(() => {
    if (!hub) return;
    setS(hub.status);
    return hub.onStatus(setS);
  }, [hub]);
  return s;
}

/**
 * Re-run `reload` (debounced) whenever a matching event arrives, and after the stream
 * reconnects (events may have been missed while it was down).
 */
export function useLiveRefresh(reload: () => void, match: (ev: NebulaEvent) => boolean, delayMs = 300): void {
  const hub = useContext(HubContext);
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  const matchRef = useRef(match);
  matchRef.current = match;
  useEffect(() => {
    if (!hub) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        reloadRef.current();
      }, delayMs);
    };
    let prev = hub.status;
    const offEv = hub.subscribe((ev) => {
      if (matchRef.current(ev)) schedule();
    });
    const offSt = hub.onStatus((s) => {
      if (s === 'open' && prev === 'reconnecting') schedule();
      prev = s;
    });
    return () => {
      offEv();
      offSt();
      if (timer) clearTimeout(timer);
    };
  }, [hub, delayMs]);
}

export const isTaskEvent = (ev: NebulaEvent) => ev.type.startsWith('task.');

/**
 * High-frequency progress events of a running task. They never change a task row's state: `task.stage` is shown from
 * the stage store, `task.message` streams text. Lists and detail views must not refetch on them.
 */
export const TASK_PROGRESS_EVENTS: ReadonlySet<string> = new Set(['task.stage', 'task.message']);

/** Task events that change task rows (state, step count, approvals) — `task.step` included. */
export const isTaskChangeEvent = (ev: Pick<NebulaEvent, 'type'>) => ev.type.startsWith('task.') && !TASK_PROGRESS_EVENTS.has(ev.type);

/** Task events that change a task's lifecycle (not the per-tool `task.step` either). */
export const isTaskLifecycleEvent = (ev: Pick<NebulaEvent, 'type'>) => isTaskChangeEvent(ev) && ev.type !== 'task.step';
export const isAgentEvent = (ev: NebulaEvent) => ev.type.startsWith('agent.');
