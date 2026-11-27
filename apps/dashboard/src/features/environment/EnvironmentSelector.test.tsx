import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setCsrfToken } from '../../api';
import { ToastProvider } from '../../components/Toast';
import { EnvironmentTab } from '../../pages/agent/EnvironmentTab';
import { apiError, installFetch, ok } from '../../test/fetchMock';
import type { Agent } from '../../types';
import { company } from '../companies/testFixtures';

beforeEach(() => setCsrfToken('csrf'));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setCsrfToken(null);
});

const agent = { id: 'a9', name: 'Nova', state: 'READY', current_task: null } as unknown as Agent;
const info = {
  environments: [
    { id: 'host', label: 'Mac mini — Native Execution', benefits: ['Real project folders'], limitations: ['No desktop control on macOS'], permissions: ['run sandboxed commands'] },
    { id: 'vm', label: 'Ubuntu VM — Isolated Execution', benefits: ['Live Desktop'], limitations: ['Shares the VM’s 4 GB RAM'], permissions: ['own workspace'] },
  ],
  host: {
    sandbox: true,
    running_commands: 1,
    background_processes: 0,
    roots: 1,
    resources: { memory_total_bytes: 16 * 2 ** 30, memory_available_bytes: 8 * 2 ** 30, memory_free_percent: 50, memory_pressure: 'normal', load_avg: [1.5, 1, 1], cpu_count: 10, disk_total_bytes: 1, disk_free_bytes: 1, vm_resident_bytes: 3 * 2 ** 30 },
  },
  vm: { state: 'running', memory_mb: 4096, cpu_count: 4, active_streams: 0 },
};
const root = { id: 'r1', name: 'App', path: '/Users/me/App', mode: 'read_write', allow_network: true, allowed_tools: [], enabled: true, exists: true, created_by: 'owner', created_at: 1, updated_at: 1 };
const vmSummary = {
  agent_id: 'a9',
  effective: { env: 'vm', root_id: null, source: 'agent', label: 'Ubuntu VM — Isolated Execution', chain: [{ level: 'agent', env: 'vm' }] },
  root: null,
  tools: ['files_read', 'browser_open', 'shell_execute'],
  skills_unavailable_here: [],
  problems: [],
  live_desktop: true,
};
const hostSummary = {
  ...vmSummary,
  effective: { env: 'host', root_id: 'r1', source: 'agent', label: 'Mac mini — Native Execution', chain: [{ level: 'agent', env: 'host' }] },
  root,
  tools: ['files_read', 'shell_execute', 'git_run'],
  skills_unavailable_here: ['browser'],
  live_desktop: false,
};

function renderTab() {
  return render(
    <ToastProvider>
      <EnvironmentTab agent={agent} onChanged={() => {}} />
    </ToastProvider>,
  );
}

describe('Agent environment tab', () => {
  it('shows the active environment, refuses a busy agent with a clear 409 message, then switches after confirmation', async () => {
    const user = userEvent.setup();
    let puts = 0;
    const { calls } = installFetch({
      'GET /api/v1/agents/a9/environment': () => ok(vmSummary),
      'GET /api/v1/environments': () => ok(info),
      'GET /api/v1/host/roots': () => ok([root]),
      'PUT /api/v1/agents/a9/environment': () => {
        puts += 1;
        return puts === 1 ? apiError(409, 'agent_busy', 'the agent has 1 active/paused task(s); finish or stop them before switching environments') : ok(hostSummary);
      },
    });
    renderTab();
    expect(await screen.findByRole('heading', { name: 'Ubuntu VM — Isolated Execution' })).toBeInTheDocument();
    const vmRadio = screen.getByRole('radio', { name: /VIRTUAL MACHINE/ });
    const hostRadio = screen.getByRole('radio', { name: /HOST COMPUTER/ });
    expect(vmRadio).toBeChecked();
    const vmCard = vmRadio.closest('label') as HTMLElement;
    expect(within(vmCard).getByText('Active now')).toBeInTheDocument();
    expect(within(vmCard).getByText('Live Desktop')).toBeInTheDocument();
    expect(within(hostRadio.closest('label') as HTMLElement).queryByText('Active now')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Already active/ })).toBeDisabled();
    expect(within(screen.getByRole('list', { name: 'Available tools' })).getByText('browser_open')).toBeInTheDocument();

    await user.click(hostRadio);
    expect(within(hostRadio.closest('label') as HTMLElement).getByText('Selected · not applied')).toBeInTheDocument();
    expect(screen.getByLabelText(/Project folder on the Mac/)).toHaveValue('r1'); // the only authorised folder
    await user.click(screen.getByRole('button', { name: 'Switch to Host computer' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('/Users/me/App')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    await user.click(within(dialog).getByRole('button', { name: 'Switch to Host computer' }));

    expect(await screen.findByText('Agent is busy — environment not switched')).toBeInTheDocument();
    expect(screen.getByText(/finish or stop them before switching environments/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the agent’s tasks' })).toHaveAttribute('href', '#/agents/a9/tasks');
    expect(screen.getByRole('heading', { name: 'Ubuntu VM — Isolated Execution' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Switch to Host computer' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Switch to Host computer' }));
    expect(await screen.findByRole('heading', { name: 'Mac mini — Native Execution' })).toBeInTheDocument();
    expect(screen.queryByText('Agent is busy — environment not switched')).not.toBeInTheDocument();
    expect(within(screen.getByRole('radio', { name: /HOST COMPUTER/ }).closest('label') as HTMLElement).getByText('Active now')).toBeInTheDocument();
    expect(screen.getByText(/browser need a desktop or browser/)).toBeInTheDocument();
    const put = calls.filter((c) => c.method === 'PUT');
    expect(put).toHaveLength(2);
    expect(put[1].body).toEqual({ env: 'host', root_id: 'r1' });
    expect(put[1].headers['x-csrf-token']).toBe('csrf');
  });

  it('reports environment_not_ready problems without changing anything', async () => {
    const user = userEvent.setup();
    installFetch({
      'GET /api/v1/agents/a9/environment': () => ok(hostSummary),
      'GET /api/v1/environments': () => ok(info),
      'GET /api/v1/host/roots': () => ok([root]),
      'PUT /api/v1/agents/a9/environment': () => apiError(409, 'environment_not_ready', 'VM unavailable: TimeoutError'),
    });
    renderTab();
    await user.click(await screen.findByRole('radio', { name: /VIRTUAL MACHINE/ }));
    await user.click(screen.getByRole('button', { name: 'Switch to Virtual machine' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Switch to Virtual machine' }));
    expect(await screen.findByText('Target environment is not ready — nothing was changed')).toBeInTheDocument();
    expect(screen.getByText('VM unavailable: TimeoutError')).toBeInTheDocument();
  });

  it('is read-only for company employees and links to the company', async () => {
    installFetch({
      'GET /api/v1/agents/a9/environment': () =>
        ok({ ...vmSummary, effective: { ...vmSummary.effective, source: 'member', env: 'host', chain: [{ level: 'company', env: 'vm' }, { level: 'member', env: 'host' }] } }),
      'GET /api/v1/environments': () => ok(info),
      'GET /api/v1/host/roots': () => ok([root]),
      'GET /api/v1/companies': () => ok([{ ...company, member_count: 1, project_count: 0, active_runs: 0 }]),
      'GET /api/v1/companies/c1': () => ok({ ...company, members: [{ ...company.members[0], agent_id: 'a9' }] }),
    });
    renderTab();
    expect(await screen.findByText('Managed by the company')).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: /Open Acme · Employees/ })).toHaveAttribute('href', '#/companies/c1/employees');
    expect(screen.getByRole('radio', { name: /HOST COMPUTER/ })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /Switch to/ })).not.toBeInTheDocument();
    const chain = screen.getByRole('list', { name: 'Environment inheritance chain' });
    expect(within(chain).getByText('Employee override').closest('[aria-current="step"]')).not.toBeNull();
    await waitFor(() => expect(screen.getByRole('link', { name: 'Acme' })).toHaveAttribute('href', '#/companies/c1'));
  });
});
