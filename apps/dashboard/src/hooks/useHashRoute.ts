import { useSyncExternalStore } from 'react';

export interface Route {
  /** Path without query, always starting with '/', e.g. '/agents/abc/live'. */
  path: string;
  segments: string[];
  query: URLSearchParams;
}

// ---------------------------------------------------------------- route base
// The Dashboard's pages live at the root of the hash (#/agents/x). The Telegram Mini App mounts the same pages under a
// prefix (#/admin/agents/x): while its administration area is shown, href() / navigate() add the base and
// useHashRoute() removes it, so every page links and reads routes exactly as in the Dashboard.
let routeBase = '';

/** Sets the prefix of every Dashboard route ('' = the Dashboard itself, '/admin' = the Mini App's administration). */
export function setRouteBase(base: string): void {
  const b = base.replace(/\/+$/, '');
  routeBase = b && !b.startsWith('/') ? `/${b}` : b;
}

export function getRouteBase(): string {
  return routeBase;
}

const slash = (p: string) => (p.startsWith('/') ? p : `/${p}`);

/** '/agents/x' -> '/admin/agents/x' (a path that already carries the base is kept). */
export function withRouteBase(path: string): string {
  const p = slash(path);
  if (!routeBase || p === routeBase || p.startsWith(`${routeBase}/`) || p.startsWith(`${routeBase}?`)) return p;
  return p === '/' ? routeBase : p.startsWith('/?') ? `${routeBase}${p.slice(1)}` : `${routeBase}${p}`;
}

/** '/admin/agents/x' -> '/agents/x' */
export function stripRouteBase(path: string): string {
  if (!routeBase) return path;
  if (path === routeBase) return '/';
  return path.startsWith(`${routeBase}/`) ? path.slice(routeBase.length) : path;
}

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, '') || '/';
  const qi = raw.indexOf('?');
  const pathPart = qi >= 0 ? raw.slice(0, qi) : raw;
  const queryPart = qi >= 0 ? raw.slice(qi + 1) : '';
  const path = pathPart.startsWith('/') ? pathPart : `/${pathPart}`;
  const segments = path
    .split('/')
    .filter(Boolean)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
  return { path, segments, query: new URLSearchParams(queryPart) };
}

function subscribe(cb: () => void): () => void {
  window.addEventListener('hashchange', cb);
  window.addEventListener('popstate', cb);
  return () => {
    window.removeEventListener('hashchange', cb);
    window.removeEventListener('popstate', cb);
  };
}

function snapshot(): string {
  return window.location.hash;
}

export function useHashRoute(): Route {
  const hash = useSyncExternalStore(subscribe, snapshot, () => '');
  if (!routeBase) return parseHash(hash);
  const raw = hash.replace(/^#/, '') || '/';
  const qi = raw.indexOf('?');
  const path = stripRouteBase(qi >= 0 ? raw.slice(0, qi) : raw);
  return parseHash(`${path}${qi >= 0 ? raw.slice(qi) : ''}`);
}

export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  const target = `#${withRouteBase(to.startsWith('#') ? to.slice(1) : to)}`;
  if (opts.replace) {
    // keep the entry's state (the Mini App numbers its history entries there)
    window.history.replaceState(window.history.state, '', target);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else {
    window.location.hash = target;
  }
}

export function href(path: string): string {
  return `#${withRouteBase(path)}`;
}
