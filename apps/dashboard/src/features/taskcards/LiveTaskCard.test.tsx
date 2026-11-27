import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setCsrfToken } from '../../api';
import { ToastProvider } from '../../components/Toast';
import { installFetch, ok } from '../../test/fetchMock';
import { actionsFor, currentStep, lifecycle, type LiveTask } from './lifecycle';
import { LiveTaskCard } from './LiveTaskCard';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setCsrfToken(null);
});

const task = (over: Partial<LiveTask> = {}): LiveTask => ({
  id: 't1234567-0000',
  agent_id: 'ag1',
  agent_name: 'Researcher',
  prompt: 'Compare three laptops\nand write a table',
  state: 'EXECUTING',
  current_step: 3,
  max_steps: 50,
  execution: { env: 'vm' },
  result: null,
  failure_reason: null,
  started_at: Date.now() / 1000 - 90,
  updated_at: 1,
  ...over,
});

describe('task lifecycle mapping (mirrors Telegram cards.py)', () => {
  it('maps every task state to a card lifecycle', () => {
    const cases: [string, number, string][] = [
      ['RECEIVED', 0, 'QUEUED'],
      ['QUEUED', 0, 'QUEUED'],
      ['PLANNING', 0, 'PREPARING'],
      ['PLANNING', 2, 'RUNNING'],
      ['EXECUTING', 1, 'RUNNING'],
      ['VERIFYING', 9, 'RUNNING'],
      ['PAUSING', 4, 'RUNNING'],
      ['WAITING_CONTROL', 4, 'RUNNING'],
      ['WAITING_PROVIDER', 4, 'RUNNING'],
      ['WAITING_APPROVAL', 4, 'WAITING_FOR_APPROVAL'],
      ['PAUSED', 4, 'PAUSED'],
      ['COMPLETED', 9, 'COMPLETED'],
      ['FAILED', 9, 'FAILED'],
      ['CANCELLED', 9, 'CANCELLED'],
    ];
    for (const [state, step, want] of cases) expect(lifecycle({ state, current_step: step })).toBe(want);
  });

  it('describes the current step and offers state-dependent actions', () => {
    expect(currentStep(task(), { tool_type: 'browser_open', result_status: 'ok' })).toBe('browser_open (ok)');
    expect(currentStep(task({ state: 'PLANNING', current_step: 0 }), null)).toBe('preparing the environment');
    expect(currentStep(task({ state: 'WAITING_APPROVAL' }), null)).toBe('waiting for your approval');
    expect(currentStep(task({ state: 'QUEUED', current_step: 0 }), null)).toBe('waiting in queue');
    expect(currentStep(task({ state: 'COMPLETED', result: { summary: 'Table saved to laptops.md' } }), null)).toBe('Table saved to laptops.md');
    expect(currentStep(task({ state: 'FAILED', failure_reason: 'provider quota' }), null)).toBe('provider quota');
    expect(actionsFor(task())).toEqual(['pause', 'stop', 'desktop', 'details']);
    expect(actionsFor(task({ execution: { env: 'host' } }))).toEqual(['pause', 'stop', 'details']);
    expect(actionsFor(task({ state: 'WAITING_APPROVAL' }))).toEqual(['approval', 'stop', 'details']);
    expect(actionsFor(task({ state: 'PAUSED' }))).toEqual(['resume', 'stop', 'details']);
    expect(actionsFor(task({ state: 'COMPLETED' }))).toEqual(['details']);
    expect(actionsFor(task({ state: 'CANCELLED' }))).toEqual(['retry', 'details']);
  });
});

function renderCard(t: LiveTask, onChanged = vi.fn()) {
  render(
    <ToastProvider>
      <LiveTaskCard task={t} fetchDetail={false} onChanged={onChanged} />
    </ToastProvider>,
  );
  return onChanged;
}

describe('LiveTaskCard', () => {
  it('shows lifecycle, step, progress and environment, and pauses / stops through the API', async () => {
    setCsrfToken('c');
    const user = userEvent.setup();
    const { calls } = installFetch({
      'POST /api/v1/tasks/t1234567-0000/pause': () => ok(task({ state: 'PAUSING', updated_at: 2 })),
      'POST /api/v1/tasks/t1234567-0000/stop': () => ok(task({ state: 'CANCELLED', updated_at: 3 })),
    });
    const onChanged = renderCard(task());
    const card = screen.getByTestId('live-task-card');
    expect(card).toHaveAttribute('data-lifecycle', 'RUNNING');
    expect(within(card).getByText('Ubuntu VM')).toBeInTheDocument();
    expect(within(card).getByText('Progress 3/50 steps')).toBeInTheDocument();
    expect(within(card).getByRole('meter')).toHaveAttribute('aria-valuenow', '6');
    expect(within(card).getByRole('link', { name: /Open desktop/ })).toHaveAttribute('href', '#/agents/ag1/live');
    expect(within(card).getByRole('link', { name: 'Details' })).toHaveAttribute('href', '#/agents/ag1/tasks?task=t1234567-0000');

    await user.click(within(card).getByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(calls.find((c) => c.path.endsWith('/pause'))?.body).toEqual({ mode: 'smart' }));
    await waitFor(() => expect(within(card).getByTestId('task-card-step')).toHaveTextContent('pausing after the current step'));
    expect(onChanged).toHaveBeenCalled();

    await user.click(within(card).getByRole('button', { name: 'Stop' }));
    const dlg = await screen.findByRole('dialog', { name: 'Stop this task?' });
    expect(calls.some((c) => c.path.endsWith('/stop'))).toBe(false);
    await user.click(within(dlg).getByRole('button', { name: 'Stop task' }));
    await waitFor(() => expect(calls.find((c) => c.path.endsWith('/stop'))?.body).toEqual({ mode: 'cancel' }));
    await waitFor(() => expect(card).toHaveAttribute('data-lifecycle', 'CANCELLED'));
    expect(within(card).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('resumes a paused task, retries a failed one and links approvals', async () => {
    setCsrfToken('c');
    const user = userEvent.setup();
    const { calls } = installFetch({
      'POST /api/v1/tasks/p1/resume': () => ok(task({ id: 'p1', state: 'EXECUTING', updated_at: 5 })),
      'POST /api/v1/tasks/f1/retry': () => ok(task({ id: 'n1', state: 'QUEUED', current_step: 0 })),
    });
    renderCard(task({ id: 'p1', state: 'PAUSED', execution: { env: 'host' } }));
    const paused = screen.getByTestId('live-task-card');
    expect(within(paused).getByText('Mac mini')).toBeInTheDocument();
    expect(within(paused).queryByRole('link', { name: /Open desktop/ })).toBeNull();
    await user.click(within(paused).getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(calls.some((c) => c.path === '/api/v1/tasks/p1/resume' && c.method === 'POST')).toBe(true));
    await waitFor(() => expect(paused).toHaveAttribute('data-lifecycle', 'RUNNING'));
    cleanup();

    const onRetry = renderCard(task({ id: 'f1', state: 'FAILED', failure_reason: 'The page did not load' }));
    const failed = screen.getByTestId('live-task-card');
    expect(within(failed).getByText('The page did not load')).toBeInTheDocument();
    await user.click(within(failed).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(calls.some((c) => c.path === '/api/v1/tasks/f1/retry')).toBe(true));
    await waitFor(() => expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ id: 'n1' })));
    cleanup();

    renderCard(task({ id: 'w1', state: 'WAITING_APPROVAL' }));
    const waiting = screen.getByTestId('live-task-card');
    expect(waiting).toHaveAttribute('data-lifecycle', 'WAITING_FOR_APPROVAL');
    expect(within(waiting).getByRole('link', { name: /Review approval/ })).toHaveAttribute('href', '#/approvals');
  });
});
