// Test fixtures of Smart Authentication sessions (shared by the core, Mini App and Dashboard tests).
import type { AuthField, AuthRequest, AuthSession, AuthTrust } from './types';

export const NOW_S = () => Date.now() / 1000;

export const field = (over: Partial<AuthField> & Pick<AuthField, 'id' | 'role'>): AuthField => ({ input: 'text', length: null, charset: null, ...over });

export const GREEN: AuthTrust = { level: 'GREEN', reasons: [], provider: null, hard: false };
export const trust = (level: AuthTrust['level'], reasons: [string, string][] = [], provider: string | null = null): AuthTrust => ({
  level,
  reasons: reasons.map(([code, text]) => ({ code, text })),
  provider,
  hard: level === 'RED',
});

/** `fresh` follows `local` unless given (a remote request is not freshly confirmed by default). */
export function authRequest(over: Partial<AuthRequest> = {}): AuthRequest {
  const r: AuthRequest = {
    id: 'ar_1',
    type: 'credentials',
    seq: 1,
    expires_at: NOW_S() + 600,
    step: 'identifier_password',
    fields: [field({ id: 'f1', role: 'email', input: 'email' }), field({ id: 'f2', role: 'password', input: 'password' })],
    otp: null,
    confidence: 'HIGH',
    flags: [],
    review_required: false,
    error: null,
    trust: GREEN,
    alternatives: [],
    page_origin: 'https://github.com',
    vault: { state: 'unlocked', can_save: true, can_unlock: false, reason: null },
    save_intent: 'once',
    local: true,
    fresh: true,
    remote_submission: true,
    pin_configured: true,
    pin_locked_until: null,
    pin_required_for: [],
    allow_future_available: true,
    allow_future_needs_stepup: false,
    accounts: [],
    ...over,
  };
  if (over.fresh === undefined) r.fresh = r.local;
  return r;
}

export function authSession(over: Partial<AuthSession> = {}, req: Partial<AuthRequest> | null = {}): AuthSession {
  const t = NOW_S();
  return {
    id: 'as_0123456789abcdef01234567',
    state: 'IDENTIFIER_AND_PASSWORD_REQUIRED',
    agent_id: 'a1',
    agent_name: 'Researcher',
    task_id: 't1234567890abcdef',
    conversation_id: 'c1',
    requested_origin: 'https://github.com',
    verified_origin: 'https://github.com',
    site: 'github.com',
    allowed_origins: ['https://github.com'],
    step: 'identifier_password',
    step_seq: req && typeof req.seq === 'number' ? req.seq : 1,
    confidence: 'HIGH',
    flags: [],
    auth_method: null,
    error_code: null,
    created_at: t - 30,
    updated_at: t - 5,
    expires_at: t + 1800,
    completed_at: null,
    attempts: { credentials: 0, codes: 0, max_credentials: 3, max_codes: 3 },
    saved_to_vault: false,
    trust: GREEN,
    steps_seen: 1,
    request: req === null ? null : authRequest(req),
    ...over,
  };
}

/** Remote (Mini App, not freshly confirmed) request defaults: PIN rules as the host sends them for credentials. */
export const REMOTE_CREDENTIALS: Partial<AuthRequest> = {
  local: false,
  fresh: false,
  pin_required_for: ['credentials', 'saved_without_grant', 'save_to_vault'],
  allow_future_needs_stepup: true,
};

// ---------------------------------------------------------------- V3.4 (Smart Authentication 3.0) examples
const EMAIL_FIELD = () => field({ id: 'f1', role: 'email', input: 'email' });
const PASSWORD_FIELD = () => field({ id: 'f3', role: 'password', input: 'password' });

/** Sessions as a V3.4 host sends them: identifier states by what the page asks, LOGIN_ERROR, authenticator numbers, …. */
export const V34 = {
  email: (over: Partial<AuthSession> = {}) =>
    authSession({ state: 'EMAIL_REQUIRED', step: 'identifier', ...over }, { step: 'identifier', requirement: 'EMAIL_REQUIRED', notes: [], fields: [EMAIL_FIELD()] }),
  username: () =>
    authSession({ state: 'USERNAME_REQUIRED', step: 'identifier' }, { step: 'identifier', requirement: 'USERNAME_REQUIRED', notes: [], fields: [field({ id: 'f1', role: 'username' })] }),
  phone: () =>
    authSession({ state: 'PHONE_REQUIRED', step: 'identifier' }, { step: 'identifier', requirement: 'PHONE_REQUIRED', notes: [], fields: [field({ id: 'f1', role: 'phone', input: 'tel' })] }),
  password: (over: Partial<AuthRequest> = {}) =>
    authSession({ state: 'PASSWORD_REQUIRED', step: 'password' }, { id: 'ar_2', seq: 2, step: 'password', requirement: 'PASSWORD_REQUIRED', notes: [], fields: [PASSWORD_FIELD()], ...over }),
  /** The site rejected the password: the same password field again (requirement PASSWORD_REQUIRED). */
  loginError: () =>
    authSession(
      { state: 'LOGIN_ERROR', step: 'password', attempts: { credentials: 1, codes: 0, max_credentials: 3, max_codes: 3 } },
      { id: 'ar_3', seq: 3, step: 'password', requirement: 'PASSWORD_REQUIRED', error: 'credentials_rejected', notes: [], fields: [PASSWORD_FIELD()] },
    ),
  authenticator: (approvalNumber: string | null = '42') =>
    authSession(
      { state: 'AUTHENTICATOR_APPROVAL', step: 'device_approval' },
      { type: 'device_approval', step: 'device_approval', requirement: 'AUTHENTICATOR_APPROVAL', fields: [], notes: ['chose_password'], approval_number: approvalNumber },
    ),
  /** A physical security key with other ways offered: NEBULA cancelled the prompt; the owner picks another way. */
  securityKey: (over: Partial<AuthRequest> = {}) =>
    authSession(
      { state: 'SECURITY_KEY_REQUIRED', step: 'security_key' },
      {
        type: 'manual',
        step: 'security_key',
        requirement: 'SECURITY_KEY_REQUIRED',
        fields: [],
        alternatives: ['password', 'more'],
        notes: ['security_key_cancelled'],
        manual: { kind: 'security_key', live_desktop: true, can_complete_here: false, webauthn_pending: false },
        ...over,
      },
    ),
  passkey: () =>
    authSession(
      { state: 'PASSKEY_REQUIRED', step: 'passkey' },
      { type: 'manual', step: 'passkey', requirement: 'PASSKEY_REQUIRED', fields: [], alternatives: ['password'], notes: ['passkey_cancelled'], manual: { kind: 'passkey', live_desktop: true, can_complete_here: false, webauthn_pending: true } },
    ),
  unknown: () =>
    authSession(
      { state: 'UNKNOWN_STEP', step: 'unknown' },
      { type: 'manual', step: 'unknown', requirement: 'UNKNOWN_STEP', fields: [], notes: [], manual: { kind: 'unknown', live_desktop: true, can_complete_here: true, webauthn_pending: false } },
    ),
  failed: (error_code: 'broker_memory' | 'vm_unreachable') => authSession({ state: 'FAILED', error_code, completed_at: NOW_S() }, null),
  /** The detail (GET /smart-auth/sessions/{id}): events newest first, the pages of the sign-in. */
  detail: (over: Partial<AuthSession> = {}) => {
    const t = NOW_S();
    return V34.email({
      events: [
        { type: 'request.created', ts: t - 10, outcome: 'ok' },
        { type: 'step.detected', ts: t - 12, outcome: 'ok', meta: { step: 'identifier', origin: 'https://login.microsoftonline.com', step_id: 1, confidence: 'HIGH', diag: { quiet_ms: 350, roles: ['email'], inputs_visible: 1 } } },
        { type: 'session.started', ts: t - 20, outcome: 'ok' },
      ],
      history: [{ step: 'identifier', origin: 'https://login.microsoftonline.com', error: null, trust: 'GREEN', at: t - 12 }],
      ...over,
    });
  },
};
