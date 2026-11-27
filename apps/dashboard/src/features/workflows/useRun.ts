// Live state of one workflow run: GET /workflow-runs/{rid}, polled while the run is active, refreshed
// immediately on SSE `workflow.step` / `workflow.run.finished` events for this run.
import { useCallback, useEffect, useRef, useState } from 'react';
import { buildUrl, getTransport } from '../../api';
import { EVENT_TYPES, useNebulaEvents } from '../../hooks/useEvents';
import { workflowsApi } from './api';
import { ACTIVE_RUN_STATES } from './graph';
import type { WorkflowRun } from './types';

const POLL_MS = 2000;
const WF_EVENTS = ['workflow.step', 'workflow.run.finished', 'workflow.run.started'] as const;
/** The shared EventHub only listens to the event names it knows. */
const hubHasWorkflowEvents = () => (EVENT_TYPES as readonly string[]).includes('workflow.step');

export function runIdOf(payload: unknown): string | null {
  if (payload && typeof payload === 'object' && 'run_id' in payload) {
    const v = (payload as { run_id?: unknown }).run_id;
    return typeof v === 'string' ? v : null;
  }
  return null;
}

export function useWorkflowRun(runId: string | null) {
  const [run, setRun] = useState<WorkflowRun | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const inflight = useRef<AbortController | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(() => {
    if (!runId) return;
    inflight.current?.abort();
    const c = new AbortController();
    inflight.current = c;
    setLoading(true);
    workflowsApi
      .getRun(runId, c.signal)
      .then((r) => {
        if (c.signal.aborted) return;
        setRun(r);
        setError(null);
      })
      .catch((e: unknown) => {
        if (c.signal.aborted || (e instanceof DOMException && e.name === 'AbortError')) return;
        setError(e);
      })
      .finally(() => {
        if (!c.signal.aborted) setLoading(false);
      });
  }, [runId]);

  const schedule = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      load();
    }, 150);
  }, [load]);

  useEffect(() => {
    setRun(null);
    setError(null);
    load();
    return () => {
      inflight.current?.abort();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [load]);

  const active = !!run && ACTIVE_RUN_STATES.has(run.state);

  // polling fallback while the run is active
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => {
      if (document.visibilityState !== 'hidden') load();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [active, load]);

  // shared event hub (delivers workflow events once it subscribes to them)
  useNebulaEvents((ev) => {
    if (ev.type.startsWith('workflow.') && runIdOf(ev.payload) === runId) schedule();
  });

  // dedicated stream for workflow events while the run is active, if the shared hub does not carry them (cookie
  // sessions only: EventSource cannot send the Mini App's Bearer token; there the shared hub and the poll suffice)
  useEffect(() => {
    if (!active || !runId || hubHasWorkflowEvents() || typeof EventSource === 'undefined' || getTransport().kind !== 'cookie') return;
    const es = new EventSource(buildUrl('/events'), { withCredentials: true });
    const onEv = (e: MessageEvent) => {
      try {
        const ev = JSON.parse(String(e.data)) as { payload?: unknown };
        if (runIdOf(ev.payload) === runId) schedule();
      } catch {
        // malformed event: the poll still catches up
      }
    };
    for (const t of WF_EVENTS) es.addEventListener(t, onEv as EventListener);
    es.onerror = () => es.close(); // polling continues; no reconnect storm
    return () => es.close();
  }, [active, runId, schedule]);

  return { run, error, loading, reload: load, active };
}
