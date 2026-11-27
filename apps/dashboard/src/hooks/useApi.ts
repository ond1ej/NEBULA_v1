import { useCallback, useEffect, useRef, useState } from 'react';
import { useToast } from '../components/Toast';
import { useEventHub } from './useEvents';

export interface ApiState<T> {
  data: T | null;
  error: unknown;
  loading: boolean;
  reload: () => void;
  setData: (fn: (prev: T | null) => T | null) => void;
}

export interface ApiOptions {
  /** Poll interval while the tab is visible (polls are skipped in hidden tabs and caught up on return). */
  pollMs?: number;
  /**
   * Poll interval while the live event stream is connected (the events already push the changes; the poll is only a
   * safety net then). Falls back to `pollMs` while the stream is down.
   */
  livePollMs?: number;
}

/** True while the event stream is open (only subscribes when `enabled`). */
function useStreamOpen(enabled: boolean): boolean {
  const hub = useEventHub();
  const [open, setOpen] = useState(() => hub?.status === 'open');
  useEffect(() => {
    if (!enabled || !hub) return;
    setOpen(hub.status === 'open');
    return hub.onStatus((st) => setOpen(st === 'open'));
  }, [hub, enabled]);
  return enabled && open;
}

/**
 * Polls `run` every `ms` while the document is visible. Ticks that fall into a hidden period are skipped; the first
 * return to the tab then refreshes at once, so a background tab costs no requests and never shows stale data.
 */
export function useVisiblePoll(run: () => void, ms: number | null | undefined): void {
  const runRef = useRef(run);
  runRef.current = run;
  useEffect(() => {
    if (!ms) return;
    let missed = false;
    const t = setInterval(() => {
      if (document.visibilityState === 'hidden') missed = true;
      else runRef.current();
    }, ms);
    const onVis = () => {
      if (document.visibilityState !== 'hidden' && missed) {
        missed = false;
        runRef.current();
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [ms]);
}

/**
 * Loads data with a cancellable loader. Errors are kept in `error` (render <ErrorBanner/>) and
 * also toasted once per distinct message so failures are never silent.
 */
export function useApi<T>(loader: (signal: AbortSignal) => Promise<T>, deps: unknown[], opts: ApiOptions = {}): ApiState<T> {
  const toast = useToast();
  const [data, setDataState] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const ctl = useRef<AbortController | null>(null);
  const lastErr = useRef<string | null>(null);
  const mounted = useRef(true);

  const run = useCallback(() => {
    ctl.current?.abort();
    const c = new AbortController();
    ctl.current = c;
    setLoading(true);
    loaderRef
      .current(c.signal)
      .then((d) => {
        if (c.signal.aborted || !mounted.current) return;
        setDataState(d);
        setError(null);
        lastErr.current = null;
      })
      .catch((e: unknown) => {
        if (c.signal.aborted || !mounted.current) return;
        if (e instanceof DOMException && e.name === 'AbortError') return;
        setError(e);
        const msg = e instanceof Error ? e.message : String(e);
        if (lastErr.current !== msg) {
          lastErr.current = msg;
          toast.error(e, 'Loading failed');
        }
      })
      .finally(() => {
        if (!c.signal.aborted && mounted.current) setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toast]);

  useEffect(() => {
    mounted.current = true;
    run();
    return () => {
      ctl.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const streamOpen = useStreamOpen(Boolean(opts.livePollMs));
  useVisiblePoll(run, streamOpen && opts.livePollMs ? opts.livePollMs : opts.pollMs);

  const setData = useCallback((fn: (prev: T | null) => T | null) => setDataState((p) => fn(p)), []);
  return { data, error, loading, reload: run, setData };
}

/**
 * Wraps a mutation: tracks pending state per key, toasts explicit success / failure,
 * resolves to the result or `undefined` on failure.
 */
export function useAction() {
  const toast = useToast();
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const run = useCallback(
    async <R,>(key: string, fn: () => Promise<R>, opts: { success?: string | ((r: R) => string); errorTitle?: string } = {}) => {
      setPending((p) => ({ ...p, [key]: true }));
      try {
        const r = await fn();
        if (opts.success) toast.success(typeof opts.success === 'function' ? opts.success(r) : opts.success);
        return r;
      } catch (e) {
        toast.error(e, opts.errorTitle ?? 'Action failed');
        return undefined;
      } finally {
        setPending((p) => {
          const n = { ...p };
          delete n[key];
          return n;
        });
      }
    },
    [toast],
  );
  const isPending = useCallback((key: string) => Boolean(pending[key]), [pending]);
  return { run, isPending, anyPending: Object.keys(pending).length > 0 };
}

/** Re-renders every `ms` so countdowns / relative times stay fresh. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
