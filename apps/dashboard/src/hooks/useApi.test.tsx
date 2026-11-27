// Polling of the Dashboard: nothing while the tab is hidden (one catch-up refresh on return), and a slower safety-net
// interval while the live event stream is connected.
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../components/Toast';
import { useApi } from './useApi';
import { EventHub, EventsProvider } from './useEvents';

class OpenEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  constructor() {
    queueMicrotask(() => this.onopen?.());
  }
  addEventListener() {}
  close() {}
}

function setVisibility(v: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('useApi polling', () => {
  const loader = vi.fn(async () => 1);
  function Probe({ live }: { live?: boolean }) {
    useApi(loader, [], live ? { pollMs: 15_000, livePollMs: 60_000 } : { pollMs: 15_000 });
    return null;
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    loader.mockClear();
    setVisibility('visible');
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    setVisibility('visible');
  });

  const advance = async (ms: number) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  };

  it('skips polls in a hidden tab and refreshes once when it becomes visible again', async () => {
    render(
      <ToastProvider>
        <Probe />
      </ToastProvider>,
    );
    await advance(0);
    expect(loader).toHaveBeenCalledTimes(1);
    await advance(15_000);
    expect(loader).toHaveBeenCalledTimes(2);
    setVisibility('hidden');
    await advance(120_000);
    expect(loader).toHaveBeenCalledTimes(2); // nothing while hidden
    act(() => setVisibility('visible'));
    await advance(0);
    expect(loader).toHaveBeenCalledTimes(3); // one catch-up
  });

  it('polls every 60 s instead of 15 s while the event stream is open', async () => {
    vi.stubGlobal('EventSource', OpenEventSource);
    const hub = new EventHub();
    render(
      <ToastProvider>
        <EventsProvider hub={hub}>
          <Probe live />
        </EventsProvider>
      </ToastProvider>,
    );
    await advance(0);
    expect(hub.status).toBe('open');
    loader.mockClear();
    await advance(60_000);
    expect(loader).toHaveBeenCalledTimes(1);
    act(() => hub.stop()); // stream down: back to the fast interval
    loader.mockClear();
    await advance(60_000);
    expect(loader).toHaveBeenCalledTimes(4);
  });
});
