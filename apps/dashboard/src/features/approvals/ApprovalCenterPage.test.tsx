import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setCsrfToken } from '../../api';
import { ToastProvider } from '../../components/Toast';
import { installFetch, ok } from '../../test/fetchMock';
import { describeDecider, riskCategories } from './api';
import { ApprovalCenterPage } from './ApprovalCenterPage';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setCsrfToken(null);
});

const now = () => Date.now() / 1000;

const taskApproval = (over: Record<string, unknown> = {}) => ({
  kind: 'task',
  id: 'a1',
  task_id: 't1',
  agent_id: 'ag1',
  agent_name: 'Developer',
  tool: 'shell_exec',
  action_summary: 'shell_exec {"command": "git push origin main"}',
  action_preview: { command: 'git push origin main' },
  reason: 'sensitive action: external_share',
  requested_by: 'agent',
  resolved_by: null,
  decision: null,
  created_at: now() - 30,
  expires_at: now() + 600,
  resolved_at: null,
  prompt: 'Publish the release branch',
  environment: 'host',
  parent_ref: null,
  ...over,
});

const ownerPlan = {
  kind: 'company_plan',
  id: 'o1',
  ref: { run_id: 'r1', company_id: 'c1' },
  summary: 'CEO plan: 4 work items for "Launch website"',
  preview: { items: [{ title: 'Design' }, { title: 'Build' }] },
  decision: null,
  resolved_by: null,
  created_at: now() - 60,
  expires_at: now() + 3600,
  resolved_at: null,
};

const recent = [
  { id: 'x1', tool: 'browser_type', decision: 'approved', resolved_by: 'telegram:4242', resolved_at: now() - 120, action_summary: 'type into form' },
  { id: 'x2', tool: 'shell_exec', decision: 'denied', resolved_by: 'miniapp:4242', resolved_at: now() - 300, action_summary: 'rm -rf build' },
];

function renderPage() {
  return render(
    <ToastProvider>
      <ApprovalCenterPage />
    </ToastProvider>,
  );
}

describe('Approval Center', () => {
  it('parses risk categories and deciders', () => {
    expect(riskCategories('host action needs the owner\'s approval: host_delete, mass_delete')).toEqual(['host_delete', 'mass_delete']);
    expect(describeDecider('telegram:42')).toEqual({ channel: 'Telegram', who: '42' });
    expect(describeDecider('miniapp:42').channel).toBe('Mini App');
    expect(describeDecider('user:admin')).toEqual({ channel: 'Dashboard', who: 'admin' });
  });

  it('shows grouped approvals with the exact operation and records approve / reject', async () => {
    setCsrfToken('c');
    const user = userEvent.setup();
    const { calls } = installFetch({
      'GET /api/v1/approval-center': () => ok({ pending: [taskApproval(), ownerPlan], recent }),
      'POST /api/v1/approvals/a1': (c) => ok({ id: 'a1', decision: (c.body as { decision: string }).decision }),
      'POST /api/v1/owner-approvals/o1': (c) => ok({ id: 'o1', decision: (c.body as { decision: string }).decision }),
    });
    renderPage();
    const card = await screen.findByTestId('center-task-approval');
    expect(within(card).getByText('Developer')).toBeInTheDocument();
    expect(within(card).getByText('Mac')).toBeInTheDocument();
    expect(within(card).getByText('Publish the release branch')).toBeInTheDocument();
    expect(within(card).getByText('shell_exec {"command": "git push origin main"}')).toBeInTheDocument();
    expect(within(card).getByText('sensitive action: external_share')).toBeInTheDocument();
    expect(within(card).getByRole('timer')).toHaveTextContent(/Expires in/);
    expect(screen.getByRole('heading', { name: /Company plans/ })).toBeInTheDocument();
    // recent decisions say who decided
    expect(screen.getByText('Telegram')).toBeInTheDocument();
    expect(screen.getByText('Mini App')).toBeInTheDocument();

    await user.click(within(card).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(calls.find((c) => c.path === '/api/v1/approvals/a1')?.body).toEqual({ decision: 'approved' }));

    const plan = screen.getByTestId('center-owner-approval');
    await user.click(within(plan).getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(calls.find((c) => c.path === '/api/v1/owner-approvals/o1')?.body).toEqual({ decision: 'denied' }));
    expect(calls.filter((c) => c.method === 'POST').every((c) => c.headers['x-csrf-token'] === 'c')).toBe(true);
  });

  it('asks for confirmation before approving a destructive operation', async () => {
    setCsrfToken('c');
    const user = userEvent.setup();
    const { calls } = installFetch({
      'GET /api/v1/approval-center': () =>
        ok({ pending: [taskApproval({ id: 'a2', tool: 'host_delete', action_summary: 'delete ~/Projects/site/build', reason: "host action needs the owner's approval: host_delete" })], recent: [] }),
      'POST /api/v1/approvals/a2': () => ok({ id: 'a2', decision: 'approved' }),
    });
    renderPage();
    const card = await screen.findByTestId('center-task-approval');
    expect(within(card).getByText('Destructive')).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: 'Approve' }));
    const dlg = await screen.findByRole('dialog', { name: 'Approve a destructive operation?' });
    expect(within(dlg).getByText('delete ~/Projects/site/build')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    await user.click(within(dlg).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ decision: 'approved' }));
  });
});
