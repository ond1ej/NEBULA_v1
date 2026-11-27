// Data hooks of the Mini App: stale-while-revalidate queries (instant back navigation), event-driven refresh with a
// polling fallback, offline awareness, and mutations with toasts + Telegram haptics.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ApiError } from '../lib/http';
import { useToast } from '../components/Toast';
import { useEventHub, useEventStatus } from '../hooks/useEvents';
import type { NebulaEvent } from '../types';
import { getWebApp, haptic } from './telegram';

// ---------------------------------------------------------------- shared query store
// One cache entry and at most one request in flight per key, shared by every mounted screen / tab bar that asks for
// it: the tab bar badge and the Approvals screen ('approvals:count') or two cards of one task never fetch twice.
const cache = new Map<string, unknown>();

/** Logical clock: orders events and request starts unambiguously (wall-clock milliseconds can tie). */
let clock = 0;
const tick = () => (clock += 1);

interface Flight {
  promise: Promise<unknown>;
  startedAt: number;
  ctl: AbortController;
  users: number;
}
const inflight = new Map<string, Flight>();
/** Start tick of the newest response applied per key: an older, slower response never overwrites a newer one. */
const applied = new Map<string, number>();
const subscribers = new Map<string, Set<(data: unknown) => void>>();
/** Wall-clock time of the last server response per key: a screen mounting right after it does not refetch. */
const fetchedAt = new Map<string, number>();
const FRESH_MS = 5_000;

/** `startedAt`: when the request that produced `data` started; null for local updates (setData), which never block a response. */
function publish(key: string, data: unknown, startedAt: number | null): void {
  if (startedAt !== null) {
    if ((applied.get(key) ?? -Infinity) > startedAt) return;
    applied.set(key, startedAt);
    fetchedAt.set(key, Date.now());
  }
  cache.set(key, data);
  for (const fn of [...(subscribers.get(key) ?? [])]) fn(data);
}

export function clearQueryCache(): void {
  cache.clear();
  applied.clear();
  fetchedAt.clear();
  for (const f of inflight.values()) f.ctl.abort();
  inflight.clear();
}

/** Starts (or joins) the request for `key`. `joinAfter` (tick): join an in-flight request only if it started after it. */
function fetchShared<T>(key: string, loader: (signal: AbortSignal) => Promise<T>, joinAfter: number): { flight: Flight; release: () => void } {
  let f = inflight.get(key);
  if (!f || !(f.startedAt > joinAfter)) {
    const ctl = new AbortController();
    const startedAt = tick();
    const promise = Promise.resolve().then(() => loader(ctl.signal));
    const flight: Flight = { promise, startedAt, ctl, users: 0 };
    inflight.set(key, flight);
    promise.then(
      (d) => {
        if (inflight.get(key) === flight) inflight.delete(key);
        if (!ctl.signal.aborted) publish(key, d, startedAt);
      },
      () => {
        if (inflight.get(key) === flight) inflight.delete(key);
      },
    );
    f = flight;
  }
  const flight = f;
  flight.users += 1;
  let released = false;
  return {
    flight,
    release: () => {
      if (released) return;
      released = true;
      flight.users -= 1;
      if (flight.users <= 0 && inflight.get(key) === flight) {
        flight.ctl.abort(); // nobody waits for it any more (screen left, key changed)
        inflight.delete(key);
      }
    },
  };
}

/** The cached value of a key (null when nothing was loaded yet). */
export function peekQuery<T>(key: string): T | null {
  return cache.has(key) ? (cache.get(key) as T) : null;
}

/** Local update of a key outside a component (optimistic changes, seeding a detail from a list row). */
export function setQueryData<T>(key: string, fn: (prev: T | null) => T | null): void {
  publish(key, fn(peekQuery<T>(key)), null);
}

/** Marks a key stale: the next screen that shows it refetches (its cached data stays visible meanwhile). */
export function invalidateQuery(key: string): void {
  fetchedAt.delete(key);
}

/** Follows a key's cached value without ever fetching it (badges that must not add requests). */
export function useCachedQuery<T>(key: string): T | null {
  const [data, setData] = useState<T | null>(() => peekQuery<T>(key));
  useEffect(() => {
    setData(peekQuery<T>(key));
    let set = subscribers.get(key);
    if (!set) subscribers.set(key, (set = new Set()));
    const fn = (d: unknown) => setData(d as T);
    set.add(fn);
    return () => {
      set.delete(fn);
      if (set.size === 0 && subscribers.get(key) === set) subscribers.delete(key);
    };
  }, [key]);
  return data;
}

/** Starts loading a key before its screen mounts (pointer down on a row); the screen then joins this request. */
export function prefetchQuery<T>(key: string, loader: (signal: AbortSignal) => Promise<T>): void {
  if (cache.has(key) || inflight.has(key)) return;
  const { flight, release } = fetchShared(key, loader, -Infinity);
  flight.promise.then(release, release);
}

export interface QueryOptions {
  /** Refresh when a matching host event arrives (live). */
  refreshOn?: (ev: NebulaEvent) => boolean;
  /** Polling interval used while live events are unavailable (or always, without refreshOn). */
  pollMs?: number;
  enabled?: boolean;
  /**
   * Refresh once whenever the app is back in the foreground (visible again, Telegram's "activated"), however short the
   * break was — for what may have moved on meanwhile (an open sign-in request). Without it: after 15 s away.
   */
  resume?: boolean;
}

export interface QueryState<T> {
  data: T | null;
  error: unknown;
  loading: boolean;
  refreshing: boolean;
  /** The last failure was a network error (offline / host unreachable). */
  offline: boolean;
  reload: () => void;
  setData: (fn: (prev: T | null) => T | null) => void;
}

const isNetwork = (e: unknown) => e instanceof ApiError && e.status === 0;

export function useQuery<T>(key: string | null, loader: (signal: AbortSignal) => Promise<T>, opts: QueryOptions = {}): QueryState<T> {
  const enabled = opts.enabled !== false && key !== null;
  const [data, setDataState] = useState<T | null>(() => (key && cache.has(key) ? (cache.get(key) as T) : null));
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(enabled && !(key && cache.has(key)));
  const [refreshing, setRefreshing] = useState(false);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const keyRef = useRef(key);
  const release = useRef<(() => void) | null>(null);

  /** joinAfter: -Infinity = any in-flight request will do; Infinity = always a new request. */
  const runFrom = useCallback((joinAfter: number) => {
    const k = keyRef.current;
    if (!k) return;
    // a response requested after the triggering event was already applied (another view of this key fetched it)
    if (Number.isFinite(joinAfter) && (applied.get(k) ?? -Infinity) > joinAfter && !inflight.has(k)) return;
    release.current?.();
    const { flight, release: rel } = fetchShared(k, (s) => loaderRef.current(s), joinAfter);
    release.current = rel;
    setRefreshing(true);
    /** True when this call is still the instance's latest request (not superseded, key unchanged); releases it. */
    const settle = () => {
      const latest = release.current === rel && keyRef.current === k && !flight.ctl.signal.aborted;
      if (release.current === rel) release.current = null;
      rel();
      return latest;
    };
    flight.promise.then(
      () => {
        if (!settle()) return;
        // the data itself arrives through the subscription (publish); here only the request state
        setError(null);
        setLoading(false);
        setRefreshing(false);
      },
      (e: unknown) => {
        if (!settle()) return;
        if (e instanceof DOMException && e.name === 'AbortError') return;
        setError(e);
        setLoading(false);
        setRefreshing(false);
      },
    );
  }, []);
  const runRef = useRef(runFrom);
  runRef.current = runFrom;
  const reload = useCallback(() => runFrom(Infinity), [runFrom]);

  // every instance of a key sees every response for it (and optimistic setData from any of them)
  useEffect(() => {
    if (!enabled || !key) return;
    let set = subscribers.get(key);
    if (!set) subscribers.set(key, (set = new Set()));
    const fn = (d: unknown) => {
      if (keyRef.current !== key) return;
      setDataState(d as T);
      setError(null);
      setLoading(false);
    };
    set.add(fn);
    return () => {
      set.delete(fn);
      if (set.size === 0 && subscribers.get(key) === set) subscribers.delete(key);
    };
  }, [key, enabled]);

  useEffect(() => {
    keyRef.current = key;
    if (!enabled || !key) {
      setLoading(false);
      return;
    }
    const cached = cache.has(key) ? (cache.get(key) as T) : null;
    setDataState(cached);
    setError(null);
    setLoading(cached === null);
    // just loaded by another view (tab bar badge, a prefetch on touch): live events keep it current from here
    const fresh = cached !== null && !inflight.has(key) && Date.now() - (fetchedAt.get(key) ?? 0) < FRESH_MS;
    if (!fresh) runFrom(-Infinity);
    return () => {
      release.current?.();
      release.current = null;
    };
  }, [key, enabled, runFrom]);

  // live refresh: debounced; joins a request only if it started after the event (it then already sees the change)
  const hub = useEventHub();
  const refreshOnRef = useRef(opts.refreshOn);
  refreshOnRef.current = opts.refreshOn;
  const hasRefreshOn = Boolean(opts.refreshOn);
  useEffect(() => {
    if (!hub || !enabled || !hasRefreshOn) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let since = Infinity;
    const schedule = (at: number) => {
      since = Math.min(since, at);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const s = since;
        since = Infinity;
        runRef.current(s);
      }, 300);
    };
    let prev = hub.status;
    const offEv = hub.subscribe((ev) => {
      if (refreshOnRef.current?.(ev)) schedule(tick());
    });
    const offSt = hub.onStatus((st) => {
      if (st === 'open' && prev === 'reconnecting') schedule(tick());
      prev = st;
    });
    return () => {
      offEv();
      offSt();
      if (timer) clearTimeout(timer);
    };
  }, [hub, enabled, hasRefreshOn]);

  const status = useEventStatus();
  const live = status === 'open' && hasRefreshOn;
  const pollMs = opts.pollMs ?? (hasRefreshOn ? 20_000 : 0);
  useEffect(() => {
    if (!enabled || !pollMs || live) return;
    const t = setInterval(() => {
      if (document.visibilityState !== 'hidden') runRef.current(-Infinity);
    }, pollMs);
    return () => clearInterval(t);
  }, [enabled, pollMs, live]);

  // back online / back to the foreground: refresh (one request when "visible" and "activated" arrive together)
  const resume = opts.resume === true;
  useEffect(() => {
    if (!enabled) return;
    let hiddenAt = 0;
    let last = 0;
    const fresh = () => runRef.current(tick());
    const back = () => {
      if (Date.now() - last < 1000) return;
      last = Date.now();
      fresh();
    };
    const onVis = () => {
      if (document.visibilityState === 'hidden') hiddenAt = Date.now();
      else if (hiddenAt && (resume || Date.now() - hiddenAt > 15_000)) {
        hiddenAt = 0;
        back();
      }
    };
    window.addEventListener('online', fresh);
    document.addEventListener('visibilitychange', onVis);
    const wa = resume ? getWebApp() : null;
    try {
      wa?.onEvent?.('activated', back);
    } catch {
      // older Telegram clients: visibilitychange only
    }
    return () => {
      window.removeEventListener('online', fresh);
      document.removeEventListener('visibilitychange', onVis);
      try {
        wa?.offEvent?.('activated', back);
      } catch {
        // ignore
      }
    };
  }, [enabled, resume]);

  const setData = useCallback((fn: (prev: T | null) => T | null) => {
    const k = keyRef.current;
    if (!k) {
      setDataState((p) => fn(p));
      return;
    }
    const next = fn((cache.has(k) ? cache.get(k) : null) as T | null);
    publish(k, next, null);
  }, []);

  return { data, error, loading, refreshing, offline: isNetwork(error), reload, setData };
}

/**
 * Events that change GET /approval-center: approvals, and Smart Authentication sessions (`sign_ins`). The tab bar badge
 * and Activity share this predicate and one request per key.
 */
export const approvalCenterEvent = (ev: Pick<NebulaEvent, 'type'>): boolean =>
  ev.type.includes('approval') || ev.type === 'auth.request' || ev.type === 'auth.session.updated';

/** Mutations: pending state per key, explicit success / failure toasts and haptic feedback. */
export function useActions() {
  const toast = useToast();
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const run = useCallback(
    async <R>(key: string, fn: () => Promise<R>, opts: { success?: string | ((r: R) => string); errorTitle?: string; quiet?: boolean } = {}) => {
      haptic('impact');
      setPending((p) => ({ ...p, [key]: true }));
      try {
        const r = await fn();
        haptic('success');
        if (opts.success && !opts.quiet) toast.success(typeof opts.success === 'function' ? opts.success(r) : opts.success);
        return r;
      } catch (e) {
        haptic('error');
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
  return { run, isPending };
}

function subscribeOnline(cb: () => void): () => void {
  window.addEventListener('online', cb);
  window.addEventListener('offline', cb);
  return () => {
    window.removeEventListener('online', cb);
    window.removeEventListener('offline', cb);
  };
}

export function useOnline(): boolean {
  return useSyncExternalStore(
    subscribeOnline,
    () => (typeof navigator === 'undefined' ? true : navigator.onLine !== false),
    () => true,
  );
}

/** Re-renders every `ms` (relative times). */
export function useTick(ms = 30_000): number {
  const [n, setN] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setN(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return n;
}
