import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setCsrfToken } from '../api';
import { installFetch, ok } from '../test/fetchMock';
import type { Task } from '../types';
import { TaskActions } from './TaskDetail';
import { ToastProvider } from './Toast';

const task = (state: string): Task => ({
  id: 't1',
  agent_id: 'a1',
  prompt: 'do it',
  state,
  current_step: 2,
  retry_count: 0,
  tool_calls_done: 2,
  max_steps: 30,
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
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setCsrfToken(null);
});

describe('TaskActions', () => {
  it('emergency stop is behind a confirmation and sends mode=emergency', async () => {
    setCsrfToken('c');
    const user = userEvent.setup();
    const { calls } = installFetch({ 'POST /api/v1/tasks/t1/stop': () => ok({ ...task('CANCELLED') }) });
    render(
      <ToastProvider>
        <TaskActions task={task('EXECUTING')} />
      </ToastProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Emergency stop' }));
    const dialog = await screen.findByRole('dialog');
    expect(calls).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Emergency stop' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].body).toEqual({ mode: 'emergency' });
    expect(calls[0].headers['x-csrf-token']).toBe('c');
  });

  it('offers Retry only for failed / cancelled tasks', () => {
    const { rerender } = render(
      <ToastProvider>
        <TaskActions task={task('FAILED')} />
      </ToastProvider>,
    );
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument();
    rerender(
      <ToastProvider>
        <TaskActions task={task('PAUSED')} />
      </ToastProvider>,
    );
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resume' })).toBeInTheDocument();
  });
});
