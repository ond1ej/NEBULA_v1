// Wire types of the NEBULA host API (apps/host-api/nebula_host). Timestamps are epoch SECONDS (float).

export type Epoch = number;
export type Json = Record<string, unknown>;

export interface Envelope<T> {
  data: T;
  request_id: string;
  job_id?: string;
}

export interface ErrorEnvelope {
  error: { code: string; message: string; details: Json };
  request_id: string;
  job_id?: string;
}

// ------------------------------------------------------------------ auth
export interface AuthState {
  initialized: boolean;
  authenticated: boolean;
  user: { username: string } | null;
  csrf_token: string | null;
}

export interface LoginResult {
  session_id: string;
  csrf_token: string;
  user: { id: string; username: string };
}

// ------------------------------------------------------------------ health / system
export interface Health {
  status: 'ok' | 'degraded' | string;
  api: string;
  db: string;
  vm: { state: string | null };
  guest: { status: string; latency_ms?: number | null };
  providers: Record<string, string>;
  telegram: { polling: boolean };
  version: string;
}

export interface HostResources {
  memory_total_bytes: number;
  memory_available_bytes: number;
  memory_free_percent: number;
  memory_pressure: string;
  load_avg: number[];
  cpu_count: number | null;
  disk_total_bytes: number;
  disk_free_bytes: number;
  vm_resident_bytes: number;
  /** The VM's real memory footprint (≈ 3 GB); `vm_resident_bytes` is ps-style RSS and understates the VM. Newer hosts only. */
  vm_footprint_bytes?: number | null;
  os: string;
  arch: string;
  app_version: string;
}

export interface VmStatus {
  state: string;
  error?: string;
  message?: string;
  [k: string]: unknown;
}

export interface GuestHealth {
  status: string;
  latency_ms?: number;
  detail?: string;
  [k: string]: unknown;
}

export interface Installation {
  id: number;
  installation_id: string;
  state: string;
  state_detail: string | null;
  app_version: string;
  vm_image_version: string | null;
  guest_version: string | null;
  last_health: unknown;
  updated_at: Epoch;
}

export interface ActiveStream {
  session_id: string;
  agent_id: string;
  bytes_out: number;
  control: boolean;
}

export interface SystemInfo {
  host: HostResources;
  vm: VmStatus;
  guest: GuestHealth;
  installation: Installation | null;
  storage: { artifacts_bytes: number; data_dir: string };
  limits: { active_gui_agents: number; running_workers: number };
  live: { active_streams: ActiveStream[] };
}

export interface LogResult {
  name: string;
  lines: string[];
}

export interface BackupResult {
  path: string;
  size_bytes: number;
  note: string;
}

export interface JobStep {
  state: string;
  detail: string;
  status: string; // running | done | failed
  started_at: Epoch;
  updated_at: Epoch;
}

export interface InstallJob {
  id: string;
  kind: string;
  state: string; // RUNNING | SUCCEEDED | FAILED ...
  current_step: string | null;
  steps: JobStep[];
  progress: number | null;
  error: string | null;
  result: Json | null;
  idempotency_key: string | null;
  created_at: Epoch;
  updated_at: Epoch;
}

export interface PreflightCheck {
  id: string;
  status: 'pass' | 'warn' | 'fail' | string;
  detail: string;
  required?: string;
  note?: string;
  [k: string]: unknown;
}

export interface PreflightReport {
  status: string;
  checks: PreflightCheck[];
}

export interface AuditEvent {
  id: number;
  ts: Epoch;
  actor: string;
  action: string;
  target: string | null;
  metadata: Json | null;
  request_id: string | null;
}

// ------------------------------------------------------------------ agents
export type AgentState =
  | 'CREATING'
  | 'READY'
  | 'ACTIVE'
  | 'IDLE'
  | 'SLEEP'
  | 'PAUSED'
  | 'STOPPED'
  | 'ERROR'
  | 'DELETING';

export type PermissionLevel = 'READ_ONLY' | 'STANDARD' | 'ADVANCED';
export type ResourceMode = 'ACTIVE' | 'IDLE' | 'SLEEP';

export interface Agent {
  id: string;
  name: string;
  description: string;
  state: AgentState | string;
  linux_user: string | null;
  guest_user: string | null;
  display_id: string | null;
  provider_id: string | null;
  model_id: string | null;
  task_type: string;
  permission_level: string;
  permissions: string[];
  capabilities: unknown[];
  resource_mode: string;
  desktop_resolution: string;
  fallback_provider_id: string | null;
  fallback_model_id?: string | null;
  desktop_health: unknown;
  last_error: string | null;
  last_active_at: Epoch | null;
  created_at: Epoch;
  updated_at: Epoch;
  telegram_topic_id: number | null;
  telegram_mapping: string | null;
  current_task: { id: string; state: string } | null;
  /** Per-agent V2 settings (PATCH /agents/{id}/config). */
  config?: AgentConfig;
}

export interface AgentConfig {
  memory_auto_save?: boolean;
  idle_sleep_minutes?: number;
  /** V3.2.2: avatar chosen in the agent creator (emoji, 1–2 initials or one of the fixed icon ids). */
  avatar?: AgentAvatar | null;
  /** V3.2.2: owner-written instructions added to the agent's system prompt. */
  instructions?: string;
  /** V3.2.2: Smart sign-in (vault access "ask"). */
  sign_in_assistance?: boolean;
  [k: string]: unknown;
}

export type AgentAvatarKind = 'emoji' | 'initials' | 'icon';

export interface AgentAvatar {
  kind: AgentAvatarKind;
  value: string;
}

export type AgentCapabilityId = 'browser' | 'web_research' | 'files' | 'terminal' | 'desktop';
export type AgentLevel = 'READ_ONLY' | 'STANDARD' | 'ADVANCED';
export type VaultAccess = 'none' | 'ask';

/** GET/PATCH /miniapp/agents/{id}/settings (V3.2.2 agent composer). */
export interface AgentComposerSettings {
  agent: Agent;
  name: string;
  description: string;
  avatar: AgentAvatar | null;
  provider_id: string | null;
  model_id: string | null;
  instructions: string;
  permission_level: AgentLevel | string;
  capabilities: Record<AgentCapabilityId | 'memory', boolean>;
  extra_skills: string[];
  vault_access: VaultAccess;
  vault: { mode: 'NONE' | 'SELECTED' | 'MANAGED' | string; grants: { id: string; entry_name: string; origins: string[]; policy: string; enabled: boolean }[] };
  environment: { env: 'vm' | 'host'; root_id: string | null; source: string };
  status: string;
  resource_mode: string;
  idle_sleep_minutes: number | null;
  desktop_resolution: string;
  ready: boolean;
}

export interface AgentComposerPatch {
  name?: string;
  description?: string;
  avatar?: AgentAvatar | null;
  provider_id?: string;
  model_id?: string;
  instructions?: string;
  capabilities?: Partial<Record<AgentCapabilityId | 'memory', boolean>>;
  extra_skills?: string[];
  vault_access?: VaultAccess;
  permission_level?: AgentLevel;
  idle_sleep_minutes?: number | null;
  allow_duplicate_name?: boolean;
}

export interface AgentDetail extends Agent {
  permission_catalog: Record<string, string[]>;
  tools: { name: string; min_level: string }[];
  live_streams: ActiveStream[];
  control_held_by_user: boolean;
}

export interface CreateAgentBody {
  name: string;
  description: string;
  provider_id: string | null;
  model_id: string | null;
  desktop_resolution: string;
  permission_level: PermissionLevel;
  resource_mode: ResourceMode;
  task_type: string;
  fallback_provider_id: string | null;
  fallback_model_id?: string | null;
}

export type AgentPatch = Partial<
  Pick<
    Agent,
    | 'name'
    | 'description'
    | 'provider_id'
    | 'model_id'
    | 'permission_level'
    | 'resource_mode'
    | 'fallback_provider_id'
    | 'fallback_model_id'
    | 'task_type'
  >
>;

export interface DeleteAgentResult {
  agent_id: string;
  export_path?: string;
  guest?: unknown;
  telegram_topics: TelegramTopic[];
}

export interface ExportResult {
  path: string;
  size_bytes: number;
}

export interface ChatMessage {
  id: string;
  agent_id: string;
  task_id: string | null;
  role: 'user' | 'assistant' | 'system' | 'tool' | string;
  channel: string;
  content: string;
  attachments: string[];
  created_at: Epoch;
}

export interface MemoryItem {
  id: string;
  agent_id?: string;
  key: string;
  value: string;
  source: string;
  tags: string;
  updated_at: Epoch;
  expires_at?: Epoch | null;
}

// ------------------------------------------------------------------ tasks
export type TaskState =
  | 'RECEIVED'
  | 'QUEUED'
  | 'PLANNING'
  | 'EXECUTING'
  | 'VERIFYING'
  | 'PAUSING'
  | 'PAUSED'
  | 'WAITING_APPROVAL'
  | 'WAITING_PROVIDER'
  | 'WAITING_CONTROL'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

export const TERMINAL_TASK_STATES = ['COMPLETED', 'FAILED', 'CANCELLED'];

export interface TaskResult {
  summary?: string;
  verification?: string;
  verified_artifacts?: { type: string; value: string }[];
  verified?: unknown;
  screenshots?: string[];
  possible_incomplete_side_effects?: unknown[];
  [k: string]: unknown;
}

export interface Task {
  id: string;
  agent_id: string;
  agent_name?: string;
  prompt: string;
  state: TaskState | string;
  current_step: number;
  retry_count: number;
  tool_calls_done: number;
  max_steps: number;
  checkpoint_id: string | null;
  requires_approval: boolean;
  pause_requested: string | null;
  source_channel: string;
  reply_target: Json | null;
  result: TaskResult | null;
  failure_reason: string | null;
  created_at: Epoch;
  updated_at: Epoch;
  started_at: Epoch | null;
  finished_at: Epoch | null;
}

export interface TaskStep {
  id: string;
  task_id: string;
  seq: number;
  tool_type: string;
  args_sanitized: Json | null;
  result_status: string;
  result_summary: string | null;
  screenshot_ref: string | null;
  elapsed_ms: number | null;
  created_at: Epoch;
}

export interface Approval {
  id: string;
  task_id: string;
  agent_id: string;
  tool: string;
  action_summary: string;
  action_preview: Json | null;
  reason: string | null;
  requested_by: string;
  resolved_by: string | null;
  decision: 'approved' | 'denied' | 'expired' | null;
  created_at: Epoch;
  expires_at: Epoch;
  resolved_at: Epoch | null;
}

export interface TaskDetail extends Task {
  steps: TaskStep[];
  approvals: Approval[];
}

// ------------------------------------------------------------------ live desktop
export interface LiveConnect {
  session_id: string;
  token: string;
  state: string;
  read_only: boolean;
  ws_path: string;
  expires_at: Epoch;
  ttl_seconds: number;
}

export interface LiveSessionRow {
  id: string;
  agent_id: string;
  viewer_session_id: string;
  state: string;
  control_lease: boolean;
  lease_expires_at: Epoch | null;
  bytes_to_viewer: number;
  created_at: Epoch;
  expires_at: Epoch;
  last_seen_at: Epoch | null;
  ended_at: Epoch | null;
}

export interface LiveSessions {
  sessions: LiveSessionRow[];
  active_streams: ActiveStream[];
}

export interface LiveDisconnectResult {
  session_id: string;
  state: string;
  active_stream?: boolean;
}

export interface ControlResult {
  session_id: string;
  control: boolean;
  lease_expires_at?: Epoch;
}

// ------------------------------------------------------------------ providers
export const PROVIDER_STATES = [
  'Not Connected',
  'Connect',
  'Connected (Subscription)',
  'Connected (API Billing)',
  'Connected (Local)',
  'Quota Reached',
  'Re-auth Required',
  'Unsupported on this version',
  'Error',
] as const;

export interface Provider {
  id: string;
  adapter_type: string;
  display_name: string;
  state: string;
  auth_mode: string;
  capabilities: string[];
  config: Json;
  last_checked_at: Epoch | null;
  last_error: string | null;
  created_at: Epoch;
  updated_at: Epoch;
  has_credentials: boolean;
  usage_today: { input_tokens: number; output_tokens: number; requests: number };
  daily_token_cap: number | null;
}

export interface ProviderTestResult {
  provider_id: string;
  state: string;
  detail: string;
  billing: string;
  capabilities: string[];
  account: Json;
  plan?: Json;
}

export interface SiwcStart {
  provider_id: string;
  next: string;
  authorize_url: string;
  redirect_uri: string;
  expires_in: number;
  state: string;
}

export interface ModelInfo {
  id: string;
  display_name: string;
  supports_tools: boolean;
  supports_images: boolean;
  context_tokens: number | null;
}

export interface ConnectBody {
  api_key?: string;
  base_url?: string;
  billing_note?: string;
}

// ------------------------------------------------------------------ telegram
export interface TelegramUser {
  id: string;
  telegram_user_id: number;
  chat_id: number;
  username: string | null;
  display_name: string | null;
  status: 'pending' | 'approved' | 'revoked' | string;
  permissions: string[];
  selected_agent_id: string | null;
  pairing_id: string | null;
  approved_at: Epoch | null;
  created_at: Epoch;
  /** True for the approved account the owner designated as their own (the main bot's owner). */
  owner?: boolean;
}

export interface TelegramTopic {
  id: string;
  agent_id: string;
  telegram_chat_id: number;
  message_thread_id: number | null;
  mapping_type: 'private_topic' | 'supergroup_topic' | 'command_fallback' | string;
  topic_name: string | null;
  archived: boolean;
  created_at: Epoch;
}

export interface TelegramStatus {
  enabled: boolean;
  configured: boolean;
  polling: boolean;
  bot_username: string | null;
  bot_id: number | null;
  topics_mode: string;
  has_topics_enabled: boolean | null;
  update_offset: number;
  last_poll_at: Epoch | null;
  last_error: string | null;
  users: TelegramUser[];
  topics: TelegramTopic[];
  note: string;
  /** The owner's Telegram account while it is approved (null: no Telegram owner, e.g. after revoking it). */
  owner_telegram_user_id?: number | null;
  /** The account the owner designated, even when its pairing is revoked now. */
  designated_owner_telegram_user_id?: number | null;
}

export interface TelegramPairing {
  pairing_id: string;
  code: string;
  expires_at: Epoch;
  deep_link: string | null;
  instructions: string;
}

export interface TelegramTest {
  ok: boolean;
  bot: {
    id: number;
    username: string | null;
    first_name: string | null;
    has_topics_enabled: boolean;
    allows_users_to_create_topics: boolean;
  };
}

// ------------------------------------------------------------------ settings
export interface AgentsConfig {
  default_active_limit: number;
  default_desktop: string;
  resource_policy: 'queue_when_full' | 'sleep_lru' | string;
  require_approval_for_sensitive_actions: boolean;
  max_steps_per_task: number;
  screenshot_retention_days: number;
  min_host_free_mb_for_new_desktop: number;
}

export interface NebulaConfigView {
  instance: Json;
  vm: Json;
  agents: AgentsConfig;
  live: Json;
  telegram: Json;
  providers: Json;
  security: Json;
}

export interface SettingsResponse {
  config: NebulaConfigView;
  permission_levels: Record<string, string[]>;
}

export interface SettingsPatch {
  require_approval_for_sensitive_actions?: boolean;
  default_active_limit?: number;
  screenshot_retention_days?: number;
  resource_policy?: 'queue_when_full' | 'sleep_lru';
  max_steps_per_task?: number;
}

// ------------------------------------------------------------------ events (SSE)
export interface NebulaEvent<P extends Json = Json> {
  id: string;
  sequence: number;
  type: string;
  agent_id: string | null;
  task_id: string | null;
  timestamp: Epoch;
  payload: P;
}


// ---------------------------------------------------------------- LAN access
export interface LanAddress {
  iface: string;
  ip: string;
  network: string;
  http_url: string;
  https_url: string | null;
}

export interface LanStatus {
  enabled: boolean;
  https: boolean;
  port: number;
  https_port: number;
  addresses: LanAddress[];
  mdns_name: string | null;
  mdns_urls: string[];
  listening: { url: string; running: boolean }[];
  last_error: string | null;
  ca: { sha256: string; subject: string } | null;
  loopback_url: string;
  this_request?: { host: string; scheme: string; client: string | null; via_loopback: boolean };
}

// =================================================================== NEBULA V2
// ------------------------------------------------------------------ memory (module 1)
export const MEMORY_KINDS = ['fact', 'note', 'decision', 'preference', 'episode', 'project'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];
export type MemoryTrust = 'owner' | 'agent' | 'system' | 'web';

/** Row of agent_memory. List responses carry every column; search hits omit shared_with / expires_at and add `score`. */
export interface MemoryEntry extends MemoryItem {
  agent_id: string;
  kind: MemoryKind | string;
  scope: 'private' | 'shared' | string;
  shared_with?: string[];
  project: string | null;
  importance: number;
  pinned: boolean;
  trust: MemoryTrust | string;
  use_count: number;
  last_used_at?: Epoch | null;
  created_at: Epoch | null;
  score?: number;
}

export interface MemoryBody {
  key: string;
  value: string;
  kind: MemoryKind;
  tags: string;
  importance: number;
  pinned: boolean;
  project: string | null;
  scope: 'private' | 'shared';
  shared_with: string[];
}

export type MemoryPatch = Partial<MemoryBody>;

export interface SemanticStatus {
  enabled: boolean;
  model: string | null;
  fallback: string;
  configured?: { enabled?: boolean; model?: string };
  model_installed?: boolean;
}

export interface MemoryStats {
  total: number;
  bytes: number;
  oldest: Epoch | null;
  newest: Epoch | null;
  pinned: number;
  shared: number;
  quarantined: number;
  by_kind: Record<string, number>;
  cap: number;
  auto_save: boolean;
  semantic: SemanticStatus;
}

// ------------------------------------------------------------------ teams (module 2)
export type TeamMode = 'sequential' | 'parallel';

export interface TeamMember {
  team_id?: string;
  agent_id: string;
  role: string;
  instructions: string;
  position: number;
  agent_name?: string;
  agent_status?: string;
  permission_level?: string;
}

export interface Team {
  id: string;
  name: string;
  description: string;
  lead_agent_id: string | null;
  mode: TeamMode | string;
  max_delegation_depth: number;
  max_subtasks: number;
  share_memory: boolean;
  shared_dir: string | null;
  shared_path: string | null;
  created_at: Epoch;
  updated_at: Epoch;
  members: TeamMember[];
  last_run?: { id: string; state: string; created_at: Epoch } | null;
}

export interface TeamBody {
  name: string;
  description: string;
  lead_agent_id: string | null;
  mode: TeamMode;
  max_delegation_depth: number;
  max_subtasks: number;
  share_memory: boolean;
  members: { agent_id: string; role: string; instructions: string; position: number }[];
}

export interface Artifact {
  type: string;
  value: string;
}

export interface TeamSubtask {
  id: string;
  run_id: string;
  /** null = pipeline step, "lead" = lead's own step, "aggregate" = lead review step, otherwise the delegating subtask id */
  parent_subtask_id: string | null;
  agent_id: string;
  agent_name?: string;
  role: string;
  title: string;
  prompt: string;
  depends_on: string[];
  state: string; // PENDING READY RUNNING COMPLETED FAILED SKIPPED CANCELLED
  task_id: string | null;
  attempts: number;
  max_attempts: number;
  depth: number;
  result_summary: string | null;
  artifacts: Artifact[];
  created_at: Epoch;
  updated_at: Epoch;
}

export interface AgentMessage {
  id: string;
  run_id: string | null;
  from_agent_id: string | null;
  to_agent_id: string | null;
  kind: 'handoff' | 'delegate' | 'result' | 'failure' | 'review' | 'system' | string;
  content: string;
  payload: Json | null;
  created_at: Epoch;
}

export interface TeamRunSummary {
  id: string;
  team_id: string;
  team_name?: string;
  prompt: string;
  state: string; // RUNNING COMPLETED FAILED CANCELLED
  source: string;
  reply_target?: Json | null;
  parent_ref?: Json | null;
  origin_depth?: number;
  max_model_calls: number | null;
  result: { summary?: string; artifacts?: Artifact[]; shared_path?: string | null; subtasks?: { role: string; state: string; task_id: string | null }[] } | null;
  error: string | null;
  created_at: Epoch;
  updated_at: Epoch;
  finished_at: Epoch | null;
}

export interface TeamRun extends TeamRunSummary {
  subtasks: TeamSubtask[];
  messages: AgentMessage[];
}

// ------------------------------------------------------------------ schedules (module 3)
export type ScheduleKind = 'once' | 'interval' | 'daily' | 'weekly' | 'monthly' | 'cron';
export type ScheduleTarget = 'agent' | 'team' | 'workflow';

export interface ScheduleSpec {
  at?: Epoch;
  every_s?: number;
  start_at?: Epoch;
  time?: string;
  weekdays?: number[];
  day?: number;
  cron?: string;
}

export interface ScheduleRun {
  id: string;
  schedule_id: string;
  schedule_name?: string;
  scheduled_for: Epoch;
  attempt: number;
  trigger: 'timer' | 'manual' | 'retry' | 'misfire' | string;
  state: string; // RUNNING COMPLETED FAILED SKIPPED AWAITING_CONFIRMATION CANCELLED
  target_ref: { task_id?: string; team_run_id?: string; workflow_run_id?: string } | null;
  detail: string | null;
  started_at: Epoch | null;
  finished_at: Epoch | null;
  created_at: Epoch;
}

export interface Schedule {
  id: string;
  name: string;
  target_type: ScheduleTarget;
  target_id: string;
  target_name?: string | null;
  prompt: string;
  kind: ScheduleKind;
  spec: ScheduleSpec;
  timezone: string;
  enabled: boolean;
  misfire_policy: 'skip' | 'run_once' | 'ask';
  overlap_policy: 'skip' | 'queue';
  retry_max: number;
  retry_delay_s: number;
  max_runtime_s: number;
  max_model_calls: number;
  notify: { telegram?: boolean };
  next_run_at: Epoch | null;
  last_run_at: Epoch | null;
  created_at: Epoch;
  updated_at: Epoch;
  last_run?: ScheduleRun | null;
}

export interface ScheduleDetail extends Schedule {
  runs: ScheduleRun[];
}

export interface ScheduleBody {
  name: string;
  target_type: ScheduleTarget;
  target_id: string;
  prompt: string;
  kind: ScheduleKind;
  spec: ScheduleSpec;
  timezone: string;
  enabled: boolean;
  misfire_policy: 'skip' | 'run_once' | 'ask';
  overlap_policy: 'skip' | 'queue';
  retry_max: number;
  retry_delay_s: number;
  max_runtime_s: number;
  max_model_calls: number;
  notify: { telegram: boolean };
}

// ------------------------------------------------------------------ workflows (summary only; the editor lives in features/workflows)
export interface WorkflowSummary {
  id: string;
  name: string;
  description: string;
  version: number;
  enabled: boolean;
  trigger_types: string[];
  max_runs_per_hour: number;
  created_at: Epoch;
  updated_at: Epoch;
  last_run?: { id: string; state: string; created_at: Epoch } | null;
}

export interface WorkflowRunSummary {
  id: string;
  workflow_id: string;
  state: string;
  trigger: string;
  created_at: Epoch;
  finished_at: Epoch | null;
  error: string | null;
  workflow_version: number;
}

// ------------------------------------------------------------------ owner approvals (automation)
export interface OwnerApproval {
  id: string;
  kind: 'workflow' | 'command' | 'schedule_misfire' | 'package_install' | 'plugin' | string;
  ref: Json;
  summary: string;
  preview: Json | null;
  decision: 'approved' | 'denied' | 'expired' | null;
  resolved_by: string | null;
  created_at: Epoch;
  expires_at: Epoch;
  resolved_at: Epoch | null;
}

// ------------------------------------------------------------------ skills & plugins (module 9)
export interface PluginToolManifest {
  name: string;
  description?: string;
  parameters?: Json;
}

export interface SkillManifest {
  schema_version?: number;
  id?: string;
  name?: string;
  version?: string;
  description?: string;
  /** built-ins list tool wire names; plugins list tool objects */
  tools?: (string | PluginToolManifest)[];
  permissions?: { min_level?: string; levels?: Record<string, string>; risk_categories?: string[] };
  dependencies?: { guest?: string[]; nebula?: string };
  security?: { runs_in?: string; approvals?: string; network?: boolean; side_effects?: boolean };
  entrypoint?: string;
  timeout_s?: number;
  config_schema?: Json;
  [k: string]: unknown;
}

export interface Skill {
  id: string;
  name: string;
  version: string;
  description: string;
  kind: 'builtin' | 'plugin' | string;
  manifest: SkillManifest;
  enabled: boolean;
  checksum: string | null;
  installed_at: Epoch;
  updated_at: Epoch;
  assigned_agents: number;
  usage_count: number;
}

export interface SkillUsage {
  id: number;
  skill_id: string;
  agent_id: string | null;
  task_id: string | null;
  tool: string;
  status: string;
  ts: Epoch;
}

export interface SkillDetail extends Skill {
  usage: SkillUsage[];
}

export interface AgentSkill extends Skill {
  assigned: boolean;
  config: Json;
  explicit: boolean;
}

export interface SkillCompatibility {
  capabilities: Record<string, unknown>;
  skills: Record<string, { ok: boolean; missing: string[] }>;
}

export interface PermissionMatrixTool {
  tool: string;
  description: string;
  min_level: string;
  levels: Record<string, boolean>;
  skills: string[];
  gui: boolean;
  side_effect: boolean;
  always_approve: boolean;
  approval_when: string;
}

export interface PermissionMatrix {
  levels: string[];
  tools: PermissionMatrixTool[];
  level_permissions: Record<string, string[]>;
  rules: string[];
}

// ------------------------------------------------------------------ resources (module 7)
export type ResourceProfile = 'ECO' | 'BALANCED' | 'PERFORMANCE';

export interface ResourceLimits {
  profile: ResourceProfile | string;
  max_active: number;
  idle_sleep_s: number;
  local_inference: number;
  cloud_inference: number;
  max_active_effective: number;
  constraints: string[];
  desktop_cost_mb: number;
  /** Host (Mac mini) tasks allowed at once right now (newer hosts). */
  host_tasks_effective?: number;
  /** Measured memory state behind the limits (newer hosts). */
  memory?: { pressure: string; free_percent: number | null; swap_growth_mb_2min: number | null };
}

export interface ResourceHost extends HostResources {
  cpu_percent: number | null;
  swap_used_mb: number | null;
  swap_total_mb: number | null;
  disk_free_gb: number | null;
  memory_used_percent: number | null;
}

export interface ResourceGuest {
  status: string;
  detail?: string;
  mem_total_mb?: number;
  mem_available_mb?: number;
  swap_free_mb?: number | null;
  loadavg?: number[] | null;
  uptime_s?: number | null;
}

export interface ResourceAgent {
  id: string;
  name: string;
  status: string;
  last_active_at: Epoch | null;
  resource_mode: string;
  memory_mb: number | null;
  units: unknown;
  busy: boolean;
}

export interface QueuedTask {
  id: string;
  agent_id: string;
  agent_name: string;
  priority: number;
  created_at: Epoch;
  source_channel: string;
  prompt: string;
  waiting_for_resources: boolean;
}

export interface ResourceSnapshot {
  ts: Epoch;
  host: ResourceHost;
  guest: ResourceGuest;
  agents: ResourceAgent[];
  queue: QueuedTask[];
  active_workers: number;
  inference_inflight: { local: number; cloud: number };
  limits: ResourceLimits;
}

export interface ResourceSample {
  ts: Epoch;
  host_mem_used_pct: number | null;
  host_pressure: string | null;
  host_cpu_pct: number | null;
  host_swap_used_mb: number | null;
  disk_free_gb: number | null;
  vm_rss_mb: number | null;
  /** VM memory footprint (null for samples recorded by older hosts). */
  vm_footprint_mb?: number | null;
  host_free_pct?: number | null;
  swap_growth_mb?: number | null;
  guest_mem_avail_mb: number | null;
  guest_load1: number | null;
  active_agents: number | null;
  queued_tasks: number | null;
  profile: string | null;
}

// ------------------------------------------------------------------ voice (Telegram speech-to-text)
export interface VoiceStatus {
  backend: 'whisper_cpp' | 'openai' | null;
  local: { binary: string | null; model: string | null; ffmpeg: boolean };
  cloud: { provider_connected: boolean; consent: boolean; model: string };
  setup_hint: string | null;
}

export interface VoicePatch {
  cloud_consent?: boolean;
  cloud_model?: string;
  language?: string;
}

// ------------------------------------------------------------------ overview / command center
export interface OverviewData {
  agents: { id: string; name: string; status: string; provider_id: string | null; model_id: string | null; last_active_at: Epoch | null }[];
  running_tasks: { id: string; agent_id: string; state: string; prompt: string; current_step: number; started_at: Epoch | null; source_channel: string; agent_name: string }[];
  recent_results: { id: string; agent_id: string; state: string; prompt: string; failure_reason: string | null; finished_at: Epoch | null; agent_name: string; summary: string }[];
  active_team_runs: { id: string; team_id: string; state: string; prompt: string; created_at: Epoch; team_name: string }[];
  upcoming_schedules: { id: string; name: string; next_run_at: Epoch; target_type: ScheduleTarget }[];
  providers: { id: string; display_name: string; state: string; auth_mode: string }[];
  approvals_pending: number;
  workflow_runs_active: number;
  recent_events: Omit<NebulaEvent, 'id'>[];
  resources: {
    host: ResourceHost | null;
    guest: ResourceGuest | null;
    limits: ResourceLimits;
    active_workers: number;
    queue_length: number;
  };
  telegram: { polling: boolean };
}
