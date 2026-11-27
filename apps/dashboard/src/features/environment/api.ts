// Typed client for execution environments and host access (routes_v3.py).
import { request } from '../../api';
import type {
  AgentEnvSummary,
  BrowseResult,
  EnvId,
  EnvironmentsInfo,
  HostCommand,
  HostRoot,
  HostToolsInfo,
  RootBody,
  RootPatch,
} from './types';

const enc = encodeURIComponent;

export const envApi = {
  info: (signal?: AbortSignal) => request<EnvironmentsInfo>('/environments', { signal }),
  agent: (agentId: string, projectId?: string | null, signal?: AbortSignal) =>
    request<AgentEnvSummary>(`/agents/${enc(agentId)}/environment`, { query: { project_id: projectId ?? undefined }, signal }),
  /** 409 agent_busy (active tasks) / environment_not_ready (problems joined by "; "). */
  setAgent: (agentId: string, env: EnvId, rootId: string | null) =>
    request<AgentEnvSummary>(`/agents/${enc(agentId)}/environment`, { method: 'PUT', body: { env, root_id: env === 'host' ? rootId : null } }),
};

export interface SelfTestResult {
  root: string;
  passed: boolean;
  probes: { probe: string; passed: boolean; exit_code: number | null; output?: string }[];
}

export const hostApi = {
  roots: (signal?: AbortSignal) => request<HostRoot[]>('/host/roots', { signal }),
  addRoot: (body: RootBody) => request<HostRoot>('/host/roots', { method: 'POST', body }),
  patchRoot: (id: string, body: RootPatch) => request<HostRoot>(`/host/roots/${enc(id)}`, { method: 'PATCH', body }),
  /** Revokes NEBULA's access; the folder itself is never deleted. */
  revokeRoot: (id: string) =>
    request<{ revoked: string; projects_unlinked: string[] }>(`/host/roots/${enc(id)}`, { method: 'DELETE', query: { confirm: true } }),
  tools: (refresh = false, signal?: AbortSignal) => request<HostToolsInfo>('/host/tools', { query: { refresh: refresh ? 1 : undefined }, signal }),
  commands: (filter: { root_id?: string; agent_id?: string; limit?: number } = {}, signal?: AbortSignal) =>
    request<HostCommand[]>('/host/commands', { query: { root_id: filter.root_id, agent_id: filter.agent_id, limit: filter.limit }, signal }),
  /** Fixed sandbox probes (git/python/node work; ~/Library, ~/.ssh, NEBULA data, Keychain, outside writes blocked). */
  selftest: (id: string) => request<SelfTestResult>(`/host/roots/${enc(id)}/selftest`, { method: 'POST' }),
  browse: (path?: string | null, signal?: AbortSignal) => request<BrowseResult>('/host/browse', { query: { path: path ?? undefined }, signal }),
};
