// Typed client for the workflow endpoints (routes_v2.py "Module 6: workflows").
import { request } from '../../api';
import type {
  AgentOption,
  Catalog,
  OwnerApproval,
  RootOption,
  RunSummary,
  SaveBody,
  TeamOption,
  ValidateResult,
  Workflow,
  WorkflowExport,
  WorkflowListItem,
  WorkflowRun,
  WfDefinition,
} from './types';

const enc = encodeURIComponent;

export const workflowsApi = {
  catalog: (signal?: AbortSignal) => request<Catalog>('/workflows/catalog', { signal }),
  list: (signal?: AbortSignal) => request<WorkflowListItem[]>('/workflows', { signal }),
  get: (id: string, signal?: AbortSignal) => request<Workflow>(`/workflows/${enc(id)}`, { signal }),
  create: (body: SaveBody) => request<Workflow>('/workflows', { method: 'POST', body }),
  update: (id: string, body: Partial<SaveBody> & { enabled?: boolean }) =>
    request<Workflow>(`/workflows/${enc(id)}`, { method: 'PATCH', body }),
  setEnabled: (id: string, enabled: boolean) =>
    request<Workflow>(`/workflows/${enc(id)}`, { method: 'PATCH', body: { enabled } }),
  duplicate: (id: string) => request<Workflow>(`/workflows/${enc(id)}/duplicate`, { method: 'POST' }),
  remove: (id: string) =>
    request<{ deleted: string }>(`/workflows/${enc(id)}`, { method: 'DELETE', query: { confirm: true } }),
  exportDoc: (id: string) => request<WorkflowExport>(`/workflows/${enc(id)}/export`),
  importDoc: (doc: unknown) => request<Workflow>('/workflows/import', { method: 'POST', body: doc }),
  validate: (definition: WfDefinition, signal?: AbortSignal) =>
    request<ValidateResult>('/workflows/validate', { method: 'POST', body: { definition }, signal }),
  run: (id: string, payload: Record<string, unknown>) =>
    request<WorkflowRun>(`/workflows/${enc(id)}/run`, { method: 'POST', body: { payload } }),
  runs: (workflowId: string, limit = 50, signal?: AbortSignal) =>
    request<RunSummary[]>('/workflow-runs', { query: { workflow_id: workflowId, limit }, signal }),
  getRun: (runId: string, signal?: AbortSignal) => request<WorkflowRun>(`/workflow-runs/${enc(runId)}`, { signal }),
  stopRun: (runId: string) => request<WorkflowRun>(`/workflow-runs/${enc(runId)}/stop`, { method: 'POST' }),
  ownerApprovals: (signal?: AbortSignal) => request<OwnerApproval[]>('/owner-approvals', { signal }),
  resolveApproval: (approvalId: string, decision: 'approved' | 'denied') =>
    request<OwnerApproval>(`/owner-approvals/${enc(approvalId)}`, { method: 'POST', body: { decision } }),
  schedulePreview: (kind: string, spec: Record<string, unknown>, timezone: string, signal?: AbortSignal) =>
    request<{ next: number[] }>('/schedules/preview', {
      method: 'POST',
      body: { kind, spec, timezone, count: 3 },
      signal,
    }),
};

/** Pickers used by the block parameter editor. */
export const pickerApi = {
  agents: async (signal?: AbortSignal): Promise<AgentOption[]> =>
    (await request<{ id: string; name: string; state?: string }[]>('/agents', { signal })).map((a) => ({
      id: a.id,
      name: a.name,
      state: a.state,
    })),
  teams: async (signal?: AbortSignal): Promise<TeamOption[]> =>
    (await request<{ id: string; name: string }[]>('/teams', { signal })).map((t) => ({ id: t.id, name: t.name })),
  roots: async (signal?: AbortSignal): Promise<RootOption[]> =>
    (await request<{ id: string; type: string; label: string }[]>('/files/roots', { signal })).map((r) => ({
      id: r.id,
      type: r.type,
      label: r.label,
    })),
};
