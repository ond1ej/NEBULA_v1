import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setCsrfToken } from '../api';
import { EventHub, EventsProvider } from '../hooks/useEvents';
import { installFetch, ok, type RecordedCall } from '../test/fetchMock';
import type { Agent } from '../types';
import { clampZoom, keysymForChar, LiveDesktop, qualityLabel, type LiveDesktopClient } from './LiveDesktop';
import { ToastProvider } from './Toast';

// ---- noVNC mock (tests only) --------------------------------------------------------------
const novnc = vi.hoisted(() => {
  const instances: MockRFBType[] = [];
  const ctor = vi.fn();
  interface MockRFBType extends EventTarget {
    target: HTMLElement;
    url: string;
    options: unknown;
    viewOnly: boolean;
    scaleViewport: boolean;
    resizeSession: boolean;
    clipViewport: boolean;
    background: string;
    disconnect: ReturnType<typeof vi.fn>;
    focus: ReturnType<typeof vi.fn>;
    sendKey: ReturnType<typeof vi.fn>;
    sendCtrlAltDel: ReturnType<typeof vi.fn>;
    focusOnClick: boolean;
  }
  class MockRFB extends EventTarget {
    target: HTMLElement;
    url: string;
    options: unknown;
    viewOnly = false;
    scaleViewport = false;
    resizeSession = true;
    clipViewport = false;
    background = '';
    focusOnClick = true;
    disconnect = vi.fn(() => {
      this.dispatchEvent(new CustomEvent('disconnect', { detail: { clean: true } }));
    });
    focus = vi.fn();
    sendKey = vi.fn();
    sendCtrlAltDel = vi.fn();
    constructor(target: HTMLElement, url: string, options: unknown) {
      super();
      this.target = target;
      this.url = url;
      this.options = options;
      ctor(target, url, options);
      instances.push(this as unknown as MockRFBType);
    }
  }
  return { MockRFB, instances, ctor };
});

vi.mock('@novnc/novnc', () => ({ default: novnc.MockRFB }));

// -------------------------------------------------------------------------------------------
const agent: Agent = {
  id: 'agent-1',
  name: 'Researcher',
  description: '',
  state: 'READY',
  linux_user: 'nebula_ab12cd34',
  guest_user: 'nebula_ab12cd34',
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
  current_task: { id: 'task-77', state: 'EXECUTING' },
};

function routes() {
  return {
    'POST /api/v1/agents/agent-1/live/connect': () =>
      ok(
        {
          session_id: 'sess-1',
          token: 'tok/+=secret',
          state: 'CONNECTING',
          read_only: true,
          ws_path: '/api/v1/live/ws/sess-1',
          expires_at: 9e9,
          ttl_seconds: 90,
        },
        201,
      ),
    'DELETE /api/v1/live/sessions/sess-1': () => ok({ session_id: 'sess-1', state: 'DISCONNECTED' }),
    'GET /api/v1/live/sessions': () =>
      ok({ sessions: [], active_streams: [{ session_id: 'sess-1', agent_id: 'agent-1', bytes_out: 2048, control: false }] }),
    'POST /api/v1/live/sessions/sess-1/control': (c: RecordedCall) =>
      ok({ session_id: 'sess-1', control: (c.body as { action: string }).action !== 'release', lease_expires_at: 9e9 }),
    'POST /api/v1/tasks/task-77/pause': () => ok({ id: 'task-77', state: 'PAUSING' }),
  };
}

function renderLive(a: Agent = agent) {
  return render(
    <ToastProvider>
      <LiveDesktop agent={a} />
    </ToastProvider>,
  );
}

const liveCalls = (calls: RecordedCall[]) => calls.filter((c) => c.path.includes('/live'));

describe('LiveDesktop', () => {
  beforeEach(() => {
    novnc.instances.length = 0;
    novnc.ctor.mockClear();
    setCsrfToken('csrf-live');
  });
  afterEach(() => {
    cleanup(); // unmount (and run the live-session cleanup) while fetch is still mocked
    vi.unstubAllGlobals();
    setCsrfToken(null);
  });

  it('shows the inactive placeholder and never connects on its own', async () => {
    const { calls } = installFetch(routes());
    renderLive();
    expect(screen.getByText('Desktop stream is inactive')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Connect' }).length).toBeGreaterThan(0);
    expect(screen.queryByTestId('live-badge')).not.toBeInTheDocument();
    // give any accidental effect a chance to run
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(novnc.ctor).not.toHaveBeenCalled();
    expect(liveCalls(calls)).toHaveLength(0);
  });

  it('Connect creates a viewer session and opens noVNC read-only, scaled, with the token in the URL', async () => {
    const user = userEvent.setup();
    const { calls } = installFetch(routes());
    renderLive();
    await user.click(screen.getAllByRole('button', { name: 'Connect' })[0]);

    await waitFor(() => expect(novnc.ctor).toHaveBeenCalledTimes(1));
    const connectCall = calls.find((c) => c.path === '/api/v1/agents/agent-1/live/connect');
    expect(connectCall?.method).toBe('POST');
    expect(connectCall?.headers['x-csrf-token']).toBe('csrf-live');

    const rfb = novnc.instances[0];
    expect(rfb.url).toBe(`ws://${window.location.host}/api/v1/live/ws/sess-1?token=${encodeURIComponent('tok/+=secret')}`);
    expect(rfb.options).toEqual({ wsProtocols: ['binary'], shared: true });
    expect(rfb.target).toBe(screen.getByTestId('vnc-container'));
    expect(rfb.viewOnly).toBe(true);
    expect(rfb.scaleViewport).toBe(true);

    // Live badge only after the WebSocket/RFB connection is actually open
    expect(screen.queryByTestId('live-badge')).not.toBeInTheDocument();
    act(() => {
      rfb.dispatchEvent(new CustomEvent('connect', { detail: {} }));
    });
    expect(await screen.findByTestId('live-badge')).toHaveTextContent('Live');
    expect(screen.queryByText('Desktop stream is inactive')).not.toBeInTheDocument();

    // token is never persisted in Web Storage
    expect(JSON.stringify({ ...window.localStorage })).not.toContain('tok/+=secret');
    expect(JSON.stringify({ ...window.sessionStorage })).not.toContain('tok/+=secret');
  });

  it('Disconnect calls rfb.disconnect() and DELETE /live/sessions/{sid}', async () => {
    const user = userEvent.setup();
    const { calls } = installFetch(routes());
    renderLive();
    await user.click(screen.getAllByRole('button', { name: 'Connect' })[0]);
    await waitFor(() => expect(novnc.instances).toHaveLength(1));
    const rfb = novnc.instances[0];
    act(() => {
      rfb.dispatchEvent(new CustomEvent('connect', { detail: {} }));
    });
    await screen.findByTestId('live-badge');

    await user.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(rfb.disconnect).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      const del = calls.find((c) => c.method === 'DELETE' && c.path === '/api/v1/live/sessions/sess-1');
      expect(del).toBeDefined();
      expect(del?.headers['x-csrf-token']).toBe('csrf-live');
    });
    expect(await screen.findByText('Desktop stream is inactive')).toBeInTheDocument();
    expect(screen.queryByTestId('live-badge')).not.toBeInTheDocument();
  });

  it('unmounting (route change) disconnects and deletes the session', async () => {
    const user = userEvent.setup();
    const { calls } = installFetch(routes());
    const view = renderLive();
    await user.click(screen.getAllByRole('button', { name: 'Connect' })[0]);
    await waitFor(() => expect(novnc.instances).toHaveLength(1));
    const rfb = novnc.instances[0];
    act(() => {
      rfb.dispatchEvent(new CustomEvent('connect', { detail: {} }));
    });
    view.unmount();
    expect(rfb.disconnect).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      const del = calls.find((c) => c.method === 'DELETE' && c.path === '/api/v1/live/sessions/sess-1');
      expect(del?.init.keepalive).toBe(true);
    });
  });

  it('shows the reason and offers Reconnect when the host drops the stream', async () => {
    const user = userEvent.setup();
    installFetch(routes());
    renderLive();
    await user.click(screen.getAllByRole('button', { name: 'Connect' })[0]);
    await waitFor(() => expect(novnc.instances).toHaveLength(1));
    const rfb = novnc.instances[0];
    act(() => {
      rfb.dispatchEvent(new CustomEvent('connect', { detail: {} }));
    });
    await screen.findByTestId('live-badge');
    act(() => {
      rfb.dispatchEvent(new CustomEvent('disconnect', { detail: { clean: false } }));
    });
    expect(await screen.findByText(/interrupted or rejected by the host/)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Reconnect' }).length).toBeGreaterThan(0);
    expect(screen.queryByTestId('live-badge')).not.toBeInTheDocument();
  });

  it('Take Control acquires the lease and enables input; Release returns to view-only', async () => {
    const user = userEvent.setup();
    const { calls } = installFetch(routes());
    renderLive();
    await user.click(screen.getAllByRole('button', { name: 'Connect' })[0]);
    await waitFor(() => expect(novnc.instances).toHaveLength(1));
    const rfb = novnc.instances[0];
    act(() => {
      rfb.dispatchEvent(new CustomEvent('connect', { detail: {} }));
    });
    await screen.findByTestId('live-badge');

    await user.click(screen.getByRole('button', { name: 'Take Control' }));
    await waitFor(() => expect(rfb.viewOnly).toBe(false));
    const ctl = calls.filter((c) => c.path === '/api/v1/live/sessions/sess-1/control');
    expect(ctl[0].body).toEqual({ action: 'acquire' });

    await user.click(await screen.findByRole('button', { name: 'Release Control' }));
    await waitFor(() => expect(calls.filter((c) => c.path === '/api/v1/live/sessions/sess-1/control').at(-1)?.body).toEqual({ action: 'release' }));
    expect(rfb.viewOnly).toBe(true);
  });

  it('Fit toggles scaleViewport and Pause targets the current task', async () => {
    const user = userEvent.setup();
    const { calls } = installFetch(routes());
    renderLive();
    await user.click(screen.getAllByRole('button', { name: 'Connect' })[0]);
    await waitFor(() => expect(novnc.instances).toHaveLength(1));
    const rfb = novnc.instances[0];
    await user.click(screen.getByRole('button', { name: 'Fit: on' }));
    expect(rfb.scaleViewport).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/api/v1/tasks/task-77/pause')).toBe(true));
  });

  it('Connect is disabled with a reason while the agent sleeps', () => {
    installFetch(routes());
    renderLive({ ...agent, state: 'SLEEP', current_task: null });
    const btn = screen.getAllByRole('button', { name: /Connect/ })[0];
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('title', 'Agent desktop is SLEEP; wake it first');
  });
});

// =========================================================================== V3 controls
function extendedRoutes() {
  return {
    ...routes(),
    'POST /api/v1/tasks/task-77/stop': (c: RecordedCall) => ok({ id: 'task-77', state: 'CANCELLED', mode: (c.body as { mode: string }).mode }),
    'POST /api/v1/agents/agent-1/pause': () => ok({ ...agent, state: 'PAUSED' }),
    'POST /api/v1/agents/agent-1/resume': () => ok({ ...agent, state: 'READY' }),
    'POST /api/v1/agents/agent-1/wake': () => ok({ ...agent, state: 'READY' }),
    'GET /api/v1/agents/agent-1/screenshot': () =>
      new Response(new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }), { status: 200, headers: { 'Content-Type': 'image/png', 'X-Captured-At': '1700000000' } }),
  };
}

function withHub(ui: ReactNode, hub = new EventHub()) {
  return {
    hub,
    view: render(
      <ToastProvider>
        <EventsProvider hub={hub}>{ui}</EventsProvider>
      </ToastProvider>,
    ),
  };
}

let seqCounter = 0;
/** Events need increasing sequence numbers: the hub drops anything <= the last one it saw (resume dedupe). */
function emit(hub: EventHub, type: string, payload: Record<string, unknown>, agentId: string | null = 'agent-1') {
  seqCounter += 1;
  const seq = seqCounter;
  act(() => {
    hub.handle(new MessageEvent(type, { data: JSON.stringify({ id: `e${seq}`, sequence: seq, type, agent_id: agentId, task_id: null, timestamp: 1, payload }) }));
  });
}

async function connectLive(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getAllByRole('button', { name: 'Connect' })[0]);
  await waitFor(() => expect(novnc.instances).toHaveLength(1));
  const rfb = novnc.instances[0];
  act(() => {
    rfb.dispatchEvent(new CustomEvent('connect', { detail: {} }));
  });
  await screen.findByTestId('live-badge');
  return rfb;
}

/** Simulates noVNC's canvas inside the container and records the mouse events it receives. */
function fakeCanvas() {
  const canvas = document.createElement('canvas');
  screen.getByTestId('vnc-container').appendChild(canvas);
  const mouse: { type: string; button: number; buttons: number; x: number; y: number }[] = [];
  const wheels: { dx: number; dy: number }[] = [];
  const novncTouch = vi.fn();
  for (const t of ['mousedown', 'mouseup', 'mousemove'] as const) {
    canvas.addEventListener(t, (e) => mouse.push({ type: e.type, button: e.button, buttons: e.buttons, x: e.clientX, y: e.clientY }));
  }
  canvas.addEventListener('wheel', (e) => wheels.push({ dx: (e as WheelEvent).deltaX, dy: (e as WheelEvent).deltaY }));
  canvas.addEventListener('touchstart', novncTouch); // noVNC's own gesture handler must not see phone touches
  return { canvas, mouse, wheels, novncTouch };
}

function touch(target: Element, type: 'touchstart' | 'touchmove' | 'touchend' | 'touchcancel', pts: [number, number][], remaining: [number, number][] = []) {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  const list = (p: [number, number][]) => p.map(([x, y], i) => ({ clientX: x, clientY: y, identifier: i, target }));
  Object.defineProperty(ev, 'touches', { value: list(type === 'touchend' || type === 'touchcancel' ? remaining : pts) });
  Object.defineProperty(ev, 'changedTouches', { value: list(pts) });
  act(() => {
    target.dispatchEvent(ev);
  });
  return ev;
}

describe('LiveDesktop V3 controls', () => {
  beforeEach(() => {
    novnc.instances.length = 0;
    novnc.ctor.mockClear();
    setCsrfToken('csrf-live');
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    setCsrfToken(null);
  });

  it('shows who is in control and follows live.control.changed events', async () => {
    const user = userEvent.setup();
    installFetch(extendedRoutes());
    const { hub } = withHub(<LiveDesktop agent={agent} />);
    const chip = screen.getByTestId('live-controller');
    expect(chip).toHaveAttribute('data-holder', 'agent');
    expect(chip).toHaveTextContent('In control: Agent');

    await connectLive(user);
    emit(hub, 'live.control.changed', { holder: 'user', live_session_id: 'someone-else' });
    expect(screen.getByTestId('live-controller')).toHaveTextContent('Another viewer');

    await user.click(screen.getByRole('button', { name: 'Take Control' }));
    await waitFor(() => expect(screen.getByTestId('live-controller')).toHaveAttribute('data-holder', 'you'));
    expect(screen.getAllByText('You have control').length).toBeGreaterThan(0);

    // the agent takes over again (e.g. the lease expired on the host)
    emit(hub, 'live.control.changed', { holder: 'agent' });
    await waitFor(() => expect(screen.getByTestId('live-controller')).toHaveAttribute('data-holder', 'agent'));
    expect(novnc.instances[0].viewOnly).toBe(true);
    expect(screen.getByRole('button', { name: 'Take Control' })).toBeInTheDocument();
  });

  it('Stop task asks for confirmation, then POSTs /tasks/{id}/stop', async () => {
    const user = userEvent.setup();
    const { calls } = installFetch(extendedRoutes());
    const changed = vi.fn();
    render(
      <ToastProvider>
        <LiveDesktop agent={agent} onAgentChanged={changed} />
      </ToastProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Stop task' }));
    const dialog = await screen.findByRole('dialog');
    expect(calls.some((c) => c.path.endsWith('/stop'))).toBe(false);
    await user.click(within(dialog).getByRole('button', { name: 'Stop task' }));
    await waitFor(() => expect(calls.find((c) => c.path === '/api/v1/tasks/task-77/stop')?.body).toEqual({ mode: 'cancel' }));
    await waitFor(() => expect(changed).toHaveBeenCalled());
  });

  it('Pause agent / Resume agent / Wake agent call the agent endpoints', async () => {
    const user = userEvent.setup();
    const { calls } = installFetch(extendedRoutes());
    const view = render(
      <ToastProvider>
        <LiveDesktop agent={agent} />
      </ToastProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Pause agent' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/api/v1/agents/agent-1/pause')).toBe(true));

    view.rerender(
      <ToastProvider>
        <LiveDesktop agent={{ ...agent, state: 'PAUSED' }} />
      </ToastProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Resume agent' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/api/v1/agents/agent-1/resume')).toBe(true));

    view.rerender(
      <ToastProvider>
        <LiveDesktop agent={{ ...agent, state: 'SLEEP', current_task: null }} />
      </ToastProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Wake agent' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/api/v1/agents/agent-1/wake')).toBe(true));
  });

  it('Screenshot fetches /agents/{id}/screenshot and shows it', async () => {
    const user = userEvent.setup();
    URL.createObjectURL = vi.fn(() => 'blob:shot');
    URL.revokeObjectURL = vi.fn();
    installFetch(extendedRoutes());
    render(
      <ToastProvider>
        <LiveDesktop agent={agent} />
      </ToastProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Screenshot' }));
    const img = await screen.findByRole('img', { name: "Screenshot of Researcher's desktop" });
    expect(img).toHaveAttribute('src', 'blob:shot');
    expect(screen.getByRole('link', { name: /Download PNG/ })).toHaveAttribute('download');
  });

  it('uses an injected client (Mini App Bearer mode): its WebSocket URL carries the Mini App session token', async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 500 }));
    vi.stubGlobal('fetch', fetchSpy);
    const client: LiveDesktopClient = {
      connect: vi.fn(async () => ({ session_id: 'ms1', token: 'view-tok', state: 'CONNECTING', read_only: true, ws_path: '/api/v1/live/ws/ms1', expires_at: 9e9, ttl_seconds: 90 })),
      disconnect: vi.fn(async () => ({ session_id: 'ms1', state: 'DISCONNECTED' })),
      control: vi.fn(async (_sid: string, action: string) => ({ session_id: 'ms1', control: action !== 'release' })),
      sessions: vi.fn(async () => ({ sessions: [], active_streams: [{ session_id: 'ms1', agent_id: 'agent-1', bytes_out: 10, control: false }] })),
      pauseTask: vi.fn(),
      resumeTask: vi.fn(),
      stopTask: vi.fn(),
      wake: vi.fn(),
      pauseAgent: vi.fn(),
      resumeAgent: vi.fn(),
      screenshot: vi.fn(),
      wsUrl: (p, t) => `wss://mini.example${p}?token=${t}&session_token=mini-session`,
      wsProtocols: [],
    };
    const view = render(
      <ToastProvider>
        <LiveDesktop agent={agent} client={client} variant="compact" statsIntervalMs={60_000} />
      </ToastProvider>,
    );
    await connectLive(user);
    expect(client.connect).toHaveBeenCalledWith('agent-1');
    expect(novnc.instances[0].url).toBe('wss://mini.example/api/v1/live/ws/ms1?token=view-tok&session_token=mini-session');
    expect(novnc.instances[0].options).toEqual({ wsProtocols: [], shared: true });
    expect(fetchSpy).not.toHaveBeenCalled(); // nothing went through the cookie client
    // connection quality: API round-trip latency is measured
    await waitFor(() => expect(screen.getByTestId('live-quality')).toHaveTextContent(/Good · \d+ ms/));
    view.unmount();
    await waitFor(() => expect(client.disconnect).toHaveBeenCalledWith('ms1', true));
  });

  it('touch: tap = click, long press = right click, two-finger drag = scroll, never reaching noVNC’s own touch handler', async () => {
    const user = userEvent.setup();
    installFetch(extendedRoutes());
    render(
      <ToastProvider>
        <LiveDesktop agent={agent} variant="compact" />
      </ToastProvider>,
    );
    const rfb = await connectLive(user);
    await user.click(screen.getByRole('button', { name: 'Take Control' }));
    await waitFor(() => expect(rfb.viewOnly).toBe(false));
    const { canvas, mouse, wheels, novncTouch } = fakeCanvas();

    // tap
    const start = touch(canvas, 'touchstart', [[120, 60]]);
    touch(canvas, 'touchend', [[120, 60]]);
    expect(start.defaultPrevented).toBe(true);
    expect(novncTouch).not.toHaveBeenCalled();
    expect(mouse.filter((m) => m.type !== 'mousemove')).toEqual([
      { type: 'mousedown', button: 0, buttons: 1, x: 120, y: 60 },
      { type: 'mouseup', button: 0, buttons: 0, x: 120, y: 60 },
    ]);

    // double tap: the second click lands exactly on the first one
    mouse.length = 0;
    await new Promise((r) => setTimeout(r, 400));
    touch(canvas, 'touchstart', [[200, 100]]);
    touch(canvas, 'touchend', [[200, 100]]);
    touch(canvas, 'touchstart', [[204, 103]]);
    touch(canvas, 'touchend', [[204, 103]]);
    const downs = mouse.filter((m) => m.type === 'mousedown');
    expect(downs).toHaveLength(2);
    expect(downs[1]).toMatchObject({ x: 200, y: 100 });

    // long press = right click
    mouse.length = 0;
    await new Promise((r) => setTimeout(r, 400));
    touch(canvas, 'touchstart', [[50, 50]]);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 560));
    });
    touch(canvas, 'touchend', [[50, 50]]);
    expect(mouse.filter((m) => m.type !== 'mousemove')).toEqual([
      { type: 'mousedown', button: 2, buttons: 2, x: 50, y: 50 },
      { type: 'mouseup', button: 2, buttons: 0, x: 50, y: 50 },
    ]);

    // two-finger drag up = scroll down (wheel deltaY > 0)
    touch(canvas, 'touchstart', [
      [100, 200],
      [140, 200],
    ]);
    touch(canvas, 'touchmove', [
      [100, 160],
      [140, 160],
    ]);
    touch(canvas, 'touchend', [[100, 160]], [[140, 160]]);
    touch(canvas, 'touchend', [[140, 160]]);
    expect(wheels.length).toBeGreaterThan(0);
    expect(wheels[0].dy).toBe(80);
  });

  it('touch: pinch zooms the view locally (not the remote desktop) and Reset zoom restores it', async () => {
    const user = userEvent.setup();
    installFetch(extendedRoutes());
    render(
      <ToastProvider>
        <LiveDesktop agent={agent} variant="compact" />
      </ToastProvider>,
    );
    await connectLive(user);
    const { canvas, mouse, wheels } = fakeCanvas();
    touch(canvas, 'touchstart', [
      [100, 100],
      [140, 100],
    ]);
    touch(canvas, 'touchmove', [
      [80, 100],
      [160, 100],
    ]);
    touch(canvas, 'touchend', [[80, 100]], [[160, 100]]);
    touch(canvas, 'touchend', [[160, 100]]);
    expect(screen.getByTestId('live-zoom-layer').style.width).toBe('200%');
    expect(mouse).toHaveLength(0);
    expect(wheels).toHaveLength(0);
    expect(screen.getByText('2.0×')).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'Reset zoom' })[0]);
    expect(screen.getByTestId('live-zoom-layer').style.width).toBe('100%');
  });

  it('phone keyboard: the hidden input forwards keys and text to the desktop only while in control', async () => {
    const user = userEvent.setup();
    installFetch(extendedRoutes());
    render(
      <ToastProvider>
        <LiveDesktop agent={agent} variant="compact" />
      </ToastProvider>,
    );
    const rfb = await connectLive(user);
    expect(screen.getByRole('button', { name: /^Keyboard/ })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Take Control' }));
    await waitFor(() => expect(rfb.viewOnly).toBe(false));

    await user.click(screen.getByRole('button', { name: 'Keyboard' }));
    const input = screen.getByTestId('live-keyboard-input');
    expect(input).toHaveFocus();

    fireEvent.keyDown(input, { key: 'a', code: 'KeyA' });
    expect(rfb.sendKey).toHaveBeenLastCalledWith(0x61, 'KeyA');
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    expect(rfb.sendKey).toHaveBeenLastCalledWith(0xff0d, 'Enter');
    fireEvent.keyDown(input, { key: 'Backspace', code: 'Backspace' });
    expect(rfb.sendKey).toHaveBeenLastCalledWith(0xff08, 'Backspace');
    // soft keyboards (IME) deliver text through input events
    fireEvent.input(input, { data: 'ž', inputType: 'insertText' });
    expect(rfb.sendKey).toHaveBeenLastCalledWith(0x0100017e, null);
    // special keys row
    await user.click(screen.getByRole('button', { name: 'Escape' }));
    expect(rfb.sendKey).toHaveBeenLastCalledWith(0xff1b, null);
    await user.click(screen.getByRole('button', { name: 'Control Alt Delete' }));
    expect(rfb.sendCtrlAltDel).toHaveBeenCalled();

    // after release nothing is forwarded any more
    await user.click(screen.getByRole('button', { name: 'Release Control' }));
    const n = rfb.sendKey.mock.calls.length;
    fireEvent.keyDown(input, { key: 'b', code: 'KeyB' });
    expect(rfb.sendKey.mock.calls.length).toBe(n);
  });

  it('disconnects after the page has been hidden for long and explains why', async () => {
    const user = userEvent.setup();
    const { calls } = installFetch(extendedRoutes());
    render(
      <ToastProvider>
        <LiveDesktop agent={agent} hiddenDisconnectMs={60} />
      </ToastProvider>,
    );
    const rfb = await connectLive(user);
    let state: DocumentVisibilityState = 'hidden';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
    try {
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await waitFor(() => expect(rfb.disconnect).toHaveBeenCalled());
      await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/v1/live/sessions/sess-1')).toBe(true));
      expect(await screen.findByText(/in the background to save bandwidth/)).toBeInTheDocument();
      expect(screen.getAllByRole('button', { name: 'Reconnect' }).length).toBeGreaterThan(0);
    } finally {
      state = 'visible';
      delete (document as unknown as { visibilityState?: unknown }).visibilityState;
    }
  });

  it('a VM restart is announced and explained when the stream drops', async () => {
    const user = userEvent.setup();
    installFetch(extendedRoutes());
    const { hub } = withHub(<LiveDesktop agent={agent} />);
    const rfb = await connectLive(user);
    emit(hub, 'vm.state.changed', { state: 'restarting', reason: 'unexpected stop' }, null);
    expect(screen.getByTestId('live-vm-notice')).toHaveTextContent('The Ubuntu VM is restarting');
    act(() => {
      rfb.dispatchEvent(new CustomEvent('disconnect', { detail: { clean: false } }));
    });
    expect(await screen.findByText(/interrupted or rejected by the host.*Ubuntu VM is restarting/)).toBeInTheDocument();
    emit(hub, 'vm.state.changed', { state: 'running' }, null);
    expect(screen.getByTestId('live-vm-notice')).toHaveTextContent('running again');
  });

  it('pure helpers: keysyms, zoom clamping, quality labels', () => {
    expect(keysymForChar('a')).toBe(0x61);
    expect(keysymForChar('é')).toBe(0xe9);
    expect(keysymForChar('ř')).toBe(0x01000159);
    expect(keysymForChar('\n')).toBe(0xff0d);
    expect(clampZoom({ z: 9, x: 50, y: -5000 }, 300, 200)).toEqual({ z: 4, x: 0, y: -600 });
    expect(clampZoom({ z: 0.5, x: -10, y: -10 }, 300, 200)).toEqual({ z: 1, x: 0, y: 0 });
    expect(qualityLabel({ latencyMs: null }).label).toBe('Measuring');
    expect(qualityLabel({ latencyMs: 40 }).label).toBe('Good');
    expect(qualityLabel({ latencyMs: 250 }).label).toBe('Fair');
    expect(qualityLabel({ latencyMs: 900 }).label).toBe('Poor');
  });
});

describe('LiveDesktop connect timeout', () => {
  beforeEach(() => {
    novnc.instances.length = 0;
    setCsrfToken('csrf-live');
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    setCsrfToken(null);
  });

  it('gives up when the WebSocket never opens (tunnel without WebSocket support) and ends the viewer session', async () => {
    const user = userEvent.setup();
    const { calls } = installFetch(routes());
    render(
      <ToastProvider>
        <LiveDesktop agent={agent} connectTimeoutMs={60} />
      </ToastProvider>,
    );
    await user.click(screen.getAllByRole('button', { name: 'Connect' })[0]);
    await waitFor(() => expect(novnc.instances).toHaveLength(1));
    const rfb = novnc.instances[0];
    expect(await screen.findByText(/did not open within/)).toBeInTheDocument();
    expect(rfb.disconnect).toHaveBeenCalled();
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/v1/live/sessions/sess-1')).toBe(true));
    expect(screen.getAllByRole('button', { name: 'Reconnect' }).length).toBeGreaterThan(0);
    expect(screen.queryByTestId('live-badge')).not.toBeInTheDocument();
  });
});

describe('LiveDesktop picture quality', () => {
  let stored: Map<string, string>;
  beforeEach(() => {
    novnc.instances.length = 0;
    novnc.ctor.mockClear();
    setCsrfToken('csrf-live');
    stored = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => stored.get(k) ?? null,
      setItem: (k: string, v: string) => void stored.set(k, v),
      removeItem: (k: string) => void stored.delete(k),
    });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    setCsrfToken(null);
  });

  const level = (rfb: unknown) => rfb as { qualityLevel?: number; compressionLevel?: number };

  it('the Dashboard keeps noVNC defaults and shows no quality toggle', async () => {
    const user = userEvent.setup();
    installFetch(routes());
    renderLive();
    await user.click(screen.getAllByRole('button', { name: 'Connect' })[0]);
    await waitFor(() => expect(novnc.instances).toHaveLength(1));
    expect(level(novnc.instances[0]).qualityLevel).toBeUndefined(); // never set: noVNC default 6 / 2
    expect(level(novnc.instances[0]).compressionLevel).toBeUndefined();
    expect(screen.queryByTestId('live-quality-mode')).not.toBeInTheDocument();
  });

  it('the phone viewer starts at quality 4 / compression 2 and High switches the running stream to 6 / 2', async () => {
    const user = userEvent.setup();
    installFetch(routes());
    render(
      <ToastProvider>
        <LiveDesktop agent={agent} variant="compact" adaptiveQuality />
      </ToastProvider>,
    );
    const toggle = screen.getByTestId('live-quality-mode');
    expect(within(toggle).getByRole('radio', { name: 'Auto' })).toHaveAttribute('aria-checked', 'true');
    await user.click(screen.getAllByRole('button', { name: 'Connect' })[0]);
    await waitFor(() => expect(novnc.instances).toHaveLength(1));
    const rfb = novnc.instances[0];
    expect(level(rfb)).toMatchObject({ qualityLevel: 4, compressionLevel: 2 });

    await user.click(within(toggle).getByRole('radio', { name: 'High' }));
    expect(level(rfb)).toMatchObject({ qualityLevel: 6, compressionLevel: 2 });
    expect(stored.get('nebula.live.quality')).toBe('high'); // per-device preference
    await user.click(within(toggle).getByRole('radio', { name: 'Auto' }));
    expect(level(rfb)).toMatchObject({ qualityLevel: 4, compressionLevel: 2 });
  });
});
