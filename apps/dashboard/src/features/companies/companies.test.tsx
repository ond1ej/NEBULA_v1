import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setCsrfToken } from '../../api';
import { ToastProvider } from '../../components/Toast';
import { apiError, installFetch, ok } from '../../test/fetchMock';
import { CompaniesList } from './CompaniesList';
import { CompanyWizard } from './CompanyWizard';
import { buildCompanyBody, emptyDraft, validateDraft, validateMembers } from './lib';
import { company } from './testFixtures';

beforeEach(() => {
  setCsrfToken('csrf');
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
  window.location.hash = '';
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setCsrfToken(null);
});

const catalog = [
  { key: 'ceo', title: 'CEO', responsibilities: 'Owns the objective', stage: 0 },
  { key: 'backend', title: 'Backend Developer', responsibilities: 'APIs', stage: 50 },
  { key: 'qa', title: 'QA Engineer', responsibilities: 'Tests', stage: 70 },
];
const envInfo = {
  environments: [
    { id: 'host', label: 'Mac mini — Native Execution', benefits: ['Real project folders'], limitations: ['No desktop control'], permissions: ['authorised folder only'] },
    { id: 'vm', label: 'Ubuntu VM — Isolated Execution', benefits: ['Isolated desktop'], limitations: ['Shares 4 GB RAM'], permissions: ['own workspace'] },
  ],
  host: { sandbox: true, running_commands: 0, background_processes: 0, roots: 1 },
  vm: { state: 'running' },
};
const agent = (id: string, name: string, model: string | null = 'm') => ({ id, name, state: 'READY', model_id: model, provider_id: model ? 'p' : null, description: '', permissions: [], capabilities: [] });

describe('CompaniesList', () => {
  it('shows each company with its default environment, employees, projects and active runs', async () => {
    installFetch({
      'GET /api/v1/companies': () =>
        ok([
          { ...company, member_count: 3, project_count: 1, active_runs: 2 },
          { ...company, id: 'c2', name: 'Quiet Co', default_environment: 'host', member_count: 1, project_count: 0, active_runs: 0, status: 'PAUSED' },
        ]),
    });
    render(
      <ToastProvider>
        <CompaniesList />
      </ToastProvider>,
    );
    const acme = (await screen.findByRole('link', { name: 'Acme' })).closest('article') as HTMLElement;
    expect(screen.getByRole('link', { name: 'Acme' })).toHaveAttribute('href', '#/companies/c1');
    expect(within(acme).getByText('3 employees')).toBeInTheDocument();
    expect(within(acme).getByText('1 project')).toBeInTheDocument();
    expect(within(acme).getByText('2 active runs')).toBeInTheDocument();
    expect(within(acme).getByText('Ubuntu VM')).toBeInTheDocument();
    const quiet = screen.getByRole('link', { name: 'Quiet Co' }).closest('article') as HTMLElement;
    expect(within(quiet).getByText('Mac mini · native')).toBeInTheDocument();
    expect(within(quiet).getByText('PAUSED')).toBeInTheDocument();
    expect(within(quiet).getByText('No active runs')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /New company/ })).toHaveAttribute('href', '#/companies/new');
  });
});

describe('company validation', () => {
  it('blocks host without folder, bad budgets, duplicate agents and reporting loops', () => {
    const d = { ...emptyDraft(catalog), name: 'X', default_environment: 'host' as const, budget_per_run: '0' };
    const e = validateDraft(d);
    expect(e.environment?.root).toMatch(/folder/);
    expect(e.policies?.perRun).toMatch(/1 to 500/);
    const roles = [{ ...catalog[0], custom: false }, { ...catalog[1], custom: false }];
    const loop = validateMembers(
      [
        { uid: 'u1', agent_id: 'a1', role_key: 'backend', title: '', reports_to: 'a2', environment: '', instructions: '' },
        { uid: 'u2', agent_id: 'a2', role_key: 'backend', title: '', reports_to: 'a1', environment: '', instructions: '' },
      ],
      roles,
    );
    expect(loop.u1).toMatch(/loop/);
    const dup = validateMembers(
      [
        { uid: 'u1', agent_id: 'a1', role_key: 'ceo', title: '', reports_to: '', environment: '', instructions: '' },
        { uid: 'u2', agent_id: 'a1', role_key: 'backend', title: '', reports_to: '', environment: '', instructions: '' },
      ],
      roles,
    );
    expect(dup.u2).toMatch(/only one role/);
    expect(buildCompanyBody({ ...d, default_root_id: 'r1', budget_per_run: '30' }).default_root_id).toBe('r1');
  });
});

describe('CompanyWizard', () => {
  it('walks through every step, shows the 409 from the host and submits the full payload', async () => {
    const user = userEvent.setup();
    let posts = 0;
    const { calls } = installFetch({
      'GET /api/v1/companies/roles': () => ok(catalog),
      'GET /api/v1/environments': () => ok(envInfo),
      'GET /api/v1/host/roots': () => ok([{ id: 'r1', name: 'App', path: '/Users/me/App', mode: 'read_write', allow_network: true, allowed_tools: [], enabled: true, exists: true }]),
      'GET /api/v1/agents': () => ok([agent('a1', 'Ada'), agent('a2', 'Bob'), agent('a3', 'Cy')]),
      'GET /api/v1/providers': () => ok([]),
      'GET /api/v1/companies': () => ok([{ ...company, id: 'c0', name: 'Other Co', member_count: 1, project_count: 0, active_runs: 0 }]),
      'GET /api/v1/companies/c0': () => ok({ ...company, id: 'c0', name: 'Other Co', members: [{ ...company.members[0], agent_id: 'a3', agent_name: 'Cy' }] }),
      'POST /api/v1/companies': () => {
        posts += 1;
        return posts === 1
          ? apiError(409, 'agent_in_other_company', "agent already works for company 'Other Co' (company isolation: one company per agent)")
          : ok({ ...company, id: 'new1', name: 'Nova' }, 201);
      },
    });
    render(
      <ToastProvider>
        <CompanyWizard />
      </ToastProvider>,
    );

    // 1. basics — inline validation blocks Next
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Give the company a name')).toBeInTheDocument();
    await user.type(screen.getByLabelText(/Company name/), 'Nova');
    await user.type(screen.getByLabelText('Objective'), 'Ship an app');
    await user.click(screen.getByRole('button', { name: 'Next' }));

    // 2. environment — host needs an authorised folder
    await user.click(await screen.findByRole('radio', { name: /Host computer/ }));
    expect(screen.getByText('Real project folders')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText(/Choose an authorised project folder for host work/)).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText(/Authorised project folder/), 'r1');
    await user.click(screen.getByRole('button', { name: 'Next' }));

    // 3. policies
    await user.click(await screen.findByRole('radio', { name: '3 at a time' }));
    const per = screen.getByLabelText(/AI requests per run/);
    await user.clear(per);
    await user.type(per, '40');
    await user.type(screen.getByLabelText(/Total AI requests/), '200');
    await user.click(screen.getByRole('switch', { name: 'I approve the CEO’s plan' }));
    await user.click(screen.getByRole('button', { name: 'Next' }));

    // 4. roles: CEO is preselected; add a catalogue role and a custom one
    const cat = await screen.findByRole('list', { name: 'Catalogue roles' });
    expect(within(cat).getByRole('checkbox', { name: /^CEO/ })).toBeChecked();
    await user.click(within(cat).getByRole('checkbox', { name: /^Backend Developer/ }));
    await user.click(screen.getByRole('button', { name: 'Add custom role' }));
    await user.type(screen.getByLabelText(/^Title/), 'Writer');
    await user.click(screen.getByRole('button', { name: 'Next' }));

    // 5. organisation: agents of other companies are disabled
    await user.click(await screen.findByRole('button', { name: 'Add employee' }));
    await user.click(screen.getByRole('button', { name: 'Add employee' }));
    const rows = screen.getAllByRole('listitem', { name: /^Employee \d/ });
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByRole('option', { name: /Cy — works for Other Co/ })).toBeDisabled();
    expect(within(rows[0]).getByLabelText(/^Role\*?$/)).toHaveValue('ceo');
    expect(within(rows[1]).getByLabelText(/^Agent\*?$/)).toHaveValue('a2');
    expect(within(rows[1]).getByLabelText(/^Role\*?$/)).toHaveValue('backend');
    await user.selectOptions(within(rows[1]).getByLabelText(/^Environment/), 'vm');
    // preview org chart: Bob reports to the CEO by default
    const preview = screen.getByRole('list', { name: 'Organisation preview' });
    expect(within(within(preview).getByRole('list', { name: 'Reports to Ada' })).getByText('Bob')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Next' }));

    // 6. review → create; the host's 409 sends us back to the organisation step
    await user.click(await screen.findByRole('button', { name: 'Create company' }));
    expect(await screen.findByText('An agent already works for another company')).toBeInTheDocument();
    expect(screen.getByText(/company isolation: one company per agent/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Organisation/, current: 'step' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^Review/ }));
    await user.click(await screen.findByRole('button', { name: 'Create company' }));
    await waitFor(() => expect(window.location.hash).toBe('#/companies/new1'));

    const post = calls.filter((c) => c.method === 'POST' && c.path === '/api/v1/companies');
    expect(post).toHaveLength(2);
    expect(post[1].headers['x-csrf-token']).toBe('csrf');
    expect(post[1].body).toEqual({
      name: 'Nova',
      description: '',
      objective: 'Ship an app',
      industry: '',
      default_environment: 'host',
      default_root_id: 'r1',
      provider_prefs: {},
      resource_policy: { max_parallel: 3 },
      budget: { max_model_calls_per_run: 40, max_model_calls_total: 200 },
      approval_policy: { plan_approval: true, ceo_review: true },
      roles: ['ceo', 'backend', { key: 'writer', title: 'Writer', responsibilities: '', stage: 50 }],
      members: [
        { agent_id: 'a1', role_key: 'ceo', title: '', reports_to: null, environment: null, instructions: '' },
        { agent_id: 'a2', role_key: 'backend', title: '', reports_to: null, environment: 'vm', instructions: '' },
      ],
    });
  });
});
