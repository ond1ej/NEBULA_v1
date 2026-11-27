// Hash router of the Mini App with a history index, so Telegram's BackButton can mirror in-app navigation.
//
// Deep links used by NEBULA's Telegram buttons: #/agents/<id> (the agent's chat), #/agents/<id>/desktop,
// #/agents/new (the agent creator), #/agents/<id>/settings (agent settings), #/tasks/<id>,
// #/companies/<id>, #/company-runs/<id>, #/approvals, #/notifications, #/chats/<conversation id>, #/auth/<sign-in session id>,
// #/admin and #/admin/<dashboard path> (V3.3: the owner's administration area). Telegram appends its launch parameters to the hash (`#/path?tgWebAppData=…&tgWebAppVersion=…`,
// or `#tgWebAppData=…` without a path); those are stripped here and never become part of a route.
// `startapp` links (t.me/<bot>/<app>?startapp=…) arrive as start_param: see startParamToPath.
import { useSyncExternalStore } from 'react';

export interface MiniRoute {
  /** '/agents/abc/desktop' (no query) */
  path: string;
  segments: string[];
  query: URLSearchParams;
}

const TG_PARAM = /^tgWebApp/i;

/** Removes Telegram launch parameters from a location.hash; returns '/path?query' (always starting with '/'). */
export function cleanHash(hash: string): string {
  let raw = hash.replace(/^#/, '');
  // `#tgWebAppData=…` (no path) or `#/path#tgWebAppData=…` (defensive)
  const hashInHash = raw.indexOf('#');
  if (hashInHash >= 0) raw = raw.slice(0, hashInHash);
  let pathPart = raw;
  let queryPart = '';
  const qi = raw.indexOf('?');
  if (qi >= 0) {
    pathPart = raw.slice(0, qi);
    queryPart = raw.slice(qi + 1);
  } else if (raw.includes('=') && !raw.startsWith('/')) {
    pathPart = '';
    queryPart = raw;
  }
  // `/path&tgWebAppData=…` (a client that appended with '&')
  const amp = pathPart.indexOf('&');
  if (amp >= 0) {
    queryPart = `${pathPart.slice(amp + 1)}${queryPart ? `&${queryPart}` : ''}`;
    pathPart = pathPart.slice(0, amp);
  }
  const q = new URLSearchParams(queryPart);
  for (const k of [...q.keys()]) if (TG_PARAM.test(k)) q.delete(k);
  let path = pathPart.startsWith('/') ? pathPart : `/${pathPart}`;
  if (path.length > 1) path = path.replace(/\/+$/, '');
  const qs = q.toString();
  return qs ? `${path}?${qs}` : path;
}

export function parseMiniHash(hash: string): MiniRoute {
  const clean = cleanHash(hash);
  const qi = clean.indexOf('?');
  const path = qi >= 0 ? clean.slice(0, qi) : clean;
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
  return { path, segments, query: new URLSearchParams(qi >= 0 ? clean.slice(qi + 1) : '') };
}

const ID = '[A-Za-z0-9-]+';
const START_PARAM_RULES: [RegExp, (m: RegExpExecArray) => string][] = [
  [new RegExp(`^(?:agent|agents)_(${ID})_desktop$`), (m) => `/agents/${m[1]}/desktop`],
  [new RegExp(`^desktop_(${ID})$`), (m) => `/agents/${m[1]}/desktop`],
  [new RegExp(`^(?:agent|agents)_(${ID})_(chat|tasks|memory|files|skills|settings|details|security|vault)$`), (m) => `/agents/${m[1]}/${m[2]}`],
  [new RegExp(`^(?:agent|agents)_(${ID})$`), (m) => `/agents/${m[1]}`],
  [new RegExp(`^(?:chat|conversation)_(${ID})$`), (m) => `/chats/${m[1]}`],
  [new RegExp(`^(?:task|tasks)_(${ID})$`), (m) => `/tasks/${m[1]}`],
  [new RegExp(`^(?:company|companies)_(${ID})$`), (m) => `/companies/${m[1]}`],
  [new RegExp(`^run_(${ID})$`), (m) => `/company-runs/${m[1]}`],
  [/^(?:auth|signin)_(as_[0-9a-f]{6,64})$/, (m) => `/auth/${m[1]}`],
  [/^vault$/, () => '/settings/vault'],
  [/^admin$/, () => '/admin'],
  [/^(approvals|notifications|companies|agents|workflows|files|settings|activity|chats)$/, (m) => (m[1] === 'chats' ? '/' : `/${m[1]}`)],
];

/**
 * Telegram `startapp` parameters may only contain [A-Za-z0-9_-], so routes are encoded as
 * `agent_<id>`, `agent_<id>_desktop`, `chat_<id>`, `task_<id>`, `company_<id>`, `run_<id>`, `approvals`, `vault`, …
 */
export function startParamToPath(param: string | null | undefined): string | null {
  if (!param) return null;
  for (const [re, to] of START_PARAM_RULES) {
    const m = re.exec(param);
    if (m) return to(m);
  }
  return null;
}

// ---------------------------------------------------------------- history with an index
interface NbState {
  nbIdx?: number;
}

let currentIdx = 0;
const listeners = new Set<() => void>();

function readIdx(): number | null {
  const st = window.history.state as NbState | null;
  return st && typeof st.nbIdx === 'number' ? st.nbIdx : null;
}

function syncIdx(): void {
  const idx = readIdx();
  if (idx !== null) {
    currentIdx = idx;
    return;
  }
  // a plain <a href="#/…"> created this entry: number it after the entry we came from
  currentIdx += 1;
  window.history.replaceState({ ...((window.history.state as object | null) ?? {}), nbIdx: currentIdx }, '');
}

function emit(): void {
  for (const l of [...listeners]) l();
}

let installed = false;
function onLocation(): void {
  syncIdx();
  emit();
}

/**
 * Called once at boot: removes Telegram launch params from the URL, applies a deep link from start_param when the
 * hash has no route, and numbers the first history entry 0.
 */
export function initRouter(startParam?: string | null): void {
  const clean = cleanHash(window.location.hash);
  const deep = clean === '/' ? startParamToPath(startParam) : null;
  const target = deep ?? clean;
  const prev = readIdx();
  currentIdx = prev ?? 0;
  window.history.replaceState({ ...((window.history.state as object | null) ?? {}), nbIdx: currentIdx }, '', `#${target}`);
  if (!installed) {
    installed = true;
    window.addEventListener('popstate', onLocation);
    window.addEventListener('hashchange', onLocation);
  }
  emit();
}

export function historyIndex(): number {
  return currentIdx;
}

export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  const target = `#${to.startsWith('/') ? to : `/${to}`}`;
  if (window.location.hash === target && !opts.replace) return;
  if (opts.replace) {
    window.history.replaceState({ nbIdx: currentIdx }, '', target);
  } else {
    currentIdx += 1;
    window.history.pushState({ nbIdx: currentIdx }, '', target);
  }
  emit();
}

/** Back within the Mini App; without in-app history (deep link) go to the logical parent instead. */
export function goBack(fallback: string): void {
  if (currentIdx > 0) window.history.back();
  else navigate(fallback, { replace: true });
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function snapshot(): string {
  return `${window.location.hash}|${currentIdx}`;
}

export function useMiniRoute(): MiniRoute & { index: number } {
  const snap = useSyncExternalStore(subscribe, snapshot, () => '');
  const bar = snap.lastIndexOf('|');
  const hash = bar >= 0 ? snap.slice(0, bar) : snap;
  return { ...parseMiniHash(hash), index: currentIdx };
}

export const mhref = (path: string): string => `#${path.startsWith('/') ? path : `/${path}`}`;

// ---------------------------------------------------------------- app structure
export type TabId = 'chats' | 'agents' | 'activity' | 'settings';

export const TAB_ROOTS: Record<TabId, string> = {
  chats: '/',
  agents: '/agents',
  activity: '/activity',
  settings: '/settings',
};

/** Paths shown without a Back button (tab roots, and /approvals: the Activity tab focused on approvals). */
const ROOT_PATHS = new Set([...Object.values(TAB_ROOTS), '/approvals', '/more']);

/** Agent routes that open the agent's conversation (the chat is the agent's home). */
export const AGENT_CHAT_SECTIONS = new Set(['', 'chat']);

/** `#/agents/new`: the agent creator over the Agents list (never an agent id). */
export const NEW_AGENT = 'new';

const isAgentChat = (b: string | undefined, c: string | undefined) => Boolean(b) && b !== NEW_AGENT && AGENT_CHAT_SECTIONS.has(c ?? '');

export function tabFor(route: Pick<MiniRoute, 'segments'>): TabId {
  const [a, b, c] = route.segments;
  switch (a ?? '') {
    case '':
    case 'chats':
    case 'archived':
      return 'chats';
    case 'agents':
      return isAgentChat(b, c) ? 'chats' : 'agents';
    case 'tasks':
    case 'activity':
    case 'approvals':
    case 'auth':
      return 'activity';
    default:
      return 'settings';
  }
}

export function isTabRoot(route: Pick<MiniRoute, 'path'>): boolean {
  return ROOT_PATHS.has(route.path);
}

/** Full-screen routes without the tab bar: a conversation and the Live Desktop viewer. */
export function hidesTabBar(route: Pick<MiniRoute, 'segments'>): boolean {
  const [a, b, c] = route.segments;
  if (a === 'chats' && b) return true;
  if (a === 'admin' && b) return true; // Dashboard pages use the whole screen (Back: Telegram's button / the top bar)
  return a === 'agents' && Boolean(b) && (isAgentChat(b, c) || c === 'desktop');
}

/** Logical parent for Back when there is no in-app history (e.g. opened from a Telegram button). */
export function parentPath(route: Pick<MiniRoute, 'segments'>): string {
  const [a, b, c] = route.segments;
  switch (a) {
    case 'chats':
    case 'archived':
      return '/';
    case 'agents':
      if (!b) return '/';
      if (b === NEW_AGENT && !c) return '/agents';
      if (AGENT_CHAT_SECTIONS.has(c ?? '')) return '/';
      if (c === 'desktop') return `/agents/${b}`; // the viewer closes back into the chat
      if (c === 'details') return '/agents';
      return `/agents/${b}/details`;
    case 'tasks':
      return '/activity';
    case 'companies':
      return b ? '/companies' : '/settings';
    case 'company-runs':
      return '/companies';
    case 'workflows':
      return b ? '/workflows' : '/settings';
    case 'workflow-runs':
      return '/workflows';
    case 'settings':
      if (b === 'vault' && c) {
        // #/settings/vault/entries/<id>/edit → the credential; anything else under the vault → the vault
        const [, , , d, e] = route.segments;
        return c === 'entries' && d && e ? `/settings/vault/entries/${d}` : '/settings/vault';
      }
      return '/settings';
    case 'admin':
      if (!b) return '/settings';
      return c ? `/admin/${b}` : '/admin';
    case 'activity':
    case 'approvals':
    case 'auth':
      return '/activity';
    default:
      return '/settings';
  }
}
