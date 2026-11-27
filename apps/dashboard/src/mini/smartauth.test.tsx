// Smart Authentication in the Mini App (fetch mocked, events streamed): the sign-in card in a conversation, the sheet,
// the #/auth/<id> deep link, Activity's "Needs you" from approval-center, Telegram's BackButton and secret hygiene.
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authSession, field, REMOTE_CREDENTIALS, V34 } from '../features/smartauth/core/fixtures';
import type { AuthSession } from '../features/smartauth/core/types';
import { apiError, ok, type RecordedCall } from '../test/fetchMock';
import { clearAllPending } from './chat/pending';
import { clearQueryCache, peekQuery } from './hooks';
import { authSessionKey } from './signin';
import { markBiometricStale, rememberDevice } from './stepup/biometric';
import type { TgBiometricManager } from './telegram';
import { baseRoutes, conversation, emit, installMemoryStorage, message, mount, NOW, PERMS, resetStream, telegram } from './test/kit';

vi.mock('@novnc/novnc', () => ({ default: class {} }));

const SID = 'as_0123456789abcdef01234567';
const CANARY = 'Canary-Pass-5150';

const remote = (over: Partial<AuthSession> = {}) => authSession({ created_at: NOW - 90, ...over }, REMOTE_CREDENTIALS);
type Route = (c: RecordedCall) => Response | Promise<Response>;

/** The verified owner's Mini App over Activity (deep link #/auth/<id>). */
function ownerRoutes(extra: Record<string, Route>) {
  return baseRoutes({
    'GET /api/v1/miniapp/me': () => ok({ session_id: 's1', telegram_user_id: 42, bot: 'main', permissions: PERMS, expires_in: 3600, role: 'owner', admin: true, assurance: { fresh_until: null } }),
    'GET /api/v1/approval-center': () => ok({ pending: [], recent: [], sign_ins: [] }),
    'GET /api/v1/tasks': () => ok([]),
    'GET /api/v1/workflow-runs': () => ok([]),
    ...extra,
  });
}
function ownerAssurance(o: { fresh?: boolean; locked?: boolean; devices?: object[] } = {}) {
  const devices = o.devices ?? [];
  return {
    interface: 'miniapp',
    role: 'owner',
    fresh_until: o.fresh ? NOW + 300 : null,
    fresh: Boolean(o.fresh),
    methods: { password: true, biometric: { enrolled: devices.length > 0, devices }, vault_passphrase: true },
    vault: { exists: true, locked: Boolean(o.locked), reauth_until: null },
  };
}
const confirmed = (result = 'unlocked_passphrase') => ({
  fresh_until: NOW + 300,
  vault: { exists: true, locked: false, entry_count: 1, result, reauth_until: NOW + 300, device_key: false },
  vault_unlock_needed: false,
});
const posted = (calls: RecordedCall[], path: string) => calls.filter((c) => c.method === 'POST' && c.path === path).map((c) => c.body);

/** Deep link #/auth/<id> over Activity with the given session detail. */
function deepLink(get: () => AuthSession) {
  return baseRoutes({
    [`GET /api/v1/smart-auth/sessions/${SID}`]: () => ok(get()),
    'GET /api/v1/approval-center': () => ok({ pending: [], recent: [], sign_ins: [] }),
    'GET /api/v1/tasks': () => ok([]),
    'GET /api/v1/workflow-runs': () => ok([]),
  });
}

function setVisibility(v: 'hidden' | 'visible') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v });
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

function chatRoutes(sessions: () => AuthSession[], extra: Record<string, (c: RecordedCall) => Response | Promise<Response>> = {}) {
  return baseRoutes({
    'GET /api/v1/conversations': () => ok([conversation()]),
    'GET /api/v1/conversations/c1': () => ok(conversation()),
    'GET /api/v1/conversations/c1/messages': () =>
      ok({ items: [message({ id: 'm0', role: 'user', content: 'Check my GitHub notifications', created_at: NOW - 120 }), message({ id: 'm1', content: 'On it.', created_at: NOW - 60 })], has_more: false }),
    'GET /api/v1/voice/stt': () => ok({ backend: null }),
    'GET /api/v1/smart-auth/sessions': () => ok(sessions()),
    [`GET /api/v1/smart-auth/sessions/${SID}`]: () => ok(sessions()[0]),
    ...extra,
  });
}

describe('Smart Authentication (Mini App)', () => {
  beforeEach(() => {
    sessionStorage.clear();
    installMemoryStorage();
    clearQueryCache();
    clearAllPending();
    markBiometricStale(false);
    rememberDevice(null);
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete window.Telegram;
    window.history.replaceState(null, '', '/');
    resetStream();
    delete (document as unknown as Record<string, unknown>).visibilityState; // back to jsdom's own getter
  });

  it('shows the sign-in card in the conversation (one request) between messages, and updates it on auth events', async () => {
    let current = remote();
    const { calls } = mount('#/chats/c1', chatRoutes(() => [current]));
    const card = await screen.findByTestId('auth-card');
    expect(card).toHaveTextContent('Authentication required');
    expect(card).toHaveTextContent('github.com');
    expect(card).toHaveTextContent('Agent: Researcher');
    expect(card).toHaveTextContent('Waiting for your sign-in details');
    expect(within(card).getByRole('button', { name: 'Continue sign-in' })).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    // ordered by time: after the owner's message (NOW-120), before the agent's reply (NOW-60)
    const list = screen.getByRole('list', { name: 'Conversation with Researcher' });
    const order = [...list.querySelectorAll('[data-testid="msg-user"],[data-testid="auth-card"],[data-testid="msg-agent"]')].map((el) => el.getAttribute('data-testid'));
    expect(order).toEqual(['msg-user', 'auth-card', 'msg-agent']);
    const listCalls = calls.filter((c) => c.path === '/api/v1/smart-auth/sessions');
    expect(listCalls).toHaveLength(1);
    expect(listCalls[0].url).toContain('conversation_id=c1');
    expect(listCalls[0].url).toContain('limit=10');

    // signed in elsewhere: the event refreshes the card into a status line
    current = remote({ state: 'AUTHENTICATED', request: null, completed_at: NOW });
    await emit('auth.session.updated', { session_id: SID, state: 'AUTHENTICATED', site: 'github.com', conversation_id: 'c1', agent_name: 'Researcher' }, { task_id: 't1' });
    const line = await screen.findByTestId('auth-status', {}, { timeout: 2000 });
    expect(line).toHaveTextContent('Signed in to github.com ✓');
    expect(screen.queryByTestId('auth-card')).toBeNull();
    // events of other conversations do not refetch
    const before = calls.filter((c) => c.path === '/api/v1/smart-auth/sessions').length;
    await emit('auth.session.updated', { session_id: 'as_other', state: 'IDENTIFIER_AND_PASSWORD_REQUIRED', conversation_id: 'c9' });
    await act(async () => new Promise((r) => setTimeout(r, 400)));
    expect(calls.filter((c) => c.path === '/api/v1/smart-auth/sessions').length).toBe(before);
  });

  it('Continue sign-in opens the sheet; submitting fetches a token, then submits with Bearer auth; nothing typed reaches URLs or storage', async () => {
    const user = userEvent.setup();
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const order: string[] = [];
    let current = remote();
    const wa = telegram();
    const { calls } = mount(
      '#/chats/c1',
      chatRoutes(() => [current], {
        [`POST /api/v1/smart-auth/sessions/${SID}/token`]: () => {
          order.push('token');
          return ok({ request_id: 'ar_1', token: 'tok_abcdefghijklmnopqrstuvwxyz', expires_at: NOW + 120 });
        },
        [`POST /api/v1/smart-auth/sessions/${SID}/submit`]: () => {
          order.push('submit');
          current = remote({ state: 'SUBMITTING', request: null });
          return ok(current, 202);
        },
      }),
      wa,
    );
    await user.click(await screen.findByRole('button', { name: 'Continue sign-in' }));
    const sheet = await screen.findByRole('dialog', { name: 'Sign in to github.com' });
    expect(within(sheet).getByTestId('auth-origin')).toHaveTextContent('https://github.com');
    // the sheet takes over Telegram's BackButton
    await waitFor(() => expect(wa.BackButton.show).toHaveBeenCalled());

    await user.type(within(sheet).getByLabelText('Email'), 'ada@example.com');
    await user.type(within(sheet).getByLabelText('Password'), CANARY);
    await user.type(within(sheet).getByLabelText('Remote sign-in PIN'), '846213');
    await user.click(within(sheet).getByRole('button', { name: 'Sign in' }));
    expect(await within(sheet).findByText('Signing in…')).toBeInTheDocument();
    expect(order).toEqual(['token', 'submit']);
    const submit = calls.find((c) => c.path.endsWith('/submit')) as RecordedCall;
    expect(submit.headers.authorization).toBe('Bearer tok-1');
    expect(submit.body).toMatchObject({ action: 'credentials', request_id: 'ar_1', values: { f1: 'ada@example.com', f2: CANARY }, pin: '846213', save: 'once' });
    for (const c of calls) expect(c.url).not.toContain(CANARY);
    expect(document.body.innerHTML).not.toContain(CANARY);
    for (const call of setItem.mock.calls) expect(JSON.stringify(call)).not.toContain(CANARY);
    for (const st of [window.localStorage, window.sessionStorage]) for (let i = 0; i < st.length; i += 1) expect(st.getItem(st.key(i) as string) ?? '').not.toContain(CANARY);
    // the composer draft never sees the sheet's fields
    expect(screen.getByLabelText('Message to Researcher')).toHaveValue('');

    // Telegram Back closes the sheet (the conversation stays)
    const onBack = vi.mocked(wa.BackButton.onClick).mock.calls.at(-1)?.[0] as () => void;
    act(() => onBack());
    await waitFor(() => expect(screen.queryByTestId('auth-sheet')).toBeNull());
    expect(window.location.hash).toBe('#/chats/c1');
  });

  it('a new step (verification code) arrives by event into the open sheet', async () => {
    const user = userEvent.setup();
    let current = remote({ state: 'SUBMITTING', request: null });
    mount('#/chats/c1', chatRoutes(() => [current]));
    await user.click(await screen.findByRole('button', { name: 'Show details' }));
    const sheet = await screen.findByTestId('auth-sheet');
    expect(within(sheet).getByText('Signing in…')).toBeInTheDocument();
    current = authSession(
      { state: 'OTP_REQUIRED', step: 'otp', created_at: NOW - 90 },
      { id: 'ar_2', type: 'otp', step: 'otp', local: false, fields: [field({ id: 'f1', role: 'otp', length: 6, charset: 'numeric' })], otp: { channel: 'totp', length: 6, charset: 'numeric' } },
    );
    await emit('auth.request', { session_id: SID, state: 'OTP_REQUIRED', site: 'github.com', conversation_id: 'c1', request_type: 'otp', request_id: 'ar_2' });
    const code = await within(sheet).findByLabelText('Verification code', {}, { timeout: 2000 });
    expect(code).toHaveAccessibleDescription(/authenticator app/);
    expect(within(sheet).queryByLabelText('Remote sign-in PIN')).toBeNull();
  });

  it('deep link #/auth/<id> opens the sheet over Activity; closing it returns to Activity', async () => {
    const user = userEvent.setup();
    const s = remote({ conversation_id: null });
    const { calls } = mount(
      `#/auth/${SID}`,
      baseRoutes({
        [`GET /api/v1/smart-auth/sessions/${SID}`]: () => ok(s),
        'GET /api/v1/approval-center': () => ok({ pending: [], recent: [], sign_ins: [{ ...s, kind: 'sign_in' }] }),
        'GET /api/v1/tasks': () => ok([]),
        'GET /api/v1/workflow-runs': () => ok([]),
      }),
    );
    const sheet = await screen.findByRole('dialog', { name: 'Sign in to github.com' });
    expect(within(sheet).getByLabelText('Email')).toBeInTheDocument();
    expect(calls.some((c) => c.path === `/api/v1/smart-auth/sessions/${SID}`)).toBe(true);
    // Activity underneath, its tab is active
    expect(screen.getByRole('link', { name: /^Activity/ })).toHaveAttribute('aria-current', 'page');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(window.location.hash).toBe('#/activity'));
    expect(screen.queryByTestId('auth-sheet')).toBeNull();
  });

  it('Activity lists active sign-ins under "Needs you" from approval-center (no extra request) and opens the sheet', async () => {
    const user = userEvent.setup();
    const s = remote();
    const { calls } = mount(
      '#/activity',
      baseRoutes({
        'GET /api/v1/approval-center': () => ok({ pending: [], recent: [], sign_ins: [{ ...s, kind: 'sign_in' }] }),
        'GET /api/v1/tasks': () => ok([]),
        'GET /api/v1/workflow-runs': () => ok([]),
        [`GET /api/v1/smart-auth/sessions/${SID}`]: () => ok(s),
      }),
    );
    const rows = await screen.findByRole('list', { name: 'Sign-in requests' });
    expect(rows).toHaveTextContent('Sign in to github.com');
    expect(rows).toHaveTextContent('Researcher');
    expect(calls.some((c) => c.path === '/api/v1/smart-auth/sessions')).toBe(false);
    // the tab bar badge counts the sign-in
    expect(screen.getByRole('link', { name: 'Activity, 1 pending' })).toBeInTheDocument();
    await user.click(within(rows).getByTestId('signin-row'));
    expect(await screen.findByRole('dialog', { name: 'Sign in to github.com' })).toBeInTheDocument();
  });

  it('owner, locked vault: "Unlock vault" in the save options is ONE confirmation (vault passphrase); no PIN, the typed e-mail stays; the submission has no pin', async () => {
    const user = userEvent.setup();
    const locked = { state: 'locked' as const, can_save: false, can_unlock: true, reason: 'The Password Vault is locked. Unlock it to save credentials or use a saved account.' };
    const req = () => current.request as NonNullable<AuthSession['request']>;
    let current = remote({ conversation_id: null });
    current = { ...current, request: { ...req(), vault: locked } };
    let fresh = false;
    const { calls } = mount(
      `#/auth/${SID}`,
      ownerRoutes({
        [`GET /api/v1/smart-auth/sessions/${SID}`]: () => ok(current),
        'GET /api/v1/auth/assurance': () => ok(ownerAssurance({ fresh, locked: !fresh })),
        'POST /api/v1/auth/confirm': (c) => {
          if ((c.body as { passphrase?: string }).passphrase !== CANARY) return apiError(401, 'wrong_passphrase', 'wrong vault passphrase', { attempts_left: 4 });
          fresh = true;
          // what the host answers next: unlocked, and — the session being fresh — no remote PIN any more
          current = { ...current, updated_at: current.updated_at + 5, request: { ...req(), vault: { state: 'unlocked', can_save: true, can_unlock: false, reason: null }, fresh: true, pin_required_for: [] } };
          return ok(confirmed());
        },
        [`POST /api/v1/smart-auth/sessions/${SID}/token`]: () => ok({ request_id: 'ar_1', token: 'tok_abcdefghijklmnopqrstuvwxyz', expires_at: NOW + 120 }),
        [`POST /api/v1/smart-auth/sessions/${SID}/submit`]: () => ok(remote({ state: 'SUBMITTING', request: null }), 202),
      }),
    );
    const sheet = await screen.findByTestId('auth-sheet');
    await user.type(within(sheet).getByLabelText('Email'), 'ada@example.com');
    expect(within(sheet).queryByLabelText('Remote sign-in PIN')).toBeNull(); // the owner confirms instead of a PIN
    expect(within(sheet).getByTestId('auth-confirm-instead')).toHaveTextContent('The remote sign-in PIN is not needed.');
    await user.click(within(sheet).getByRole('radio', { name: /Save to NEBULA Vault/ }));
    const gate = within(sheet).getByTestId('auth-vault-gate');
    expect(gate).toHaveTextContent(locked.reason);
    expect(within(gate).queryByLabelText('Vault passphrase')).toBeNull(); // no second secret in the form
    await user.click(within(gate).getByRole('button', { name: 'Unlock vault' }));
    const confirm = await screen.findByTestId('owner-confirm');
    await user.type(await within(confirm).findByLabelText('Vault passphrase'), CANARY);
    await user.click(within(confirm).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(within(sheet).queryByTestId('auth-vault-gate')).toBeNull(), { timeout: 2000 });
    expect(posted(calls, '/api/v1/auth/confirm')).toEqual([{ method: 'vault_passphrase', passphrase: CANARY, unlock_vault: true }]);
    expect(calls.some((c) => c.path === '/api/v1/vault/unlock' || c.path === '/api/v1/auth/stepup')).toBe(false);
    expect(within(sheet).getByLabelText('Email')).toHaveValue('ada@example.com');
    expect(within(sheet).getByRole('radio', { name: /Save to NEBULA Vault/ })).toBeChecked();
    // fresh now: signing in asks nothing more and sends no pin
    await user.type(within(sheet).getByLabelText('Password'), 'site-pw-123');
    await user.click(within(sheet).getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(calls.some((c) => c.path.endsWith('/submit'))).toBe(true));
    const submit = calls.find((c) => c.path.endsWith('/submit')) as RecordedCall;
    expect(submit.body).toMatchObject({ action: 'credentials', save: 'vault', values: { f1: 'ada@example.com', f2: 'site-pw-123' } });
    expect(submit.body).not.toHaveProperty('pin');
    expect(posted(calls, '/api/v1/auth/confirm')).toHaveLength(1);
    expect(document.body.innerHTML).not.toContain(CANARY);
    for (const st of [window.localStorage, window.sessionStorage]) for (let i = 0; i < st.length; i += 1) expect(st.getItem(st.key(i) as string) ?? '').not.toContain(CANARY);
  });

  it('owner, "allow in future" from the phone: ONE confirmation instead of the PIN (assurance → confirm), then ONE token + submit without a pin', async () => {
    const user = userEvent.setup();
    const order: string[] = [];
    const s = remote({ conversation_id: null });
    const { calls } = mount(
      `#/auth/${SID}`,
      ownerRoutes({
        [`GET /api/v1/smart-auth/sessions/${SID}`]: () => ok(s),
        'GET /api/v1/auth/assurance': () => {
          order.push('assurance');
          return ok(ownerAssurance({ locked: false }));
        },
        'POST /api/v1/auth/confirm': () => {
          order.push('confirm');
          return ok(confirmed());
        },
        [`POST /api/v1/smart-auth/sessions/${SID}/token`]: () => {
          order.push('token');
          return ok({ request_id: 'ar_1', token: 'tok_abcdefghijklmnopqrstuvwxyz', expires_at: NOW + 120 });
        },
        [`POST /api/v1/smart-auth/sessions/${SID}/submit`]: () => {
          order.push('submit');
          return ok(remote({ state: 'SUBMITTING', request: null }), 202);
        },
      }),
    );
    const sheet = await screen.findByTestId('auth-sheet');
    await user.type(within(sheet).getByLabelText('Email'), 'ada@example.com');
    await user.type(within(sheet).getByLabelText('Password'), CANARY);
    await user.click(within(sheet).getByRole('radio', { name: /Save to NEBULA Vault/ }));
    await user.click(within(sheet).getByRole('checkbox', { name: 'Allow this agent to request this credential in the future' }));
    expect(within(sheet).queryByLabelText('Remote sign-in PIN')).toBeNull();
    await user.click(within(sheet).getByRole('button', { name: 'Sign in' }));
    const confirm = await screen.findByTestId('owner-confirm');
    await user.type(await within(confirm).findByLabelText('Vault passphrase'), 'Fake-Vault-Passphrase-1');
    await user.click(within(confirm).getByRole('button', { name: 'Confirm' }));
    expect(await within(sheet).findByText('Signing in…', {}, { timeout: 2000 })).toBeInTheDocument();
    expect(order).toEqual(['assurance', 'confirm', 'token', 'submit']);
    expect(posted(calls, '/api/v1/auth/confirm')).toEqual([{ method: 'vault_passphrase', passphrase: 'Fake-Vault-Passphrase-1' }]);
    const submit = calls.find((c) => c.path.endsWith('/submit')) as RecordedCall;
    expect(submit.body).toMatchObject({ action: 'credentials', save: 'vault', allow_future: true });
    expect(submit.body).not.toHaveProperty('pin');
  });

  it('owner with Face ID (vault key on this phone): "save to vault" while locked → ONE biometric prompt confirms and unlocks, the submission has no pin', async () => {
    const user = userEvent.setup();
    const order: string[] = [];
    const bm = {
      isInited: true,
      isBiometricAvailable: true,
      biometricType: 'face' as const,
      isAccessGranted: true,
      isBiometricTokenSaved: true,
      init: vi.fn((cb?: () => void) => cb?.()),
      requestAccess: vi.fn(),
      authenticate: vi.fn((_p: { reason?: string }, cb?: (ok: boolean, token?: string) => void) => cb?.(true, 'nebula1.dev1.tok-A')),
      updateBiometricToken: vi.fn((_t: string, cb?: (ok: boolean) => void) => cb?.(true)),
    };
    let current = remote({ conversation_id: null });
    current = { ...current, request: { ...(current.request as NonNullable<AuthSession['request']>), vault: { state: 'locked', can_save: false, can_unlock: true, reason: 'The Password Vault is locked.' } } };
    const { calls } = mount(
      `#/auth/${SID}`,
      ownerRoutes({
        [`GET /api/v1/smart-auth/sessions/${SID}`]: () => ok(current),
        'GET /api/v1/auth/assurance': () => {
          order.push('assurance');
          return ok(ownerAssurance({ locked: true, devices: [{ id: 'dev1', name: 'iPhone', created_at: NOW - 86400, last_used_at: null, vault_key: true }] }));
        },
        'POST /api/v1/auth/stepup/challenge': () => {
          order.push('challenge');
          return ok({ challenge_id: 'ch1', expires_at: NOW + 60 });
        },
        'POST /api/v1/auth/confirm': () => {
          order.push('confirm');
          return ok({ ...confirmed('unlocked'), next_token: 'tok-B' });
        },
        [`POST /api/v1/smart-auth/sessions/${SID}/token`]: () => {
          order.push('token');
          return ok({ request_id: 'ar_1', token: 'tok_abcdefghijklmnopqrstuvwxyz', expires_at: NOW + 120 });
        },
        [`POST /api/v1/smart-auth/sessions/${SID}/submit`]: () => {
          order.push('submit');
          return ok(remote({ state: 'SUBMITTING', request: null }), 202);
        },
      }),
      telegram({ BiometricManager: bm as unknown as TgBiometricManager }),
    );
    const sheet = await screen.findByTestId('auth-sheet');
    await user.type(within(sheet).getByLabelText('Email'), 'ada@example.com');
    await user.type(within(sheet).getByLabelText('Password'), CANARY);
    await user.click(within(sheet).getByRole('radio', { name: /Save to NEBULA Vault/ }));
    expect(within(sheet).getByTestId('auth-confirm-instead')).toHaveTextContent('which also unlocks the vault');
    await user.click(within(sheet).getByRole('button', { name: 'Sign in' }));
    expect(await within(sheet).findByText('Signing in…', {}, { timeout: 2000 })).toBeInTheDocument();
    expect(order).toEqual(['assurance', 'challenge', 'confirm', 'token', 'submit']);
    expect(bm.authenticate).toHaveBeenCalledTimes(1);
    expect(posted(calls, '/api/v1/auth/confirm')).toEqual([{ method: 'telegram_biometric', device_id: 'dev1', challenge_id: 'ch1', token: 'tok-A', unlock_vault: true }]);
    expect(bm.updateBiometricToken).toHaveBeenCalledWith('nebula1.dev1.tok-B', expect.any(Function));
    const submit = calls.find((c) => c.path.endsWith('/submit')) as RecordedCall;
    expect(submit.body).toMatchObject({ action: 'credentials', save: 'vault', values: { f1: 'ada@example.com', f2: CANARY } });
    expect(submit.body).not.toHaveProperty('pin');
  });

  it('an operator sees the request but cannot answer it (the host answers 403 owner_only): no form, no token, no submit', async () => {
    const s = remote({ conversation_id: null });
    const { calls } = mount(
      `#/auth/${SID}`,
      baseRoutes({
        'GET /api/v1/miniapp/me': () => ok({ session_id: 's1', telegram_user_id: 42, bot: 'main', permissions: PERMS, expires_in: 3600, role: 'operator', admin: false }),
        [`GET /api/v1/smart-auth/sessions/${SID}`]: () => ok(s),
        'GET /api/v1/approval-center': () => ok({ pending: [], recent: [], sign_ins: [] }),
        'GET /api/v1/tasks': () => ok([]),
        'GET /api/v1/workflow-runs': () => ok([]),
      }),
    );
    const sheet = await screen.findByTestId('auth-sheet');
    expect(await within(sheet).findByText(/Only the NEBULA owner can answer sign-in requests/)).toBeInTheDocument();
    expect(within(sheet).queryByLabelText('Email')).toBeNull();
    expect(within(sheet).queryByLabelText('Password')).toBeNull();
    expect(within(sheet).queryByRole('button', { name: 'Sign in' })).toBeNull();
    expect(calls.some((c) => c.method === 'POST' && c.path.startsWith('/api/v1/smart-auth/'))).toBe(false);
    expect(screen.queryByTestId('owner-confirm')).toBeNull();
  });

  it('V3.4 e-mail step in the sheet: only the e-mail field, focused, phone keyboard attributes; the sheet keeps the safe-area padding', async () => {
    const s = V34.email({ created_at: NOW - 90, conversation_id: null });
    s.request = { ...(s.request as NonNullable<AuthSession['request']>), ...REMOTE_CREDENTIALS };
    mount(`#/auth/${SID}`, deepLink(() => s));
    const sheet = await screen.findByTestId('auth-sheet');
    const email = await within(sheet).findByLabelText('Email');
    expect(within(sheet).getByTestId('auth-step-heading')).toHaveTextContent('Email required');
    expect(within(sheet).getByTestId('auth-typed').querySelectorAll('input')).toHaveLength(1);
    expect(email).toHaveAttribute('type', 'email');
    expect(email).toHaveAttribute('autocomplete', 'username');
    expect(email).toHaveAttribute('enterkeyhint', 'go');
    await waitFor(() => expect(document.activeElement).toBe(email));
    expect(within(sheet).getByRole('dialog').className).toContain('mini-sheet');
  });

  it('resume: one refresh when the app is back (visible + Telegram "activated" together); a newer step replaces the form, an older answer never returns', async () => {
    const wa = telegram();
    const older = V34.email({ created_at: NOW - 90, conversation_id: null, updated_at: NOW - 30 });
    const newer = authSession(
      { state: 'PASSWORD_REQUIRED', step: 'password', step_seq: 2, created_at: NOW - 90, conversation_id: null, updated_at: NOW - 5 },
      { id: 'ar_2', seq: 2, step: 'password', requirement: 'PASSWORD_REQUIRED', fields: [field({ id: 'f3', role: 'password', input: 'password' })] },
    );
    let current = older;
    const { calls } = mount(`#/auth/${SID}`, deepLink(() => current), wa);
    const sheet = await screen.findByTestId('auth-sheet');
    expect(await within(sheet).findByLabelText('Email')).toBeInTheDocument();
    const gets = () => calls.filter((c) => c.method === 'GET' && c.path === `/api/v1/smart-auth/sessions/${SID}`).length;
    await act(async () => new Promise((r) => setTimeout(r, 50)));
    const n0 = gets();
    const activated = () => {
      const cb = vi.mocked(wa.onEvent).mock.calls.filter(([e]) => e === 'activated').at(-1)?.[1] as () => void;
      act(() => cb());
    };

    // the owner read a code in another app; meanwhile the page moved on to the password
    current = newer;
    setVisibility('hidden');
    setVisibility('visible');
    activated();
    expect(await within(sheet).findByLabelText('Password', {}, { timeout: 2000 })).toBeInTheDocument();
    expect(within(sheet).queryByLabelText('Email')).toBeNull();
    expect(gets()).toBe(n0 + 1);

    // a later resume answered with an older view (e.g. a lagging replica): the newer step stays
    const now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now + 5_000);
    current = older;
    activated();
    await waitFor(() => expect(gets()).toBe(n0 + 2));
    await act(async () => new Promise((r) => setTimeout(r, 50)));
    expect(within(sheet).getByTestId('smart-auth')).toHaveAttribute('data-state', 'PASSWORD_REQUIRED');
    expect(peekQuery<AuthSession>(authSessionKey(SID))?.request?.id).toBe('ar_2'); // the shared cache kept the newer step too
    expect(within(sheet).getByLabelText('Password')).toBeInTheDocument();
    expect(within(sheet).queryByLabelText('Email')).toBeNull();
    // no polling loop: nothing more without a resume or an event
    await act(async () => new Promise((r) => setTimeout(r, 400)));
    expect(gets()).toBe(n0 + 2);
  });

  it('the sheet (session detail) has a collapsed Diagnostics section', async () => {
    const user = userEvent.setup();
    const s = V34.detail({ created_at: NOW - 90, conversation_id: null });
    mount(`#/auth/${SID}`, deepLink(() => s));
    const sheet = await screen.findByTestId('auth-sheet');
    const toggle = await within(sheet).findByRole('button', { name: /Diagnostics/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(within(sheet).queryByTestId('auth-diag-events')).toBeNull();
    await user.click(toggle);
    expect(within(sheet).getByTestId('auth-diag-events')).toHaveTextContent('step.detected');
    expect(within(sheet).getByTestId('auth-diag-history')).toHaveTextContent('login.microsoftonline.com');
  });

  it('Telegram Back closes the "Cancel this sign-in?" sheet of a conversation card first', async () => {
    const user = userEvent.setup();
    const wa = telegram();
    mount('#/chats/c1', chatRoutes(() => [remote()]), wa);
    const card = await screen.findByTestId('auth-card');
    await user.click(within(card).getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByRole('dialog', { name: 'Cancel this sign-in?' })).toBeInTheDocument();
    const onBack = vi.mocked(wa.BackButton.onClick).mock.calls.at(-1)?.[0] as () => void;
    act(() => onBack());
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Cancel this sign-in?' })).toBeNull());
    expect(window.location.hash).toBe('#/chats/c1');
    expect(screen.getByTestId('auth-card')).toBeInTheDocument();
  });
});
