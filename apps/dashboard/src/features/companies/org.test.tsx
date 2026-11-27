import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setCsrfToken } from '../../api';
import { ToastProvider } from '../../components/Toast';
import { installFetch, ok } from '../../test/fetchMock';
import { CompanyDashboard } from './CompanyDashboard';
import { buildOrgTree } from './lib';
import { company, org } from './testFixtures';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setCsrfToken(null);
});

const n = (agent_id: string, reports_to: string | null, role_key = 'dev') => ({ agent_id, reports_to, role_key });

describe('buildOrgTree', () => {
  it('puts the CEO first and never hides anyone (unknown managers, self reports, loops)', () => {
    const tree = buildOrgTree([n('x', 'ghost'), n('ceo', null, 'ceo'), n('a', 'ceo'), n('b', 'a'), n('s', 's'), n('l1', 'l2'), n('l2', 'l1')]);
    expect(tree.map((t) => t.node.agent_id)).toEqual(['ceo', 'x', 's', 'l1']);
    expect(tree[0].children[0].node.agent_id).toBe('a');
    expect(tree[0].children[0].children[0].node.agent_id).toBe('b');
    expect(tree[3].children.map((c) => c.node.agent_id)).toEqual(['l2']);
    const count = (ts: ReturnType<typeof buildOrgTree>): number => ts.reduce((s, t) => s + 1 + count(t.children), 0);
    expect(count(tree)).toBe(7);
  });
});

describe('Organization chart', () => {
  it('renders the reporting tree from /org with roles, lifecycle, environment badges and a details panel', async () => {
    const user = userEvent.setup();
    installFetch({
      'GET /api/v1/companies/c1': () => ok(company),
      'GET /api/v1/companies/c1/org': () => ok(org),
      'GET /api/v1/host/roots': () => ok([]),
    });
    render(
      <ToastProvider>
        <CompanyDashboard companyId="c1" tab="org" query={new URLSearchParams()} />
      </ToastProvider>,
    );
    const chart = await screen.findByRole('list', { name: 'Organisation chart' });
    // CEO at the top, Bob reports to Ada, Cy reports to Bob
    const ada = within(chart).getByRole('button', { name: /^Ada, CEO/ });
    const underAda = within(chart).getByRole('list', { name: 'Reports to Ada' });
    const bob = within(underAda).getByRole('button', { name: /^Bob, Lead dev · Backend Developer, running/ });
    const underBob = within(underAda).getByRole('list', { name: 'Reports to Bob' });
    expect(within(underBob).getByRole('button', { name: /^Cy, QA Engineer, assigned/ })).toBeInTheDocument();
    expect(ada.compareDocumentPosition(bob) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // environment badges: honest labels per effective environment
    expect(ada.querySelector('[data-env="vm"]')).toHaveTextContent('Ubuntu VM');
    expect(bob.querySelector('[data-env="host"]')).toHaveTextContent('Mac mini · native');
    // lifecycle, status, model, current activity
    expect(within(bob).getByText('RUNNING')).toBeInTheDocument();
    expect(within(bob).getByText('m-code')).toBeInTheDocument();
    expect(within(bob).getByText('Backend Developer: build the API')).toBeInTheDocument();
    expect(within(ada).getByText('No assigned work')).toBeInTheDocument();

    await user.click(bob);
    const panel = await screen.findByRole('dialog', { name: 'Bob' });
    expect(within(panel).getByText('Ada')).toBeInTheDocument(); // reports to
    expect(within(panel).getByText('Cy')).toBeInTheDocument(); // direct reports
    expect(within(panel).getByRole('link', { name: /Open agent/ })).toHaveAttribute('href', '#/agents/a2');
    const chain = within(panel).getByRole('list', { name: 'Environment inheritance chain' });
    expect(within(chain).getByText('Employee override').closest('[aria-current="step"]')).not.toBeNull();
  });
});
