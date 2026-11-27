// Wire types of the Password Vault API (apps/host-api/nebula_host/api/routes_v32.py, vault.py, vault_broker.py).
// Timestamps are epoch SECONDS. Metadata types never carry a secret; the only secret-bearing responses are
// `reveal` ({value}) and `export` (an encrypted blob), and those are never stored outside component state.
import type { Epoch } from '../../types';

export type CredentialType = 'website' | 'application' | 'api_token';
export type ApprovalPolicy = 'always_ask' | 'once_per_task' | 'auto';
export type AgentVaultMode = 'NONE' | 'SELECTED' | 'MANAGED';
export type RevealField = 'password' | 'username' | 'notes';

export const AUTO_LOCK_CHOICES = [5, 15, 30, 60] as const;
export type AutoLockMinutes = (typeof AUTO_LOCK_CHOICES)[number];

/** vault.py MIN_PASSPHRASE */
export const MIN_PASSPHRASE = 12;

export interface VaultKdf {
  alg: string | null;
  time_cost: number | null;
  memory_kib: number | null;
  parallelism: number | null;
  calibrated_ms: number | null;
}

export interface VaultBroker {
  enabled: boolean;
  available: boolean;
  reason: string | null;
  mechanism: string;
  environments: string[];
}

/** Owner settings of the vault (stored on the host, not secret). */
export interface VaultSettings {
  /** Vault management allowed from other devices over LAN HTTPS (default off). */
  allow_lan_https: boolean;
  /** Agent credential use through the sign-in broker (default on). */
  broker_enabled: boolean;
}

/** GET /vault/status */
export interface VaultStatus {
  exists: boolean;
  locked: boolean;
  entry_count: number;
  auto_lock_minutes: number;
  unlocked_at: Epoch | null;
  lock_at: Epoch | null;
  lockout_until: Epoch | null;
  /** Omitted for Mini App sessions. */
  kdf?: VaultKdf | null;
  broker: VaultBroker;
  /** False when this browser session may not manage the vault (remote / proxied / Mini App). */
  management_local: boolean;
  /** Absent on hosts before V3.2.1 (then: LAN management off, broker per `broker.enabled`). */
  settings?: VaultSettings;
}

/**
 * Status returned by create / unlock / rotate / settings. Current hosts return the full status; the extras are
 * optional so a response without them never wipes what the page already knows (it is merged into the status).
 */
export type VaultCoreStatus = Omit<VaultStatus, 'broker' | 'management_local' | 'settings'> &
  Partial<Pick<VaultStatus, 'broker' | 'management_local' | 'settings'>>;

/** GET /vault/entries: metadata only. */
export interface VaultEntry {
  id: string;
  display_name: string;
  app_name: string | null;
  origin: string | null;
  credential_type: CredentialType;
  tags: string[];
  created_at: Epoch;
  updated_at: Epoch;
  grant_count: number;
}

/** GET /vault/entries/{id}: metadata + username and flags (never the password or notes). */
export interface VaultEntryDetail extends Omit<VaultEntry, 'grant_count'> {
  grant_count?: number;
  username: string;
  has_password: boolean;
  has_notes: boolean;
  login_url: string;
}

export interface EntryBody {
  display_name: string;
  app_name?: string;
  origin?: string;
  credential_type: CredentialType;
  tags?: string[];
  username?: string;
  password?: string;
  notes?: string;
  login_url?: string;
}

export type EntryPatch = Partial<EntryBody>;

export interface VaultGrant {
  id: string;
  entry_id: string;
  entry_name: string | null;
  credential_type: CredentialType | null;
  agent_id: string;
  allowed_origins: string[];
  allowed_actions: string[];
  approval_policy: ApprovalPolicy;
  enabled: boolean;
  expires_at: Epoch | null;
  created_at: Epoch;
  last_used_at: Epoch | null;
}

export interface GrantBody {
  entry_id: string;
  allowed_origins?: string[];
  allowed_actions?: string[];
  approval_policy?: ApprovalPolicy;
  expires_at?: Epoch;
}

export interface GrantPatch {
  allowed_origins?: string[];
  approval_policy?: ApprovalPolicy;
  expires_at?: Epoch;
  clear_expiry?: boolean;
  enabled?: boolean;
}

/** Redacted audit row (GET /vault/audit, agent view `recent`). */
export interface VaultAuditRow {
  id: string;
  ts: Epoch;
  actor_type: 'owner' | 'agent' | 'system' | string;
  actor_id: string;
  agent_id: string | null;
  agent_name: string | null;
  entry_id: string | null;
  entry_name: string | null;
  task_id: string | null;
  operation: string;
  destination_origin: string | null;
  approval_id: string | null;
  outcome: string;
  reason_code: string | null;
}

/** GET/PUT /agents/{id}/vault */
export interface AgentVaultView {
  agent_id: string;
  mode: AgentVaultMode;
  managed_tags: string[];
  grants: VaultGrant[];
  recent: VaultAuditRow[];
}

/** POST /vault/export: encrypted with the export passphrase (AES-GCM, Argon2id key). */
export interface VaultExportFile {
  header: { format: string; version: number; created_at: Epoch; entry_count: number; kdf: Record<string, unknown> };
  nonce: string;
  ciphertext: string;
}
