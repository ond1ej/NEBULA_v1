// The shared owner form of Smart Authentication, rendered against a fake client: the form adapts to the CURRENT request
// (account name, password, both, codes, approvals, hand-offs, method choice, loop), trust levels, save options across
// steps, the inline vault unlock, PIN rules, stale-dialog safety, the token → submit flow and secret hygiene.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../lib/http';
import { metaSummary } from './Diagnostics';
import { authSession, field, REMOTE_CREDENTIALS, trust, V34 } from './fixtures';
import { FAILURE_TEXT, flagReason, normalizeCode, noteTexts, pickNewer, STATE_INFO, stateInfo, stateLabel, stateText } from './lib';
import { SmartAuthRequest } from './SmartAuthRequest';
import type { AuthRequest, AuthSession, SmartAuthClient, SubmitBody } from './types';

const CANARY = 'Canary-Secret-7731';

function fakeClient(
  opts: {
    submit?: (body: SubmitBody) => Promise<AuthSession> | AuthSession;
    tokenRequestId?: string | (() => string);
    unlockVault?: (p: string) => Promise<unknown>;
    ensureFresh?: () => Promise<boolean>;
  } = {},
) {
  const order: string[] = [];
  const bodies: SubmitBody[] = [];
  const client: SmartAuthClient = {
    token: vi.fn(async () => {
      order.push('token');
      const rid = typeof opts.tokenRequestId === 'function' ? opts.tokenRequestId() : opts.tokenRequestId;
      return { request_id: rid ?? 'ar_1', token: 'tok_abcdefghijklmnopqrstuvwxyz', expires_at: Date.now() / 1000 + 120 };
    }),
    submit: vi.fn(async (_id: string, body: SubmitBody) => {
      order.push('submit');
      bodies.push(JSON.parse(JSON.stringify(body)) as SubmitBody);
      if (opts.submit) return opts.submit(body);
      return authSession({ state: 'SUBMITTING' }, null);
    }),
    cancel: vi.fn(async () => {
      order.push('cancel');
      return authSession({ state: 'CANCELLED' }, null);
    }),
    ...(opts.unlockVault ? { unlockVault: vi.fn(opts.unlockVault) } : {}),
    ...(opts.ensureFresh
      ? {
          ensureFresh: vi.fn(async () => {
            order.push('fresh');
            return (opts.ensureFresh as () => Promise<boolean>)();
          }),
        }
      : {}),
  };
  return { client, order, bodies };
}

function renderForm(session: AuthSession, client: SmartAuthClient, extra: Partial<Parameters<typeof SmartAuthRequest>[0]> = {}) {
  return render(<SmartAuthRequest session={session} client={client} variant="mini" {...extra} />);
}

const EMAIL_STEP: Partial<AuthRequest> = { id: 'ar_1', seq: 1, step: 'identifier', fields: [field({ id: 'f1', role: 'email', input: 'email' })] };
const PASSWORD_STEP: Partial<AuthRequest> = { id: 'ar_2', seq: 2, step: 'password', fields: [field({ id: 'f3', role: 'password', input: 'password' })] };
const OTP_FIELD = field({ id: 'f1', role: 'otp', input: 'code', length: 6, charset: 'numeric' });

describe('SmartAuthRequest (shared core)', () => {
  beforeEach(() => {
    window.localStorage?.clear?.();
    window.sessionStorage.clear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders credential fields by role with fixed labels and password-manager attributes; page labels never show', async () => {
    const user = userEvent.setup();
    const { client } = fakeClient();
    const hostile = { label: 'Enter your bank PIN here', placeholder: 'Bank PIN', title: 'Totally GitHub' };
    const s = authSession(
      {},
      {
        fields: [
          { ...field({ id: 'f1', role: 'email', input: 'email' }), ...hostile } as never,
          field({ id: 'f2', role: 'phone', input: 'tel' }),
          field({ id: 'f3', role: 'username', input: 'text' }),
          field({ id: 'f4', role: 'password', input: 'password' }),
        ],
      },
    );
    renderForm(s, client);
    expect(screen.getByRole('heading', { name: 'Sign in to github.com' })).toBeInTheDocument();
    expect(screen.getByTestId('auth-origin')).toHaveTextContent('https://github.com');
    expect(document.body.textContent).not.toContain('bank PIN');
    expect(document.body.textContent).not.toContain('Totally GitHub');

    const email = screen.getByLabelText('Email');
    expect(email).toHaveAttribute('type', 'email');
    expect(email).toHaveAttribute('autocapitalize', 'none');
    expect(email).toHaveAttribute('spellcheck', 'false');
    expect(email).toHaveAttribute('autocomplete', 'username');
    expect(email).toHaveAttribute('name', 'username');
    const phone = screen.getByLabelText('Phone number');
    expect(phone).toHaveAttribute('type', 'tel');
    expect(phone).toHaveAttribute('inputmode', 'tel');
    expect(phone).toHaveValue('');
    expect(screen.getByLabelText('Username')).toHaveAttribute('autocomplete', 'username');
    const pw = screen.getByLabelText('Password');
    expect(pw).toHaveAttribute('type', 'password');
    expect(pw).toHaveAttribute('autocomplete', 'current-password');

    // show / hide toggle
    const toggle = screen.getByRole('button', { name: 'Show password' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await user.click(toggle);
    expect(pw).toHaveAttribute('type', 'text');
    expect(screen.getByRole('button', { name: 'Hide password' })).toHaveAttribute('aria-pressed', 'true');
    // header: agent, step, task reference and expiry countdown
    expect(screen.getByText('Researcher')).toBeInTheDocument();
    expect(screen.getByText('Account name and password')).toBeInTheDocument();
    expect(screen.getByText('#t1234567')).toBeInTheDocument();
    expect(screen.getByRole('timer')).toHaveTextContent(/^\d+:\d\d$/);
  });

  it('falls back to the requested origin with a "not verified yet" note', () => {
    const { client } = fakeClient();
    renderForm(authSession({ verified_origin: null }), client);
    expect(screen.getByTestId('auth-origin')).toHaveTextContent('not verified yet');
  });

  it('adapts to the current step: e-mail only, password only, or both — with fixed headings and actions', () => {
    const { client } = fakeClient();
    const a = renderForm(authSession({ state: 'IDENTIFIER_REQUIRED', step: 'identifier' }, EMAIL_STEP), client);
    expect(screen.getByTestId('auth-step-heading')).toHaveTextContent('Email required');
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.queryByLabelText('Password')).toBeNull();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument();
    a.unmount();

    const b = renderForm(authSession({ state: 'PASSWORD_REQUIRED', step: 'password' }, PASSWORD_STEP), client);
    expect(screen.getByTestId('auth-step-heading')).toHaveTextContent('Password required');
    expect(screen.queryByLabelText('Email')).toBeNull();
    expect(document.querySelectorAll('input[type="password"]')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    b.unmount();

    renderForm(authSession(), client);
    expect(screen.getByTestId('auth-step-heading')).toHaveTextContent('Email and password required');
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
  });

  it('e-mail → password: the new request replaces the form (no e-mail field, nothing typed survives) and the save choice persists', async () => {
    const user = userEvent.setup();
    let open = 'ar_1';
    const { client, bodies } = fakeClient({ tokenRequestId: () => open });
    const step1 = authSession({ state: 'IDENTIFIER_REQUIRED', step: 'identifier' }, EMAIL_STEP);
    const view = renderForm(step1, client);
    await user.type(screen.getByLabelText('Email'), 'ada@example.com');
    await user.click(screen.getByRole('radio', { name: /Save to NEBULA Vault/ }));
    expect(screen.getByTestId('auth-save-together')).toHaveTextContent('The email and password will be saved together after a successful sign-in.');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({ action: 'credentials', values: { f1: 'ada@example.com' }, save: 'vault' });

    // the owner's answer moved the page on: no "page changed" notice; the host now reports save_intent "vault"
    view.rerender(<SmartAuthRequest session={authSession({ state: 'SUBMITTING', step_seq: 1, updated_at: Date.now() / 1000 }, null)} client={client} variant="mini" />);
    open = 'ar_2';
    view.rerender(
      <SmartAuthRequest
        session={authSession({ state: 'PASSWORD_REQUIRED', step: 'password', updated_at: Date.now() / 1000 + 1 }, { ...PASSWORD_STEP, save_intent: 'vault' })}
        client={client}
        variant="mini"
      />,
    );
    expect(screen.queryByLabelText('Email')).toBeNull();
    expect(screen.getByTestId('auth-step-heading')).toHaveTextContent('Password required');
    expect(document.body.innerHTML).not.toContain('ada@example.com');
    expect(screen.queryByTestId('auth-page-changed')).toBeNull();
    expect(screen.getByRole('radio', { name: /Save to NEBULA Vault/ })).toBeChecked();
    expect(screen.getByTestId('auth-save-together')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Password'), CANARY);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]).toMatchObject({ action: 'credentials', request_id: 'ar_2', values: { f3: CANARY }, save: 'vault' });
  });

  it('a newer request replacing an open form discards its state with a "page changed" notice; an older one never comes back', async () => {
    const user = userEvent.setup();
    const { client } = fakeClient();
    const older = authSession({ state: 'IDENTIFIER_REQUIRED', step: 'identifier' }, EMAIL_STEP);
    const view = renderForm(older, client);
    await user.type(screen.getByLabelText('Email'), 'ada@example.com');
    const newer = authSession({ state: 'PASSWORD_REQUIRED', step: 'password', updated_at: Date.now() / 1000 + 5 }, PASSWORD_STEP);
    view.rerender(<SmartAuthRequest session={newer} client={client} variant="mini" />);
    expect(screen.getByTestId('auth-page-changed')).toHaveTextContent('The page changed — this is the current step.');
    expect(screen.queryByLabelText('Email')).toBeNull();
    expect(screen.getByLabelText('Password')).toHaveValue('');
    // a late response with the older step must not overwrite the newer one
    view.rerender(<SmartAuthRequest session={older} client={client} variant="mini" />);
    expect(screen.queryByLabelText('Email')).toBeNull();
    expect(screen.getByTestId('smart-auth')).toHaveAttribute('data-state', 'PASSWORD_REQUIRED');
    expect(pickNewer(newer, older)).toBe(newer);
    expect(pickNewer(older, newer)).toBe(newer);
    expect(pickNewer(authSession({ state: 'AUTHENTICATED' }, null), newer).state).toBe('AUTHENTICATED');
  });

  it('OTP: autofocus, numeric keypad, one-time-code, maxLength from the length, paste normalisation, channel and TTL hints', async () => {
    const user = userEvent.setup();
    const { client, bodies } = fakeClient();
    const s = authSession({ state: 'OTP_REQUIRED', step: 'otp' }, { type: 'otp', step: 'otp', fields: [OTP_FIELD], otp: { channel: 'sms', length: 6, charset: 'numeric' }, code_ttl_s: 120 });
    renderForm(s, client);
    expect(screen.getByRole('heading', { name: 'Verification required' })).toBeInTheDocument();
    const code = screen.getByLabelText('Verification code');
    expect(document.activeElement).toBe(code);
    expect(code).toHaveAttribute('inputmode', 'numeric');
    expect(code).toHaveAttribute('autocomplete', 'one-time-code');
    expect(code).toHaveAttribute('maxlength', '6');
    expect(code).toHaveAccessibleDescription(/Enter the code sent to your phone/);
    expect(screen.getByText(/within 2 minutes/)).toBeInTheDocument();

    fireEvent.paste(code, { clipboardData: { getData: () => ' 123-456 ' } });
    expect(code).toHaveValue('123456');
    await user.click(screen.getByRole('button', { name: 'Submit code' }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({ action: 'code', request_id: 'ar_1', values: { f1: '123456' } });
    expect(bodies[0].pin).toBeUndefined();
  });

  it('OTP: variable length (3–12) and alphanumeric codes', async () => {
    const user = userEvent.setup();
    const { client, bodies } = fakeClient();
    const s = authSession(
      { state: 'OTP_REQUIRED' },
      { type: 'otp', step: 'otp', fields: [field({ id: 'f9', role: 'otp', input: 'code', length: null, charset: 'alphanumeric' })], otp: { channel: 'email', length: null, charset: 'alphanumeric' } },
    );
    renderForm(s, client);
    const code = screen.getByLabelText('Verification code');
    expect(code).toHaveAttribute('inputmode', 'text');
    expect(code).toHaveAttribute('maxlength', '12');
    expect(code).toHaveAccessibleDescription(/sent to your email/);
    await user.type(code, 'ab');
    await user.click(screen.getByRole('button', { name: 'Submit code' }));
    expect(await screen.findByText('The code has 3–12 characters')).toBeInTheDocument();
    expect(client.token).not.toHaveBeenCalled();
    await user.type(code, '-12 cD');
    expect(code).toHaveValue('ab12cD');
    await user.click(screen.getByRole('button', { name: 'Submit code' }));
    await waitFor(() => expect(bodies[0]?.values).toEqual({ f9: 'ab12cD' }));
    expect(normalizeCode('12 34-56', field({ id: 'f1', role: 'otp', charset: 'numeric', length: 6 }))).toBe('123456');
  });

  it('PIN: only when the host lists the action (never on this Mac or after a fresh confirmation); explained when none is set', async () => {
    const { client } = fakeClient();
    // local Dashboard: never a PIN
    const { unmount } = renderForm(authSession(), client);
    expect(screen.queryByLabelText('Remote sign-in PIN')).toBeNull();
    unmount();

    // remote credentials: PIN field
    const r1 = renderForm(authSession({}, REMOTE_CREDENTIALS), client);
    expect(screen.getByLabelText('Remote sign-in PIN')).toHaveAttribute('type', 'password');
    r1.unmount();

    // remote, but the owner confirmed it's them (fresh): the host sends no PIN actions — no PIN field
    const r0 = renderForm(authSession({}, { ...REMOTE_CREDENTIALS, fresh: true, pin_required_for: [] }), client);
    expect(screen.queryByLabelText('Remote sign-in PIN')).toBeNull();
    r0.unmount();

    // remote OTP: no PIN (one-time codes work without it)
    const r2 = renderForm(authSession({ state: 'OTP_REQUIRED' }, { ...REMOTE_CREDENTIALS, type: 'otp', pin_required_for: [], fields: [OTP_FIELD] }), client);
    expect(screen.queryByLabelText('Remote sign-in PIN')).toBeNull();
    r2.unmount();

    // remote recovery code: PIN
    const r3 = renderForm(authSession({ state: 'OTP_REQUIRED' }, { local: false, type: 'recovery_code', step: 'recovery_code', pin_required_for: ['code'], fields: [field({ id: 'f1', role: 'recovery_code' })] }), client);
    expect(screen.getByLabelText('Remote sign-in PIN')).toBeInTheDocument();
    r3.unmount();

    // remote credentials without a configured PIN: explained, Sign in disabled
    renderForm(authSession({}, { ...REMOTE_CREDENTIALS, pin_configured: false }), client);
    expect(screen.getByText('Remote sign-in PIN needed')).toBeInTheDocument();
    expect(screen.getByText(/Password Vault → Smart sign-in/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Sign in/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel sign-in' })).toBeEnabled();
  });

  it('trust GREEN: a calm verified line with the provider and no warning or confirmation', () => {
    const { client } = fakeClient();
    renderForm(authSession({}, { trust: trust('GREEN', [], 'Microsoft'), page_origin: 'https://login.microsoftonline.com' }), client);
    const t = screen.getByTestId('auth-trust');
    expect(t).toHaveAttribute('data-level', 'GREEN');
    expect(t).toHaveTextContent('Verified sign-in · Microsoft');
    expect(screen.queryByRole('checkbox', { name: /I checked/ })).toBeNull();
    expect(screen.queryByText(/Check this address/)).toBeNull();
    expect(screen.queryByTestId('auth-review')).toBeNull();
  });

  it('trust YELLOW: the exact host name, the reasons and the "I checked" confirmation before anything is sent', async () => {
    const user = userEvent.setup();
    const { client, bodies } = fakeClient();
    const yellow = trust('YELLOW', [['same_site_unverified', 'Another address of the same website (not verified)']]);
    renderForm(authSession({ verified_origin: 'https://login.github-auth.example' }, { trust: yellow, review_required: true, page_origin: 'https://login.github-auth.example' }), client);
    const box = screen.getByTestId('auth-trust');
    expect(box).toHaveAttribute('data-level', 'YELLOW');
    expect(within(box).getByTestId('auth-trust-host')).toHaveTextContent('login.github-auth.example');
    expect(box).toHaveTextContent('Another address of the same website (not verified)');
    await user.type(screen.getByLabelText('Email'), 'ada@example.com');
    await user.type(screen.getByLabelText('Password'), 'pw-123456');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Confirm that you checked the site first')).toBeInTheDocument();
    expect(client.token).not.toHaveBeenCalled();
    await user.click(screen.getByRole('checkbox', { name: /I checked that https:\/\/login\.github-auth\.example is the right site/ }));
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(bodies[0]).toMatchObject({ action: 'credentials', review_confirmed: true }));
  });

  it('trust RED: a blocked banner with the reasons and no submit controls — only Cancel', () => {
    const { client } = fakeClient();
    const red = trust('RED', [['lookalike:github.com', 'The address imitates github.com']]);
    renderForm(authSession({ verified_origin: 'https://gith0b.com' }, { trust: red, page_origin: 'https://gith0b.com', alternatives: ['code'] }), client);
    const blocked = screen.getByTestId('auth-blocked');
    expect(blocked).toHaveTextContent('NEBULA blocked this sign-in page');
    expect(blocked).toHaveTextContent('gith0b.com');
    expect(blocked).toHaveTextContent('The address imitates github.com');
    expect(screen.queryByRole('button', { name: /Sign in|Continue|Use a verification code/ })).toBeNull();
    expect(document.querySelectorAll('input')).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Cancel sign-in' })).toBeEnabled();
  });

  it('legacy review (no trust verdict): MEDIUM shows the flags and requires the confirmation; LOW is styled more severely', async () => {
    const user = userEvent.setup();
    const { client, bodies } = fakeClient();
    const s = authSession({ confidence: 'MEDIUM', trust: null }, { trust: null, confidence: 'MEDIUM', review_required: true, flags: ['brand_mismatch:github', 'plain_http'] });
    const { unmount } = renderForm(s, client);
    const review = screen.getByTestId('auth-review');
    expect(review).toHaveAttribute('data-severity', 'medium');
    expect(within(review).getByText('The page looks like GitHub, but it is not on a GitHub domain')).toBeInTheDocument();
    expect(within(review).getByText('The page is not encrypted (plain HTTP)')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Email'), 'ada@example.com');
    await user.type(screen.getByLabelText('Password'), 'pw-123456');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Confirm that you checked the site first')).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: /I checked that https:\/\/github.com is the right site/ }));
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({ action: 'credentials', review_confirmed: true, save: 'once' });
    unmount();
    renderForm(authSession({ trust: null }, { trust: null, confidence: 'LOW', review_required: true, flags: ['other_site'] }), client);
    expect(screen.getByTestId('auth-review')).toHaveAttribute('data-severity', 'high');
    expect(screen.getByText('Careful — this sign-in page looks suspicious')).toBeInTheDocument();
    expect(flagReason('brand_mismatch:paypal')).toBe('The page looks like PayPal, but it is not on a PayPal domain');
  });

  it('save options: "Use once" by default; a locked vault shows its reason and an inline unlock; typed values stay', async () => {
    const user = userEvent.setup();
    const onReload = vi.fn();
    const { client, bodies } = fakeClient({ unlockVault: async () => ({ locked: false }) });
    const locked = { state: 'locked' as const, can_save: false, can_unlock: true, reason: 'The Password Vault is locked. Unlock it to save credentials or use a saved account.' };
    const view = renderForm(authSession({}, { vault: locked }), client, { onReload });
    expect(screen.getByRole('radio', { name: /^Use once/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: /Save to NEBULA Vault/ })).toHaveAccessibleDescription(locked.reason);
    await user.type(screen.getByLabelText('Email'), 'ada@example.com');
    await user.click(screen.getByRole('radio', { name: /Save to NEBULA Vault/ }));
    const gate = screen.getByTestId('auth-vault-gate');
    expect(gate).toHaveTextContent('Password Vault locked');
    expect(within(gate).getByTestId('auth-vault-reason')).toHaveTextContent(locked.reason);
    expect(screen.getByRole('button', { name: /^Sign in/ })).toBeDisabled();
    // Enter in the passphrase field unlocks; it never submits the sign-in
    await user.type(within(gate).getByLabelText('Vault passphrase'), `${CANARY}{Enter}`);
    await waitFor(() => expect(client.unlockVault).toHaveBeenCalledWith(CANARY));
    expect(onReload).toHaveBeenCalled();
    expect(client.token).not.toHaveBeenCalled();
    expect(within(gate).getByLabelText('Vault passphrase')).toHaveValue('');
    // the refreshed session (same request): unlocked — the form and what was typed are kept
    view.rerender(<SmartAuthRequest session={authSession({ updated_at: Date.now() / 1000 + 2 }, { vault: { state: 'unlocked', can_save: true, can_unlock: false, reason: null } })} client={client} variant="mini" onReload={onReload} />);
    expect(screen.queryByTestId('auth-vault-gate')).toBeNull();
    expect(screen.getByLabelText('Email')).toHaveValue('ada@example.com');
    expect(screen.getByRole('radio', { name: /Save to NEBULA Vault/ })).toBeChecked();
    await user.type(screen.getByLabelText('Password'), 'pw-123456');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(bodies[0]).toMatchObject({ action: 'credentials', save: 'vault', allow_future: false }));
    expect(document.body.innerHTML).not.toContain(CANARY);
  });

  it('save options: no vault yet — the reason is shown and saving cannot be chosen (never silently)', () => {
    const { client } = fakeClient({ unlockVault: async () => ({}) });
    renderForm(authSession({}, { vault: { state: 'not_created', can_save: false, can_unlock: false, reason: 'Set up the Password Vault first (Password Vault → Create).' } }), client);
    const vault = screen.getByRole('radio', { name: /Save to NEBULA Vault/ });
    expect(vault).toBeDisabled();
    expect(vault).toHaveAccessibleDescription('Set up the Password Vault first (Password Vault → Create).');
  });

  it('saved account: "Use an existing saved account" sends action "saved"; "allow in future" only for an account without a grant', async () => {
    const user = userEvent.setup();
    const { client, bodies } = fakeClient();
    const s = authSession(
      {},
      {
        ...REMOTE_CREDENTIALS,
        allow_future_needs_stepup: false,
        accounts: [
          { entry_id: 'e1', name: 'GitHub (work)', username: 'ada-work', has_grant: true, policy: 'always_ask' },
          { entry_id: 'e2', name: 'GitHub (private)', username: 'ada', has_grant: false },
        ],
      },
    );
    renderForm(s, client);
    await user.click(screen.getByRole('radio', { name: /Use an existing saved account/ }));
    expect(screen.queryByLabelText('Email')).toBeNull();
    expect(screen.getByText('Allowed for this agent')).toBeInTheDocument();
    // granted account: no "allow in future", no PIN (remote)
    expect(screen.getByRole('radio', { name: /GitHub \(work\)/ })).toBeChecked();
    expect(screen.queryByRole('checkbox', { name: /in the future/ })).toBeNull();
    expect(screen.queryByLabelText('Remote sign-in PIN')).toBeNull();
    // account without a grant: checkbox + PIN
    await user.click(screen.getByRole('radio', { name: /GitHub \(private\)/ }));
    await user.click(screen.getByRole('checkbox', { name: 'Allow this agent to request this credential in the future' }));
    await user.type(screen.getByLabelText('Remote sign-in PIN'), '846213');
    await user.click(screen.getByRole('button', { name: 'Use saved account' }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual({ request_id: 'ar_1', token: 'tok_abcdefghijklmnopqrstuvwxyz', action: 'saved', entry_id: 'e2', allow_future: true, pin: '846213' });
    expect(bodies[0].values).toBeUndefined();
    // back to typing
    await user.click(screen.getByRole('radio', { name: /^Use once/ }));
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
  });

  it('"allow in future" from the phone: the owner confirms it is them BEFORE the single-use token is fetched', async () => {
    const user = userEvent.setup();
    let confirm = false;
    const { client, order, bodies } = fakeClient({ ensureFresh: async () => confirm });
    renderForm(authSession({}, { ...REMOTE_CREDENTIALS, fresh: false }), client);
    await user.type(screen.getByLabelText('Email'), 'ada@example.com');
    await user.type(screen.getByLabelText('Password'), 'pw-123456');
    await user.click(screen.getByRole('radio', { name: /Save to NEBULA Vault/ }));
    const allow = screen.getByRole('checkbox', { name: 'Allow this agent to request this credential in the future' });
    expect(allow).toHaveAccessibleDescription(/confirm it’s you first/);
    await user.click(allow);
    await user.type(screen.getByLabelText('Remote sign-in PIN'), '846213');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByTestId('auth-error')).toHaveAttribute('data-code', 'stepup_required');
    expect(order).toEqual(['fresh']);
    confirm = true;
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(order).toEqual(['fresh', 'fresh', 'token', 'submit']);
    expect(bodies[0]).toMatchObject({ save: 'vault', allow_future: true });
  });

  it('submits with a fresh token first (token → submit), the right body, then clears every typed value and the PIN', async () => {
    const user = userEvent.setup();
    const { client, order, bodies } = fakeClient({ submit: () => authSession({}, REMOTE_CREDENTIALS) });
    const onSession = vi.fn();
    renderForm(authSession({}, REMOTE_CREDENTIALS), client, { onSession });
    await user.type(screen.getByLabelText('Email'), 'ada@example.com');
    await user.type(screen.getByLabelText('Password'), CANARY);
    await user.click(screen.getByRole('radio', { name: /Save to NEBULA Vault/ }));
    await user.type(screen.getByLabelText(/Name in the vault/), 'GitHub work');
    expect(screen.getByRole('checkbox', { name: 'Allow this agent to request this credential in the future' })).not.toBeChecked();
    await user.type(screen.getByLabelText('Remote sign-in PIN'), '846213');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(onSession).toHaveBeenCalled());
    expect(order).toEqual(['token', 'submit']);
    expect(bodies[0]).toEqual({
      request_id: 'ar_1',
      token: 'tok_abcdefghijklmnopqrstuvwxyz',
      action: 'credentials',
      values: { f1: 'ada@example.com', f2: CANARY },
      save: 'vault',
      allow_future: false,
      name: 'GitHub work',
      pin: '846213',
    });
    // the same request is still shown (no event yet): every field is empty again
    expect(screen.getByLabelText('Email')).toHaveValue('');
    expect(screen.getByLabelText('Password')).toHaveValue('');
    expect(screen.getByLabelText('Remote sign-in PIN')).toHaveValue('');
    expect(document.body.innerHTML).not.toContain(CANARY);
  });

  it('a failed submit (wrong PIN) shows the API message with attempts left and keeps the form', async () => {
    const user = userEvent.setup();
    const { client } = fakeClient({
      submit: () => {
        throw new ApiError(403, 'pin_invalid', 'Wrong PIN.', { attempts_left: 2 });
      },
    });
    renderForm(authSession({}, REMOTE_CREDENTIALS), client);
    await user.type(screen.getByLabelText('Email'), 'ada@example.com');
    await user.type(screen.getByLabelText('Password'), CANARY);
    await user.type(screen.getByLabelText('Remote sign-in PIN'), '999999');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    const err = await screen.findByTestId('auth-error');
    expect(err).toHaveTextContent('Wrong PIN. 2 attempts left before a temporary lock.');
    expect(err).toHaveAttribute('data-code', 'pin_invalid');
    expect(err).toHaveAttribute('role', 'alert');
    expect(err.textContent).not.toContain(CANARY);
    expect(screen.getByLabelText('Email')).toHaveValue('ada@example.com');
    expect(screen.getByLabelText('Password')).toHaveValue(CANARY);
    expect(screen.getByLabelText('Remote sign-in PIN')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  });

  it('request_closed (the page moved on): reloads with a short notice and never resubmits by itself', async () => {
    const user = userEvent.setup();
    const onReload = vi.fn();
    const { client, bodies } = fakeClient({
      submit: () => {
        throw new ApiError(409, 'request_closed', 'this request was already answered or replaced');
      },
    });
    const view = renderForm(authSession(), client, { onReload });
    await user.type(screen.getByLabelText('Email'), 'ada@example.com');
    await user.type(screen.getByLabelText('Password'), 'pw-123456');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByTestId('auth-error')).toHaveTextContent('The sign-in page moved on. It was reloaded — nothing was sent.');
    expect(onReload).toHaveBeenCalledTimes(1);
    await act(async () => new Promise((r) => setTimeout(r, 50)));
    expect(bodies).toHaveLength(1);
    // the reloaded session shows the current step, with the notice
    view.rerender(
      <SmartAuthRequest
        session={authSession({ state: 'OTP_REQUIRED', updated_at: Date.now() / 1000 + 3 }, { id: 'ar_2', seq: 2, type: 'otp', step: 'otp', fields: [OTP_FIELD] })}
        client={client}
        variant="mini"
        onReload={onReload}
      />,
    );
    expect(screen.getByTestId('auth-page-changed')).toBeInTheDocument();
    expect(screen.getByLabelText('Verification code')).toBeInTheDocument();
    expect(client.submit).toHaveBeenCalledTimes(1);
  });

  it('vault_locked / blocked_suspicious answers: clear explanations and a reload', async () => {
    const user = userEvent.setup();
    const onReload = vi.fn();
    let code = 'vault_locked';
    const { client } = fakeClient({
      submit: () => {
        throw code === 'vault_locked'
          ? new ApiError(409, 'vault_locked', 'locked', { vault_state: 'locked' })
          : new ApiError(403, 'blocked_suspicious', 'This sign-in was blocked as suspicious; nothing can be submitted.');
      },
    });
    renderForm(authSession({}, { save_intent: 'vault' }), client, { onReload });
    await user.type(screen.getByLabelText('Email'), 'ada@example.com');
    await user.type(screen.getByLabelText('Password'), 'pw-123456');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByTestId('auth-error')).toHaveTextContent('Your Password Vault is locked. Unlock it, or choose “Use once”.');
    expect(onReload).toHaveBeenCalledTimes(1);
    code = 'blocked';
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(screen.getByTestId('auth-error')).toHaveTextContent('This sign-in was blocked as suspicious — nothing can be submitted.'));
    expect(onReload).toHaveBeenCalledTimes(2);
  });

  it('never sends values to a request that was replaced meanwhile (token for another request)', async () => {
    const user = userEvent.setup();
    const onReload = vi.fn();
    const { client } = fakeClient({ tokenRequestId: 'ar_2' });
    renderForm(authSession(), client, { onReload });
    await user.type(screen.getByLabelText('Email'), 'ada@example.com');
    await user.type(screen.getByLabelText('Password'), 'pw-123456');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByTestId('auth-error')).toHaveTextContent('This request changed meanwhile');
    expect(client.submit).not.toHaveBeenCalled();
    expect(onReload).toHaveBeenCalled();
  });

  it('writes nothing typed to localStorage / sessionStorage', async () => {
    const user = userEvent.setup();
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const { client } = fakeClient({
      submit: () => {
        throw new ApiError(400, 'invalid_value', 'empty or invalid value');
      },
    });
    renderForm(authSession({}, REMOTE_CREDENTIALS), client);
    await user.type(screen.getByLabelText('Email'), `${CANARY}@example.com`);
    await user.type(screen.getByLabelText('Password'), CANARY);
    await user.type(screen.getByLabelText('Remote sign-in PIN'), CANARY);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByTestId('auth-error');
    for (const call of setItem.mock.calls) expect(JSON.stringify(call)).not.toContain(CANARY);
    for (const st of [window.localStorage, window.sessionStorage]) {
      if (!st || typeof st.length !== 'number') continue;
      for (let i = 0; i < st.length; i += 1) expect(st.getItem(st.key(i) as string) ?? '').not.toContain(CANARY);
    }
  });

  it('why the step is shown again: rejected details / code, the page changed, the page did not react', () => {
    const { client } = fakeClient();
    const cases: [Partial<AuthSession>, Partial<AuthRequest>, string, string | null][] = [
      [{ attempts: { credentials: 1, codes: 0, max_credentials: 3, max_codes: 3 } }, { error: 'credentials_rejected' }, 'The website did not accept these details. Check them and try again.', 'Attempt 2 of 3.'],
      [{ state: 'OTP_REQUIRED' }, { type: 'otp', error: 'code_rejected', fields: [OTP_FIELD] }, 'The verification code was rejected. Please enter a new code.', null],
      [{}, { error: 'page_changed' }, 'The sign-in page changed — this is the current step.', null],
      [{}, { error: 'no_progress' }, 'The page did not react — check the details and try again.', null],
    ];
    for (const [s, r, title, extra] of cases) {
      const { unmount } = renderForm(authSession(s, r), client);
      expect(screen.getByTestId('auth-step-error')).toHaveTextContent(title);
      if (extra) expect(screen.getByText(extra)).toBeInTheDocument();
      unmount();
    }
  });

  it('confirm_destination: explains where it continues; Allow needs the check (and the PIN remotely when secrets are pending)', async () => {
    const user = userEvent.setup();
    const { client, bodies } = fakeClient();
    const s = authSession(
      { state: 'REDIRECT_REVIEW_REQUIRED', step: 'destination' },
      {
        type: 'confirm_destination',
        step: 'destination',
        fields: [],
        confidence: 'LOW',
        review_required: true,
        flags: ['other_site'],
        trust: trust('YELLOW', [['unverified_destination', 'This site is not a verified sign-in provider for the service']]),
        local: false,
        pin_required_for: ['allow_destination_with_secrets'],
        destination: { origin: 'https://login.example-sso.com', kind: 'form_target', same_site: false, requested_origin: 'https://github.com', secrets_pending: true },
      },
    );
    renderForm(s, client);
    expect(screen.getByRole('heading', { name: 'Review sign-in destination' })).toBeInTheDocument();
    const box = screen.getByTestId('auth-destination');
    expect(box).toHaveTextContent('The sign-in continues on https://login.example-sso.com (requested: https://github.com)');
    expect(box).toHaveTextContent('This is a different site.');
    expect(box).toHaveTextContent('The sign-in form wants to send what you typed to this site.');
    expect(screen.getByTestId('auth-trust-host')).toHaveTextContent('login.example-sso.com');
    expect(box).toHaveTextContent('This site is not a verified sign-in provider for the service');
    await user.click(screen.getByRole('checkbox', { name: /login\.example-sso\.com is the right site/ }));
    await user.type(screen.getByLabelText('Remote sign-in PIN'), '846213');
    await user.click(screen.getByRole('button', { name: 'Allow' }));
    await waitFor(() => expect(bodies[0]).toEqual({ request_id: 'ar_1', token: 'tok_abcdefghijklmnopqrstuvwxyz', action: 'allow_destination', review_confirmed: true, pin: '846213' }));
  });

  it('device approval: waiting screen with instructions; "Check now" sends "check" and never claims approval', async () => {
    const user = userEvent.setup();
    const { client, bodies } = fakeClient({ submit: () => authSession({ state: 'AUTHENTICATOR_APPROVAL' }, { type: 'device_approval', step: 'device_approval', fields: [] }) });
    // an older host's state name (DEVICE_APPROVAL_REQUIRED) is read as AUTHENTICATOR_APPROVAL
    renderForm(authSession({ state: 'DEVICE_APPROVAL_REQUIRED' as AuthSession['state'], step: 'device_approval' }, { type: 'device_approval', step: 'device_approval', fields: [] }), client);
    expect(screen.getByTestId('smart-auth')).toHaveAttribute('data-state', 'AUTHENTICATOR_APPROVAL');
    expect(screen.getByRole('heading', { name: 'Approve in your authenticator app' })).toBeInTheDocument();
    expect(screen.getByText('Approve the sign-in on your device')).toBeInTheDocument();
    expect(screen.queryByTestId('auth-approval-number')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Check now' }));
    await waitFor(() => expect(bodies[0]).toMatchObject({ action: 'check' }));
    expect(await screen.findByText(/NEBULA is checking again/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/approved|signed in/i);
  });

  it('alternatives: fixed labels by kind (never page text); a choice submits {action: "choose", alternative}', async () => {
    const user = userEvent.setup();
    const { client, bodies } = fakeClient();
    renderForm(authSession({ state: 'OTP_REQUIRED' }, { type: 'otp', step: 'otp', fields: [OTP_FIELD], alternatives: ['password', 'app'] }), client);
    const alts = screen.getByTestId('auth-alternatives');
    expect(within(alts).getAllByRole('button').map((b) => b.textContent)).toEqual(['Use my password instead', 'Approve in the authenticator app instead']);
    await user.click(within(alts).getByRole('button', { name: 'Use my password instead' }));
    await waitFor(() => expect(bodies[0]).toEqual({ request_id: 'ar_1', token: 'tok_abcdefghijklmnopqrstuvwxyz', action: 'choose', alternative: 'password' }));
  });

  it('method choice: one button per offered kind plus Live Desktop; nothing to type', async () => {
    const user = userEvent.setup();
    const { client, bodies } = fakeClient();
    renderForm(authSession({ state: 'WAITING_FOR_USER', step: 'method_choice' }, { type: 'method_choice', step: 'method_choice', fields: [], alternatives: ['password', 'code', 'app', 'more'] }), client);
    expect(screen.getByRole('heading', { name: 'Choose how to sign in' })).toBeInTheDocument();
    for (const label of ['Use password', 'Use a verification code', 'Approve in the authenticator app', 'Show other ways to sign in']) expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    expect(document.querySelectorAll('input')).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Use a verification code' }));
    await waitFor(() => expect(bodies[0]).toMatchObject({ action: 'choose', alternative: 'code' }));
    await user.click(screen.getByRole('button', { name: 'Finish in Live Desktop instead' }));
    await waitFor(() => expect(bodies[1]).toMatchObject({ action: 'handoff' }));
  });

  it('passkey / CAPTCHA with other ways: Live Desktop hand-off button plus "Use my password instead"', async () => {
    const user = userEvent.setup();
    const { client, bodies } = fakeClient();
    renderForm(authSession({ state: 'PASSKEY_REQUIRED', step: 'passkey' }, { type: 'manual', step: 'passkey', fields: [], manual: { kind: 'passkey', live_desktop: true }, alternatives: ['password'] }), client);
    expect(screen.getByTestId('auth-manual')).toHaveAttribute('data-handoff', 'pending');
    expect(screen.queryByRole('button', { name: 'I’m done' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Finish in Live Desktop' }));
    await waitFor(() => expect(bodies[0]).toMatchObject({ action: 'handoff' }));
    await user.click(screen.getByRole('button', { name: 'Use my password instead' }));
    await waitFor(() => expect(bodies[1]).toMatchObject({ action: 'choose', alternative: 'password' }));
  });

  it('loop: explains the stop and offers Retry / Inspect in Live Desktop / Cancel', async () => {
    const user = userEvent.setup();
    const { client, bodies } = fakeClient();
    renderForm(authSession({ state: 'WAITING_FOR_USER', error_code: 'loop_no_progress' }, { type: 'loop', step: 'loop', fields: [], loop: { reason: 'no_progress', page_step: 'password' } }), client);
    expect(screen.getByRole('heading', { name: 'Sign-in paused' })).toBeInTheDocument();
    const loop = screen.getByTestId('auth-loop');
    expect(loop).toHaveTextContent('The page did not react');
    expect(loop).toHaveTextContent('Current page: Password.');
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(bodies[0]).toMatchObject({ action: 'retry' }));
    await user.click(screen.getByRole('button', { name: 'Inspect in Live Desktop' }));
    await waitFor(() => expect(bodies[1]).toMatchObject({ action: 'inspect' }));
    expect(screen.getByRole('button', { name: 'Cancel sign-in' })).toBeInTheDocument();
  });

  it('manual step: explains it, links Live Desktop with a warning, "I’m done" sends manual_done and handles still_sign_in_page', async () => {
    const user = userEvent.setup();
    const onReload = vi.fn();
    const { client, bodies } = fakeClient({
      submit: () => {
        throw new ApiError(409, 'still_sign_in_page', "The agent's browser still shows a sign-in step on the site. Finish it in Live Desktop, then tap Done again.");
      },
    });
    renderForm(authSession({ state: 'CAPTCHA_REQUIRED', step: 'captcha' }, { type: 'manual', step: 'captcha', fields: [], manual: { kind: 'captcha', live_desktop: true } }), client, {
      liveDesktopHref: '#/agents/a1/desktop',
      onReload,
    });
    expect(screen.getByRole('heading', { name: 'Finish this step yourself' })).toBeInTheDocument();
    expect(screen.getByText(/CAPTCHA that only a person can solve/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Live Desktop' })).toHaveAttribute('href', '#/agents/a1/desktop');
    expect(screen.getByText('Anything you type in Live Desktop is visible to the agent’s computer — use it only for this step.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'I’m done' }));
    await waitFor(() => expect(bodies[0]).toMatchObject({ action: 'manual_done' }));
    expect(await screen.findByTestId('auth-error')).toHaveTextContent('still shows a sign-in step');
    expect(onReload).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'I’m done' })).toBeEnabled();
  });

  it('final states and progress', () => {
    const { client } = fakeClient();
    const onClose = vi.fn();
    const cases: [Partial<AuthSession>, RegExp][] = [
      [{ state: 'AUTHENTICATED', completed_at: Date.now() / 1000 }, /Signed in — the agent continues.*Nothing you typed was stored/],
      [{ state: 'AUTHENTICATED', saved_to_vault: true }, /saved to your NEBULA Vault/],
      [{ state: 'AUTHENTICATED', error_code: 'not_saved_vault_locked' }, /not saved: the Password Vault was locked/],
      [{ state: 'CANCELLED' }, /Sign-in cancelled/],
      [{ state: 'EXPIRED', error_code: 'request_expired' }, /Sign-in request expired.*Nobody answered the request in time/],
      [{ state: 'FAILED', error_code: 'too_many_attempts' }, /Sign-in failed.*Too many wrong attempts/],
      [{ state: 'FAILED', error_code: 'broker_unavailable' }, /isolated sign-in browser is not available/],
      [{ state: 'FAILED', error_code: 'suspicious_page', trust: trust('RED', [['lookalike:github.com', 'The address imitates github.com']]) }, /blocked this sign-in page as suspicious.*imitates github\.com/],
      [{ state: 'FAILED', error_code: 'site_unreachable' }, /could not be reached/],
      [{ state: 'INITIALIZING' }, /Opening the sign-in page/],
      [{ state: 'SUBMITTING' }, /Signing in…/],
      [{ state: 'VERIFYING' }, /Checking what the website asks for next/],
    ];
    for (const [over, text] of cases) {
      const { unmount } = renderForm(authSession(over, null), client, { onClose });
      expect(screen.getByTestId('smart-auth').textContent).toMatch(text);
      expect(screen.queryByLabelText('Password')).toBeNull();
      unmount();
    }
  });

  it('cancel asks first, then cancels and clears the form', async () => {
    const user = userEvent.setup();
    const onSession = vi.fn();
    const { client } = fakeClient();
    renderForm(authSession(), client, { onSession });
    await user.type(screen.getByLabelText('Password'), CANARY);
    await user.click(screen.getByRole('button', { name: 'Cancel sign-in' }));
    await act(async () => {
      await user.click(screen.getByRole('button', { name: 'Yes, cancel sign-in' }));
    });
    expect(client.cancel).toHaveBeenCalledWith('as_0123456789abcdef01234567');
    expect(onSession).toHaveBeenCalledWith(expect.objectContaining({ state: 'CANCELLED' }));
    expect(client.token).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------- V3.4 (Smart Authentication 3.0)
describe('SmartAuthRequest V3.4 (Smart Authentication 3.0)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('every state has a title and subtitle; card texts name what the page asks; the old state name maps to the new one', () => {
    for (const [state, info] of Object.entries(STATE_INFO)) {
      expect(info.title, state).toBeTruthy();
      expect(info.subtitle, state).toBeTruthy();
    }
    expect(stateInfo('EMAIL_REQUIRED').title).toBe('Email required');
    expect(stateInfo('USERNAME_REQUIRED').title).toBe('Username required');
    expect(stateInfo('PHONE_REQUIRED').title).toBe('Phone number required');
    expect(stateInfo('AUTHENTICATOR_APPROVAL').title).toBe('Approve in your authenticator app');
    expect(stateInfo('DEVICE_APPROVAL_REQUIRED').title).toBe('Approve in your authenticator app');
    expect(stateInfo('SECURITY_KEY_REQUIRED').title).toBe('Security key requested');
    expect(stateInfo('PASSKEY_REQUIRED').title).toBe('Passkey requested');
    expect(stateInfo('LOGIN_ERROR').title).toBe('Wrong sign-in details');
    expect(stateInfo('UNKNOWN_STEP').title).toBe('Unrecognised sign-in step');
    expect(stateText(V34.email())).toBe('Waiting for your email');
    expect(stateText(V34.username())).toBe('Waiting for your username');
    expect(stateText(V34.phone())).toBe('Waiting for your phone number');
    expect(stateText(V34.loginError())).toMatch(/^Wrong sign-in details/);
    expect(stateText(V34.unknown())).toMatch(/^Unrecognised sign-in step/);
    expect(stateText(V34.securityKey())).toMatch(/^Security key requested/);
    expect(stateText(V34.authenticator('42'))).toBe('Enter 42 in your authenticator app');
    expect(stateText(V34.authenticator(null))).toBe('Waiting for approval in your authenticator app');
    expect(stateText({ ...V34.authenticator(null), state: 'DEVICE_APPROVAL_REQUIRED' as AuthSession['state'] })).toBe('Waiting for approval in your authenticator app');
    for (const st of ['EMAIL_REQUIRED', 'LOGIN_ERROR', 'UNKNOWN_STEP', 'SECURITY_KEY_REQUIRED', 'AUTHENTICATOR_APPROVAL', 'DEVICE_APPROVAL_REQUIRED'] as AuthSession['state'][]) {
      expect(stateLabel(st)).toBe('Waiting for you');
    }
  });

  it('identifier steps: EMAIL / USERNAME / PHONE render exactly the one field the page asks for, focused, with the right keyboard', () => {
    const { client } = fakeClient();
    const cases: [AuthSession, string, string, Record<string, string>][] = [
      [V34.email(), 'Email required', 'Email', { type: 'email', inputmode: 'email', autocomplete: 'username', enterkeyhint: 'go' }],
      [V34.username(), 'Username required', 'Username', { type: 'text', autocomplete: 'username', enterkeyhint: 'go' }],
      [V34.phone(), 'Phone number required', 'Phone number', { type: 'tel', inputmode: 'tel', autocomplete: 'username', enterkeyhint: 'go' }],
    ];
    for (const [s, heading, label, attrs] of cases) {
      const view = renderForm(s, client);
      expect(screen.getByTestId('smart-auth')).toHaveAttribute('data-state', s.state);
      expect(screen.getByTestId('auth-step-heading')).toHaveTextContent(heading);
      const typed = screen.getByTestId('auth-typed');
      expect(typed.querySelectorAll('input')).toHaveLength(1);
      const input = screen.getByLabelText(label);
      for (const [k, v] of Object.entries(attrs)) expect(input, `${label} ${k}`).toHaveAttribute(k, v);
      expect(document.activeElement).toBe(input);
      expect(screen.queryByLabelText('Password')).toBeNull();
      expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument();
      view.unmount();
    }
  });

  it('email + password: the first field is focused, "next" then "go"; password: current-password; OTP: one-time-code, numeric, "done"', () => {
    const { client } = fakeClient();
    const a = renderForm(authSession(), client);
    expect(document.activeElement).toBe(screen.getByLabelText('Email'));
    expect(screen.getByLabelText('Email')).toHaveAttribute('enterkeyhint', 'next');
    const pw = screen.getByLabelText('Password');
    expect(pw).toHaveAttribute('type', 'password');
    expect(pw).toHaveAttribute('autocomplete', 'current-password');
    expect(pw).toHaveAttribute('enterkeyhint', 'go');
    a.unmount();
    renderForm(authSession({ state: 'OTP_REQUIRED', step: 'otp' }, { type: 'otp', step: 'otp', requirement: 'OTP_REQUIRED', fields: [OTP_FIELD], otp: { channel: 'totp', length: 6, charset: 'numeric' } }), client);
    const code = screen.getByLabelText('Verification code');
    expect(code).toHaveAttribute('inputmode', 'numeric');
    expect(code).toHaveAttribute('autocomplete', 'one-time-code');
    expect(code).toHaveAttribute('enterkeyhint', 'done');
    expect(document.activeElement).toBe(code);
  });

  it('LOGIN_ERROR with requirement PASSWORD_REQUIRED: the error banner above ONLY the password field; one banner, the attempt count', async () => {
    const user = userEvent.setup();
    const { client, bodies } = fakeClient({ tokenRequestId: 'ar_3' });
    renderForm(V34.loginError(), client);
    expect(screen.getByTestId('smart-auth')).toHaveAttribute('data-state', 'LOGIN_ERROR');
    const banner = screen.getByTestId('auth-login-error');
    expect(banner).toHaveAttribute('role', 'alert');
    expect(banner).toHaveTextContent('Wrong sign-in details');
    expect(banner).toHaveTextContent('The site did not accept these details. Check them and try again.');
    expect(banner).toHaveTextContent('Attempt 2 of 3.');
    expect(screen.queryByTestId('auth-step-error')).toBeNull();
    expect(screen.getByTestId('auth-step-heading')).toHaveTextContent('Password required');
    const typed = screen.getByTestId('auth-typed');
    expect(typed.querySelectorAll('input')).toHaveLength(1);
    expect(screen.queryByLabelText('Email')).toBeNull();
    // the banner comes before the field
    expect(banner.compareDocumentPosition(typed) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await user.type(screen.getByLabelText('Password'), CANARY);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(bodies[0]).toMatchObject({ action: 'credentials', request_id: 'ar_3', values: { f3: CANARY } }));
  });

  it('notes: fixed texts for what NEBULA did on the page; unknown codes are ignored, duplicates shown once', () => {
    const { client } = fakeClient();
    const notes = ['passkey_cancelled', 'chose_password', 'declined_nag', 'declined_prompt', 'restarted_from_service', '<b>page text</b>', 'opened_other_ways', 'declined_kmsi', 'restarted_at_provider', 'security_key_cancelled'];
    renderForm(V34.password({ notes }), client);
    const list = screen.getByTestId('auth-notes');
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'The site asked for a passkey. NEBULA’s secure browser has none, so it closed that prompt.',
      'NEBULA chose the site’s “use your password” option.',
      'NEBULA skipped an optional prompt.',
      'NEBULA started the sign-in again from the service’s start page — the agent’s window may show a different step.',
      'NEBULA opened the site’s other sign-in options.',
      'NEBULA answered “No” to “Stay signed in?”.',
      'NEBULA started again at the provider’s sign-in page.',
      'The site asked for a security key. NEBULA’s secure browser has none, so it closed that prompt.',
    ]);
    expect(document.body.textContent).not.toContain('page text');
    expect(noteTexts({ notes: ['nope'] })).toEqual([]);
    expect(noteTexts({})).toEqual([]);
  });

  it('authenticator approval with a number: "Enter 42 in your authenticator app" shown large; keeps waiting; Check now sends "check"', async () => {
    const user = userEvent.setup();
    const { client, bodies } = fakeClient({ submit: () => V34.authenticator('42') });
    renderForm(V34.authenticator('42'), client);
    expect(screen.getByRole('heading', { name: 'Approve in your authenticator app' })).toBeInTheDocument();
    const box = screen.getByTestId('auth-approval-number');
    expect(within(box).getByText('Enter 42 in your authenticator app')).toBeInTheDocument();
    expect(within(box).getByText('42')).toHaveClass('text-5xl');
    expect(screen.getByText('Waiting for your approval')).toBeInTheDocument();
    expect(screen.getByTestId('auth-device').querySelector('.animate-spin')).not.toBeNull();
    expect(screen.getByTestId('auth-notes')).toHaveTextContent('NEBULA chose the site’s “use your password” option.');
    await user.click(screen.getByRole('button', { name: 'Check now' }));
    await waitFor(() => expect(bodies[0]).toMatchObject({ action: 'check' }));
    // a malformed number from an old host is never shown
    const odd = V34.authenticator('42');
    odd.request = { ...(odd.request as AuthRequest), approval_number: 'abcd' };
    const { unmount } = renderForm(odd, client);
    expect(screen.getAllByText('Approve the sign-in on your device')).toHaveLength(1);
    unmount();
  });

  it('security key (cannot be completed here): explains it, offers the site’s other ways, Live Desktop and Cancel', async () => {
    const user = userEvent.setup();
    const { client, bodies } = fakeClient();
    renderForm(V34.securityKey({ manual: { kind: 'security_key', live_desktop: true, can_complete_here: false, webauthn_pending: true } }), client);
    expect(screen.getByRole('heading', { name: 'Security key requested' })).toBeInTheDocument();
    expect(screen.getByTestId('smart-auth')).toHaveAttribute('data-state', 'SECURITY_KEY_REQUIRED');
    expect(screen.getByTestId('auth-key')).toHaveTextContent('NEBULA’s secure browser has no passkey or security key. Choose another way below, or finish in Live Desktop.');
    expect(screen.getByTestId('auth-webauthn-pending')).toHaveTextContent('The site’s security key prompt is still open.');
    expect(screen.getByTestId('auth-notes')).toHaveTextContent('The site asked for a security key.');
    const alts = screen.getByTestId('auth-alternatives');
    expect(within(alts).getAllByRole('button').map((b) => b.textContent)).toEqual(['Use my password instead', 'Show other ways to sign in']);
    expect(screen.queryByRole('button', { name: 'I’m done' })).toBeNull();
    await user.click(within(alts).getByRole('button', { name: 'Use my password instead' }));
    await waitFor(() => expect(bodies[0]).toMatchObject({ action: 'choose', alternative: 'password' }));
    await user.click(screen.getByRole('button', { name: 'Finish in Live Desktop' }));
    await waitFor(() => expect(bodies[1]).toMatchObject({ action: 'handoff' }));
    expect(screen.getByRole('button', { name: 'Cancel sign-in' })).toBeInTheDocument();
  });

  it('passkey requested: its own title; after the hand-off (no other ways) the Live Desktop step explains why', () => {
    const { client } = fakeClient();
    const a = renderForm(V34.passkey(), client);
    expect(screen.getByRole('heading', { name: 'Passkey requested' })).toBeInTheDocument();
    expect(screen.getByTestId('auth-key')).toHaveTextContent('NEBULA’s secure browser has no passkey or security key.');
    expect(screen.getByTestId('auth-webauthn-pending')).toHaveTextContent('The site’s passkey prompt is still open.');
    a.unmount();
    // handed off (the page offered no other way): the page is in the agent's browser
    const handedOff = V34.passkey();
    handedOff.request = { ...(handedOff.request as AuthRequest), alternatives: [], manual: { kind: 'passkey', live_desktop: true, can_complete_here: false } };
    renderForm(handedOff, client, { liveDesktopHref: '#/agents/a1/desktop' });
    expect(screen.getByTestId('auth-manual')).toHaveTextContent('NEBULA’s secure browser has no passkey or security key.');
    expect(screen.getByTestId('auth-manual')).toHaveTextContent('choose another way to sign in there');
    expect(screen.getByRole('link', { name: 'Open Live Desktop' })).toHaveAttribute('href', '#/agents/a1/desktop');
    expect(screen.getByRole('button', { name: 'I’m done' })).toBeInTheDocument();
  });

  it('unknown step: never success; Retry re-reads the request, Live Desktop hands the page over, Cancel stays', async () => {
    const user = userEvent.setup();
    const onReload = vi.fn();
    const { client, bodies } = fakeClient();
    renderForm(V34.unknown(), client, { onReload });
    expect(screen.getByRole('heading', { name: 'Unrecognised sign-in step' })).toBeInTheDocument();
    expect(screen.getByTestId('auth-unknown')).toHaveTextContent('NEBULA could not recognise this sign-in step. Check it in Live Desktop.');
    expect(document.body.textContent).not.toMatch(/signed in/i);
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(client.token).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('NEBULA checks the page again.');
    await user.click(screen.getByRole('button', { name: 'Open in Live Desktop' }));
    await waitFor(() => expect(bodies[0]).toMatchObject({ action: 'handoff' }));
    expect(screen.getByRole('button', { name: 'Cancel sign-in' })).toBeInTheDocument();
  });

  it('failures: the secure browser ran out of memory, the VM stopped answering', () => {
    const { client } = fakeClient();
    for (const [code, text] of [
      ['broker_memory', 'The site’s page needed more memory than the secure browser allows. Retry, or use Live Desktop.'],
      ['vm_unreachable', 'The NEBULA VM stopped answering. Make sure the VM is running.'],
    ] as const) {
      expect(FAILURE_TEXT[code]).toBe(text);
      const { unmount } = renderForm(V34.failed(code), client);
      expect(screen.getByTestId('auth-final')).toHaveTextContent(`Sign-in failed${text}`);
      expect(stateText(V34.failed(code))).toBe(`Sign-in failed — ${text}`);
      unmount();
    }
  });

  it('Diagnostics (session detail): collapsed by default; pages and events in order with a short structural summary', async () => {
    const user = userEvent.setup();
    const { client } = fakeClient();
    const view = renderForm(V34.email(), client);
    expect(screen.queryByTestId('auth-diagnostics')).toBeNull(); // list rows carry no events
    view.unmount();
    renderForm(V34.detail(), client);
    const diag = screen.getByTestId('auth-diagnostics');
    const toggle = within(diag).getByRole('button', { name: /Diagnostics/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveTextContent('1 page, 3 events');
    expect(within(diag).queryByTestId('auth-diag-events')).toBeNull();
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(within(diag).getByTestId('auth-diag-history')).toHaveTextContent('Account name · login.microsoftonline.com · GREEN');
    const rows = within(within(diag).getByTestId('auth-diag-events')).getAllByRole('listitem');
    expect(rows.map((r) => r.querySelector('.font-mono:not(time)')?.textContent)).toEqual(['session.started', 'step.detected', 'request.created']);
    expect(rows[1]).toHaveTextContent('identifier · login.microsoftonline.com · #1 · confidence HIGH · roles email · 1 input · quiet 350 ms');
    for (const r of rows) expect(r.querySelector('time')).not.toBeNull();
    await user.click(toggle);
    expect(within(diag).queryByTestId('auth-diag-events')).toBeNull();
    // the summary takes only structural fields, clipped
    expect(metaSummary({ from_step: 'identifier', step: 'password', evidence: ['provider_session_cookie'], auto: ['chose_password'], diag: { webauthn: 'passkey', webauthn_pending: true } })).toBe(
      'identifier → password · evidence provider_session_cookie · auto chose_password · webauthn passkey · prompt open',
    );
    expect(metaSummary({ reason: 'x'.repeat(80) }).length).toBeLessThanOrEqual(32);
    expect(metaSummary(undefined)).toBe('');
  });
});
