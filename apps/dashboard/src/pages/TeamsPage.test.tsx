import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setCsrfToken } from '../api';
import { ToastProvider } from '../components/Toast';
import { installFetch, ok } from '../test/fetchMock';
import { TeamRunPage, validateTeam } from './TeamsPage';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setCsrfToken(null);
});

const m = (agent_id: string, role = 'member') => ({ key: agent_id, agent_id, role, instructions: '' });

describe('validateTeam', () => {
  it('enforces the host rules before sending', () => {
    expect(validateTeam('', [m('a')], 'a')).toMatch(/name/);
    expect(validateTeam('T', [], '')).toMatch(/at least one member/);
    expect(validateTeam('T', [m('a'), m('a')], 'a')).toMatch(/only once/);
    expect(validateTeam('T', [m('a', ' ')], 'a')).toMatch(/role/);
    expect(validateTeam('T', Array.from({ length: 9 }, (_, i) => m(`a${i}`)), 'a0')).toMatch(/8 members/);
    expect(validateTeam('T', [m('a'), m('b')], 'c')).toMatch(/lead/);
    expect(validateTeam('T', [m('a'), m('b')], 'b')).toBeNull();
  });
});

const run = {
  id: 'r1',
  team_id: 'tm1',
  team_name: 'Squad',
  prompt: 'Write the brief',
  state: 'RUNNING',
  source: 'web',
  max_model_calls: null,
  result: null,
  error: null,
  created_at: 1,
  updated_at: 1,
  finished_at: null,
  subtasks: [
    { id: 's1', run_id: 'r1', parent_subtask_id: 'lead', agent_id: 'a1', agent_name: 'Researcher', role: 'researcher', title: 'researcher', prompt: 'x', depends_on: [], state: 'COMPLETED', task_id: 't1', attempts: 1, max_attempts: 2, depth: 0, result_summary: 'Found 12 sources', artifacts: [{ type: 'file', value: '/srv/notes.md' }], created_at: 1, updated_at: 1 },
    { id: 's2', run_id: 'r1', parent_subtask_id: null, agent_id: 'a2', agent_name: 'Writer', role: 'writer', title: 'writer', prompt: 'x', depends_on: ['s1'], state: 'RUNNING', task_id: 't2', attempts: 1, max_attempts: 2, depth: 0, result_summary: null, artifacts: [], created_at: 2, updated_at: 2 },
  ],
  messages: [{ id: 'm1', run_id: 'r1', from_agent_id: 'a1', to_agent_id: 'a2', kind: 'handoff', content: 'researcher → writer: Found 12 sources', payload: null, created_at: 3 }],
};

describe('TeamRunPage', () => {
  it('shows the graph, subtask results and message history, and cancels only after confirmation', async () => {
    setCsrfToken('c');
    const user = userEvent.setup();
    const { calls } = installFetch({
      'GET /api/v1/team-runs/r1': () => ok(run),
      'POST /api/v1/team-runs/r1/cancel': () => ok({ ...run, state: 'CANCELLED' }),
    });
    render(
      <ToastProvider>
        <TeamRunPage teamId="tm1" runId="r1" />
      </ToastProvider>,
    );
    expect(await screen.findByRole('button', { name: 'writer by Writer: running' })).toBeInTheDocument();
    expect(screen.getByText('1 of 2 subtasks finished · 1 completed')).toBeInTheDocument();
    expect(screen.getByText('researcher → writer: Found 12 sources')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^researcher.*attempt 1\/2/ }));
    expect(await screen.findByText('Found 12 sources')).toBeInTheDocument();
    expect(screen.getByText('/srv/notes.md')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Cancel run' }));
    const dialog = await screen.findByRole('dialog');
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel run' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/api/v1/team-runs/r1/cancel')).toBe(true));
  });
});
