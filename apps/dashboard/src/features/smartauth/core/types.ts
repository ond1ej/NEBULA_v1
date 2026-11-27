// Wire types of NEBULA Smart Authentication (routes_v321.py, smart_auth.py `public` / `_public_request`; V3.3 state
// machine, trust and multi-step flows; V3.4 universal step states, notes, authenticator numbers, diagnostics). Shared
// by the Mini App and the Dashboard.
// Nothing here is ever a secret: typed values, submission tokens, the remote PIN and the vault passphrase live only in
// component state of <SmartAuthRequest> and in the request body of one POST.
import type { Epoch } from '../../../types';

/** Session states (persisted for the whole sign-in, across navigations and reloads). V3.4: identifier states by what the
 * page asks, AUTHENTICATOR_APPROVAL (was DEVICE_APPROVAL_REQUIRED), SECURITY_KEY_REQUIRED, LOGIN_ERROR, UNKNOWN_STEP. */
export type AuthState =
  | 'INITIALIZING'
  | 'IDENTIFIER_REQUIRED'
  | 'EMAIL_REQUIRED'
  | 'USERNAME_REQUIRED'
  | 'PHONE_REQUIRED'
  | 'PASSWORD_REQUIRED'
  | 'IDENTIFIER_AND_PASSWORD_REQUIRED'
  | 'OTP_REQUIRED'
  | 'AUTHENTICATOR_APPROVAL'
  | 'PASSKEY_REQUIRED'
  | 'SECURITY_KEY_REQUIRED'
  | 'CAPTCHA_REQUIRED'
  | 'REDIRECT_REVIEW_REQUIRED'
  | 'LOGIN_ERROR'
  | 'UNKNOWN_STEP'
  | 'WAITING_FOR_USER'
  | 'SUBMITTING'
  | 'VERIFYING'
  | 'AUTHENTICATED'
  | 'FAILED'
  | 'CANCELLED'
  | 'EXPIRED';

/** Names of older hosts / stored data, read as their V3.4 state (state.ts `normalizeState`). */
export type LegacyAuthState = 'DEVICE_APPROVAL_REQUIRED';

export type FieldRole = 'email' | 'phone' | 'username' | 'username_or_email' | 'password' | 'otp' | 'recovery_code';

export interface AuthField {
  id: string;
  role: FieldRole;
  input: 'email' | 'tel' | 'text' | 'password' | 'code';
  length: number | null;
  charset: 'numeric' | 'alphanumeric' | null;
  /** OTP split into boxes on the page: the value is still ONE string. */
  ids?: string[];
}

export interface AuthAccount {
  entry_id: string;
  name: string;
  /** Only while the vault is unlocked (and on this Mac or after a fresh confirmation). */
  username: string | null;
  has_grant: boolean;
  policy?: string | null;
}

export type TrustLevel = 'GREEN' | 'YELLOW' | 'RED';

/** How much NEBULA trusts the page / destination (auth_trust.py). `text` is NEBULA's fixed wording, never page text. */
export interface AuthTrust {
  level: TrustLevel;
  reasons: { code: string; text: string }[];
  /** A verified sign-in provider relationship (e.g. "Microsoft"), else null. */
  provider: string | null;
  /** Transport / exfiltration findings the owner cannot override. */
  hard: boolean;
}

/** Other ways to sign in the page offers. Kinds only — the page's own button text is never shown. */
export type AltKind = 'password' | 'code' | 'app' | 'more';

export type AuthRequestType =
  | 'credentials'
  | 'otp'
  | 'recovery_code'
  | 'confirm_destination'
  | 'device_approval'
  | 'manual'
  | 'method_choice'
  | 'loop';

export type SaveIntent = 'once' | 'vault';

/** Fixed codes of what NEBULA did by itself on the page (V3.4); unknown codes are ignored. */
export type AuthNote =
  | 'passkey_cancelled'
  | 'security_key_cancelled'
  | 'chose_password'
  | 'opened_other_ways'
  | 'declined_kmsi'
  | 'declined_nag'
  | 'declined_prompt'
  | 'restarted_from_service'
  | 'restarted_at_provider'
  | 'approval_number_hidden';

export type ManualKind = 'captcha' | 'passkey' | 'security_key' | 'unknown' | 'unconfirmed' | 'manual' | 'interstitial' | 'embedded_login' | 'new_password';

export interface AuthManual {
  kind: ManualKind | string;
  live_desktop: true;
  /** False for a passkey / security key: NEBULA's isolated browser has neither, so it never finishes there. */
  can_complete_here?: boolean;
  /** The page's passkey / security key prompt is still open. */
  webauthn_pending?: boolean;
}

export interface AuthVaultInfo {
  state: 'not_created' | 'locked' | 'unlocked';
  can_save: boolean;
  /** The owner may unlock it right here (POST /vault/unlock). */
  can_unlock?: boolean;
  /** Why saving / saved accounts are not possible right now (null when they are). */
  reason?: string | null;
}

export interface AuthRequest {
  id: string;
  type: AuthRequestType;
  seq: number;
  expires_at: Epoch;
  step: string | null;
  fields: AuthField[];
  otp: { channel: 'sms' | 'email' | 'totp' | 'unknown'; length: number | null; charset: 'numeric' | 'alphanumeric' } | null;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | null;
  flags: string[];
  review_required: boolean;
  /** Why this step is shown again: the page rejected the details / code, changed, or did not react. */
  error: 'credentials_rejected' | 'code_rejected' | 'page_changed' | 'no_progress' | string | null;
  /** V3.4: the state of what the page asks right now (e.g. PASSWORD_REQUIRED while the session is in LOGIN_ERROR). */
  requirement?: AuthState | null;
  /** V3.4: what NEBULA did by itself on the page (fixed codes). */
  notes?: (AuthNote | string)[];
  trust?: AuthTrust | null;
  alternatives?: AltKind[];
  /** The origin of the page that asks (the verified one). */
  page_origin?: string | null;
  vault: AuthVaultInfo;
  /** The save choice of this sign-in so far ("vault" once the owner chose to save on an earlier step). */
  save_intent?: SaveIntent;
  local: boolean;
  /** On this Mac, or the owner confirmed it's them within the last minutes (step-up): no remote PIN then. */
  fresh?: boolean;
  remote_submission: boolean;
  pin_configured: boolean;
  pin_locked_until: Epoch | null;
  /** Empty when local or fresh. Remote: "credentials" | "saved_without_grant" | "save_to_vault" | "code" | "allow_destination_with_secrets". */
  pin_required_for: string[];
  /** Granting future use changes vault permissions: offered to the owner only. */
  allow_future_available?: boolean;
  /** Granting future use from here first needs a fresh owner confirmation (Face ID / NEBULA password). */
  allow_future_needs_stepup?: boolean;
  accounts?: AuthAccount[];
  destination?: { origin: string; kind: 'redirect' | 'form_target'; same_site: boolean; requested_origin: string; secrets_pending: boolean };
  manual?: AuthManual;
  /** type "device_approval": the number to enter in the authenticator app (2–3 digits), when the page shows one. */
  approval_number?: string | null;
  /** type "loop": automatic submission stopped. */
  loop?: { reason: 'no_progress' | 'too_many_steps' | string; page_step: string | null };
  code_ttl_s?: number | null;
}

export interface AuthHistoryStep {
  step: string | null;
  origin: string | null;
  error: string | null;
  trust: TrustLevel | null;
  at: Epoch | null;
}

/** Structural facts of a session event (step.*, detection.*, origin.*, success.*, stopped): never a value or page text. */
export interface AuthEventMeta {
  step?: string;
  from_step?: string;
  origin?: string;
  from_origin?: string;
  step_id?: number | string;
  confidence?: string;
  diag?: Record<string, unknown>;
  evidence?: string | string[];
  auto?: string[];
  reason?: string;
  [key: string]: unknown;
}

export interface AuthSessionEvent {
  type: string;
  ts: Epoch;
  outcome: string | null;
  meta?: AuthEventMeta;
}

export interface AuthSession {
  id: string;
  state: AuthState;
  agent_id: string;
  agent_name: string;
  task_id: string;
  conversation_id: string | null;
  requested_origin: string;
  verified_origin: string | null;
  site: string;
  allowed_origins: string[];
  step: string | null;
  /** Sequence number of the newest request of this session (grows with every new step). */
  step_seq: number;
  confidence: string | null;
  flags: string[];
  auth_method: string | null;
  error_code: string | null;
  created_at: Epoch;
  updated_at: Epoch;
  expires_at: Epoch;
  completed_at: Epoch | null;
  attempts: { credentials: number; codes: number; max_credentials: number; max_codes: number };
  saved_to_vault: boolean;
  trust?: AuthTrust | null;
  /** How many pages the sign-in went through. */
  steps_seen?: number;
  request: AuthRequest | null;
  /** Only on GET /smart-auth/sessions/{id}: the latest events (newest first, at most 40). */
  events?: AuthSessionEvent[];
  /** Only on GET /smart-auth/sessions/{id}: the last pages of the sign-in. */
  history?: AuthHistoryStep[];
}

/** An active sign-in as listed by GET /approval-center (`sign_ins`). */
export type SignInItem = AuthSession & { kind: 'sign_in' };

export interface SubmitToken {
  request_id: string;
  token: string;
  expires_at: Epoch;
}

export type SubmitAction =
  | 'credentials'
  | 'saved'
  | 'code'
  | 'allow_destination'
  | 'check'
  | 'manual_done'
  | 'choose'
  | 'handoff'
  | 'retry'
  | 'inspect';

export interface SubmitBody {
  request_id: string;
  token: string;
  action: SubmitAction;
  values?: Record<string, string>;
  entry_id?: string;
  /** Omitted: the session keeps its earlier choice. */
  save?: SaveIntent;
  allow_future?: boolean;
  name?: string;
  review_confirmed?: boolean;
  pin?: string;
  alternative?: AltKind;
}

/** The calls the owner form needs; each app provides them over its own HTTP client. */
export interface SmartAuthClient {
  token: (sessionId: string) => Promise<SubmitToken>;
  submit: (sessionId: string, body: SubmitBody) => Promise<AuthSession>;
  cancel: (sessionId: string) => Promise<AuthSession>;
  /** POST /vault/unlock — the inline "Unlock vault" of the save options (absent: not offered). */
  unlockVault?: (passphrase: string) => Promise<unknown>;
  /**
   * Makes sure the owner confirmed it's them recently (Mini App step-up) before an answer that changes vault
   * permissions; resolves false when the owner cancelled. Absent: nothing to confirm (Dashboard on this Mac).
   */
  ensureFresh?: () => Promise<boolean>;
  /**
   * V4.0, the owner on the phone: ONE confirmation (Face ID / the vault passphrase / the NEBULA password) that stands in
   * for the remote PIN, allows vault-permission changes and — with `unlockVault` — unlocks the vault in the same step.
   * Resolves false when the owner cancelled. When present, the form never asks for the remote PIN or a vault passphrase.
   */
  confirmOwner?: (opts: { unlockVault: boolean }) => Promise<boolean>;
}

export interface SmartAuthPinStatus {
  configured: boolean;
  set_at: Epoch | null;
  locked_until: Epoch | null;
}

export type PasskeyFallback = 'password' | 'ask';

export interface SmartAuthSettings {
  enabled: boolean;
  remote_submission: boolean;
  request_ttl_s: number;
  otp_ttl_s: number;
  token_ttl_s: number;
  max_retries: number;
  max_per_agent: number;
  max_global: number;
  max_credential_attempts: number;
  max_otp_attempts: number;
  session_max_s: number;
  /** Sign-in to IP addresses / local-network names (agents in the VM could serve those pages). */
  allow_local_network?: boolean;
  /** V3.3: how often an open request re-checks the page (s), the most pages per sign-in, the loop guard. */
  observe_interval_s?: number;
  max_steps?: number;
  loop_threshold?: number;
  /** V3.4: a passkey / security key request — pick the site's "use your password" option by itself, or ask first. */
  passkey_fallback?: PasskeyFallback;
  pin: SmartAuthPinStatus;
  /** False when this Dashboard is not opened on the NEBULA Mac. */
  local: boolean;
}

export type SmartAuthSettingsPatch = Partial<Omit<SmartAuthSettings, 'pin' | 'local'>>;

/** GET /smart-auth/trust: built-in sign-in providers, the owner's relationships and verified sites. */
export interface TrustProvider {
  id: string;
  name: string;
  sign_in_hosts: string[];
  services: string[];
}

export interface TrustRelationship {
  service: string;
  idp: string;
  first_party: boolean;
  added_at: Epoch | null;
}

export interface TrustSite {
  origin: string;
  added_at: Epoch | null;
}

export interface TrustConfig {
  builtin: TrustProvider[];
  relationships: TrustRelationship[];
  verified_sites: TrustSite[];
}

/** Payload of `auth.session.updated` / `auth.request` events (metadata only). */
export interface AuthEventPayload {
  session_id: string;
  state: AuthState;
  step: string | null;
  origin: string;
  site: string;
  agent_name: string;
  conversation_id: string | null;
  request_type: AuthRequestType | null;
  request_id: string | null;
  confidence: string | null;
  trust?: TrustLevel | null;
  error_code: string | null;
  expires_at: Epoch;
}
