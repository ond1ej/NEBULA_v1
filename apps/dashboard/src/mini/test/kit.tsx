// Test kit of the Mini App: a Telegram WebApp double, a session, fixtures, a controllable event stream, the fetch
// routes every signed-in screen needs, and an XMLHttpRequest double that sends through the fetch mock (uploads).
import { act, render } from '@testing-library/react';
import { vi } from 'vitest';
import { ToastProvider } from '../../components/Toast';
import { installFetch, ok, type RecordedCall } from '../../test/fetchMock';
import type { AgentDetail } from '../../types';
import { MiniApp } from '../App';
import type { TgWebApp } from '../telegram';
import type { Conversation, Message } from '../types';

export const INIT = 'query_id=AAH&user=%7B%22id%22%3A42%7D&auth_date=1700000000&hash=abcdef';

export function versionAtLeast(have: string) {
  return (want: string) => {
    const a = have.split('.').map(Number);
    const b = want.split('.').map(Number);
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
      if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
    }
    return true;
  };
}

export function telegram(over: Partial<TgWebApp> = {}) {
  const back = { show: vi.fn(), hide: vi.fn(), onClick: vi.fn(), offClick: vi.fn() };
  const wa = {
    initData: INIT,
    initDataUnsafe: { user: { id: 42, first_name: 'Ada' } },
    version: '8.0',
    platform: 'ios',
    colorScheme: 'dark' as 'dark' | 'light',
    themeParams: { bg_color: '#17212b', secondary_bg_color: '#0e1621', section_bg_color: '#17212b', text_color: '#f5f5f5', hint_color: '#708499', button_color: '#5288c1', button_text_color: '#ffffff' },
    viewportHeight: 700,
    viewportStableHeight: 700,
    safeAreaInset: { top: 0, bottom: 34, left: 0, right: 0 },
    contentSafeAreaInset: { top: 0, bottom: 0, left: 0, right: 0 },
    BackButton: back,
    HapticFeedback: { impactOccurred: vi.fn(), notificationOccurred: vi.fn(), selectionChanged: vi.fn() },
    ready: vi.fn(),
    expand: vi.fn(),
    close: vi.fn(),
    isVersionAtLeast: versionAtLeast('8.0'),
    onEvent: vi.fn(),
    offEvent: vi.fn(),
    setHeaderColor: vi.fn(),
    setBackgroundColor: vi.fn(),
    setBottomBarColor: vi.fn(),
    enableVerticalSwipes: vi.fn(),
    disableVerticalSwipes: vi.fn(),
    enableClosingConfirmation: vi.fn(),
    disableClosingConfirmation: vi.fn(),
    ...over,
  };
  window.Telegram = { WebApp: wa as TgWebApp };
  return wa;
}

export const PERMS = ['tasks', 'commands', 'screenshot', 'desktop', 'files', 'companies', 'workflows', 'approvals'];

export const session = {
  token: 'tok-1',
  csrf_token: 'csrf-1',
  session_id: 's1',
  expires_at: Date.now() / 1000 + 3600,
  telegram_user: { id: 42, first_name: 'Ada' },
  bot: 'main',
  permissions: PERMS,
  start_param: null,
};

export const agent: AgentDetail = {
  id: 'a1',
  name: 'Researcher',
  description: 'Finds things',
  state: 'READY',
  linux_user: 'nebula_a1',
  guest_user: 'nebula_a1',
  display_id: ':21',
  provider_id: 'anthropic-api',
  model_id: 'claude-x',
  task_type: 'general',
  permission_level: 'STANDARD',
  permissions: [],
  capabilities: [],
  resource_mode: 'ACTIVE',
  desktop_resolution: '1280x800',
  fallback_provider_id: null,
  desktop_health: null,
  last_error: null,
  last_active_at: null,
  created_at: 1,
  updated_at: 1,
  telegram_topic_id: null,
  telegram_mapping: null,
  current_task: null,
  permission_catalog: {},
  tools: [],
  live_streams: [],
  control_held_by_user: false,
};

export const env = (e: 'vm' | 'host') => ({
  agent_id: 'a1',
  effective: { env: e, root_id: null, source: 'agent', label: e, chain: [{ level: 'agent', env: e }] },
  root: null,
  tools: [],
  skills_unavailable_here: [],
  problems: [],
  live_desktop: e === 'vm',
});

export const NOW = Math.floor(Date.now() / 1000);

export function conversation(over: Partial<Conversation> = {}): Conversation {
  return {
    id: 'c1',
    agent_id: 'a1',
    agent_name: 'Researcher',
    agent_status: 'READY',
    title: 'Researcher',
    created_at: NOW - 3600,
    updated_at: NOW - 60,
    last_message_at: NOW - 60,
    last_message: { role: 'assistant', content: 'Here is **the summary**', created_at: NOW - 60 },
    unread_count: 0,
    archived: false,
    is_default: true,
    running_task: null,
    ...over,
  };
}

export function message(over: Partial<Message> = {}): Message {
  return {
    id: 'm1',
    conversation_id: 'c1',
    agent_id: 'a1',
    task_id: null,
    role: 'assistant',
    channel: 'web',
    content: 'Hello, how can I help?',
    attachments: [],
    created_at: NOW - 120,
    client_id: null,
    task: null,
    ...over,
  };
}

// ---------------------------------------------------------------- event stream
const enc = new TextEncoder();
let pushChunk: ((s: string) => void) | null = null;
let seq = 1000;

export function openStream(c: RecordedCall): Response {
  const body = new ReadableStream<Uint8Array>({
    start(ctrl) {
      ctrl.enqueue(enc.encode('retry: 3000\n\n'));
      pushChunk = (s) => ctrl.enqueue(enc.encode(s));
      c.init.signal?.addEventListener('abort', () => {
        try {
          ctrl.error(new DOMException('aborted', 'AbortError'));
        } catch {
          // closed
        }
      });
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

/** Sends one host event through the open stream (agent a1 unless given). */
export async function emit(type: string, payload: Record<string, unknown> = {}, over: { task_id?: string | null; agent_id?: string | null; timestamp?: number } = {}) {
  seq += 1;
  const ev = { id: `e${seq}`, sequence: seq, type, agent_id: over.agent_id === undefined ? 'a1' : over.agent_id, task_id: over.task_id ?? null, timestamp: over.timestamp ?? Date.now() / 1000, payload };
  await act(async () => {
    pushChunk?.(`event: ${type}\ndata: ${JSON.stringify(ev)}\n\n`);
    await new Promise((r) => setTimeout(r, 0));
  });
}

export function resetStream() {
  pushChunk = null;
}

type Handler = (c: RecordedCall) => Response | Promise<Response>;

export function baseRoutes(extra: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'POST /api/mini/auth': () => ok(session),
    // the main bot's owner (role "owner"): approvals and sign-in answers are the owner's
    'GET /api/v1/miniapp/me': () => ok({ session_id: 's1', telegram_user_id: 42, bot: 'main', permissions: PERMS, expires_in: 3600, role: 'owner' }),
    'GET /api/v1/events': (c) => openStream(c),
    'GET /api/v1/approval-center': () => ok({ pending: [], recent: [] }),
    'GET /api/v1/health': () =>
      ok({ status: 'ok', api: 'ok', db: 'ok', vm: { state: 'running' }, guest: { status: 'ok', latency_ms: 4 }, providers: { 'anthropic-api': 'Connected (API Billing)' }, telegram: { polling: true }, version: '3.2.0' }),
    'GET /api/v1/agents/a1': () => ok(agent),
    'GET /api/v1/agents/a1/environment': () => ok(env('vm')),
    ...extra,
  };
}

export function renderApp(wa: TgWebApp | null) {
  return render(
    <ToastProvider>
      <MiniApp webApp={wa} />
    </ToastProvider>,
  );
}

export function mount(hash: string, routes: Record<string, Handler>, wa: TgWebApp | null = telegram()) {
  window.history.replaceState(null, '', `/mini/${hash}`);
  const net = installFetch(routes);
  const view = renderApp(wa);
  return { ...net, view, wa };
}

// ---------------------------------------------------------------- localStorage
/**
 * An in-memory Storage as window.localStorage (Node >= 25 ships a global localStorage that shadows jsdom's and does not
 * work without --localstorage-file).
 */
export function installMemoryStorage(): Storage {
  const data = new Map<string, string>();
  const store: Storage = {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k: string) => (data.has(k) ? (data.get(k) as string) : null),
    key: (i: number) => [...data.keys()][i] ?? null,
    removeItem: (k: string) => void data.delete(k),
    setItem: (k: string, v: string) => void data.set(k, String(v)),
  };
  Object.defineProperty(window, 'localStorage', { value: store, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'localStorage', { value: store, configurable: true, writable: true });
  return store;
}

// ---------------------------------------------------------------- XMLHttpRequest over the fetch mock
/** Uploads in the Mini App use XHR (progress); this double reports progress and answers through `fetch` (mocked). */
export function installXhrOverFetch(opts: { hold?: boolean } = {}) {
  const sent: FakeXHR[] = [];
  class FakeXHR {
    upload: { onprogress: ((e: ProgressEvent) => void) | null } = { onprogress: null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    status = 0;
    responseText = '';
    withCredentials = false;
    method = 'GET';
    url = '';
    headers: Record<string, string> = {};
    body: unknown = null;
    aborted = false;
    release: (() => void) | null = null;
    responseHeaders: Headers | null = null;
    getResponseHeader(name: string) {
      return this.responseHeaders?.get(name) ?? null;
    }
    open(m: string, u: string) {
      this.method = m;
      this.url = u;
    }
    setRequestHeader(k: string, v: string) {
      this.headers[k] = v;
    }
    abort() {
      this.aborted = true;
      this.onabort?.();
    }
    send(body: unknown) {
      this.body = body;
      sent.push(this);
      const total = body instanceof FormData ? [...body.values()].reduce<number>((n, v) => n + (v instanceof Blob ? v.size : String(v).length), 0) : 0;
      const go = async () => {
        this.upload.onprogress?.({ lengthComputable: true, loaded: Math.round(total / 2), total } as ProgressEvent);
        if (opts.hold) await new Promise<void>((r) => (this.release = r));
        if (this.aborted) return;
        this.upload.onprogress?.({ lengthComputable: true, loaded: total, total } as ProgressEvent);
        try {
          const res = await fetch(this.url, { method: this.method, headers: this.headers, body: body as BodyInit, credentials: this.withCredentials ? 'same-origin' : 'omit' });
          if (this.aborted) return;
          this.status = res.status;
          this.responseHeaders = res.headers;
          this.responseText = await res.text();
          this.onload?.();
        } catch {
          this.onerror?.();
        }
      };
      void Promise.resolve().then(go);
    }
  }
  vi.stubGlobal('XMLHttpRequest', FakeXHR);
  return { sent };
}
