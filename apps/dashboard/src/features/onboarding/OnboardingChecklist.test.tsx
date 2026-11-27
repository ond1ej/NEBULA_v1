import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setCsrfToken } from '../../api';
import { ToastProvider } from '../../components/Toast';
import { installFetch, ok } from '../../test/fetchMock';
import type { OverviewData } from '../../types';
import { OnboardingChecklist } from './OnboardingChecklist';
import { SAMPLE_TASK } from './sample';
import { readDismissed, readLiveOpened, writeDismissed, writeLiveOpened } from './storage';

let store: Map<string, string>;
beforeEach(() => {
  store = new Map();
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setCsrfToken(null);
});

const overview = (over: Partial<OverviewData> = {}): OverviewData =>
  ({
    agents: [],
    running_tasks: [],
    recent_results: [],
    active_team_runs: [],
    upcoming_schedules: [],
    providers: [{ id: 'ollama-local', display_name: 'Ollama', state: 'Not connected', auth_mode: 'local' }],
    approvals_pending: 0,
    workflow_runs_active: 0,
    recent_events: [],
    resources: { host: null, guest: null, limits: {} as OverviewData['resources']['limits'], active_workers: 0, queue_length: 0 },
    telegram: { polling: false },
    ...over,
  }) as OverviewData;

const remote = (over: Record<string, unknown> = {}) => ({ enabled: false, tunnel: 'none', tunnel_running: false, public_mini_url: null, ...over });

function setup(ov: OverviewData, opts: { remote?: Record<string, unknown> } = {}) {
  const net = installFetch({
    'GET /api/v1/remote': () => ok(remote(opts.remote)),
  });
  const onDismiss = vi.fn();
  render(
    <ToastProvider>
      <OnboardingChecklist overview={ov} onDismiss={onDismiss} />
    </ToastProvider>,
  );
  return { onDismiss, calls: net.calls };
}

const step = (id: string) => screen.getByTestId(`onboarding-${id}`);

describe('OnboardingChecklist', () => {
  it('fresh install: nothing is done, the next step is highlighted and later steps wait for an agent', async () => {
    setup(overview());
    expect(screen.getByText('Get started with NEBULA')).toBeInTheDocument();
    expect(screen.getByText('0 of 4 steps done')).toBeInTheDocument();
    expect(within(step('provider')).getByRole('link', { name: 'Choose a provider' })).toHaveAttribute('href', '#/providers');
    expect(within(step('agent')).getByRole('link', { name: 'Create the agent' })).toHaveAttribute('href', '#/agents/new?first=1');
    expect(within(step('task')).queryByRole('link')).toBeNull();
    expect(within(step('task')).getByText('Create an agent first')).toBeInTheDocument();
    expect(within(step('live')).getByText('Create an agent first')).toBeInTheDocument();
    expect(within(step('remote')).getByText('Optional')).toBeInTheDocument();
    expect(step('remote')).toHaveAttribute('data-done', 'false');
  });

  it('adds no request while the required steps are open (the Command Center has a request budget)', async () => {
    const { calls } = setup(overview());
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toHaveLength(0);
  });

  it('shows done state from the overview and deep-links to the first agent', () => {
    setup(
      overview({
        providers: [{ id: 'openai-api', display_name: 'OpenAI', state: 'Connected (API Billing)', auth_mode: 'api_key' }],
        agents: [{ id: 'a1', name: 'Assistant', status: 'ACTIVE', provider_id: 'openai-api', model_id: 'm', last_active_at: 1700000000 }],
      }),
    );
    expect(step('task')).toHaveAttribute('data-done', 'true');
    expect(step('provider')).toHaveAttribute('data-done', 'true');
    expect(step('agent')).toHaveAttribute('data-done', 'true');
    expect(step('live')).toHaveAttribute('data-done', 'false');
    expect(screen.getByText('3 of 4 steps done')).toBeInTheDocument();
    expect(within(step('live')).getByRole('link', { name: 'Open Live Desktop' })).toHaveAttribute('href', '#/agents/a1/live');
    expect(within(step('task')).getByRole('link', { name: 'Open' })).toHaveAttribute('href', '#/agents/a1/chat?sample=1');
  });

  it('opening Live Desktop completes that step (remembered in this browser) and finishes the checklist', async () => {
    const user = userEvent.setup();
    setup(
      overview({
        providers: [{ id: 'ollama-local', display_name: 'Ollama', state: 'Connected', auth_mode: 'local' }],
        agents: [{ id: 'a1', name: 'Assistant', status: 'ACTIVE', provider_id: 'ollama-local', model_id: 'm', last_active_at: null }],
        recent_results: [{ id: 't1', agent_id: 'a1', state: 'COMPLETED', prompt: 'p', failure_reason: null, finished_at: 1, agent_name: 'Assistant', summary: 's' }],
      }),
    );
    const link = within(step('live')).getByRole('link', { name: 'Open Live Desktop' });
    link.addEventListener('click', (e) => e.preventDefault());
    await user.click(link);
    expect(readLiveOpened()).toBe(true);
    expect(await screen.findByText('You are all set')).toBeInTheDocument();
    expect(step('live')).toHaveAttribute('data-done', 'true');
    expect(step('remote')).toHaveAttribute('data-done', 'false');
  });

  it('once the required steps are done it asks GET /remote and marks the optional remote step', async () => {
    store.set('nebula.onboarding.liveDesktop', '1');
    const { calls } = setup(
      overview({
        providers: [{ id: 'ollama-local', display_name: 'Ollama', state: 'Connected', auth_mode: 'local' }],
        agents: [{ id: 'a1', name: 'Assistant', status: 'ACTIVE', provider_id: 'ollama-local', model_id: 'm', last_active_at: 1700000000 }],
      }),
      { remote: { enabled: true, tunnel: 'tailscale_serve', tunnel_running: true, public_mini_url: 'https://mac.tail.ts.net/mini/' } },
    );
    await waitFor(() => expect(step('remote')).toHaveAttribute('data-done', 'true'));
    expect(calls.map((c) => c.path)).toEqual(['/api/v1/remote']);
    expect(screen.getByText('You are all set')).toBeInTheDocument();
  });

  it('is dismissible', async () => {
    const user = userEvent.setup();
    const { onDismiss } = setup(overview());
    await user.click(screen.getByRole('button', { name: 'Dismiss the setup checklist' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe('onboarding storage', () => {
  it('remembers the dismissal and survives blocked storage', () => {
    expect(readDismissed()).toBe(false);
    writeDismissed(true);
    expect(readDismissed()).toBe(true);
    writeDismissed(false);
    expect(readDismissed()).toBe(false);
    writeLiveOpened(true);
    expect(readLiveOpened()).toBe(true);
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    });
    expect(readDismissed()).toBe(false);
    expect(() => writeDismissed(true)).not.toThrow();
  });

  it('the sample task is read-only and harmless', () => {
    expect(SAMPLE_TASK).toMatch(/example\.com/);
    expect(SAMPLE_TASK).toMatch(/Do not click anything or type anything/);
  });
});
