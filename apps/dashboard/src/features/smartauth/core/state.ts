// Smart Authentication state + event helpers without dependencies: imported by the Dashboard's always-loaded
// sign-in notice, so they must stay tiny (the rest of lib.ts loads with the form).
import type { AuthEventPayload, AuthSession, AuthState } from './types';

// ---------------------------------------------------------------- states
export const TERMINAL_STATES: ReadonlySet<AuthState> = new Set(['AUTHENTICATED', 'FAILED', 'CANCELLED', 'EXPIRED']);
/** The owner has to answer: every *_REQUIRED state, a destination review and other owner decisions (WAITING_FOR_USER). */
export const OWNER_WAIT_STATES: ReadonlySet<AuthState> = new Set([
  'IDENTIFIER_REQUIRED',
  'EMAIL_REQUIRED',
  'USERNAME_REQUIRED',
  'PHONE_REQUIRED',
  'PASSWORD_REQUIRED',
  'IDENTIFIER_AND_PASSWORD_REQUIRED',
  'OTP_REQUIRED',
  'AUTHENTICATOR_APPROVAL',
  'PASSKEY_REQUIRED',
  'SECURITY_KEY_REQUIRED',
  'CAPTCHA_REQUIRED',
  'REDIRECT_REVIEW_REQUIRED',
  'LOGIN_ERROR',
  'UNKNOWN_STEP',
  'WAITING_FOR_USER',
]);

/** V3.4 name of a state: older hosts / stored data used DEVICE_APPROVAL_REQUIRED for AUTHENTICATOR_APPROVAL. */
export const normalizeState = (state: string): AuthState => (state === 'DEVICE_APPROVAL_REQUIRED' ? 'AUTHENTICATOR_APPROVAL' : (state as AuthState));

export const isTerminal = (s: Pick<AuthSession, 'state'>) => TERMINAL_STATES.has(s.state);
/** The owner has something to answer right now. */
export const needsOwner = (s: Pick<AuthSession, 'state' | 'request'>) => OWNER_WAIT_STATES.has(normalizeState(s.state)) && s.request !== null;

/**
 * The newer of two views of one session (a late submit / list response must never replace a newer step): terminal
 * states are final, then the request sequence decides, then `updated_at`. Different sessions: `next`.
 */
export function pickNewer<T extends AuthSession>(prev: T | null | undefined, next: T): T {
  if (!prev || prev.id !== next.id) return next;
  if (TERMINAL_STATES.has(prev.state) && !TERMINAL_STATES.has(next.state)) return prev;
  const ps = prev.step_seq ?? 0;
  const ns = next.step_seq ?? 0;
  if (ns < ps) return prev;
  if (ns === ps && next.updated_at < prev.updated_at) return prev;
  if (ns === ps && next.request && prev.request && next.request.seq < prev.request.seq) return prev;
  return next;
}

// ---------------------------------------------------------------- events
export const AUTH_EVENT_TYPES: readonly string[] = ['auth.session.updated', 'auth.request'];
export const isAuthEvent = (ev: { type: string }) => ev.type === 'auth.session.updated' || ev.type === 'auth.request';

/** Session id of an auth event (payload.session_id), or null. */
export function authEventSession(ev: { type: string; payload?: Record<string, unknown> | null }): string | null {
  if (!isAuthEvent(ev)) return null;
  const id = ev.payload?.session_id;
  return typeof id === 'string' && id ? id : null;
}

export function authEventPayload(ev: { payload?: Record<string, unknown> | null }): Partial<AuthEventPayload> {
  const p = (ev.payload ?? {}) as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === 'string' ? v : null);
  const state = s(p.state);
  return {
    session_id: s(p.session_id) ?? undefined,
    state: state ? normalizeState(state) : undefined,
    site: s(p.site) ?? undefined,
    origin: s(p.origin) ?? undefined,
    agent_name: s(p.agent_name) ?? undefined,
    conversation_id: s(p.conversation_id),
    request_type: s(p.request_type) as AuthEventPayload['request_type'],
    request_id: s(p.request_id),
    error_code: s(p.error_code),
  };
}
