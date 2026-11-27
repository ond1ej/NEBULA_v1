// Wire types used only by the Mini App (V3 endpoints of routes_v3.py, companies.py, environments.py).
// Kept local so the Mini App does not depend on dashboard feature modules that evolve independently.
import type { Epoch, Json } from '../types';
import type { SignInItem } from '../features/smartauth/core/types';

export type MiniRole = 'owner' | 'operator' | 'agent_bot';

export interface MiniMe {
  mode?: 'telegram' | 'dashboard';
  username?: string;
  session_id?: string;
  telegram_user_id?: number;
  bot?: string | null;
  permissions: string[];
  expires_in?: number;
  public_url?: string | null;
  /** V3.3: who this session belongs to. */
  role?: MiniRole;
  /** V3.3: true only for the main bot's owner — full administration (the Dashboard's pages) in the Mini App. */
  admin?: boolean;
  /** V3.3: until when sensitive actions need no new confirmation (unix seconds). */
  assurance?: { fresh_until: number | null };
}

/** GET /auth/assurance */
export interface Assurance {
  interface: 'local' | 'miniapp' | 'app';
  role: MiniRole | string;
  fresh_until: number | null;
  /** True while sensitive actions need no new confirmation (always on the Mac itself). */
  fresh?: boolean;
  methods: {
    password: boolean;
    biometric: { enrolled: boolean; devices: BiometricDevice[] };
    /** V4.0: the vault passphrase confirms the owner (and unlocks the vault) in one step. */
    vault_passphrase?: boolean;
  };
  /** V4.0: the Password Vault as this session sees it (reveal / export need `reauth_until` in the future). */
  vault?: { exists: boolean; locked: boolean; reauth_until: number | null };
}

export interface BiometricDevice {
  id: string;
  name: string;
  created_at: number;
  last_used_at: number | null;
  /** V4.0: the vault key is wrapped for this device — one Face ID unlocks the vault too. */
  vault_key?: boolean;
}

export type ExecEnv = 'host' | 'vm';

export interface EnvEffective {
  env: ExecEnv;
  root_id: string | null;
  source: string;
  label: string;
  chain: { level: string; env: string }[];
}

export interface AgentEnvironment {
  agent_id: string;
  effective: EnvEffective;
  root: { id: string; name?: string; path?: string; mode?: string } | null;
  tools: string[];
  skills_unavailable_here: string[];
  problems: string[];
  live_desktop: boolean;
}

export interface AgentVoice {
  reply_mode: 'text' | 'voice' | 'text_voice' | 'auto' | string;
  provider: string;
  voice: string | null;
  language: string;
  rate: number;
}

export interface AttachmentTranscript {
  ok: boolean;
  text?: string;
  error?: string;
  backend?: string;
  language?: string | null;
}

export interface Attachment {
  id: string;
  name: string;
  kind: string;
  mime: string;
  size: number;
  status: string;
  error?: string | null;
  created_at: Epoch;
  /** Server-side extraction (text excerpt, media metadata, speech-to-text transcript when configured). */
  extracted?: { transcript?: AttachmentTranscript; [k: string]: unknown } | null;
}

// ---------------------------------------------------------------- companies
export interface CompanySummary {
  id: string;
  name: string;
  description: string;
  objective: string;
  industry: string;
  default_environment: ExecEnv;
  status: string;
  member_count: number;
  project_count: number;
  active_runs: number;
  budget: { max_model_calls_per_run?: number; max_model_calls_total?: number | null };
  created_at: Epoch;
  updated_at: Epoch;
}

export interface CompanyMember {
  agent_id: string;
  agent_name: string;
  agent_status: string;
  role_key: string;
  role_title: string;
  title: string | null;
  reports_to: string | null;
  provider_id: string | null;
  model_id: string | null;
  environment_effective: EnvEffective;
  lifecycle: string;
  current_item: { id: string; title: string; state: string; run_id: string } | null;
}

export interface CompanyProject {
  id: string;
  company_id: string;
  name: string;
  description: string;
  objective: string;
  status: string;
  environment: ExecEnv | null;
  host_root_id: string | null;
  created_at: Epoch;
}

export interface CompanyRunRef {
  id: string;
  state: string;
  project_id: string;
  created_at: Epoch;
}

export interface CompanyApproval {
  id: string;
  kind: string;
  summary: string;
  ref: Json;
  created_at: Epoch;
  expires_at: Epoch;
}

export interface CompanyDetail extends CompanySummary {
  ceo_agent_id: string | null;
  approval_policy: { plan_approval?: boolean; ceo_review?: boolean; external_actions?: string };
  resource_policy: { max_parallel?: number };
  roles: { key: string; title: string; stage: number }[];
  members: CompanyMember[];
  projects: CompanyProject[];
  recent_runs: CompanyRunRef[];
  stats: { members: number; projects: number; running_items: number; open_items: number; runs_active: number; model_calls_used: number };
  pending_approvals: CompanyApproval[];
}

export interface OrgNode {
  agent_id: string;
  name: string;
  role_key: string;
  role: string;
  title: string | null;
  reports_to: string | null;
  model: string | null;
  provider: string | null;
  status: string;
  lifecycle: string;
  environment: EnvEffective;
  current_item: { id: string; title: string; state: string; run_id: string } | null;
}

export interface CompanyOrg {
  company_id: string;
  nodes: OrgNode[];
}

export interface CompanyActivity {
  id: number;
  company_id: string;
  project_id: string | null;
  run_id: string | null;
  agent_id: string | null;
  kind: string;
  content: string;
  ts: Epoch;
}

export interface WorkItem {
  id: string;
  run_id: string;
  kind: string;
  title: string;
  role_key: string | null;
  agent_id: string | null;
  agent_name: string | null;
  state: string;
  priority: number;
  environment: string | null;
  task_id: string | null;
  attempts: number;
  max_attempts: number;
  result_summary: string | null;
  depends_on: string[] | null;
  started_at: Epoch | null;
  finished_at: Epoch | null;
}

export interface CompanyRun {
  id: string;
  company_id: string;
  project_id: string;
  objective: string;
  state: string;
  planner: string;
  source: string;
  max_model_calls: number;
  model_calls_used: number;
  result: Json | null;
  error: string | null;
  created_at: Epoch;
  finished_at: Epoch | null;
  items: WorkItem[];
  activity: CompanyActivity[];
}

// ---------------------------------------------------------------- approval center & notifications
export interface CenterTaskApproval {
  kind: 'task';
  id: string;
  task_id: string;
  agent_id: string;
  agent_name: string;
  tool: string;
  action_summary: string;
  /** Structured preview (vault_sign_in: VaultSignInPreview). Rendered only through a whitelist. */
  action_preview?: Json | null;
  reason: string | null;
  prompt: string;
  environment: string;
  created_at: Epoch;
  expires_at: Epoch;
}

export interface CenterOwnerApproval {
  kind: string;
  id: string;
  summary: string;
  ref: Json;
  preview: Json | null;
  created_at: Epoch;
  expires_at: Epoch;
}

export type CenterApproval = CenterTaskApproval | CenterOwnerApproval;

export interface ApprovalCenter {
  pending: CenterApproval[];
  /** NEBULA 3.2.1: active Smart Authentication sessions (the same objects as GET /smart-auth/sessions). */
  sign_ins?: SignInItem[];
  recent: { id: string; tool: string; decision: string; resolved_by: string | null; resolved_at: Epoch | null; action_summary: string }[];
}

export interface MiniNotification {
  id: string;
  sequence: number;
  type: string;
  agent_id: string | null;
  task_id: string | null;
  agent_name: string | null;
  timestamp: Epoch;
  payload: {
    reason?: string;
    summary?: string;
    state?: string;
    company?: string;
    project?: string;
    run_id?: string;
    approval_id?: string;
    kind?: string;
    message?: string;
    level?: string;
    status?: string;
    tool?: string;
    /** auth.request (Smart Authentication): metadata only. */
    session_id?: string;
    site?: string;
    agent_name?: string;
  };
}

export const isTaskApproval = (a: CenterApproval): a is CenterTaskApproval => a.kind === 'task';

// ---------------------------------------------------------------- conversations (V3.2)
export type MessageRole = 'user' | 'assistant' | 'system';

export interface ConversationPreview {
  role: MessageRole | string;
  content: string;
  created_at: Epoch;
}

export interface Conversation {
  id: string;
  agent_id: string;
  agent_name: string;
  agent_status: string;
  title: string;
  created_at: Epoch;
  updated_at: Epoch;
  last_message_at: Epoch | null;
  last_message: ConversationPreview | null;
  unread_count: number;
  archived: boolean;
  is_default: boolean;
  running_task: { id: string; state: string } | null;
}

export interface MessageTask {
  id: string;
  state: string;
  started_at: Epoch | null;
  finished_at: Epoch | null;
  failure_reason: string | null;
}

/** Attachment reference inside a message: an uploaded attachment, or an artifact ref (task screenshots). */
export type MessageAttachment = string | (Partial<Attachment> & { id?: string });

export interface Message {
  id: string;
  conversation_id: string;
  agent_id: string;
  task_id: string | null;
  role: MessageRole | string;
  channel: string;
  content: string;
  attachments: MessageAttachment[];
  created_at: Epoch;
  client_id: string | null;
  task: MessageTask | null;
}

export interface MessagePage {
  items: Message[];
  has_more: boolean;
}

export interface SendMessageResult {
  message: Message;
  task: { id: string; state: string; started_at?: Epoch | null; finished_at?: Epoch | null; failure_reason?: string | null } | null;
}

export interface SearchHit {
  message_id: string;
  conversation_id: string;
  agent_id: string;
  agent_name: string;
  role: string;
  snippet: string;
  created_at: Epoch;
}

export interface SearchResult {
  conversations: Conversation[];
  messages: SearchHit[];
}

// ---------------------------------------------------------------- voice
export interface SttStatus {
  backend: 'whisper_cpp' | 'openai' | string | null;
  setup_hint?: string | null;
  language?: string;
}

export interface VoiceOverview {
  stt: SttStatus;
  tts: { provider?: string; available?: boolean; [k: string]: unknown };
}

// ---------------------------------------------------------------- Password Vault (metadata only — never a secret)
export interface VaultStatus {
  exists: boolean;
  locked: boolean;
  entry_count: number;
  auto_lock_minutes: number | null;
  unlocked_at: Epoch | null;
  lock_at: Epoch | null;
  broker: { enabled: boolean; available: boolean; reason: string | null };
  management_local: boolean;
}

export type CredentialType = 'website' | 'application' | 'api_token';

export interface VaultEntry {
  id: string;
  display_name: string;
  app_name: string | null;
  origin: string | null;
  credential_type: CredentialType | string;
  tags: string[];
  created_at: Epoch;
  updated_at: Epoch;
  grant_count: number;
}

export interface VaultAuditRow {
  id: string;
  ts: Epoch;
  actor_type: string;
  actor_id: string | null;
  agent_id: string | null;
  agent_name: string | null;
  entry_id: string | null;
  entry_name: string | null;
  operation: string;
  destination_origin: string | null;
  approval_id: string | null;
  outcome: string;
  reason_code: string | null;
}

export type ApprovalPolicy = 'always_ask' | 'once_per_task' | 'auto';

export interface VaultGrant {
  id: string;
  entry_id: string;
  entry_name: string;
  credential_type: CredentialType | string;
  allowed_origins: string[];
  allowed_actions: string[];
  approval_policy: ApprovalPolicy | string;
  enabled: boolean;
  expires_at: Epoch | null;
  created_at: Epoch;
  last_used_at: Epoch | null;
}

export interface AgentVault {
  agent_id: string;
  mode: 'NONE' | 'SELECTED' | 'MANAGED' | string;
  managed_tags: string[];
  grants: VaultGrant[];
  recent: VaultAuditRow[];
}

export interface VaultSignInPreview {
  kind: 'vault_sign_in';
  agent_name: string;
  credential_name: string;
  origin: string;
  operation: string;
  task_id: string;
  expires_at: Epoch | null;
}

// ---------------------------------------------------------------- misc read-only lists
export interface HostRoot {
  id: string;
  name?: string;
  path?: string;
  mode?: string;
  [k: string]: unknown;
}
