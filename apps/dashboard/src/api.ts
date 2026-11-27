// Typed client for the NEBULA host API (/api/v1).
//
// Contract (apps/host-api/nebula_host/api/common.py + errors.py):
//   success -> {data, request_id, job_id?}
//   error   -> {error: {code, message, details}, request_id} + HTTP status
// The session cookie is HttpOnly; every POST/PUT/PATCH/DELETE carries `x-csrf-token`.
import type {
  LanStatus,
  Agent,
  AgentConfig,
  AgentSkill,
  MemoryBody,
  MemoryEntry,
  MemoryPatch,
  MemoryStats,
  OverviewData,
  OwnerApproval,
  PermissionMatrix,
  ResourceLimits,
  ResourceProfile,
  ResourceSample,
  ResourceSnapshot,
  Schedule,
  ScheduleBody,
  ScheduleDetail,
  ScheduleKind,
  ScheduleRun,
  ScheduleSpec,
  SemanticStatus,
  Skill,
  SkillCompatibility,
  SkillDetail,
  SkillUsage,
  Team,
  TeamBody,
  TeamRun,
  TeamRunSummary,
  VoicePatch,
  VoiceStatus,
  WorkflowRunSummary,
  WorkflowSummary,
  AgentDetail,
  AgentComposerPatch,
  AgentComposerSettings,
  AgentPatch,
  Approval,
  AuditEvent,
  AuthState,
  BackupResult,
  ChatMessage,
  ConnectBody,
  ControlResult,
  CreateAgentBody,
  DeleteAgentResult,

  ExportResult,
  Health,
  InstallJob,
  LiveConnect,
  LiveDisconnectResult,
  LiveSessions,
  LoginResult,
  LogResult,
  MemoryItem,
  ModelInfo,
  PreflightReport,
  Provider,
  ProviderTestResult,
  SettingsPatch,
  SettingsResponse,
  SiwcStart,
  SystemInfo,
  Task,
  TaskDetail,
  TelegramPairing,
  TelegramStatus,
  TelegramTest,
  TelegramUser,
} from './types';
import { request, requestBlob, requestEnvelope } from './lib/http';

export * from './lib/http';

const enc = encodeURIComponent;

// ---------------------------------------------------------------- endpoints
export const api = {
  auth: {
    state: () => request<AuthState>('/auth/state'),
    setup: (username: string, password: string, setup_token: string) =>
      request<LoginResult>('/auth/setup', { method: 'POST', body: { username, password, setup_token } }),
    login: (username: string, password: string) =>
      request<LoginResult>('/auth/login', { method: 'POST', body: { username, password } }),
    logout: () => request<{ logged_out: boolean }>('/auth/logout', { method: 'POST' }),
    changePassword: (current_password: string, new_password: string) =>
      request<{ changed: boolean; note: string }>('/auth/password', {
        method: 'POST',
        body: { current_password, new_password },
      }),
  },

  health: () => request<Health>('/health'),

  system: {
    info: () => request<SystemInfo>('/system'),
    vmStart: () => request<Record<string, unknown>>('/system/vm/start', { method: 'POST' }),
    vmStop: () => request<Record<string, unknown>>('/system/vm/stop', { method: 'POST' }),
    restartServices: () => request<{ restarting: boolean }>('/system/services/restart', { method: 'POST' }),
    repair: () => requestEnvelope<{ job_id: string }>('/system/repair', { method: 'POST' }),
    logs: (name: string, lines = 300) => request<LogResult>('/system/logs', { query: { name, lines } }),
    diagnostics: () => requestBlob('/system/diagnostics'),
    backup: () => request<BackupResult>('/system/backup', { method: 'POST' }),
    preflight: () => request<PreflightReport>('/setup/preflight', { method: 'POST' }),
    lan: () => request<LanStatus>('/system/lan'),
    setLan: (body: { enabled: boolean; https?: boolean }) => request<LanStatus>('/system/lan', { method: 'POST', body }),
    job: (jobId: string) => request<InstallJob>(`/setup/jobs/${enc(jobId)}`),
  },

  agents: {
    list: () => request<Agent[]>('/agents'),
    get: (id: string) => request<AgentDetail>(`/agents/${enc(id)}`),
    create: (body: CreateAgentBody, idempotencyKey: string) =>
      request<Agent>('/agents', { method: 'POST', body, idempotencyKey }),
    patch: (id: string, body: AgentPatch) => request<Agent>(`/agents/${enc(id)}`, { method: 'PATCH', body }),
    remove: (id: string, exportFirst: boolean, idempotencyKey: string) =>
      request<DeleteAgentResult>(`/agents/${enc(id)}`, {
        method: 'DELETE',
        query: { confirm: true, export: exportFirst },
        idempotencyKey,
      }),
    sleep: (id: string) => request<Agent>(`/agents/${enc(id)}/sleep`, { method: 'POST' }),
    wake: (id: string) => request<Agent>(`/agents/${enc(id)}/wake`, { method: 'POST' }),
    pause: (id: string) => request<Agent>(`/agents/${enc(id)}/pause`, { method: 'POST' }),
    resume: (id: string) => request<Agent>(`/agents/${enc(id)}/resume`, { method: 'POST' }),
    exportWorkspace: (id: string) => request<ExportResult>(`/agents/${enc(id)}/export`, { method: 'POST' }),
    restartDesktop: (id: string) =>
      request<Record<string, unknown>>(`/agents/${enc(id)}/restart-desktop`, { method: 'POST' }),
    screenshot: (id: string) => requestBlob(`/agents/${enc(id)}/screenshot`),
    messages: (id: string, limit = 200) => request<ChatMessage[]>(`/agents/${enc(id)}/messages`, { query: { limit } }),
    memory: (id: string, q?: string) => request<MemoryItem[]>(`/agents/${enc(id)}/memory`, { query: { q } }),
    deleteMemory: (id: string, memoryId: string) =>
      request<{ deleted: number }>(`/agents/${enc(id)}/memory/${enc(memoryId)}`, { method: 'DELETE' }),
    tasks: (id: string, limit = 50) => request<Task[]>(`/agents/${enc(id)}/tasks`, { query: { limit } }),
    createTask: (id: string, prompt: string, idempotencyKey: string) =>
      request<Task>(`/agents/${enc(id)}/tasks`, { method: 'POST', body: { prompt }, idempotencyKey }),
    /** V3.2.2 composer settings (instructions, avatar, Smart sign-in …), shared with the Telegram Mini App. */
    composerSettings: (id: string) => request<AgentComposerSettings>(`/miniapp/agents/${enc(id)}/settings`),
    patchComposerSettings: (id: string, body: AgentComposerPatch) =>
      request<AgentComposerSettings>(`/miniapp/agents/${enc(id)}/settings`, { method: 'PATCH', body }),
  },

  tasks: {
    list: (state?: string, limit = 200) => request<Task[]>('/tasks', { query: { state, limit } }),
    get: (id: string) => request<TaskDetail>(`/tasks/${enc(id)}`),
    pause: (id: string, mode: 'smart' | 'immediate' = 'smart') =>
      request<Task>(`/tasks/${enc(id)}/pause`, { method: 'POST', body: { mode } }),
    resume: (id: string) => request<Task>(`/tasks/${enc(id)}/resume`, { method: 'POST' }),
    stop: (id: string, mode: 'cancel' | 'emergency' = 'cancel') =>
      request<Task>(`/tasks/${enc(id)}/stop`, { method: 'POST', body: { mode } }),
    retry: (id: string) => request<Task>(`/tasks/${enc(id)}/retry`, { method: 'POST' }),
  },

  approvals: {
    list: (pending = true) => request<Approval[]>('/approvals', { query: { pending } }),
    resolve: (id: string, decision: 'approved' | 'denied') =>
      request<Approval>(`/approvals/${enc(id)}`, { method: 'POST', body: { decision } }),
  },

  live: {
    connect: (agentId: string) => request<LiveConnect>(`/agents/${enc(agentId)}/live/connect`, { method: 'POST' }),
    disconnect: (sessionId: string, keepalive = false) =>
      request<LiveDisconnectResult>(`/live/sessions/${enc(sessionId)}`, { method: 'DELETE', keepalive }),
    control: (sessionId: string, action: 'acquire' | 'renew' | 'release') =>
      request<ControlResult>(`/live/sessions/${enc(sessionId)}/control`, { method: 'POST', body: { action } }),
    sessions: () => request<LiveSessions>('/live/sessions'),
  },

  providers: {
    list: () => request<Provider[]>('/providers'),
    models: (id: string) => request<ModelInfo[]>(`/providers/${enc(id)}/models`),
    connect: (id: string, body: ConnectBody = {}) =>
      request<ProviderTestResult>(`/providers/${enc(id)}/connect`, { method: 'POST', body }),
    connectSiwc: () => request<SiwcStart>('/providers/openai-siwc/connect', { method: 'POST' }),
    test: (id: string) => request<ProviderTestResult>(`/providers/${enc(id)}/test`, { method: 'POST' }),
    disconnect: (id: string) =>
      request<{ provider_id: string; state: string }>(`/providers/${enc(id)}/disconnect`, { method: 'POST' }),
    setLimit: (id: string, daily_token_cap: number | null) =>
      request<{ provider_id: string; daily_token_cap: number | null }>(`/providers/${enc(id)}/limits`, {
        method: 'POST',
        body: { daily_token_cap },
      }),
  },

  telegram: {
    status: () => request<TelegramStatus>('/telegram'),
    setToken: (token: string) => request<TelegramStatus>('/telegram/token', { method: 'POST', body: { token } }),
    test: () => request<TelegramTest>('/telegram/test', { method: 'POST' }),
    pairing: () => request<TelegramPairing>('/telegram/pairing', { method: 'POST' }),
    approve: (pairingId: string) =>
      request<TelegramUser>(`/telegram/pairing/${enc(pairingId)}/approve`, { method: 'POST' }),
    /** Designates an approved main-bot account as the owner's own (a fresh owner confirmation on the host). */
    makeOwner: (userRowId: string) =>
      request<TelegramUser>(`/telegram/pairing/${enc(userRowId)}/approve`, { method: 'POST', body: { owner: true } }),
    revoke: (userRowId: string) => request<TelegramStatus>(`/telegram/users/${enc(userRowId)}/revoke`, { method: 'POST' }),
    disconnect: () => request<TelegramStatus>('/telegram', { method: 'DELETE' }),
  },

  settings: {
    get: () => request<SettingsResponse>('/settings'),
    patch: (body: SettingsPatch) => request<{ config: SettingsResponse['config'] }>('/settings', { method: 'PATCH', body }),
  },

  audit: (limit = 200) => request<AuditEvent[]>('/audit', { query: { limit } }),

  // ============================================================== V2
  overview: () => request<OverviewData>('/overview'),

  agentConfig: {
    patch: (agentId: string, body: Partial<Pick<AgentConfig, 'memory_auto_save' | 'idle_sleep_minutes'>>) =>
      request<{ config: AgentConfig }>(`/agents/${enc(agentId)}/config`, { method: 'PATCH', body }),
  },

  memory: {
    list: (agentId: string, opts: { q?: string; kind?: string; shared?: boolean; limit?: number } = {}) =>
      request<MemoryEntry[]>(`/agents/${enc(agentId)}/memory`, {
        query: { q: opts.q, kind: opts.kind, shared: opts.shared ? true : undefined, limit: opts.limit },
      }),
    stats: (agentId: string) => request<MemoryStats>(`/agents/${enc(agentId)}/memory/stats`),
    create: (agentId: string, body: MemoryBody) => request<MemoryEntry>(`/agents/${enc(agentId)}/memory`, { method: 'POST', body }),
    update: (agentId: string, memoryId: string, body: MemoryPatch) =>
      request<MemoryEntry>(`/agents/${enc(agentId)}/memory/${enc(memoryId)}`, { method: 'PATCH', body }),
    remove: (agentId: string, memoryId: string) =>
      request<{ deleted: number }>(`/agents/${enc(agentId)}/memory/${enc(memoryId)}`, { method: 'DELETE' }),
    /** Bulk delete (optionally one kind only). Always sends confirm=true: call only after the user confirmed. */
    clear: (agentId: string, kind?: string) =>
      request<{ deleted: number }>(`/agents/${enc(agentId)}/memory`, { method: 'DELETE', query: { kind, confirm: true } }),
    semantic: () => request<SemanticStatus>('/memory/semantic'),
    setSemantic: (enabled: boolean, model = 'nomic-embed-text') =>
      request<SemanticStatus>('/memory/semantic', { method: 'POST', body: { enabled, model } }),
  },

  teams: {
    list: () => request<Team[]>('/teams'),
    get: (id: string) => request<Team>(`/teams/${enc(id)}`),
    create: (body: TeamBody) => request<Team>('/teams', { method: 'POST', body }),
    update: (id: string, body: Partial<TeamBody>) => request<Team>(`/teams/${enc(id)}`, { method: 'PATCH', body }),
    remove: (id: string, deleteFiles: boolean) =>
      request<{ deleted: string; files_deleted: boolean }>(`/teams/${enc(id)}`, {
        method: 'DELETE',
        query: { confirm: true, delete_files: deleteFiles },
      }),
    startRun: (id: string, prompt: string, maxModelCalls?: number | null) =>
      request<TeamRun>(`/teams/${enc(id)}/runs`, { method: 'POST', body: { prompt, max_model_calls: maxModelCalls ?? null } }),
    runs: (teamId?: string, limit = 50) => request<TeamRunSummary[]>('/team-runs', { query: { team_id: teamId, limit } }),
    run: (runId: string) => request<TeamRun>(`/team-runs/${enc(runId)}`),
    cancelRun: (runId: string) => request<TeamRun>(`/team-runs/${enc(runId)}/cancel`, { method: 'POST' }),
  },

  schedules: {
    list: () => request<Schedule[]>('/schedules'),
    get: (id: string) => request<ScheduleDetail>(`/schedules/${enc(id)}`),
    create: (body: ScheduleBody) => request<Schedule>('/schedules', { method: 'POST', body }),
    update: (id: string, body: Partial<ScheduleBody>) => request<Schedule>(`/schedules/${enc(id)}`, { method: 'PATCH', body }),
    remove: (id: string) => request<{ deleted: string }>(`/schedules/${enc(id)}`, { method: 'DELETE', query: { confirm: true } }),
    runNow: (id: string) => request<ScheduleRun>(`/schedules/${enc(id)}/run`, { method: 'POST' }),
    preview: (body: { kind: ScheduleKind; spec: ScheduleSpec; timezone: string; count?: number }, signal?: AbortSignal) =>
      request<{ next: number[] }>('/schedules/preview', { method: 'POST', body, signal }),
    runs: (scheduleId?: string, limit = 100) => request<ScheduleRun[]>('/schedule-runs', { query: { schedule_id: scheduleId, limit } }),
  },

  /** Read-only summaries used as schedule targets / on the Command Center (the editor lives in features/workflows). */
  workflows: {
    list: () => request<WorkflowSummary[]>('/workflows'),
    runs: (workflowId?: string, limit = 50) => request<WorkflowRunSummary[]>('/workflow-runs', { query: { workflow_id: workflowId, limit } }),
  },

  ownerApprovals: {
    list: () => request<OwnerApproval[]>('/owner-approvals'),
    resolve: (id: string, decision: 'approved' | 'denied') =>
      request<OwnerApproval>(`/owner-approvals/${enc(id)}`, { method: 'POST', body: { decision } }),
  },

  skills: {
    list: () => request<Skill[]>('/skills'),
    get: (id: string) => request<SkillDetail>(`/skills/${enc(id)}`),
    usage: (skillId?: string, limit = 200) => request<SkillUsage[]>('/skills/usage', { query: { skill_id: skillId, limit } }),
    compatibility: () => request<SkillCompatibility>('/skills/compatibility'),
    setEnabled: (id: string, enabled: boolean) => request<Skill>(`/skills/${enc(id)}/enabled`, { method: 'POST', body: { enabled } }),
    /** Raw .zip upload (the host streams the body). */
    installPlugin: (file: Blob, allowDowngrade = false) =>
      request<Skill>('/skills/plugins', {
        method: 'POST',
        rawBody: file,
        contentType: 'application/zip',
        query: { allow_downgrade: allowDowngrade || undefined },
      }),
    uninstallPlugin: (id: string) =>
      request<{ uninstalled: string }>(`/skills/plugins/${enc(id)}`, { method: 'DELETE', query: { confirm: true } }),
    forAgent: (agentId: string) => request<AgentSkill[]>(`/agents/${enc(agentId)}/skills`),
    assign: (agentId: string, skills: string[], configs?: Record<string, Record<string, unknown>>) =>
      request<AgentSkill[]>(`/agents/${enc(agentId)}/skills`, { method: 'PUT', body: { skills, configs: configs ?? {} } }),
    permissionMatrix: () => request<PermissionMatrix>('/permissions/matrix'),
    setGithubToken: (token: string) => request<{ configured: boolean }>('/skills/github/token', { method: 'POST', body: { token } }),
    removeGithubToken: () => request<{ configured: boolean }>('/skills/github/token', { method: 'DELETE' }),
  },

  resources: {
    snapshot: () => request<ResourceSnapshot>('/resources'),
    history: (rangeS: number) => request<ResourceSample[]>('/resources/history', { query: { range_s: rangeS } }),
    setProfile: (profile: ResourceProfile) => request<ResourceLimits>('/resources/profile', { method: 'POST', body: { profile } }),
  },

  voice: {
    status: () => request<VoiceStatus>('/voice/stt'),
    update: (body: VoicePatch) => request<VoiceStatus>('/voice/stt', { method: 'PATCH', body }),
  },
};

export type Api = typeof api;
