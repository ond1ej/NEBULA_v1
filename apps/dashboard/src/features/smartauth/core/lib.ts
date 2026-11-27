// Pure helpers of Smart Authentication: fixed labels (page-provided labels are never shown), input attributes per
// field role, code normalisation, human texts for states / flags / steps / notes / failures / API errors, and which
// action needs the remote sign-in PIN. Shared by the Mini App and the Dashboard.
import { isApiError } from '../../../lib/http';
import type { AltKind, AuthField, AuthRequest, AuthSession, AuthState, AuthTrust, FieldRole, SubmitAction } from './types';

export { AUTH_EVENT_TYPES, authEventPayload, authEventSession, isAuthEvent, isTerminal, needsOwner, normalizeState,
  OWNER_WAIT_STATES, pickNewer, TERMINAL_STATES } from './state';
import { normalizeState, OWNER_WAIT_STATES } from './state';

// ---------------------------------------------------------------- fixed labels
export const FIELD_LABEL: Record<FieldRole, string> = {
  email: 'Email',
  phone: 'Phone number',
  username: 'Username',
  username_or_email: 'Username or email',
  password: 'Password',
  otp: 'Verification code',
  recovery_code: 'Recovery code',
};

export const STEP_LABEL: Record<string, string> = {
  identifier: 'Account name',
  identifier_password: 'Account name and password',
  password: 'Password',
  otp: 'Verification code',
  recovery_code: 'Recovery code',
  device_approval: 'Authenticator approval',
  captcha: 'CAPTCHA',
  passkey: 'Passkey',
  security_key: 'Security key',
  unknown: 'Unrecognised step',
  embedded_login: 'Embedded sign-in',
  new_password: 'New password',
  destination: 'Sign-in destination',
  method_choice: 'Choose how to sign in',
  interstitial: 'Website prompt',
  unconfirmed: 'Check the result',
  manual: 'Manual step',
  loop: 'Paused',
  authenticated: 'Signed in',
};

const IDENTIFIER_ROLES: ReadonlySet<FieldRole> = new Set(['email', 'phone', 'username', 'username_or_email']);
export const isIdentifierRole = (r: FieldRole) => IDENTIFIER_ROLES.has(r);

/** What the CURRENT page asks for, by field role ("Email required", "Password required", …). */
export function fieldsHeading(fields: readonly AuthField[]): string {
  const id = fields.find((f) => isIdentifierRole(f.role));
  const pw = fields.some((f) => f.role === 'password');
  if (id && pw) return `${FIELD_LABEL[id.role]} and password required`;
  if (pw) return 'Password required';
  if (id) return `${FIELD_LABEL[id.role]} required`;
  return 'Sign-in details required';
}

/** Host name of an origin (shown large for the owner to check), or the input when it is not a URL. */
export function hostOf(origin: string | null | undefined): string {
  if (!origin) return '';
  try {
    return new URL(origin).host || origin;
  } catch {
    return origin;
  }
}

/** The trust verdict of the current step (request), else of the session. */
export const trustOf = (s: Pick<AuthSession, 'trust' | 'request'>): AuthTrust | null => s.request?.trust ?? s.trust ?? null;

export function stepLabel(step: string | null | undefined): string | null {
  if (!step) return null;
  return STEP_LABEL[step] ?? step.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

export const taskRef = (taskId: string | null | undefined) => (taskId ? `#${taskId.slice(0, 8)}` : '');

/** The origin the owner should check: the verified page origin, else the requested one (not verified yet). */
export function shownOrigin(s: Pick<AuthSession, 'verified_origin' | 'requested_origin'>): { origin: string; verified: boolean } {
  return s.verified_origin ? { origin: s.verified_origin, verified: true } : { origin: s.requested_origin, verified: false };
}

// ---------------------------------------------------------------- states (title + subtitle of every state)
export const STATE_INFO: Record<AuthState, { title: string; subtitle: string }> = {
  INITIALIZING: { title: 'Opening the sign-in page', subtitle: 'NEBULA opens the website in its isolated browser.' },
  IDENTIFIER_REQUIRED: { title: 'Username or email required', subtitle: 'The website asks for your account name.' },
  EMAIL_REQUIRED: { title: 'Email required', subtitle: 'The website asks for the email address of your account.' },
  USERNAME_REQUIRED: { title: 'Username required', subtitle: 'The website asks for your username.' },
  PHONE_REQUIRED: { title: 'Phone number required', subtitle: 'The website asks for the phone number of your account.' },
  PASSWORD_REQUIRED: { title: 'Password required', subtitle: 'The website asks for your password.' },
  IDENTIFIER_AND_PASSWORD_REQUIRED: { title: 'Sign-in details required', subtitle: 'The website asks for your account name and password.' },
  OTP_REQUIRED: { title: 'Verification code required', subtitle: 'The website asks for a one-time code.' },
  AUTHENTICATOR_APPROVAL: { title: 'Approve in your authenticator app', subtitle: 'The website sent a sign-in request to your app or device.' },
  PASSKEY_REQUIRED: { title: 'Passkey requested', subtitle: 'The website asks for a passkey.' },
  SECURITY_KEY_REQUIRED: { title: 'Security key requested', subtitle: 'The website asks for a physical security key.' },
  CAPTCHA_REQUIRED: { title: 'CAPTCHA', subtitle: 'The website shows a CAPTCHA that only a person can solve.' },
  REDIRECT_REVIEW_REQUIRED: { title: 'Review the sign-in destination', subtitle: 'The sign-in continues on another address.' },
  LOGIN_ERROR: { title: 'Wrong sign-in details', subtitle: 'The website did not accept the details. Enter them again.' },
  UNKNOWN_STEP: { title: 'Unrecognised sign-in step', subtitle: 'NEBULA could not recognise this sign-in page.' },
  WAITING_FOR_USER: { title: 'Your decision is needed', subtitle: 'The sign-in waits for your answer.' },
  SUBMITTING: { title: 'Signing in', subtitle: 'NEBULA enters your answer on the website.' },
  VERIFYING: { title: 'Checking the next step', subtitle: 'NEBULA checks what the website asks for next.' },
  AUTHENTICATED: { title: 'Signed in', subtitle: 'The agent continues its task.' },
  FAILED: { title: 'Sign-in failed', subtitle: 'The sign-in could not be completed.' },
  CANCELLED: { title: 'Sign-in cancelled', subtitle: 'The agent continues without signing in.' },
  EXPIRED: { title: 'Sign-in request expired', subtitle: 'Nobody answered the request in time.' },
};

/** Title + subtitle of a state (older names mapped first; an unknown state gets a neutral text). */
export function stateInfo(state: string): { title: string; subtitle: string } {
  return STATE_INFO[normalizeState(state)] ?? { title: 'Sign-in', subtitle: String(state).toLowerCase().replace(/_/g, ' ') };
}

export function requestTitle(s: Pick<AuthSession, 'site' | 'request' | 'state'>): string {
  const state = normalizeState(s.state);
  switch (s.request?.type) {
    case 'credentials':
      return `Sign in to ${s.site}`;
    case 'otp':
    case 'recovery_code':
      return 'Verification required';
    case 'confirm_destination':
      return 'Review sign-in destination';
    case 'device_approval':
      return STATE_INFO.AUTHENTICATOR_APPROVAL.title;
    case 'manual': {
      const k = s.request.manual?.kind;
      if (k === 'passkey' || state === 'PASSKEY_REQUIRED') return STATE_INFO.PASSKEY_REQUIRED.title;
      if (k === 'security_key' || state === 'SECURITY_KEY_REQUIRED') return STATE_INFO.SECURITY_KEY_REQUIRED.title;
      if (k === 'unknown' || state === 'UNKNOWN_STEP') return STATE_INFO.UNKNOWN_STEP.title;
      return 'Finish this step yourself';
    }
    case 'method_choice':
      return 'Choose how to sign in';
    case 'loop':
      return 'Sign-in paused';
    default:
      return s.state === 'AUTHENTICATED' ? `Signed in to ${s.site}` : `Sign in to ${s.site}`;
  }
}

// ---------------------------------------------------------------- inputs
export interface FieldInputProps {
  type: 'email' | 'tel' | 'text' | 'password';
  inputMode?: 'email' | 'tel' | 'text' | 'numeric';
  autoComplete: string;
  maxLength?: number;
}

/** Input attributes by ROLE (never from page-provided metadata); password managers get the standard tokens. */
export function fieldInputProps(f: AuthField): FieldInputProps {
  switch (f.role) {
    case 'email':
      return { type: 'email', inputMode: 'email', autoComplete: 'username' };
    case 'phone':
      return { type: 'tel', inputMode: 'tel', autoComplete: 'username' };
    case 'username':
    case 'username_or_email':
      return { type: 'text', inputMode: 'text', autoComplete: 'username' };
    case 'password':
      return { type: 'password', autoComplete: 'current-password' };
    case 'otp': {
      const len = codeLength(f);
      return { type: 'text', inputMode: (f.charset ?? 'numeric') === 'numeric' ? 'numeric' : 'text', autoComplete: 'one-time-code', maxLength: len ?? 12 };
    }
    case 'recovery_code':
      return { type: 'text', inputMode: 'text', autoComplete: 'off', maxLength: 64 };
    default:
      return { type: 'text', autoComplete: 'off' };
  }
}

export const isCodeRole = (r: FieldRole) => r === 'otp' || r === 'recovery_code';

/** The exact code length when the page tells it (boxes or a length), else null (3–12 accepted). */
export function codeLength(f: AuthField): number | null {
  if (f.ids && f.ids.length) return f.ids.length;
  return f.length ?? null;
}

/** Pasted / typed codes: spaces and dashes go; only letters and digits stay (digits only for numeric codes). */
export function normalizeCode(raw: string, f: AuthField): string {
  const cleaned = raw.replace(/[\s\-–—]/g, '');
  const kept = f.role === 'otp' && f.charset === 'numeric' ? cleaned.replace(/\D/g, '') : cleaned.replace(/[^A-Za-z0-9]/g, '');
  const max = f.role === 'otp' ? (codeLength(f) ?? 12) : 64;
  return kept.slice(0, max);
}

/** Why a value cannot be sent yet (null = fine). Values are never part of the message. */
export function fieldProblem(f: AuthField, v: string): string | null {
  if (!v) return `Enter the ${FIELD_LABEL[f.role].toLowerCase()}`;
  if (f.role === 'otp') {
    const len = codeLength(f);
    if (f.charset === 'numeric' && !/^\d+$/.test(v)) return 'The code may contain only digits';
    if (!/^[A-Za-z0-9]+$/.test(v)) return 'The code may contain only letters and digits';
    if (len && v.length !== len) return `The code has ${len} characters`;
    if (!len && (v.length < 3 || v.length > 12)) return 'The code has 3–12 characters';
    return null;
  }
  if (f.role === 'recovery_code') return /^[A-Za-z0-9]{4,64}$/.test(v) ? null : 'The recovery code has 4–64 letters and digits';
  if (f.role === 'phone' && !/^[+0-9 ()./-]{3,32}$/.test(v)) return 'A phone number may contain only digits, spaces and + ( ) - .';
  if (f.role !== 'password' && !v.trim()) return `Enter the ${FIELD_LABEL[f.role].toLowerCase()}`;
  return null;
}

export const CHANNEL_HINT: Record<string, string> = {
  sms: 'Enter the code sent to your phone',
  email: 'Enter the code sent to your email',
  totp: 'Enter the code from your authenticator app',
  unknown: 'Enter the verification code requested by the website',
};

// ---------------------------------------------------------------- review reasons
const BRANDS: Record<string, string> = {
  github: 'GitHub',
  google: 'Google',
  microsoft: 'Microsoft',
  apple: 'Apple',
  amazon: 'Amazon',
  paypal: 'PayPal',
  facebook: 'Facebook',
  meta: 'Meta',
  linkedin: 'LinkedIn',
  gitlab: 'GitLab',
  openai: 'OpenAI',
  dropbox: 'Dropbox',
  slack: 'Slack',
  x: 'X',
  twitter: 'X (Twitter)',
};

const FLAG_TEXT: Record<string, string> = {
  other_site: 'The sign-in continues on a different site than the one the agent opened',
  origin_changed: 'The page moved to another address during the sign-in',
  cross_site_form_action: 'The form sends what you type to a different site',
  cross_origin_form_action: 'The form sends what you type to another address of this site',
  third_party_frame: 'The sign-in form is embedded from another site',
  unexpected_recovery_code: 'The site unexpectedly asks for a recovery code',
  hidden_password_field: 'The page has a hidden password field',
  ambiguous_identifier: 'It is unclear which account name the site expects',
  multiple_password_forms: 'The page shows more than one password form',
  plain_http: 'The page is not encrypted (plain HTTP)',
};

/** Human-readable reason for one detection flag. */
export function flagReason(flag: string): string {
  const [key, arg] = flag.split(':', 2);
  if (key === 'brand_mismatch') {
    const brand = arg ? (BRANDS[arg] ?? arg.charAt(0).toUpperCase() + arg.slice(1)) : 'a well-known brand';
    return `The page looks like ${brand}, but it is not on a ${brand} domain`;
  }
  return FLAG_TEXT[key] ?? `Unusual sign-in page (${flag.replace(/_/g, ' ')})`;
}

// ---------------------------------------------------------------- outcomes
export const FAILURE_TEXT: Record<string, string> = {
  too_many_attempts: 'Too many wrong attempts — the sign-in was stopped.',
  no_login_form: 'The website did not show a sign-in form NEBULA could use.',
  broker_unavailable: 'The isolated sign-in browser is not available right now.',
  no_session: 'The sign-in did not produce a session for the agent.',
  broker_lost: 'The isolated sign-in browser stopped unexpectedly.',
  redirect_blocked: 'The sign-in was stopped because the site redirected somewhere unexpected.',
  busy: 'Too many sign-ins are running at the same time.',
  service_restarted: 'NEBULA restarted during the sign-in.',
  request_expired: 'Nobody answered the request in time.',
  code_expired_before_use: 'The verification code expired before it could be used.',
  insecure_destination: 'The sign-in was stopped because the destination is not secure.',
  too_many_destinations: 'The sign-in was stopped because it moved across too many sites.',
  owner_cancelled: 'You cancelled the sign-in.',
  site_unreachable: 'The website could not be reached from the NEBULA VM (network or address problem).',
  form_not_restored: 'The sign-in page could not be opened again after you allowed the destination. Ask the agent to retry.',
  suspicious_page: 'NEBULA blocked this sign-in page as suspicious — nothing you typed was sent.',
  suspicious_destination: 'NEBULA blocked the sign-in because it tried to continue on a suspicious address.',
  suspicious_site: 'NEBULA blocked the sign-in because the site looks like an imitation of a known service.',
  blocked_suspicious: 'This sign-in was blocked as suspicious — nothing can be submitted.',
  loop_no_progress: 'The page did not react to the details, so NEBULA stopped sending them.',
  loop_too_many_steps: 'The sign-in took more steps than expected, so NEBULA stopped it.',
  unsupported_interstitial: 'The website showed a prompt NEBULA cannot answer on its own.',
  unsupported_embedded_login: 'The sign-in form is embedded from another site, which NEBULA does not fill.',
  unsupported_new_password: 'The website asks to set a new password, which only you should do (in Live Desktop).',
  unexpected_page: 'The website showed an unexpected page during the sign-in.',
  broker_timeout: 'The website took too long to answer.',
  broker_error: 'The isolated sign-in browser reported an error.',
  origin_mismatch: 'The sign-in ended on a different site than expected.',
  origin_unverified: 'The sign-in page was not on an allowed address.',
  bad_step: 'NEBULA could not recognise the sign-in page.',
  internal_error: 'NEBULA ran into an internal error during the sign-in.',
  broker_memory: 'The site’s page needed more memory than the secure browser allows. Retry, or use Live Desktop.',
  vm_unreachable: 'The NEBULA VM stopped answering. Make sure the VM is running.',
};

/** Why a signed-in session's credential was NOT saved (AUTHENTICATED + error_code), or null. */
export function saveNoteText(code: string | null | undefined): string | null {
  if (!code || !code.startsWith('not_saved')) return null;
  switch (code) {
    case 'not_saved_vault_locked':
      return 'The credential was not saved: the Password Vault was locked.';
    case 'not_saved_incomplete':
      return 'The credential was not saved: NEBULA did not see both the account name and the password.';
    case 'not_saved_origin':
      return 'The credential was not saved: the password was typed on another address than the account name.';
    case 'not_saved_unconfirmed':
      return 'The credential was not saved because the sign-in could not be confirmed automatically.';
    default:
      return 'The credential could not be saved to the Password Vault.';
  }
}

export function failureText(code: string | null | undefined): string {
  if (!code) return 'The sign-in could not be completed.';
  return FAILURE_TEXT[code] ?? `The sign-in could not be completed (${code.replace(/_/g, ' ')}).`;
}

export const MANUAL_KIND: Record<string, { title: string; text: string }> = {
  captcha: { title: 'CAPTCHA', text: 'The website shows a CAPTCHA that only a person can solve.' },
  passkey: { title: 'Passkey requested', text: 'The website asks for a passkey, which only you can provide.' },
  security_key: { title: 'Security key requested', text: 'The website asks for a physical security key, which only you can provide.' },
  unknown: { title: 'Unrecognised sign-in step', text: 'NEBULA could not recognise this sign-in step. Check it in Live Desktop.' },
  embedded_login: { title: 'Embedded sign-in', text: 'The sign-in form is embedded in a way NEBULA cannot fill safely.' },
  new_password: { title: 'New password', text: 'The website asks to set a new password, which only you should choose.' },
  unconfirmed: { title: 'Check the result', text: 'NEBULA could not confirm that the sign-in worked. Check the page in Live Desktop.' },
  interstitial: { title: 'Website prompt', text: 'The website shows a prompt NEBULA does not answer on its own (for example “Stay signed in?”).' },
  manual: { title: 'Finish in Live Desktop', text: 'The sign-in page is open in the agent’s browser for you to finish.' },
};

/** A passkey / physical security key: NEBULA's isolated browser has neither. */
export const isKeyKind = (k: string | null | undefined) => k === 'passkey' || k === 'security_key';
export const KEY_TEXT = 'NEBULA’s secure browser has no passkey or security key. Choose another way below, or finish in Live Desktop.';

// ---------------------------------------------------------------- notes: what NEBULA did by itself (fixed codes)
export const NOTE_TEXT: Record<string, string> = {
  passkey_cancelled: 'The site asked for a passkey. NEBULA’s secure browser has none, so it closed that prompt.',
  security_key_cancelled: 'The site asked for a security key. NEBULA’s secure browser has none, so it closed that prompt.',
  chose_password: 'NEBULA chose the site’s “use your password” option.',
  opened_other_ways: 'NEBULA opened the site’s other sign-in options.',
  declined_kmsi: 'NEBULA answered “No” to “Stay signed in?”.',
  declined_nag: 'NEBULA skipped an optional prompt.',
  declined_prompt: 'NEBULA skipped an optional prompt.',
  restarted_from_service: 'NEBULA started the sign-in again from the service’s start page — the agent’s window may show a different step.',
  restarted_at_provider: 'NEBULA started again at the provider’s sign-in page.',
  approval_number_hidden: 'The page showed a number to enter, but it is not a verified sign-in page, so NEBULA does not show it. Approve only if you started this sign-in.',
};

/** The fixed texts of a request's notes, in order, without duplicates; unknown codes are ignored. */
export function noteTexts(req: Pick<AuthRequest, 'notes'>): { code: string; text: string }[] {
  const out: { code: string; text: string }[] = [];
  for (const code of req.notes ?? []) {
    const text = typeof code === 'string' ? NOTE_TEXT[code] : undefined;
    if (text && !out.some((n) => n.text === text)) out.push({ code, text });
  }
  return out;
}

// ---------------------------------------------------------------- alternatives (kinds only; fixed labels)
/** Buttons of a "choose how to sign in" step. */
export const ALT_LABEL: Record<AltKind, string> = {
  password: 'Use password',
  code: 'Use a verification code',
  app: 'Approve in the authenticator app',
  more: 'Show other ways to sign in',
};

/** The same choices offered next to another step. */
export const ALT_INSTEAD_LABEL: Record<AltKind, string> = {
  password: 'Use my password instead',
  code: 'Use a verification code instead',
  app: 'Approve in the authenticator app instead',
  more: 'Show other ways to sign in',
};

export const altKinds = (req: Pick<AuthRequest, 'alternatives'>): AltKind[] =>
  (req.alternatives ?? []).filter((k): k is AltKind => k === 'password' || k === 'code' || k === 'app' || k === 'more');

// ---------------------------------------------------------------- the page's verdict on the current step
/** Why the same step is shown again (request.error). */
export const STEP_ERROR_TEXT: Record<string, { tone: 'danger' | 'warning'; text: string }> = {
  credentials_rejected: { tone: 'danger', text: 'The website did not accept these details. Check them and try again.' },
  code_rejected: { tone: 'danger', text: 'The verification code was rejected. Please enter a new code.' },
  page_changed: { tone: 'warning', text: 'The sign-in page changed — this is the current step.' },
  no_progress: { tone: 'warning', text: 'The page did not react — check the details and try again.' },
};

/** LOGIN_ERROR: the site said the details were wrong — the same form is asked again. */
export const LOGIN_ERROR_TEXT = {
  credentials: 'The site did not accept these details. Check them and try again.',
  code: 'The site did not accept this code. Enter a new code and try again.',
} as const;

export const LOOP_TEXT: Record<string, { title: string; text: string }> = {
  no_progress: {
    title: 'The page did not react',
    text: 'The website showed the same step again after NEBULA sent your answer, so automatic sign-in stopped (nothing is sent twice).',
  },
  too_many_steps: {
    title: 'Too many sign-in steps',
    text: 'The sign-in went through more pages than expected, so automatic sign-in stopped.',
  },
};

/** One-line status for cards and lists. */
export function stateText(s: Pick<AuthSession, 'state' | 'request' | 'site' | 'error_code'>): string {
  switch (normalizeState(s.state)) {
    case 'INITIALIZING':
      return 'Opening the sign-in page…';
    case 'IDENTIFIER_REQUIRED':
      return 'Waiting for your account name';
    case 'EMAIL_REQUIRED':
      return 'Waiting for your email';
    case 'USERNAME_REQUIRED':
      return 'Waiting for your username';
    case 'PHONE_REQUIRED':
      return 'Waiting for your phone number';
    case 'LOGIN_ERROR':
      return 'Wrong sign-in details — waiting for you to try again';
    case 'UNKNOWN_STEP':
      return 'Unrecognised sign-in step — check it in Live Desktop';
    case 'SECURITY_KEY_REQUIRED':
      return 'Security key requested — choose another way or use Live Desktop';
    case 'PASSWORD_REQUIRED':
      return 'Waiting for your password';
    case 'IDENTIFIER_AND_PASSWORD_REQUIRED':
      return 'Waiting for your sign-in details';
    case 'OTP_REQUIRED':
      return 'Waiting for a verification code';
    case 'AUTHENTICATOR_APPROVAL':
      return s.request?.approval_number ? `Enter ${s.request.approval_number} in your authenticator app` : 'Waiting for approval in your authenticator app';
    case 'PASSKEY_REQUIRED':
      return 'Passkey requested — choose another way or use Live Desktop';
    case 'CAPTCHA_REQUIRED':
      return 'Waiting for you to solve a CAPTCHA';
    case 'REDIRECT_REVIEW_REQUIRED':
      return 'Waiting for you to review the destination';
    case 'WAITING_FOR_USER':
      switch (s.request?.type) {
        case 'method_choice':
          return 'Waiting for you to choose how to sign in';
        case 'loop':
          return 'Paused — the sign-in needs your decision';
        case 'credentials':
          return 'Waiting for your sign-in details';
        default:
          return 'Waiting for you to finish a step yourself';
      }
    case 'SUBMITTING':
      return 'Signing in…';
    case 'VERIFYING':
      return 'Checking the next step…';
    case 'AUTHENTICATED':
      return `Signed in to ${s.site} ✓`;
    case 'CANCELLED':
      return 'Sign-in cancelled';
    case 'EXPIRED':
      return 'Sign-in request expired';
    case 'FAILED':
      return `Sign-in failed — ${failureText(s.error_code)}`;
    default:
      return String(s.state).toLowerCase().replace(/_/g, ' ');
  }
}

/** Short state label for badges. */
export function stateLabel(raw: AuthState): string {
  const state = normalizeState(raw);
  switch (state) {
    case 'AUTHENTICATED':
      return 'Signed in';
    case 'FAILED':
      return 'Failed';
    case 'CANCELLED':
      return 'Cancelled';
    case 'EXPIRED':
      return 'Expired';
    case 'INITIALIZING':
      return 'Starting';
    case 'VERIFYING':
      return 'Checking';
    case 'SUBMITTING':
      return 'Signing in';
    default:
      return OWNER_WAIT_STATES.has(state) ? 'Waiting for you' : String(state).toLowerCase().replace(/_/g, ' ');
  }
}

export type StateTone = 'success' | 'danger' | 'warning' | 'neutral' | 'accent';

export function stateTone(s: Pick<AuthSession, 'state'>): StateTone {
  if (s.state === 'AUTHENTICATED') return 'success';
  if (s.state === 'FAILED') return 'danger';
  if (s.state === 'CANCELLED' || s.state === 'EXPIRED') return 'neutral';
  return OWNER_WAIT_STATES.has(normalizeState(s.state)) ? 'warning' : 'accent';
}

// ---------------------------------------------------------------- remote PIN
/** Which pin_required_for key an action maps to, given the choices on the form. */
export function pinKeysFor(req: AuthRequest, action: SubmitAction, opts: { hasGrant?: boolean; allowFuture?: boolean; save?: 'once' | 'vault' } = {}): string[] {
  switch (action) {
    case 'credentials':
      return ['credentials', ...(opts.save === 'vault' ? ['save_to_vault'] : []), ...(opts.save === 'vault' && opts.allowFuture ? ['allow_future'] : [])];
    case 'saved':
      return [...(!opts.hasGrant ? ['saved_without_grant'] : []), ...(opts.allowFuture ? ['allow_future'] : [])];
    case 'code':
      return req.type === 'recovery_code' ? ['code'] : [];
    case 'allow_destination':
      return req.destination?.secrets_pending ? ['allow_destination_with_secrets'] : [];
    default:
      return [];
  }
}

/**
 * The remote PIN is needed for this action: only when the host lists it in `pin_required_for` (empty on this Mac and
 * after a fresh owner confirmation).
 */
export function pinNeeded(req: AuthRequest, action: SubmitAction, opts: { hasGrant?: boolean; allowFuture?: boolean; save?: 'once' | 'vault' } = {}): boolean {
  if (req.local || req.fresh) return false;
  const keys = pinKeysFor(req, action, opts);
  return keys.some((k) => req.pin_required_for.includes(k));
}

// ---------------------------------------------------------------- API errors
export interface FormError {
  code: string;
  message: string;
}

const fmtWait = (s: number) => (s >= 90 ? `${Math.ceil(s / 60)} min` : `${Math.max(1, Math.round(s))} s`);

/** Inline error text for a failed token / submit / cancel call (API message; never a typed value). */
export function formError(e: unknown): FormError {
  if (!isApiError(e)) return { code: 'error', message: e instanceof Error ? e.message : 'Something went wrong' };
  const d = e.details ?? {};
  const left = typeof d.attempts_left === 'number' ? d.attempts_left : null;
  const retry = typeof d.retry_after === 'number' ? d.retry_after : null;
  switch (e.code) {
    case 'network_error':
      return { code: e.code, message: 'NEBULA cannot be reached. Check your connection and try again.' };
    case 'pin_invalid':
      return { code: e.code, message: `Wrong PIN.${left !== null ? ` ${left} attempt${left === 1 ? '' : 's'} left before a temporary lock.` : ''}` };
    case 'pin_locked':
      return { code: e.code, message: `Too many wrong PINs. Try again${retry !== null ? ` in ${fmtWait(retry)}` : ' later'}.` };
    case 'pin_not_configured':
      return {
        code: e.code,
        message: 'No remote sign-in PIN is set. Set one in Password Vault → Smart sign-in, or answer on your Mac. One-time codes work without a PIN.',
      };
    case 'review_required':
      return { code: e.code, message: 'Confirm that you checked the destination first.' };
    case 'vault_locked':
      return {
        code: e.code,
        message:
          d.vault_state === 'not_created'
            ? 'There is no Password Vault yet. Choose “Use once”, or create the vault first.'
            : 'Your Password Vault is locked. Unlock it, or choose “Use once”.',
      };
    case 'stepup_required':
      return { code: e.code, message: 'Letting the agent use this credential in future needs a confirmation that it’s you. Confirm it, or turn that option off.' };
    case 'blocked_suspicious':
      return { code: e.code, message: 'This sign-in was blocked as suspicious — nothing can be submitted.' };
    case 'token_expired':
    case 'invalid_token':
    case 'conflict':
      return { code: e.code, message: 'This request changed or the form was open too long. It was reloaded — check it and try again.' };
    case 'still_sign_in_page':
      return { code: e.code, message: e.message || 'The agent’s browser still shows a sign-in step. Finish it in Live Desktop, then tap “I’m done” again.' };
    case 'request_closed':
    case 'not_waiting':
    case 'stale':
      return { code: e.code, message: 'The sign-in page moved on. It was reloaded — nothing was sent.' };
    case 'expired':
      return { code: e.code, message: 'This sign-in request is no longer waiting for you.' };
    case 'entry_not_offered':
      return { code: e.code, message: 'That saved account cannot be used on this page. Choose another one.' };
    case 'rate_limited':
      return { code: e.code, message: `Too many attempts. Wait${retry !== null ? ` ${fmtWait(retry)}` : ' a moment'} and try again.` };
    case 'remote_disabled':
      return { code: e.code, message: 'Entering sign-in details remotely is turned off. Use the Dashboard on your Mac, or allow it in Password Vault → Smart sign-in.' };
    default:
      return { code: e.code, message: e.message || 'The request failed.' };
  }
}

/** Inline error of the "Unlock vault" passphrase form (never echoes the passphrase). */
export function vaultUnlockError(e: unknown): string {
  if (!isApiError(e)) return e instanceof Error ? e.message : 'The vault could not be unlocked.';
  const left = typeof e.details?.attempts_left === 'number' ? e.details.attempts_left : null;
  const retry = typeof e.details?.retry_after === 'number' ? e.details.retry_after : null;
  switch (e.code) {
    case 'wrong_passphrase':
      return `Wrong vault passphrase.${left !== null ? ` ${left} attempt${left === 1 ? '' : 's'} left before a temporary lock.` : ''}`;
    case 'rate_limited':
      return `Too many wrong passphrases. Try again${retry !== null ? ` in ${fmtWait(retry)}` : ' later'}.`;
    case 'no_vault':
      return 'There is no Password Vault yet.';
    case 'stepup_required':
      return 'Unlocking the vault needs a confirmation that it’s you.';
    case 'network_error':
      return 'NEBULA cannot be reached. Check your connection and try again.';
    default:
      return e.message || 'The vault could not be unlocked.';
  }
}

/** Errors after which the session must be reloaded before the owner tries again. */
export const RELOAD_ERRORS: ReadonlySet<string> = new Set(['token_expired', 'invalid_token', 'request_closed', 'conflict', 'not_waiting', 'stale', 'expired', 'still_sign_in_page']);

// ---------------------------------------------------------------- PIN strength (Dashboard settings)
export function pinProblem(pin: string): string | null {
  if (pin.length < 6) return 'Use at least 6 characters';
  if (pin.length > 64) return 'Use at most 64 characters';
  if (/[\x00-\x1f\x7f]/.test(pin)) return 'Control characters are not allowed';
  if (new Set(pin).size < 3) return 'Too repetitive — use at least 3 different characters';
  if (/^\d+$/.test(pin) && ('01234567890123456789'.includes(pin) || '98765432109876543210'.includes(pin))) return 'Too predictable — avoid number sequences';
  return null;
}

/** 0–3: too weak / fair / good / strong (a hint only; the host enforces the rules). */
export function pinStrength(pin: string): { score: number; label: string } {
  if (pinProblem(pin)) return { score: 0, label: 'Too weak' };
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pin)).length;
  if (pin.length >= 12 && classes >= 2) return { score: 3, label: 'Strong' };
  if (pin.length >= 8 || classes >= 2) return { score: 2, label: 'Good' };
  return { score: 1, label: 'Fair' };
}

// ---------------------------------------------------------------- misc
/** Seconds until `epoch` (>= 0). */
export const secondsLeft = (epoch: number, nowMs = Date.now()) => Math.max(0, Math.floor(epoch - nowMs / 1000));

export function countdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

/** Newest first, de-duplicated by id. */
export function mergeSessions(...lists: (readonly AuthSession[] | null | undefined)[]): AuthSession[] {
  const byId = new Map<string, AuthSession>();
  for (const l of lists) for (const s of l ?? []) if (!byId.has(s.id) || byId.get(s.id)!.updated_at < s.updated_at) byId.set(s.id, s);
  return [...byId.values()].sort((a, b) => b.created_at - a.created_at);
}
