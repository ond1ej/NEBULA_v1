// Typed client for AI Company Mode 2.0 (routes_v3.py "AI companies").
import { request } from '../../api';
import type {
  Activity,
  CatalogRole,
  CompanyBody,
  CompanyDetail,
  CompanyPatch,
  CompanyRun,
  CompanySummary,
  GitStatus,
  Knowledge,
  KnowledgeBody,
  OrgData,
  Planner,
  ProjectBody,
  ProjectDetail,
  RunDetail,
} from './types';

const enc = encodeURIComponent;

export const companiesApi = {
  roles: (signal?: AbortSignal) => request<CatalogRole[]>('/companies/roles', { signal }),
  list: (signal?: AbortSignal) => request<CompanySummary[]>('/companies', { signal }),
  /** 409 agent_in_other_company / exists. */
  create: (body: CompanyBody) => request<CompanyDetail>('/companies', { method: 'POST', body }),
  get: (id: string, signal?: AbortSignal) => request<CompanyDetail>(`/companies/${enc(id)}`, { signal }),
  update: (id: string, body: CompanyPatch) => request<CompanyDetail>(`/companies/${enc(id)}`, { method: 'PATCH', body }),
  /** 409 busy while runs are active. */
  remove: (id: string, deleteFiles: boolean) =>
    request<{ deleted: string; files_deleted: boolean }>(`/companies/${enc(id)}`, {
      method: 'DELETE',
      query: { confirm: true, delete_files: deleteFiles ? true : undefined },
    }),
  org: (id: string, signal?: AbortSignal) => request<OrgData>(`/companies/${enc(id)}/org`, { signal }),
  activity: (id: string, opts: { project_id?: string; limit?: number } = {}, signal?: AbortSignal) =>
    request<Activity[]>(`/companies/${enc(id)}/activity`, { query: { project_id: opts.project_id, limit: opts.limit }, signal }),
  knowledge: (id: string, opts: { project_id?: string; kind?: string; q?: string } = {}, signal?: AbortSignal) =>
    request<Knowledge[]>(`/companies/${enc(id)}/knowledge`, { query: { project_id: opts.project_id, kind: opts.kind, q: opts.q }, signal }),
  addKnowledge: (id: string, body: KnowledgeBody) =>
    request<{ id: string; kind: string; title: string }>(`/companies/${enc(id)}/knowledge`, { method: 'POST', body }),
  deleteKnowledge: (id: string, kid: string) =>
    request<{ deleted: string }>(`/companies/${enc(id)}/knowledge/${enc(kid)}`, { method: 'DELETE' }),
};

export const projectsApi = {
  create: (companyId: string, body: ProjectBody) =>
    request<ProjectDetail>(`/companies/${enc(companyId)}/projects`, { method: 'POST', body }),
  get: (id: string, signal?: AbortSignal) => request<ProjectDetail>(`/projects/${enc(id)}`, { signal }),
  update: (id: string, body: Partial<ProjectBody>) => request<ProjectDetail>(`/projects/${enc(id)}`, { method: 'PATCH', body }),
  remove: (id: string) => request<{ deleted: string }>(`/projects/${enc(id)}`, { method: 'DELETE', query: { confirm: true } }),
  git: (id: string, signal?: AbortSignal) => request<GitStatus>(`/projects/${enc(id)}/git`, { signal }),
  runs: (id: string, signal?: AbortSignal) => request<CompanyRun[]>(`/projects/${enc(id)}/runs`, { signal }),
  startRun: (id: string, body: { objective: string; planner: Planner; max_model_calls: number | null }) =>
    request<RunDetail>(`/projects/${enc(id)}/runs`, { method: 'POST', body }),
};

export const runsApi = {
  get: (id: string, signal?: AbortSignal) => request<RunDetail>(`/company-runs/${enc(id)}`, { signal }),
  pause: (id: string) => request<RunDetail>(`/company-runs/${enc(id)}/pause`, { method: 'POST' }),
  resume: (id: string) => request<RunDetail>(`/company-runs/${enc(id)}/resume`, { method: 'POST' }),
  cancel: (id: string) => request<RunDetail>(`/company-runs/${enc(id)}/cancel`, { method: 'POST' }),
  retryItem: (itemId: string) => request<RunDetail>(`/company-items/${enc(itemId)}/retry`, { method: 'POST' }),
};

/**
 * The company an agent works for. The host has no direct lookup (GET /agents/{id}/environment does not name the
 * company), so this scans the company details; there is at most one match (one company per agent).
 */
export async function findCompanyOfAgent(agentId: string, signal?: AbortSignal): Promise<CompanyDetail | null> {
  const list = await companiesApi.list(signal);
  const details = await Promise.all(list.map((c) => companiesApi.get(c.id, signal).catch(() => null)));
  return details.find((d) => Array.isArray(d?.members) && d.members.some((m) => m.agent_id === agentId)) ?? null;
}

/** agent_id → company name for every agent that already works for a company (wizard hints). */
export async function agentCompanyMap(signal?: AbortSignal): Promise<Record<string, { id: string; name: string }>> {
  const list = await companiesApi.list(signal);
  const details = await Promise.all(list.map((c) => companiesApi.get(c.id, signal).catch(() => null)));
  const out: Record<string, { id: string; name: string }> = {};
  for (const d of details) if (d && Array.isArray(d.members)) for (const m of d.members) out[m.agent_id] = { id: d.id, name: d.name };
  return out;
}
