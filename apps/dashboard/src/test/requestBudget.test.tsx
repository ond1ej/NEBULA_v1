// Network budget of the Dashboard: how many HTTP requests the first load and an idle minute cost, and that
// high-frequency progress events (task.step / task.stage) do not trigger refetch storms.
// Uses fake timers for polling and a fake EventSource that opens immediately (like a healthy host).
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { ToastProvider } from '../components/Toast';
import type { Agent, Task } from '../types';
import { installFetch, ok, type RecordedCall } from './fetchMock';

vi.mock('@novnc/novnc', () => ({ default: class {} }));

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  listeners = new Map<string, ((e: MessageEvent) => void)[]>();
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
    queueMicrotask(() => this.onopen?.());
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  emit(type: string, data: unknown) {
    for (const fn of this.listeners.get(type) ?? []) fn(new MessageEvent(type, { data: JSON.stringify(data) }));
  }
  close() {}
}

const agent: Agent = {
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
};

const task: Task = {
  id: 't1',
  agent_id: 'a1',
  prompt: 'Compare laptops',
  state: 'EXECUTING',
  current_step: 2,
  retry_count: 0,
  tool_calls_done: 2,
  max_steps: 40,
  checkpoint_id: null,
  requires_approval: false,
  pause_requested: null,
  source_channel: 'web',
  reply_target: null,
  result: null,
  failure_reason: null,
  created_at: 1,
  updated_at: 1,
  started_at: 1,
  finished_at: null,
};

const overview = {
  agents: [{ id: 'a1', name: 'Researcher', status: 'ACTIVE', provider_id: 'p', model_id: 'm', last_active_at: null }],
  running_tasks: [{ id: 't1', agent_id: 'a1', state: 'EXECUTING', prompt: 'Compare laptops', current_step: 2, started_at: 1, source_channel: 'web', agent_name: 'Researcher' }],
  recent_results: [],
  active_team_runs: [],
  upcoming_schedules: [],
  providers: [],
  approvals_pending: 0,
  workflow_runs_active: 0,
  recent_events: [],
  resources: { host: null, guest: null, limits: { profile: 'BALANCED', max_active_effective: 2 }, active_workers: 1, queue_length: 0 },
  telegram: { polling: true },
};

function routes() {
  return {
    'GET /api/v1/auth/state': () => ok({ initialized: true, authenticated: true, user: { username: 'owner' }, csrf_token: 'c' }),
    'GET /api/v1/health': () =>
      ok({ status: 'ok', api: 'ok', db: 'ok', vm: { state: 'running' }, guest: { status: 'ok' }, providers: {}, telegram: { polling: true }, version: '3' }),
    'GET /api/v1/overview': () => ok(overview),
    'GET /api/v1/approvals': () => ok([]),
    'GET /api/v1/owner-approvals': () => ok([]),
    'GET /api/v1/system/lan': () => ok({ enabled: false, https: false, addresses: [], port: 3101 }),
    'GET /api/v1/tasks/t1': () => ok({ ...task, steps: [], approvals: [] }),
    'GET /api/v1/agents/a1': () => ok(agent),
    'GET /api/v1/agents/a1/messages': () => ok([]),
    'GET /api/v1/agents/a1/tasks': () => ok([task]),
    'GET /api/v1/agents/a1/attachments': () => ok([]),
    'GET /api/v1/smart-auth/sessions': () => ok([]),
  } satisfies Record<string, (c: RecordedCall) => Response>;
}

/** Lets real I/O (lazy chunks) and promise chains settle while fake timers stay frozen. */
async function settle(realMs = 150) {
  const until = Date.now() + realMs; // Date is not faked
  while (Date.now() < until) {
    await act(async () => {
      await new Promise((r) => setImmediate(r));
      vi.advanceTimersByTime(0); // 0 ms timers (debounce helpers)
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

async function boot(hash: string) {
  window.history.replaceState(null, '', `/${hash}`);
  const net = installFetch(routes());
  render(
    <ToastProvider>
      <App />
    </ToastProvider>,
  );
  // wait for lazy route chunks + first data; then let debounced refreshes fire
  for (let i = 0; i < 40 && net.calls.length < 3; i += 1) await settle(20);
  await settle(400);
  await advance(2000);
  await settle(200);
  return net;
}

let sequence = 100;
const sse = (type: string, payload: Record<string, unknown>, taskId: string | null = 't1') => {
  sequence += 1;
  const es = FakeEventSource.instances.at(-1);
  es?.emit(type, { id: `e${sequence}`, sequence, type, agent_id: 'a1', task_id: taskId, timestamp: 1_700_000_000 + sequence, payload });
};

describe('Dashboard network budget', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    FakeEventSource.instances = [];
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    window.history.replaceState(null, '', '/');
  });

  // Upper bounds (measured before this change: overview 7 / 10 per idle minute; agent chat 9 / 6).
  // 3.2.1: the agent chat lists the agent's active sign-in requests (GET /smart-auth/sessions?agent_id=&active=true):
  // +1 on first load, refreshed only by auth events. The global sign-in notice is event-driven and costs nothing.
  const BUDGET: Record<string, { initial: number; idle: number; burst: number }> = {
    '#/overview': { initial: 7, idle: 3, burst: 1 },
    '#/agents/a1/chat': { initial: 9, idle: 1, burst: 0 },
  };

  for (const hash of ['#/overview', '#/agents/a1/chat']) {
    it(`first load and one idle minute on ${hash}`, async () => {
      const net = await boot(hash);
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
      const burstCount = net.calls.length;

      console.info(`[budget] ${hash} initial=${initialCount} ${JSON.stringify(initial)}`);
      console.info(`[budget] ${hash} idle/min=${idleCount} ${JSON.stringify(idle)}`);
      console.info(`[budget] ${hash} progress-burst=${burstCount} ${JSON.stringify(burst)}`);
      expect(initialCount).toBeGreaterThan(0);
      expect(initialCount).toBeLessThanOrEqual(BUDGET[hash].initial);
      expect(idleCount).toBeLessThanOrEqual(BUDGET[hash].idle);
      expect(burstCount).toBeLessThanOrEqual(BUDGET[hash].burst);
      // pending approvals are loaded once for the whole app (the chat reuses them)
      expect(initial['GET /api/v1/approvals']).toBe(1);
      // progress events never refetch task details, lists or the overview
      expect(burst['GET /api/v1/tasks/t1'] ?? 0).toBe(0);
      expect(burst['GET /api/v1/agents/a1/tasks'] ?? 0).toBe(0);
    }, 30_000);
  }
});
