import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setCsrfToken } from '../api';
import { EventHub, EventsProvider } from '../hooks/useEvents';
import { installFetch, ok } from '../test/fetchMock';
import { ApprovalsProvider, useApprovals } from './Approval';
import { ToastProvider } from './Toast';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setCsrfToken(null);
});

const owner = {
  id: 'oa1',
  kind: 'schedule_misfire',
  ref: { schedule_id: 'sc1', run_id: 'r9' },
  summary: "Schedule 'Morning brief' missed 2 run(s) while NEBULA was offline. Run it once now?",
  preview: null,
  decision: null,
  resolved_by: null,
  created_at: Date.now() / 1000 - 5,
  expires_at: Date.now() / 1000 + 3600,
  resolved_at: null,
};

function Count() {
  const { count, openPanel } = useApprovals();
  return (
    <button type="button" onClick={openPanel}>
      waiting {count}
    </button>
  );
}

describe('ApprovalsProvider', () => {
  it('pops up owner approvals announced over SSE and resolves them with POST /owner-approvals/{id}', async () => {
    setCsrfToken('c');
    const user = userEvent.setup();
    let pending = [] as (typeof owner)[];
    const { calls } = installFetch({
      'GET /api/v1/approvals': () => ok([]),
      'GET /api/v1/owner-approvals': () => ok(pending),
      'POST /api/v1/owner-approvals/oa1': (c) => ok({ ...owner, decision: (c.body as { decision: string }).decision }),
    });
    const hub = new EventHub();
    render(
      <ToastProvider>
        <EventsProvider hub={hub}>
          <ApprovalsProvider>
            <Count />
          </ApprovalsProvider>
        </EventsProvider>
      </ToastProvider>,
    );
    expect(await screen.findByText('waiting 0')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    pending = [owner];
    act(() => {
      hub.handle(new MessageEvent('owner.approval.requested', { data: JSON.stringify({ id: 'e1', sequence: 1, type: 'owner.approval.requested', agent_id: null, task_id: null, timestamp: 1, payload: { approval_id: 'oa1', kind: 'schedule_misfire' } }) }));
    });
    const dialog = await screen.findByRole('dialog', { name: 'NEBULA needs your decision' });
    expect(within(dialog).getByText(owner.summary)).toBeInTheDocument();
    expect(screen.getByText('waiting 1')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Run it now' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ decision: 'approved' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    hub.stop();
  });

  it('lists task and automation approvals in the panel', async () => {
    installFetch({
      'GET /api/v1/approvals': () => ok([]),
      'GET /api/v1/owner-approvals': () => ok([owner]),
      'GET /api/v1/agents': () => ok([]),
    });
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <ApprovalsProvider>
          <Count />
        </ApprovalsProvider>
      </ToastProvider>,
    );
    await user.click(await screen.findByText('waiting 1'));
    const panel = await screen.findByRole('dialog', { name: 'Approvals' });
    expect(within(panel).getByText('Automation (1)')).toBeInTheDocument();
    expect(within(panel).getByText('No agent is waiting for approval.')).toBeInTheDocument();
    expect(within(panel).getByRole('link', { name: 'Open schedule' })).toHaveAttribute('href', '#/schedules/sc1');
  });
});
