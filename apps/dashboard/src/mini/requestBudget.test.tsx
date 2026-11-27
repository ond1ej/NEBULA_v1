// Network budget of the Telegram Mini App (Bearer mode, streamed events): first load, one idle minute, and a burst of
// task progress events. Fake timers drive polling; the fake event stream sends a keepalive every 15 s like the host.
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../components/Toast';
import { installFetch, ok, type RecordedCall } from '../test/fetchMock';
import type { AgentDetail } from '../types';
import { MiniApp } from './App';
import { clearQueryCache } from './hooks';
import type { TgWebApp } from './telegram';

vi.mock('@novnc/novnc', () => ({ default: class {} }));

const enc = new TextEncoder();
let push: ((chunk: string) => void) | null = null;

function openStream(c: RecordedCall): Response {
  let keepalive: ReturnType<typeof setInterval> | null = null;
  const body = new ReadableStream<Uint8Array>({
    start(ctrl) {
      ctrl.enqueue(enc.encode('retry: 3000\n\n'));
      push = (s) => ctrl.enqueue(enc.encode(s));
      keepalive = setInterval(() => ctrl.enqueue(enc.encode(': keepalive\n\n')), 15_000);
      c.init.signal?.addEventListener('abort', () => {
        if (keepalive) clearInterval(keepalive);
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

const agent = {
  id: 'a1',
  name: 'Researcher',
  description: '',
  state: 'ACTIVE',
  linux_user: 'nebula_a1',
  guest_user: 'nebula_a1',
  display_id: ':21',
  provider_id: 'p',
  model_id: 'm',
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
  current_task: { id: 't1', state: 'EXECUTING' },
  permission_catalog: {},
  tools: [],
  live_streams: [],
  control_held_by_user: false,
} as AgentDetail;

const session = {
  token: 'tok-1',
  csrf_token: 'csrf-1',
  session_id: 's1',
  expires_at: Date.now() / 1000 + 3600,
  telegram_user: { id: 42, first_name: 'Ada' },
  bot: 'main',
  permissions: ['tasks', 'commands', 'screenshot', 'desktop', 'files', 'companies', 'workflows', 'approvals'],
  start_param: null,
};

function routes() {
  return {
    'POST /api/mini/auth': () => ok(session),
    'GET /api/v1/miniapp/me': () => ok({ session_id: 's1', telegram_user_id: 42, bot: 'main', permissions: session.permissions, expires_in: 3600, role: 'owner' }),
    'GET /api/v1/events': (c: RecordedCall) => openStream(c),
    'GET /api/v1/approval-center': () => ok({ pending: [], recent: [] }),
    'GET /api/v1/health': () => ok({ status: 'ok', api: 'ok', db: 'ok', vm: { state: 'running' }, guest: { status: 'ok' }, providers: {}, telegram: { polling: true }, version: '3' }),
    'GET /api/v1/overview': () =>
      ok({
        agents: [],
        running_tasks: [],
        recent_results: [],
        active_team_runs: [],
        upcoming_schedules: [],
        providers: [],
        approvals_pending: 0,
        workflow_runs_active: 0,
        recent_events: [],
        resources: { host: null, guest: null, limits: { profile: 'BALANCED', max_active_effective: 2 }, active_workers: 0, queue_length: 0 },
        telegram: { polling: true },
      }),
    'GET /api/v1/resources': () => ok({ host: null, guest: null, limits: { profile: 'BALANCED', max_active_effective: 2 }, active_workers: 0, queue_length: 0 }),
    'GET /api/v1/companies': () => ok([]),
    'GET /api/v1/agents/a1': () => ok(agent),
    'GET /api/v1/agents/a1/environment': () =>
      ok({ agent_id: 'a1', effective: { env: 'vm', root_id: null, source: 'agent', label: 'vm', chain: [] }, root: null, tools: [], skills_unavailable_here: [], problems: [], live_desktop: true }),
    'GET /api/v1/agents/a1/messages': () => ok([]),
    // V3.2 conversations
    'GET /api/v1/conversations': () =>
      ok([
        {
          id: 'c1',
          agent_id: 'a1',
          agent_name: 'Researcher',
          agent_status: 'ACTIVE',
          title: 'Researcher',
          created_at: 1,
          updated_at: 2,
          last_message_at: 2,
          last_message: { role: 'user', content: 'Compare laptops', created_at: 2 },
          unread_count: 0,
          archived: false,
          is_default: true,
          running_task: { id: 't1', state: 'EXECUTING' },
        },
      ]),
    'GET /api/v1/agents/a1/conversation': () =>
      ok({ id: 'c1', agent_id: 'a1', agent_name: 'Researcher', agent_status: 'ACTIVE', title: 'Researcher', created_at: 1, updated_at: 2, last_message_at: 2, last_message: null, unread_count: 0, archived: false, is_default: true, running_task: { id: 't1', state: 'EXECUTING' } }),
    'GET /api/v1/conversations/c1': () =>
      ok({ id: 'c1', agent_id: 'a1', agent_name: 'Researcher', agent_status: 'ACTIVE', title: 'Researcher', created_at: 1, updated_at: 2, last_message_at: 2, last_message: null, unread_count: 0, archived: false, is_default: true, running_task: { id: 't1', state: 'EXECUTING' } }),
    'GET /api/v1/conversations/c1/messages': () =>
      ok({
        items: [
          { id: 'm1', conversation_id: 'c1', agent_id: 'a1', task_id: 't1', role: 'user', channel: 'web', content: 'Compare laptops', attachments: [], created_at: 2, client_id: 'k1', task: { id: 't1', state: 'EXECUTING', started_at: 2, finished_at: null, failure_reason: null } },
        ],
        has_more: false,
      }),
    'GET /api/v1/tasks': () => ok([{ id: 't1', agent_id: 'a1', agent_name: 'Researcher', prompt: 'Compare laptops', state: 'EXECUTING', current_step: 2, max_steps: 40, retry_count: 0, tool_calls_done: 2, source_channel: 'telegram', created_at: 1, updated_at: 1, started_at: 1, finished_at: null, result: null, failure_reason: null }]),
    'GET /api/v1/workflow-runs': () => ok([]),
    'GET /api/v1/tasks/t1': () =>
      ok({ id: 't1', agent_id: 'a1', prompt: 'Compare laptops', state: 'EXECUTING', current_step: 2, max_steps: 40, retry_count: 0, tool_calls_done: 2, source_channel: 'telegram', steps: [], approvals: [], created_at: 1, updated_at: 1, started_at: 1, finished_at: null }),
    // V3.2.1 Smart Authentication: sign-in cards of the open conversation
    'GET /api/v1/smart-auth/sessions': () => ok([]),
  } satisfies Record<string, (c: RecordedCall) => Response>;
}

function telegram(): TgWebApp {
  const fn = () => {};
  const wa = {
    initData: 'query_id=AAH&user=%7B%22id%22%3A42%7D&auth_date=1700000000&hash=abcdef',
    initDataUnsafe: { user: { id: 42, first_name: 'Ada' } },
    version: '8.0',
    platform: 'ios',
    colorScheme: 'dark' as const,
    themeParams: {},
    viewportStableHeight: 700,
    BackButton: { show: fn, hide: fn, onClick: fn, offClick: fn },
    HapticFeedback: { impactOccurred: fn, notificationOccurred: fn, selectionChanged: fn },
    ready: fn,
    expand: fn,
    close: fn,
    isVersionAtLeast: () => true,
    onEvent: fn,
    offEvent: fn,
  };
  window.Telegram = { WebApp: wa as unknown as TgWebApp };
  return wa as unknown as TgWebApp;
}

async function settle(realMs = 150) {
  const until = Date.now() + realMs;
  while (Date.now() < until) {
    await act(async () => {
      await new Promise((r) => setImmediate(r));
      vi.advanceTimersByTime(0);
    });
  }
}

async function advance(ms: number) {
  for (let t = 0; t < ms; t += 1000) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await settle(10);
  }
}

const tally = (calls: RecordedCall[]) => {
  const m: Record<string, number> = {};
  for (const c of calls) m[`${c.method} ${c.path}`] = (m[`${c.method} ${c.path}`] ?? 0) + 1;
  return m;
};

let sequence = 100;
function sse(type: string, payload: Record<string, unknown>) {
  sequence += 1;
  const ev = { id: `e${sequence}`, sequence, type, agent_id: 'a1', task_id: 't1', timestamp: 1_700_000_000 + sequence, payload };
  push?.(`event: ${type}\ndata: ${JSON.stringify(ev)}\n\n`);
}

describe('Mini App network budget', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    sessionStorage.clear();
    clearQueryCache();
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete window.Telegram;
    window.history.replaceState(null, '', '/');
    push = null;
  });

  // Upper bounds. 3.1.0 measured: home 8 / 2 / 1, chat 7 / 0 / 0, task 5 / 0 / 10. Since 3.2.0 the first screen is
  // Chats (conversations + the health dot; no resources polling): 6 / 0 / 0.
  // 3.2.1 (Smart Authentication): opening a conversation adds exactly ONE request — its sign-in cards
  // (GET /smart-auth/sessions?conversation_id=…), then refreshed only by auth events. Chats and Activity add none:
  // Activity's "Needs you" sign-ins come from the approval-center response it already loads.
  const BUDGET: Record<string, { initial: number; idle: number; burst: number }> = {
    '#/': { initial: 6, idle: 0, burst: 0 },
    '#/agents/a1/chat': { initial: 8, idle: 0, burst: 0 }, // resolve the agent's conversation, its messages, the agent, its sign-ins
    '#/chats/c1': { initial: 8, idle: 0, burst: 0 },
    '#/tasks/t1': { initial: 5, idle: 0, burst: 10 }, // one refetch per finished tool step (new step row)
    '#/activity': { initial: 6, idle: 0, burst: 0 },
  };

  for (const hash of ['#/', '#/agents/a1/chat', '#/chats/c1', '#/tasks/t1', '#/activity']) {
    it(`first load and one idle minute on ${hash}`, async () => {
      const wa = telegram();
      window.history.replaceState(null, '', `/mini/${hash}`);
      const net = installFetch(routes());
      render(
        <ToastProvider>
          <MiniApp webApp={wa} />
        </ToastProvider>,
      );
      for (let i = 0; i < 40 && net.calls.length < 4; i += 1) await settle(20);
      await settle(400);
      await advance(2000);
      await settle(200);
      const initial = tally(net.calls);
      const initialCount = net.calls.length;
      net.calls.length = 0;
      await advance(60_000);
      const idle = tally(net.calls);
      const idleCount = net.calls.length;
      net.calls.length = 0;
      // a running task streams progress for 30 s: per round a model request, a tool stage and the finished tool step
      for (let i = 0; i < 10; i += 1) {
        await act(async () => sse('task.stage', { stage: 'model_request', detail: null, elapsed_ms: i * 3000, at: 1_700_000_000 + i * 3 }));
        await advance(1000);
        await act(async () => sse('task.stage', { stage: 'tool', detail: 'browser.open', elapsed_ms: i * 3000 + 1000, at: 1_700_000_001 + i * 3 }));
        await advance(1000);
        await act(async () => sse('task.step', { seq: 3 + i, tool: 'browser.open', status: 'ok', summary: 'ok' }));
        await advance(1000);
      }
      await advance(3000);
      const burst = tally(net.calls);
      console.info(`[mini-budget] ${hash} initial=${initialCount} ${JSON.stringify(initial)}`);
      console.info(`[mini-budget] ${hash} idle/min=${idleCount} ${JSON.stringify(idle)}`);
      console.info(`[mini-budget] ${hash} progress-burst=${net.calls.length} ${JSON.stringify(burst)}`);
      expect(initialCount).toBeGreaterThan(0);
      expect(initialCount).toBeLessThanOrEqual(BUDGET[hash].initial);
      expect(idleCount).toBeLessThanOrEqual(BUDGET[hash].idle);
      expect(net.calls.length).toBeLessThanOrEqual(BUDGET[hash].burst);
      // the tab bar badge and the screens share one request per query key
      expect(initial['GET /api/v1/approval-center']).toBe(1);
      // sign-in cards: one request when a conversation opens, none anywhere else (Activity reuses approval-center)
      const isChat = hash.startsWith('#/chats/') || hash.startsWith('#/agents/');
      expect(initial['GET /api/v1/smart-auth/sessions'] ?? 0).toBe(isChat ? 1 : 0);
    }, 30_000);
  }
});
