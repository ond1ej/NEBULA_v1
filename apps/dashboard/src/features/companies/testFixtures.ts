// Test fixtures shaped like the host's company read models (companies.py get_company / get_project / get_run).
import type { CompanyDetail, OrgData, ProjectDetail, RunDetail, WorkItem } from './types';

export const env = (e: 'vm' | 'host', source = 'company', chain = [{ level: 'company', env: e }]) => ({
  env: e,
  root_id: e === 'host' ? 'r1' : null,
  source,
  label: e === 'host' ? 'Mac mini — Native Execution' : 'Ubuntu VM — Isolated Execution',
  chain,
});

export const company: CompanyDetail = {
  id: 'c1',
  name: 'Acme',
  description: 'Builds apps',
  objective: 'Ship the app',
  industry: 'Software',
  default_environment: 'vm',
  default_root_id: null,
  provider_prefs: {},
  resource_policy: { max_parallel: 2 },
  budget: { max_model_calls_per_run: 30, max_model_calls_total: 100 },
  approval_policy: { plan_approval: false, ceo_review: true, external_actions: 'always_ask' },
  ceo_agent_id: 'a1',
  workspace_dir: 'abc123',
  status: 'ACTIVE',
  created_at: 1_700_000_000,
  updated_at: 1_700_000_000,
  roles: [
    { key: 'ceo', title: 'CEO', responsibilities: 'Owns the objective', stage: 0, position: 0 },
    { key: 'backend', title: 'Backend Developer', responsibilities: 'APIs', stage: 50, position: 1 },
    { key: 'qa', title: 'QA Engineer', responsibilities: 'Tests', stage: 70, position: 2 },
  ],
  members: [
    {
      company_id: 'c1', agent_id: 'a1', role_key: 'ceo', title: '', reports_to: null, environment: null, instructions: '', position: 0, created_at: 1,
      agent_name: 'Ada', agent_status: 'READY', provider_id: 'p', model_id: 'm-large', role_title: 'CEO', environment_effective: env('vm'), lifecycle: 'IDLE', current_item: null,
    },
    {
      company_id: 'c1', agent_id: 'a2', role_key: 'backend', title: 'Lead dev', reports_to: 'a1', environment: 'host', instructions: '', position: 1, created_at: 1,
      agent_name: 'Bob', agent_status: 'ACTIVE', provider_id: 'p', model_id: 'm-code', role_title: 'Backend Developer',
      environment_effective: env('host', 'member', [{ level: 'company', env: 'vm' }, { level: 'member', env: 'host' }]), lifecycle: 'RUNNING',
      current_item: { id: 'i2', title: 'Backend Developer: build the API', state: 'RUNNING', run_id: 'r1' },
    },
    {
      company_id: 'c1', agent_id: 'a3', role_key: 'qa', title: '', reports_to: 'a2', environment: null, instructions: '', position: 2, created_at: 1,
      agent_name: 'Cy', agent_status: 'READY', provider_id: 'p', model_id: 'm-small', role_title: 'QA Engineer', environment_effective: env('vm'), lifecycle: 'ASSIGNED', current_item: null,
    },
  ],
  projects: [
    {
      id: 'p1', company_id: 'c1', name: 'Mobile app', description: '', objective: 'Build the MVP', status: 'ACTIVE', environment: null, host_root_id: 'r1',
      git: { remote: 'git@x:app.git', branch: 'main' }, milestones: [{ id: 'ms1', title: 'MVP', due: null, done: false }], budget: {}, vm_dir: 'mobile-app-p1',
      created_at: 1, updated_at: 1,
    },
  ],
  recent_runs: [{ id: 'r1', state: 'RUNNING', project_id: 'p1', created_at: 1_700_000_100 }],
  stats: { members: 3, projects: 1, running_items: 1, open_items: 2, runs_active: 1, model_calls_used: 12 },
  pending_approvals: [],
};

export const org: OrgData = {
  company_id: 'c1',
  roles: company.roles,
  nodes: [
    { agent_id: 'a1', name: 'Ada', role_key: 'ceo', role: 'CEO', title: '', reports_to: null, model: 'm-large', provider: 'p', status: 'READY', lifecycle: 'IDLE', environment: env('vm'), current_item: null },
    {
      agent_id: 'a2', name: 'Bob', role_key: 'backend', role: 'Backend Developer', title: 'Lead dev', reports_to: 'a1', model: 'm-code', provider: 'p', status: 'ACTIVE', lifecycle: 'RUNNING',
      environment: env('host', 'member', [{ level: 'company', env: 'vm' }, { level: 'member', env: 'host' }]),
      current_item: { id: 'i2', title: 'Backend Developer: build the API', state: 'RUNNING', run_id: 'r1' },
    },
    { agent_id: 'a3', name: 'Cy', role_key: 'qa', role: 'QA Engineer', title: '', reports_to: 'a2', model: 'm-small', provider: 'p', status: 'READY', lifecycle: 'ASSIGNED', environment: env('vm'), current_item: null },
  ],
};

export const item = (over: Partial<WorkItem>): WorkItem => ({
  id: 'i', run_id: 'r1', company_id: 'c1', project_id: 'p1', kind: 'work', title: 'Item', prompt: '', role_key: 'backend', agent_id: 'a2', depends_on: [], state: 'PENDING',
  priority: 0, environment: null, env_source: null, task_id: null, attempts: 0, max_attempts: 2, result_summary: null, artifacts: [], transfers: [], position: 0,
  created_at: 1, updated_at: 1, started_at: null, finished_at: null, agent_name: 'Bob', ...over,
});

export const run: RunDetail = {
  id: 'r1', company_id: 'c1', project_id: 'p1', objective: 'Build the MVP', state: 'RUNNING', planner: 'template', plan: null, source: 'web', reply_target: null,
  max_model_calls: 30, result: null, error: null, created_by: 'owner', created_at: 1_700_000_100, updated_at: 1_700_000_100, finished_at: null, model_calls_used: 7, activity: [],
  items: [
    item({ id: 'i1', title: 'Researcher: market scan', role_key: 'qa', agent_id: 'a3', agent_name: 'Cy', state: 'COMPLETED', environment: 'vm', env_source: 'company', attempts: 1, task_id: 't1', position: 0, result_summary: 'Found 5 competitors', artifacts: [{ type: 'file', value: '/srv/nebula/shared/abc123/mobile-app-p1/report.md', environment: 'vm' }] }),
    item({ id: 'i2', title: 'Backend Developer: build the API', state: 'RUNNING', environment: 'host', env_source: 'member', attempts: 1, task_id: 't2', position: 1, depends_on: ['i1'],
      transfers: [{ from_item: 'i1', from_env: 'vm', to_env: 'host', source: '/srv/nebula/shared/abc123/mobile-app-p1/report.md', dest: '/Users/me/.nebula/inbox/report.md', ok: true }] }),
    item({ id: 'i3', title: 'QA Engineer: test it', role_key: 'qa', agent_id: 'a3', agent_name: 'Cy', state: 'FAILED', environment: 'vm', env_source: 'company', attempts: 2, position: 2, result_summary: 'Tests crashed' }),
    item({ id: 'i4', title: 'CEO: review results and report', kind: 'summary', role_key: 'ceo', agent_id: 'a1', agent_name: 'Ada', state: 'PENDING', position: 3, depends_on: ['i1', 'i2', 'i3'] }),
  ],
};

export const project: ProjectDetail = {
  ...company.projects[0],
  company_name: 'Acme',
  root: { id: 'r1', name: 'App', path: '/Users/me/Projects/App', mode: 'read_write', allow_network: true, allowed_tools: [], enabled: true, created_by: 'owner', created_at: 1, updated_at: 1 },
  members: [
    { project_id: 'p1', agent_id: 'a1', environment: null, created_at: 1, agent_name: 'Ada', role_key: 'ceo', environment_effective: env('vm') },
    { project_id: 'p1', agent_id: 'a2', environment: null, created_at: 1, agent_name: 'Bob', role_key: 'backend', environment_effective: env('host', 'member', [{ level: 'company', env: 'vm' }, { level: 'member', env: 'host' }]) },
    { project_id: 'p1', agent_id: 'a3', environment: 'host', created_at: 1, agent_name: 'Cy', role_key: 'qa', environment_effective: env('host', 'assignment', [{ level: 'company', env: 'vm' }, { level: 'assignment', env: 'host' }]) },
  ],
  runs: [{ ...run, items: undefined } as unknown as ProjectDetail['runs'][number]],
};

export const roots = [
  { id: 'r1', name: 'App', path: '/Users/me/Projects/App', mode: 'read_write', allow_network: true, allowed_tools: [], enabled: true, created_by: 'owner', created_at: 1, updated_at: 1, exists: true },
];
