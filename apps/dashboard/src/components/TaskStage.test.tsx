// Live execution stages in the UI: the Dashboard's live task card and the shared stage line (Mini App task view).
import { act, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveTaskCard } from '../features/taskcards/LiveTaskCard';
import type { LiveTask } from '../features/taskcards/lifecycle';
import { EventHub, EventsProvider } from '../hooks/useEvents';
import type { NebulaEvent } from '../types';
import { TaskStageLine } from './TaskStage';
import { ToastProvider } from './Toast';

let seq = 0;
function emit(hub: EventHub, type: string, taskId: string, payload: Record<string, unknown>, timestamp = Date.now() / 1000) {
  seq += 1;
  const ev: NebulaEvent = { id: `e${seq}`, sequence: seq, type, agent_id: 'ag1', task_id: taskId, timestamp, payload };
  act(() => hub.handle(new MessageEvent(type, { data: JSON.stringify(ev) })));
}

const task = (over: Partial<LiveTask> = {}): LiveTask => ({
  id: 't1',
  agent_id: 'ag1',
  agent_name: 'Researcher',
  prompt: 'Compare laptops',
  state: 'EXECUTING',
  current_step: 2,
  max_steps: 40,
  execution: { env: 'vm' },
  started_at: Date.now() / 1000 - 30,
  updated_at: 1,
  ...over,
});

function setup(ui: (hub: EventHub) => React.ReactNode) {
  const hub = new EventHub(); // never started: events are injected with hub.handle()
  render(
    <ToastProvider>
      <EventsProvider hub={hub}>{ui(hub)}</EventsProvider>
    </ToastProvider>,
  );
  return hub;
}

describe('live task stages', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-11-16T10:00:00Z'));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'x', message: 'offline' } }), { status: 503 })));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('shows the current stage with a ticking timer on the task card, and the tool name for tool stages', () => {
    const hub = setup(() => <LiveTaskCard task={task()} fetchDetail={false} />);
    const card = screen.getByTestId('live-task-card');
    // no stage yet (older task / older host): the existing step line
    expect(within(card).getByTestId('task-card-step')).toHaveTextContent('thinking');

    const now = Date.now() / 1000;
    emit(hub, 'task.stage', 't1', { stage: 'model_request', detail: 'anthropic-api/claude-x', elapsed_ms: 30_000, at: now }, now);
    expect(within(card).getByTestId('task-card-step')).toHaveTextContent('Waiting for the model · 0 s');
    act(() => vi.advanceTimersByTime(4_000));
    expect(within(card).getByTestId('task-card-step')).toHaveTextContent('Waiting for the model · 4 s');

    const later = Date.now() / 1000;
    emit(hub, 'task.stage', 't1', { stage: 'tool', detail: 'browser.open', elapsed_ms: 34_000, at: later }, later);
    expect(within(card).getByTestId('task-card-step')).toHaveTextContent('Running browser.open · 0 s');
    act(() => vi.advanceTimersByTime(2_000));
    expect(within(card).getByTestId('task-card-step')).toHaveTextContent('Running browser.open · 2 s');

    // another task's stage does not touch this card
    emit(hub, 'task.stage', 't2', { stage: 'verifying', detail: null, elapsed_ms: 1, at: later }, later);
    expect(within(card).getByTestId('task-card-step')).toHaveTextContent('Running browser.open');
  });

  it('a stage that arrived before the view mounted is shown; finished tasks drop it', () => {
    const hub = new EventHub();
    const now = Date.now() / 1000;
    const { rerender } = render(
      <EventsProvider hub={hub}>
        <span />
      </EventsProvider>,
    );
    emit(hub, 'task.stage', 't1', { stage: 'waking_desktop', detail: null, elapsed_ms: 2000, at: now - 3 }, now); // began 3 s ago
    rerender(
      <EventsProvider hub={hub}>
        <TaskStageLine taskId="t1" state="EXECUTING" startedAt={now - 10} />
      </EventsProvider>,
    );
    expect(screen.getByTestId('task-stage')).toHaveTextContent('Waking the desktop · 3 s');
    emit(hub, 'task.completed', 't1', {});
    // no stage any more: falls back to the task state and the time since it started
    expect(screen.getByTestId('task-stage')).toHaveTextContent('Working · 10 s');
    rerender(
      <EventsProvider hub={hub}>
        <TaskStageLine taskId="t1" state="COMPLETED" startedAt={now - 10} />
      </EventsProvider>,
    );
    expect(screen.queryByTestId('task-stage')).not.toBeInTheDocument();
  });

  it('falls back gracefully without any stage event and defers to approval / provider waits', () => {
    const now = Date.now() / 1000;
    const hub = setup(() => (
      <>
        <TaskStageLine taskId="old" state="EXECUTING" startedAt={now - 75} />
        <TaskStageLine taskId="q" state="QUEUED" startedAt={null} />
        <TaskStageLine taskId="ap" state="WAITING_APPROVAL" startedAt={now - 5} />
      </>
    ));
    emit(hub, 'task.stage', 'ap', { stage: 'tool', detail: 'browser.submit', elapsed_ms: 1, at: now }, now);
    const lines = screen.getAllByTestId('task-stage');
    expect(lines[0]).toHaveTextContent('Working · 1 min 15 s');
    expect(lines[1]).toHaveTextContent('Waiting in the queue');
    expect(lines[1]).not.toHaveTextContent('·');
    expect(lines[2]).toHaveTextContent('Waiting for your approval');
    expect(lines[2]).not.toHaveTextContent('browser.submit');
  });
});
