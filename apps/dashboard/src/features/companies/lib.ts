// Pure helpers for AI Company Mode (validation, request bodies, org tree, task board grouping).
import type { Tone } from '../../components/ui';
import type { EnvId } from '../environment/types';
import type { CatalogRole, CompanyBody, CompanyMember, CompanyRole, MemberInput, RoleInput, WorkItem } from './types';

export const RUN_ACTIVE = new Set(['PLANNING', 'AWAITING_APPROVAL', 'RUNNING', 'PAUSED']);
export const RUN_TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);
export const ITEM_RETRYABLE = new Set(['FAILED', 'SKIPPED', 'CANCELLED']);

export const LIFECYCLE_TONE: Record<string, Tone> = {
  IDLE: 'neutral',
  ASSIGNED: 'info',
  RUNNING: 'accent',
  WAITING: 'warn',
  PAUSED: 'warn',
  COMPLETED: 'success',
  FAILED: 'danger',
  SLEEPING: 'neutral',
};

export const LIFECYCLE_TEXT: Record<string, string> = {
  IDLE: 'Idle — no assigned work',
  ASSIGNED: 'Assigned — work queued for this employee',
  RUNNING: 'Running — working on a task now',
  WAITING: 'Waiting — needs an approval, control or provider',
  PAUSED: 'Paused',
  COMPLETED: 'Completed work in the last hour',
  FAILED: 'Last work item failed (last hour)',
  SLEEPING: 'Sleeping — agent is asleep or stopped',
};

export const ACTIVITY_TONE: Record<string, Tone> = {
  run: 'accent',
  plan: 'accent',
  assign: 'info',
  handoff: 'info',
  transfer: 'info',
  result: 'success',
  failure: 'danger',
  review: 'warn',
  system: 'neutral',
};

export const KNOWLEDGE_KINDS = [
  { value: 'requirement', label: 'Requirements' },
  { value: 'decision', label: 'Decisions' },
  { value: 'doc', label: 'Docs' },
  { value: 'report', label: 'Reports' },
  { value: 'knowledge', label: 'Knowledge' },
] as const;

export const PLANNER_TEXT = {
  template:
    'Deterministic: one work item per assigned employee, ordered by role stage (research → design → build → QA/security → DevOps), then an optional CEO review. Planning costs no AI requests.',
  ceo: 'The CEO agent breaks the objective into work items for the roles on this project (max 12, with dependencies). Needs a CEO assigned to the project; the company may require your approval of the plan.',
} as const;

/** Mirrors companies._slug in the host. */
export function slug(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
}

// ---------------------------------------------------------------- wizard / editor drafts
export interface RoleDraft {
  key: string;
  title: string;
  responsibilities: string;
  stage: number;
  /** false = catalogue role (sent as its key). */
  custom: boolean;
}

export interface MemberDraft {
  uid: string;
  agent_id: string;
  role_key: string;
  title: string;
  /** '' = default (reports to the CEO). */
  reports_to: string;
  /** '' = inherit */
  environment: '' | EnvId;
  instructions: string;
}

export interface CompanyDraft {
  name: string;
  description: string;
  objective: string;
  industry: string;
  default_environment: EnvId;
  default_root_id: string;
  provider_id: string;
  model_id: string;
  max_parallel: number;
  budget_per_run: string;
  budget_total: string;
  plan_approval: boolean;
  ceo_review: boolean;
  roles: RoleDraft[];
  members: MemberDraft[];
}

let uidSeq = 0;
export const newUid = () => `m${++uidSeq}`;

export function emptyDraft(catalog: CatalogRole[] = []): CompanyDraft {
  const ceo = catalog.find((r) => r.key === 'ceo');
  return {
    name: '',
    description: '',
    objective: '',
    industry: '',
    default_environment: 'vm',
    default_root_id: '',
    provider_id: '',
    model_id: '',
    max_parallel: 2,
    budget_per_run: '30',
    budget_total: '',
    plan_approval: false,
    ceo_review: true,
    roles: ceo ? [{ ...ceo, custom: false }] : [],
    members: [],
  };
}

export function rolesFromCompany(roles: CompanyRole[], catalog: CatalogRole[]): RoleDraft[] {
  return [...roles]
    .sort((a, b) => a.stage - b.stage || a.position - b.position)
    .map((r) => {
      const cat = catalog.find((c) => c.key === r.key);
      const custom = !cat || cat.title !== r.title || cat.responsibilities !== r.responsibilities || cat.stage !== r.stage;
      return { key: r.key, title: r.title, responsibilities: r.responsibilities, stage: r.stage, custom };
    });
}

export function membersFromCompany(members: CompanyMember[]): MemberDraft[] {
  return [...members]
    .sort((a, b) => a.position - b.position)
    .map((m) => ({
      uid: newUid(),
      agent_id: m.agent_id,
      role_key: m.role_key,
      title: m.title ?? '',
      reports_to: m.reports_to ?? '',
      environment: m.environment ?? '',
      instructions: m.instructions ?? '',
    }));
}

export function roleKeyOf(r: RoleDraft): string {
  return r.custom ? slug(r.key || r.title) : r.key;
}

/** Errors for the roles list (empty = valid). */
export function validateRoles(roles: RoleDraft[]): string[] {
  const errs: string[] = [];
  if (roles.length === 0) errs.push('Choose at least one role');
  const keys = new Set<string>();
  for (const r of roles) {
    const key = roleKeyOf(r);
    if (r.custom && !r.title.trim()) errs.push('Every custom role needs a title');
    else if (!key) errs.push(`“${r.title}” needs letters or digits in its title`);
    else if (keys.has(key)) errs.push(`Role “${r.title}” is defined twice`);
    if (r.custom && (!Number.isInteger(r.stage) || r.stage < 0 || r.stage > 100)) errs.push(`Stage of “${r.title || 'custom role'}”: 0–100`);
    keys.add(key);
  }
  return [...new Set(errs)];
}

/** Per-member errors keyed by uid, plus list-level errors under "" (empty = valid). */
export function validateMembers(members: MemberDraft[], roles: RoleDraft[]): Record<string, string> {
  const errs: Record<string, string> = {};
  const roleKeys = new Set(roles.map(roleKeyOf));
  const ids = new Set<string>();
  const byAgent = new Map(members.filter((m) => m.agent_id).map((m) => [m.agent_id, m]));
  for (const m of members) {
    if (!m.agent_id) errs[m.uid] = 'Choose an agent';
    else if (ids.has(m.agent_id)) errs[m.uid] = 'An agent can hold only one role in a company';
    else if (!m.role_key || !roleKeys.has(m.role_key)) errs[m.uid] = 'Choose one of the company’s roles';
    else if (m.reports_to && m.reports_to === m.agent_id) errs[m.uid] = 'An employee cannot report to themselves';
    else if (m.reports_to && !byAgent.has(m.reports_to)) errs[m.uid] = 'Reports to must be another employee';
    if (m.agent_id) ids.add(m.agent_id);
  }
  // reporting cycles (A → B → A)
  for (const m of members) {
    if (errs[m.uid] || !m.reports_to) continue;
    const seen = new Set([m.agent_id]);
    let cur = byAgent.get(m.reports_to);
    while (cur) {
      if (seen.has(cur.agent_id)) {
        errs[m.uid] = 'Reporting lines form a loop';
        break;
      }
      seen.add(cur.agent_id);
      cur = cur.reports_to ? byAgent.get(cur.reports_to) : undefined;
    }
  }
  if (members.filter((m) => m.role_key === 'ceo').length > 1) errs[''] = 'Only one employee can be the CEO';
  return errs;
}

export type WizardStep = 'basics' | 'environment' | 'policies' | 'roles' | 'organisation' | 'review';

/** Field errors per wizard step (empty object = valid). */
export function validateDraft(d: CompanyDraft): Partial<Record<WizardStep, Record<string, string>>> {
  const out: Partial<Record<WizardStep, Record<string, string>>> = {};
  const basics: Record<string, string> = {};
  if (!d.name.trim()) basics.name = 'Give the company a name';
  else if (d.name.trim().length > 96) basics.name = 'At most 96 characters';
  if (d.industry.length > 96) basics.industry = 'At most 96 characters';
  if (Object.keys(basics).length) out.basics = basics;
  if (d.default_environment === 'host' && !d.default_root_id) out.environment = { root: 'Choose an authorised project folder for host work' };
  const pol: Record<string, string> = {};
  if (!Number.isInteger(d.max_parallel) || d.max_parallel < 1 || d.max_parallel > 4) pol.parallel = 'Between 1 and 4';
  const per = Number(d.budget_per_run);
  if (!d.budget_per_run.trim() || !Number.isInteger(per) || per < 1 || per > 500) pol.perRun = 'A whole number from 1 to 500';
  if (d.budget_total.trim()) {
    const t = Number(d.budget_total);
    if (!Number.isInteger(t) || t < 1) pol.total = 'A whole number of at least 1 (or empty for no limit)';
  }
  if (d.provider_id && !d.model_id) pol.model = 'Choose a model for the preferred provider';
  if (Object.keys(pol).length) out.policies = pol;
  const roleErrs = validateRoles(d.roles);
  if (roleErrs.length) out.roles = { roles: roleErrs.join(' · ') };
  const memErrs = validateMembers(d.members, d.roles);
  if (Object.keys(memErrs).length) out.organisation = memErrs;
  return out;
}

export function rolesBody(roles: RoleDraft[]): RoleInput[] {
  return roles.map((r) =>
    r.custom ? { key: roleKeyOf(r), title: r.title.trim(), responsibilities: r.responsibilities.trim(), stage: r.stage } : r.key,
  );
}

export function membersBody(members: MemberDraft[]): MemberInput[] {
  return members.map((m) => ({
    agent_id: m.agent_id,
    role_key: m.role_key,
    title: m.title.trim(),
    reports_to: m.reports_to || null,
    environment: m.environment || null,
    instructions: m.instructions.trim(),
  }));
}

export function buildCompanyBody(d: CompanyDraft): CompanyBody {
  return {
    name: d.name.trim(),
    description: d.description.trim(),
    objective: d.objective.trim(),
    industry: d.industry.trim(),
    default_environment: d.default_environment,
    default_root_id: d.default_environment === 'host' ? d.default_root_id || null : null,
    provider_prefs: d.provider_id ? { provider_id: d.provider_id, model_id: d.model_id || null } : {},
    resource_policy: { max_parallel: d.max_parallel },
    budget: { max_model_calls_per_run: Number(d.budget_per_run), max_model_calls_total: d.budget_total.trim() ? Number(d.budget_total) : null },
    approval_policy: { plan_approval: d.plan_approval, ceo_review: d.ceo_review },
    roles: rolesBody(d.roles),
    members: membersBody(d.members),
  };
}

// ---------------------------------------------------------------- org tree
export interface TreeNode<T> {
  node: T;
  children: TreeNode<T>[];
}

/**
 * Reporting tree: roots are nodes without a (valid) manager — the CEO first. Unknown managers and reporting loops
 * never hide anyone: such nodes become roots.
 */
export function buildOrgTree<T extends { agent_id: string; reports_to: string | null; role_key: string }>(nodes: T[]): TreeNode<T>[] {
  const byId = new Map(nodes.map((n) => [n.agent_id, n]));
  const order = new Map(nodes.map((n, i) => [n.agent_id, i]));
  const parent = new Map<string, string | null>(
    nodes.map((n) => [n.agent_id, n.reports_to && n.reports_to !== n.agent_id && byId.has(n.reports_to) ? n.reports_to : null]),
  );
  // break reporting loops: the CEO (or the first member of the loop) becomes a root so everyone stays visible
  for (const n of nodes) {
    const path: string[] = [];
    const onPath = new Set<string>();
    let cur: string | null = n.agent_id;
    while (cur !== null && !onPath.has(cur)) {
      onPath.add(cur);
      path.push(cur);
      cur = parent.get(cur) ?? null;
    }
    if (cur !== null) {
      const loop = path.slice(path.indexOf(cur));
      const pick = loop.find((id) => byId.get(id)?.role_key === 'ceo') ?? [...loop].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))[0];
      parent.set(pick, null);
    }
  }
  const make = (n: T): TreeNode<T> => ({
    node: n,
    children: nodes.filter((c) => parent.get(c.agent_id) === n.agent_id).map(make),
  });
  const roots = nodes.filter((n) => parent.get(n.agent_id) === null);
  roots.sort((a, b) => Number(b.role_key === 'ceo') - Number(a.role_key === 'ceo'));
  return roots.map(make);
}

// ---------------------------------------------------------------- task board
export const ITEM_GROUPS = [
  { id: 'queued', label: 'Queued', states: ['PENDING', 'READY'], tone: 'neutral' as Tone },
  { id: 'running', label: 'In progress', states: ['RUNNING', 'WAITING'], tone: 'accent' as Tone },
  { id: 'completed', label: 'Completed', states: ['COMPLETED'], tone: 'success' as Tone },
  { id: 'failed', label: 'Failed', states: ['FAILED'], tone: 'danger' as Tone },
  { id: 'stopped', label: 'Skipped / cancelled', states: ['SKIPPED', 'CANCELLED'], tone: 'neutral' as Tone },
] as const;

export type ItemGroupId = (typeof ITEM_GROUPS)[number]['id'];

export function itemGroupOf(state: string): ItemGroupId {
  return ITEM_GROUPS.find((g) => (g.states as readonly string[]).includes(state))?.id ?? 'queued';
}

/** Work items grouped by board column (in board order), each column sorted by position. */
export function groupWorkItems(items: WorkItem[]): { id: ItemGroupId; label: string; tone: Tone; items: WorkItem[] }[] {
  return ITEM_GROUPS.map((g) => ({
    id: g.id,
    label: g.label,
    tone: g.tone,
    items: items.filter((i) => itemGroupOf(i.state) === g.id).sort((a, b) => a.position - b.position),
  }));
}

/** "M  src/app.ts" → {code: 'M', path: 'src/app.ts', label: 'modified'} */
export function parseGitChange(line: string): { code: string; path: string; label: string } {
  const code = line.slice(0, 2);
  const path = line.slice(3);
  const c = code.trim();
  const label = c === '??' ? 'untracked' : c.includes('M') ? 'modified' : c.includes('A') ? 'added' : c.includes('D') ? 'deleted' : c.includes('R') ? 'renamed' : c || 'changed';
  return { code: c || code, path: path || line, label };
}

export function pct(used: number, total: number | null | undefined): number | null {
  if (!total || total <= 0) return null;
  return Math.max(0, Math.min(100, (used / total) * 100));
}
