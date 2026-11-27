// Types for AI Company Mode 2.0 (routes_v3.py "AI companies", nebula_host/companies.py read models).
import type { Epoch, OwnerApproval } from '../../types';
import type { EffectiveEnv, EnvId, HostRoot } from '../environment/types';

export type CompanyStatus = 'ACTIVE' | 'PAUSED' | 'ARCHIVED';
export type ProjectStatus = 'PLANNING' | 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'ARCHIVED';
export type RunState = 'PLANNING' | 'AWAITING_APPROVAL' | 'RUNNING' | 'PAUSED' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
export type ItemState = 'PENDING' | 'READY' | 'RUNNING' | 'WAITING' | 'COMPLETED' | 'FAILED' | 'SKIPPED' | 'CANCELLED';
export type Lifecycle = 'IDLE' | 'ASSIGNED' | 'RUNNING' | 'WAITING' | 'PAUSED' | 'COMPLETED' | 'FAILED' | 'SLEEPING';
export type Planner = 'template' | 'ceo';
export type KnowledgeKind = 'knowledge' | 'decision' | 'requirement' | 'doc' | 'report';

/** GET /companies/roles (16-role catalogue). */
export interface CatalogRole {
  key: string;
  title: string;
  responsibilities: string;
  stage: number;
}

export interface CompanyRole extends CatalogRole {
  company_id?: string;
  position: number;
}

export interface ProviderPrefs {
  provider_id?: string | null;
  model_id?: string | null;
}

export interface Budget {
  max_model_calls_per_run: number;
  max_model_calls_total: number | null;
}

export interface ApprovalPolicy {
  plan_approval: boolean;
  ceo_review: boolean;
  external_actions?: string;
}

export interface Company {
  id: string;
  name: string;
  description: string;
  objective: string;
  industry: string;
  default_environment: EnvId;
  default_root_id: string | null;
  provider_prefs: ProviderPrefs;
  resource_policy: { max_parallel: number };
  budget: Budget;
  approval_policy: ApprovalPolicy;
  ceo_agent_id: string | null;
  workspace_dir: string | null;
  status: CompanyStatus | string;
  created_at: Epoch;
  updated_at: Epoch;
}

/** GET /companies */
export interface CompanySummary extends Company {
  member_count: number;
  project_count: number;
  active_runs: number;
}

export interface CurrentItem {
  id: string;
  title: string;
  state: ItemState | string;
  run_id: string;
}

export interface CompanyMember {
  company_id: string;
  agent_id: string;
  role_key: string;
  title: string;
  reports_to: string | null;
  /** null = inherit */
  environment: EnvId | null;
  instructions: string;
  position: number;
  created_at: Epoch;
  agent_name: string;
  agent_status: string;
  provider_id: string | null;
  model_id: string | null;
  role_title: string;
  environment_effective: EffectiveEnv;
  lifecycle: Lifecycle | string;
  current_item: CurrentItem | null;
}

export interface Milestone {
  id: string;
  title: string;
  due: string | null;
  done: boolean;
}

export interface Project {
  id: string;
  company_id: string;
  name: string;
  description: string;
  objective: string;
  status: ProjectStatus | string;
  /** null = company default */
  environment: EnvId | null;
  host_root_id: string | null;
  git: { remote?: string; branch?: string };
  milestones: Milestone[];
  budget: { max_model_calls_per_run?: number };
  vm_dir: string | null;
  created_at: Epoch;
  updated_at: Epoch;
}

export interface RunRef {
  id: string;
  state: RunState | string;
  project_id: string;
  created_at: Epoch;
}

export interface CompanyStats {
  members: number;
  projects: number;
  running_items: number;
  open_items: number;
  runs_active: number;
  model_calls_used: number;
}

/** GET /companies/{id} */
export interface CompanyDetail extends Company {
  roles: CompanyRole[];
  members: CompanyMember[];
  projects: Project[];
  recent_runs: RunRef[];
  stats: CompanyStats;
  pending_approvals: OwnerApproval[];
}

export interface OrgNode {
  agent_id: string;
  name: string;
  role_key: string;
  role: string;
  title: string;
  reports_to: string | null;
  model: string | null;
  provider: string | null;
  status: string;
  lifecycle: Lifecycle | string;
  environment: EffectiveEnv;
  current_item: CurrentItem | null;
}

/** GET /companies/{id}/org */
export interface OrgData {
  company_id: string;
  nodes: OrgNode[];
  roles: CompanyRole[];
}

export interface ProjectMember {
  project_id: string;
  agent_id: string;
  /** Assignment override (null = inherit). */
  environment: EnvId | null;
  created_at: Epoch;
  agent_name: string;
  role_key: string;
  environment_effective: EffectiveEnv;
}

export interface Artifact {
  type: 'file' | 'url' | string;
  value: string;
  environment?: EnvId | string;
  root_id?: string;
}

export interface Transfer {
  from_item: string;
  from_env?: EnvId;
  to_env?: EnvId;
  source: string;
  dest?: string;
  ok: boolean;
  error?: string;
}

export interface RunResult {
  summary: string;
  ceo_report: boolean;
  items: { title: string; state: string; environment: EnvId | null; task_id: string | null }[];
  artifacts: Artifact[];
  model_calls: number;
}

export interface PlanItem {
  kind: string;
  title: string;
  prompt: string;
  role_key: string;
  agent_id?: string | null;
  depends_on: string[];
  priority: number;
}

export interface CompanyRun {
  id: string;
  company_id: string;
  project_id: string;
  objective: string;
  state: RunState | string;
  planner: Planner | string;
  plan: { summary?: string; items: PlanItem[] } | null;
  source: string;
  reply_target: unknown;
  max_model_calls: number | null;
  result: RunResult | null;
  error: string | null;
  created_by: string;
  created_at: Epoch;
  updated_at: Epoch;
  finished_at: Epoch | null;
}

export interface WorkItem {
  id: string;
  run_id: string;
  company_id: string;
  project_id: string;
  kind: 'plan' | 'work' | 'review' | 'summary' | string;
  title: string;
  prompt: string;
  role_key: string;
  agent_id: string | null;
  depends_on: string[];
  state: ItemState | string;
  priority: number;
  environment: EnvId | null;
  env_source: string | null;
  task_id: string | null;
  attempts: number;
  max_attempts: number;
  result_summary: string | null;
  artifacts: Artifact[];
  transfers: Transfer[];
  position: number;
  created_at: Epoch;
  updated_at: Epoch;
  started_at: Epoch | null;
  finished_at: Epoch | null;
  agent_name: string | null;
}

export interface Activity {
  id: number;
  company_id: string;
  project_id: string | null;
  run_id: string | null;
  agent_id: string | null;
  /** run plan assign handoff transfer result failure review system */
  kind: string;
  content: string;
  payload: Record<string, unknown> | null;
  ts: Epoch;
}

/** GET /company-runs/{id} */
export interface RunDetail extends CompanyRun {
  items: WorkItem[];
  activity: Activity[];
  model_calls_used: number;
}

/** GET /projects/{id} */
export interface ProjectDetail extends Project {
  members: ProjectMember[];
  runs: CompanyRun[];
  company_name: string;
  root: HostRoot | null;
}

export interface Knowledge {
  id: string;
  company_id: string;
  project_id: string | null;
  kind: KnowledgeKind | string;
  title: string;
  content: string;
  author: string;
  created_at: Epoch;
  updated_at: Epoch;
}

export interface GitStatus {
  environment: EnvId;
  /** true = repository found, false = folder is not a git repository, null = not applicable / unknown. */
  repository: boolean | null;
  branch?: string | null;
  changes?: string[];
  clean?: boolean;
  recent_commits?: { hash: string; date?: string; subject?: string }[];
  error?: string | null;
  note?: string;
  config: { remote?: string; branch?: string };
}

// ---------------------------------------------------------------- request bodies
export type RoleInput = string | { key?: string; title: string; responsibilities?: string; stage?: number };

export interface MemberInput {
  agent_id: string;
  role_key: string;
  title?: string;
  reports_to: string | null;
  environment: EnvId | null;
  instructions?: string;
}

export interface CompanyBody {
  name: string;
  description: string;
  objective: string;
  industry: string;
  default_environment: EnvId;
  default_root_id: string | null;
  provider_prefs: ProviderPrefs;
  resource_policy: { max_parallel: number };
  budget: { max_model_calls_per_run: number; max_model_calls_total: number | null };
  approval_policy: { plan_approval: boolean; ceo_review: boolean };
  roles: RoleInput[];
  members: MemberInput[];
}

export type CompanyPatch = Partial<CompanyBody> & { status?: CompanyStatus };

export interface AssignmentInput {
  agent_id: string;
  environment: EnvId | null;
}

export interface ProjectBody {
  name: string;
  objective: string;
  description: string;
  environment: EnvId | null;
  host_root_id: string | null;
  git: { remote: string; branch: string };
  milestones: { id?: string; title: string; due: string | null; done: boolean }[];
  /** {} = reset to the company default (the host stores the current company value). */
  budget?: { max_model_calls_per_run?: number };
  assign: AssignmentInput[];
  status?: ProjectStatus;
}

export interface KnowledgeBody {
  kind: KnowledgeKind;
  title: string;
  content: string;
  project_id?: string | null;
}
