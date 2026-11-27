// Shared Mini App queries: one request per key for every screen that shows it, event refreshes that join a request
// already started after the event, and fresh requests for explicit reloads.
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../components/Toast';
import { EventHub, EventsProvider } from '../hooks/useEvents';
import type { NebulaEvent } from '../types';
import { clearQueryCache, useQuery, type QueryState } from './hooks';

let seq = 0;
const emit = (hub: EventHub, type: string) => {
  seq += 1;
  const ev: NebulaEvent = { id: `e${seq}`, sequence: seq, type, agent_id: null, task_id: null, timestamp: 1, payload: {} };
  act(() => hub.handle(new MessageEvent(type, { data: JSON.stringify(ev) })));
};

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
};

describe('Mini App useQuery', () => {
  let n = 0;
  const loader = vi.fn(async () => {
    n += 1;
    return { pending: n };
  });
  const handles: Record<string, QueryState<{ pending: number }>> = {};
  function Probe({ id, refresh = true }: { id: string; refresh?: boolean }) {
    const q = useQuery('approvals:count', loader, refresh ? { refreshOn: (ev) => ev.type.includes('approval') } : {});
    handles[id] = q;
    return <span data-testid={id}>{q.data ? String(q.data.pending) : '…'}</span>;
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    clearQueryCache();
    loader.mockClear();
    n = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup() {
    const hub = new EventHub();
    render(
      <ToastProvider>
        <EventsProvider hub={hub}>
          <Probe id="tabbar" />
          <Probe id="screen" />
        </EventsProvider>
      </ToastProvider>,
    );
    return hub;
  }

  it('two components with the same key share one request and one result', async () => {
    setup();
    await flush();
    expect(loader).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('tabbar')).toHaveTextContent('1');
    expect(screen.getByTestId('screen')).toHaveTextContent('1');
  });

  it('an event refreshes both with a single request; an explicit reload always fetches anew', async () => {
    const hub = setup();
    await flush();
    emit(hub, 'owner.approval.requested');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(350);
    });
    await flush();
    expect(loader).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('tabbar')).toHaveTextContent('2');
    expect(screen.getByTestId('screen')).toHaveTextContent('2');

    act(() => handles.screen.reload());
    await flush();
    expect(loader).toHaveBeenCalledTimes(3);
    expect(screen.getByTestId('tabbar')).toHaveTextContent('3'); // the other view follows
  });

  it('a view mounting right after the key was loaded (lazy screen, prefetch) uses it without a second request', async () => {
    const hub = new EventHub();
    const { rerender } = render(
      <ToastProvider>
        <EventsProvider hub={hub}>
          <Probe id="tabbar" />
        </EventsProvider>
      </ToastProvider>,
    );
    await flush();
    expect(loader).toHaveBeenCalledTimes(1);
    rerender(
      <ToastProvider>
        <EventsProvider hub={hub}>
          <Probe id="tabbar" />
          <Probe id="screen" />
        </EventsProvider>
      </ToastProvider>,
    );
    await flush();
    expect(loader).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('screen')).toHaveTextContent('1');
    // events still refresh both
    emit(hub, 'owner.approval.requested');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(350);
    });
    await flush();
    expect(loader).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('screen')).toHaveTextContent('2');
  });

  it('local updates (setData) reach every view and never block the next server response', async () => {
    setup();
    await flush();
    act(() => handles.tabbar.setData(() => ({ pending: 42 })));
    expect(screen.getByTestId('screen')).toHaveTextContent('42');
    act(() => handles.screen.reload());
    await flush();
    expect(screen.getByTestId('tabbar')).toHaveTextContent('2');
  });
});
