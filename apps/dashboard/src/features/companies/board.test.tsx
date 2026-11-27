import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setCsrfToken } from '../../api';
import { ToastProvider } from '../../components/Toast';
import { installFetch, ok } from '../../test/fetchMock';
import { groupWorkItems } from './lib';
import { ProjectWorkspace } from './ProjectWorkspace';
import { company, item, project, roots, run } from './testFixtures';

beforeEach(() => setCsrfToken('csrf'));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setCsrfToken(null);
});

describe('groupWorkItems', () => {
  it('groups work items into board columns by state, ordered by position', () => {
    const g = groupWorkItems([
      item({ id: 'a', state: 'READY', position: 2 }),
      item({ id: 'b', state: 'PENDING', position: 1 }),
      item({ id: 'c', state: 'WAITING' }),
      item({ id: 'd', state: 'SKIPPED' }),
      item({ id: 'e', state: 'CANCELLED' }),
      item({ id: 'f', state: 'COMPLETED' }),
      item({ id: 'g', state: 'FAILED' }),
    ]);
    const ids = Object.fromEntries(g.map((x) => [x.id, x.items.map((i) => i.id)]));
    expect(ids).toEqual({ queued: ['b', 'a'], running: ['c'], completed: ['f'], failed: ['g'], stopped: ['d', 'e'] });
  });
});

describe('Project task board', () => {
  it('shows work items by state with role, agent, environment + source, attempts, artifacts, transfers, and retries failed items', async () => {
    const user = userEvent.setup();
    const { calls } = installFetch({
      'GET /api/v1/projects/p1': () => ok(project),
      'GET /api/v1/companies/c1': () => ok(company),
      'GET /api/v1/host/roots': () => ok(roots),
      'GET /api/v1/company-runs/r1': () => ok(run),
      'POST /api/v1/company-items/i3/retry': () => ok({ ...run, items: run.items.map((i) => (i.id === 'i3' ? { ...i, state: 'PENDING', attempts: 0, result_summary: null } : i)) }),
    });
    render(
      <ToastProvider>
        <ProjectWorkspace companyId="c1" projectId="p1" tab="board" query={new URLSearchParams()} />
      </ToastProvider>,
    );
    const completed = await screen.findByRole('region', { name: 'Completed (1)' });
    const running = screen.getByRole('region', { name: 'In progress (1)' });
    const failed = screen.getByRole('region', { name: 'Failed (1)' });
    const queued = screen.getByRole('region', { name: 'Queued (1)' });

    const research = within(completed).getByRole('article', { name: 'Researcher: market scan' });
    expect(within(research).getByText('Found 5 competitors')).toBeInTheDocument();
    expect(within(research).getByText('/srv/nebula/shared/abc123/mobile-app-p1/report.md')).toBeInTheDocument();
    expect(within(research).getByRole('link', { name: /Open task/ })).toHaveAttribute('href', '#/agents/a3/tasks?task=t1');

    const api = within(running).getByRole('article', { name: 'Backend Developer: build the API' });
    expect(within(api).getByText('Backend Developer')).toBeInTheDocument();
    expect(within(api).getByRole('link', { name: 'Bob' })).toHaveAttribute('href', '#/agents/a2');
    const badge = api.querySelector('[data-env="host"]') as HTMLElement;
    expect(badge).toHaveTextContent('Mac mini · native');
    expect(badge).toHaveTextContent('employee override');
    expect(within(api).getByText('attempt 1/2')).toBeInTheDocument();
    expect(within(api).getByText('transferred')).toBeInTheDocument();
    expect(within(api).getByText('/Users/me/.nebula/inbox/report.md')).toBeInTheDocument();

    const summary = within(queued).getByRole('article', { name: 'CEO: review results and report' });
    expect(within(summary).getByText('CEO report')).toBeInTheDocument();
    expect(within(summary).getByText(/Waits for 2 items/)).toBeInTheDocument();

    // run bar: budget + controls
    expect(screen.getByText('1/4 completed · 1 failed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument();

    const qa = within(failed).getByRole('article', { name: 'QA Engineer: test it' });
    expect(within(qa).getByText('Tests crashed')).toBeInTheDocument();
    await user.click(within(qa).getByRole('button', { name: 'Retry QA Engineer: test it' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/api/v1/company-items/i3/retry')).toBe(true));
    expect(await screen.findByRole('region', { name: 'Queued (2)' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /^Failed/ })).not.toBeInTheDocument();
  });

  it('explains the effective environment chain per assigned employee', async () => {
    installFetch({
      'GET /api/v1/projects/p1': () => ok(project),
      'GET /api/v1/companies/c1': () => ok(company),
      'GET /api/v1/host/roots': () => ok(roots),
      'GET /api/v1/company-runs/r1': () => ok(run),
    });
    render(
      <ToastProvider>
        <ProjectWorkspace companyId="c1" projectId="p1" tab="environment" query={new URLSearchParams()} />
      </ToastProvider>,
    );
    const cyChain = await screen.findByRole('list', { name: 'Environment chain of Cy' });
    expect(within(cyChain).getByText('Project assignment').closest('[aria-current="step"]')).not.toBeNull();
    expect(within(cyChain).getAllByText('inherits')).toHaveLength(2); // project + employee levels unset
    const adaChain = screen.getByRole('list', { name: 'Environment chain of Ada' });
    expect(within(adaChain).getByText('Company default').closest('[aria-current="step"]')).not.toBeNull();
  });
});
