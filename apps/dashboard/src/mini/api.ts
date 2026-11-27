// Typed endpoints of the Mini App. Only routes on the Mini App gateway allow-list (nebula_host/remote.py ALLOW)
// are used, so every screen works identically through Telegram and in the local preview.
import { newIdempotencyKey } from '../lib/http';
import type {
  Agent,
  AgentDetail,
  AgentSkill,
  ChatMessage,
  ControlResult,
  Health,
  LiveConnect,
  LiveDisconnectResult,
  LiveSessions,
  MemoryEntry,
  OverviewData,
  OwnerApproval,
  ResourceSnapshot,
  Task,
  TaskDetail,
} from '../types';
import type { FileEntry, FilePreview, FileRoot, ListResult, WriteResult } from '../features/files/types';
import type { RunSummary, Workflow, WorkflowListItem, WorkflowRun } from '../features/workflows/types';
import type { Schedule, ScheduleRun, Team, TeamRunSummary } from '../types';
import type { AuthSession, SmartAuthClient, SubmitBody, SubmitToken } from '../features/smartauth/core/types';
import type { MiniClient } from './client';
import type {
  AgentEnvironment,
  AgentVault,
  AgentVoice,
  ApprovalCenter,
  Conversation,
  HostRoot,
  MessagePage,
  SearchResult,
  SendMessageResult,
  SttStatus,
  VaultAuditRow,
  VaultEntry,
  VaultGrant,
  VaultStatus,
  VoiceOverview,
  CompanyActivity,
  CompanyDetail,
  CompanyOrg,
  CompanyRun,
  CompanySummary,
  MiniMe,
  MiniNotification,
} from './types';

const enc = encodeURIComponent;

export interface CreateCompanyBody {
  name: string;
  description?: string;
  objective?: string;
  industry?: string;
  default_environment: 'vm' | 'host';
  members?: { agent_id: string; role_key: string }[];
}

export function createMiniApi(c: MiniClient) {
  return {
    me: (signal?: AbortSignal) => c.request<MiniMe>('/miniapp/me', { signal }),
    health: (signal?: AbortSignal) => c.request<Health>('/health', { signal }),
    overview: (signal?: AbortSignal) => c.request<OverviewData>('/overview', { signal }),
    resources: (signal?: AbortSignal) => c.request<ResourceSnapshot>('/resources', { signal }),
    notifications: (before?: number, signal?: AbortSignal) =>
      c.request<MiniNotification[]>('/notifications', { query: { limit: 50, before }, signal }),

    agents: {
      list: (signal?: AbortSignal) => c.request<Agent[]>('/agents', { signal }),
      get: (id: string, signal?: AbortSignal) => c.request<AgentDetail>(`/agents/${enc(id)}`, { signal }),
      environment: (id: string, signal?: AbortSignal) => c.request<AgentEnvironment>(`/agents/${enc(id)}/environment`, { signal }),
      voice: (id: string, signal?: AbortSignal) => c.request<AgentVoice>(`/agents/${enc(id)}/voice`, { signal }),
      skills: (id: string, signal?: AbortSignal) => c.request<AgentSkill[]>(`/agents/${enc(id)}/skills`, { signal }),
      memory: (id: string, q?: string, signal?: AbortSignal) =>
        c.request<MemoryEntry[]>(`/agents/${enc(id)}/memory`, { query: { q, limit: 100 }, signal }),
      messages: (id: string, signal?: AbortSignal) => c.request<ChatMessage[]>(`/agents/${enc(id)}/messages`, { query: { limit: 200 }, signal }),
      tasks: (id: string, signal?: AbortSignal) => c.request<Task[]>(`/agents/${enc(id)}/tasks`, { query: { limit: 50 }, signal }),
      createTask: (id: string, prompt: string, attachmentIds: string[]) =>
        c.request<Task>(`/agents/${enc(id)}/tasks`, {
          method: 'POST',
          body: { prompt, attachment_ids: attachmentIds },
          idempotencyKey: newIdempotencyKey(),
        }),
      createTaskWithKey: (id: string, prompt: string, attachmentIds: string[], idempotencyKey: string) =>
        c.request<Task>(`/agents/${enc(id)}/tasks`, {
          method: 'POST',
          body: { prompt, attachment_ids: attachmentIds },
          idempotencyKey,
        }),
      conversation: (id: string, signal?: AbortSignal) => c.request<Conversation>(`/agents/${enc(id)}/conversation`, { signal }),
      wake: (id: string) => c.request<Agent>(`/agents/${enc(id)}/wake`, { method: 'POST' }),
      sleep: (id: string) => c.request<Agent>(`/agents/${enc(id)}/sleep`, { method: 'POST' }),
      pause: (id: string) => c.request<Agent>(`/agents/${enc(id)}/pause`, { method: 'POST' }),
      resume: (id: string) => c.request<Agent>(`/agents/${enc(id)}/resume`, { method: 'POST' }),
      screenshot: (id: string) => c.blob(`/agents/${enc(id)}/screenshot`),
    },

    tasks: {
      list: (state?: string, signal?: AbortSignal) => c.request<Task[]>('/tasks', { query: { state, limit: 100 }, signal }),
      get: (id: string, signal?: AbortSignal) => c.request<TaskDetail>(`/tasks/${enc(id)}`, { signal }),
      pause: (id: string) => c.request<Task>(`/tasks/${enc(id)}/pause`, { method: 'POST', body: { mode: 'smart' } }),
      resume: (id: string) => c.request<Task>(`/tasks/${enc(id)}/resume`, { method: 'POST' }),
      stop: (id: string) => c.request<Task>(`/tasks/${enc(id)}/stop`, { method: 'POST', body: { mode: 'cancel' } }),
      retry: (id: string) => c.request<Task>(`/tasks/${enc(id)}/retry`, { method: 'POST' }),
    },

    conversations: {
      list: (opts: { agentId?: string; archived?: boolean } = {}, signal?: AbortSignal) =>
        c.request<Conversation[]>('/conversations', { query: { agent_id: opts.agentId, archived: opts.archived ? 'true' : 'false', limit: 100 }, signal }),
      get: (id: string, signal?: AbortSignal) => c.request<Conversation>(`/conversations/${enc(id)}`, { signal }),
      create: (agentId: string, title?: string) => c.request<Conversation>('/conversations', { method: 'POST', body: title ? { agent_id: agentId, title } : { agent_id: agentId } }),
      update: (id: string, patch: { title?: string; archived?: boolean }) => c.request<Conversation>(`/conversations/${enc(id)}`, { method: 'PATCH', body: patch }),
      markRead: (id: string) => c.request<{ unread_count: number }>(`/conversations/${enc(id)}/read`, { method: 'POST' }),
      messages: (id: string, before?: number, signal?: AbortSignal) =>
        c.request<MessagePage>(`/conversations/${enc(id)}/messages`, { query: { before, limit: 50 }, signal }),
      /** Idempotent: the same client_id returns the original message (also sent as Idempotency-Key). */
      send: (id: string, body: { content: string; client_id: string; attachment_ids?: string[] }) =>
        c.request<SendMessageResult>(`/conversations/${enc(id)}/messages`, { method: 'POST', body, idempotencyKey: body.client_id }),
      search: (q: string, signal?: AbortSignal) => c.request<SearchResult>('/conversations/search', { query: { q, limit: 30 }, signal }),
    },

    attachments: {
      content: (id: string) => c.blob(`/attachments/${enc(id)}/content`),
    },

    voice: {
      stt: (signal?: AbortSignal) => c.request<SttStatus>('/voice/stt', { signal }),
      status: (signal?: AbortSignal) => c.request<VoiceOverview>('/voice/status', { signal }),
    },

    /** Password Vault: metadata and protective actions only. There is no endpoint here that returns a secret. */
    vault: {
      status: (signal?: AbortSignal) => c.request<VaultStatus>('/vault/status', { signal }),
      entries: (q?: string, signal?: AbortSignal) => c.request<VaultEntry[]>('/vault/entries', { query: { q }, signal }),
      audit: (agentId?: string, signal?: AbortSignal) => c.request<VaultAuditRow[]>('/vault/audit', { query: { limit: 50, agent_id: agentId }, signal }),
      agent: (agentId: string, signal?: AbortSignal) => c.request<AgentVault>(`/agents/${enc(agentId)}/vault`, { signal }),
      lock: () => c.request<{ locked: boolean }>('/vault/lock', { method: 'POST' }),
      revoke: (grantId: string) => c.request<VaultGrant>(`/vault/grants/${enc(grantId)}/revoke`, { method: 'POST' }),
    },

    teams: {
      list: (signal?: AbortSignal) => c.request<Team[]>('/teams', { signal }),
      runs: (signal?: AbortSignal) => c.request<TeamRunSummary[]>('/team-runs', { query: { limit: 20 }, signal }),
    },

    schedules: {
      list: (signal?: AbortSignal) => c.request<Schedule[]>('/schedules', { signal }),
      runs: (signal?: AbortSignal) => c.request<ScheduleRun[]>('/schedule-runs', { query: { limit: 20 }, signal }),
    },

    host: {
      roots: (signal?: AbortSignal) => c.request<HostRoot[]>('/host/roots', { signal }),
    },

    /**
     * Smart Authentication (sign-in assistance during agent tasks). Remote-safe subset only: the settings and the remote
     * PIN are local-only (Dashboard on the Mac) and never offered here. Typed values travel only in the submit body.
     */
    smartAuth: {
      sessions: (opts: { conversationId?: string; agentId?: string; taskId?: string; active?: boolean; limit?: number } = {}, signal?: AbortSignal) =>
        c.request<AuthSession[]>('/smart-auth/sessions', {
          query: {
            conversation_id: opts.conversationId,
            agent_id: opts.agentId,
            task_id: opts.taskId,
            active: opts.active === undefined ? undefined : opts.active ? 'true' : 'false',
            limit: opts.limit,
          },
          signal,
        }),
      get: (id: string, signal?: AbortSignal) => c.request<AuthSession>(`/smart-auth/sessions/${enc(id)}`, { signal }),
      token: (id: string) => c.request<SubmitToken>(`/smart-auth/sessions/${enc(id)}/token`, { method: 'POST' }),
      submit: (id: string, body: SubmitBody) => c.request<AuthSession>(`/smart-auth/sessions/${enc(id)}/submit`, { method: 'POST', body }),
      cancel: (id: string) => c.request<AuthSession>(`/smart-auth/sessions/${enc(id)}/cancel`, { method: 'POST' }),
    } satisfies SmartAuthClient & Record<string, unknown>,

    approvals: {
      center: (signal?: AbortSignal) => c.request<ApprovalCenter>('/approval-center', { signal }),
      resolveTask: (id: string, decision: 'approved' | 'denied') =>
        c.request<unknown>(`/approvals/${enc(id)}`, { method: 'POST', body: { decision } }),
      resolveOwner: (id: string, decision: 'approved' | 'denied') =>
        c.request<OwnerApproval>(`/owner-approvals/${enc(id)}`, { method: 'POST', body: { decision } }),
    },

    live: {
      connect: (agentId: string) => c.request<LiveConnect>(`/agents/${enc(agentId)}/live/connect`, { method: 'POST' }),
      disconnect: (sid: string, keepalive = false) =>
        c.request<LiveDisconnectResult>(`/live/sessions/${enc(sid)}`, { method: 'DELETE', keepalive }),
      control: (sid: string, action: 'acquire' | 'renew' | 'release') =>
        c.request<ControlResult>(`/live/sessions/${enc(sid)}/control`, { method: 'POST', body: { action } }),
      sessions: () => c.request<LiveSessions>('/live/sessions'),
    },

    companies: {
      list: (signal?: AbortSignal) => c.request<CompanySummary[]>('/companies', { signal }),
      get: (id: string, signal?: AbortSignal) => c.request<CompanyDetail>(`/companies/${enc(id)}`, { signal }),
      org: (id: string, signal?: AbortSignal) => c.request<CompanyOrg>(`/companies/${enc(id)}/org`, { signal }),
      activity: (id: string, signal?: AbortSignal) =>
        c.request<CompanyActivity[]>(`/companies/${enc(id)}/activity`, { query: { limit: 50 }, signal }),
      create: (body: CreateCompanyBody) => c.request<CompanyDetail>('/companies', { method: 'POST', body }),
      startRun: (projectId: string, objective: string, planner: 'template' | 'ceo') =>
        c.request<CompanyRun>(`/projects/${enc(projectId)}/runs`, { method: 'POST', body: { objective, planner } }),
      run: (runId: string, signal?: AbortSignal) => c.request<CompanyRun>(`/company-runs/${enc(runId)}`, { signal }),
      runAction: (runId: string, action: 'pause' | 'resume' | 'cancel') =>
        c.request<CompanyRun>(`/company-runs/${enc(runId)}/${action}`, { method: 'POST' }),
      retryItem: (itemId: string) => c.request<unknown>(`/company-items/${enc(itemId)}/retry`, { method: 'POST' }),
    },

    workflows: {
      list: (signal?: AbortSignal) => c.request<WorkflowListItem[]>('/workflows', { signal }),
      get: (id: string, signal?: AbortSignal) => c.request<Workflow>(`/workflows/${enc(id)}`, { signal }),
      setEnabled: (id: string, enabled: boolean) => c.request<Workflow>(`/workflows/${enc(id)}`, { method: 'PATCH', body: { enabled } }),
      run: (id: string) => c.request<WorkflowRun>(`/workflows/${enc(id)}/run`, { method: 'POST', body: { payload: {} } }),
      runs: (workflowId?: string, signal?: AbortSignal) =>
        c.request<RunSummary[]>('/workflow-runs', { query: { workflow_id: workflowId, limit: 30 }, signal }),
      getRun: (runId: string, signal?: AbortSignal) => c.request<WorkflowRun>(`/workflow-runs/${enc(runId)}`, { signal }),
      stopRun: (runId: string) => c.request<WorkflowRun>(`/workflow-runs/${enc(runId)}/stop`, { method: 'POST' }),
    },

    files: {
      roots: (signal?: AbortSignal) => c.request<FileRoot[]>('/files/roots', { signal }),
      list: (root: string, path: string, signal?: AbortSignal) => c.request<ListResult>('/files/list', { query: { root, path }, signal }),
      preview: (root: string, path: string, signal?: AbortSignal) =>
        c.request<FilePreview>('/files/preview', { query: { root, path }, signal }),
      stat: (root: string, path: string) => c.request<FileEntry>('/files/stat', { query: { root, path } }),
      download: (root: string, path: string) => c.blob('/files/download', { root, path }),
      mkdir: (root: string, path: string) => c.request<{ path: string }>('/files/mkdir', { method: 'POST', body: { root, path } }),
      upload: (root: string, path: string, file: Blob) =>
        c.request<WriteResult>('/files/upload', { method: 'POST', query: { root, path }, rawBody: file, contentType: 'application/octet-stream' }),
    },

    /** Authenticated binary GET (artifacts, screenshots): <img src> cannot carry a Bearer token. */
    artifact: (ref: string) => c.blob(`/artifacts/${ref.split('/').map(enc).join('/')}`),
  };
}

export type MiniApi = ReturnType<typeof createMiniApi>;
