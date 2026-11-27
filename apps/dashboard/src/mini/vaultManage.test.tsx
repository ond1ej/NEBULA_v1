// The owner's Password Vault in the Mini App (V3.3; V4.0: ONE owner confirmation): create / unlock (the vault passphrase
// once, which also confirms it's the owner) / lock, credentials (add with a generated password, search, edit, delete),
// reveal with ONE confirmation (no step-up followed by the passphrase), copy that clears the clipboard, agent grants,
// settings, export / import, Smart sign-in trust — and no secret in storage or URLs.
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiError, ok, type RecordedCall } from '../test/fetchMock';
import { clearQueryCache } from './hooks';
import { agent, baseRoutes, installMemoryStorage, mount, NOW, PERMS, resetStream } from './test/kit';
import { cleanEntryDetail } from './vault/data';
import { copySecret, generatePassword } from './vault/ui';

vi.mock('@novnc/novnc', () => ({ default: class {} }));

type Handler = (c: RecordedCall) => Response | Promise<Response>;

const ME_OWNER = { session_id: 's1', telegram_user_id: 42, bot: 'main', permissions: [...PERMS, 'agents'], expires_in: 3600, role: 'owner', admin: true, assurance: { fresh_until: null } };
const PASS = 'Correct-Horse-Battery-77';
const SECRET = 'S3cret-Stored-Pw-9184';
const CANARY = 'CANARY-SECRET';

const status = (over: Record<string, unknown> = {}) => ({
  exists: true,
  locked: false,
  entry_count: 1,
  auto_lock_minutes: 15,
  unlocked_at: NOW - 60,
  lock_at: NOW + 840,
  lockout_until: null,
  broker: { enabled: true, available: true, reason: null },
  management_local: true,
  settings: { allow_lan_https: false, broker_enabled: true },
  ...over,
});
const ENTRY = { id: 'e1', display_name: 'GitHub (work)', app_name: null, origin: 'https://github.com', credential_type: 'website', tags: ['dev'], created_at: NOW - 900, updated_at: NOW - 60, grant_count: 1 };
// a hostile detail response that carries the password: it must never reach the screen
const DETAIL = { ...ENTRY, username: 'ada', has_password: true, has_notes: false, login_url: '', password: CANARY, notes: CANARY };
const GRANT = { id: 'g1', entry_id: 'e1', entry_name: 'GitHub (work)', credential_type: 'website', agent_id: 'a1', allowed_origins: ['https://github.com'], allowed_actions: ['sign_in'], approval_policy: 'always_ask', enabled: true, expires_at: null, created_at: NOW - 600, last_used_at: null };

function routes(extra: Record<string, Handler> = {}) {
  return baseRoutes({
    'GET /api/v1/miniapp/me': () => ok(ME_OWNER),
    'GET /api/v1/vault/status': () => ok(status()),
    'GET /api/v1/vault/entries': () => ok([ENTRY]),
    'GET /api/v1/vault/entries/e1': () => ok(DETAIL),
    'GET /api/v1/vault/grants': () => ok([GRANT]),
    'GET /api/v1/vault/audit': () => ok([]),
    'GET /api/v1/agents': () => ok([agent]),
    // already confirmed and re-confirmed for the vault (tests that confirm override it)
    'GET /api/v1/auth/assurance': () => ok(assurance({ fresh: true, reauth: true })),
    'POST /api/v1/auth/confirm': () => ok(confirmResult()),
    ...extra,
  });
}

/** GET /auth/assurance of the owner on the phone without biometrics. */
function assurance(o: { fresh?: boolean; locked?: boolean; reauth?: boolean } = {}) {
  return {
    interface: 'miniapp',
    role: 'owner',
    fresh_until: o.fresh ? NOW + 300 : null,
    fresh: Boolean(o.fresh),
    methods: { password: true, biometric: { enrolled: false, devices: [] }, vault_passphrase: true },
    vault: { exists: true, locked: Boolean(o.locked), reauth_until: o.reauth ? NOW + 300 : null },
  };
}
const confirmResult = (result = 'confirmed_passphrase') => ({
  fresh_until: NOW + 300,
  vault: { exists: true, locked: false, entry_count: 1, result, reauth_until: NOW + 300, device_key: false },
  vault_unlock_needed: false,
});
/** POST /auth/confirm with the vault passphrase: wrong → 401 (attempts left), right → confirmed (and `onOk`). */
function confirmByPassphrase(onOk: () => void = () => {}) {
  return (c: RecordedCall) => {
    if ((c.body as { passphrase?: string }).passphrase !== PASS) return apiError(401, 'wrong_passphrase', 'wrong vault passphrase', { attempts_left: 4 });
    onOk();
    return ok(confirmResult());
  };
}

const readBlob = (b: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsText(b);
  });
const posted = (calls: RecordedCall[], method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);
function assertNothingStored(...secrets: string[]) {
  const all = [
    ...Array.from({ length: window.localStorage.length }, (_, i) => window.localStorage.getItem(window.localStorage.key(i) as string) ?? ''),
    ...Array.from({ length: sessionStorage.length }, (_, i) => sessionStorage.getItem(sessionStorage.key(i) as string) ?? ''),
  ].join('\n');
  for (const s of secrets) expect(all).not.toContain(s);
}

describe('Password Vault management (owner, Mini App)', () => {
  beforeEach(() => {
    sessionStorage.clear();
    installMemoryStorage();
    clearQueryCache();
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete window.Telegram;
    window.history.replaceState(null, '', '/');
    resetStream();
  });

  it('creates the vault: length rule, strength hint and confirmation; nothing typed is kept', async () => {
    const user = userEvent.setup();
    let st = status({ exists: false, locked: true, entry_count: 0, unlocked_at: null, lock_at: null });
    const { calls } = mount(
      '#/settings/vault',
      routes({
        'GET /api/v1/vault/status': () => ok(st),
        'POST /api/v1/vault': () => {
          st = status({ entry_count: 0 });
          return ok(st, 201);
        },
      }),
    );
    const form = await screen.findByTestId('vault-create');
    expect(within(screen.getByTestId('vault-status')).getByText('Not set up')).toBeInTheDocument();
    await user.type(within(form).getByLabelText('Vault passphrase'), 'short');
    await user.click(within(form).getByRole('button', { name: 'Create vault' }));
    expect(within(form).getByText('Use at least 12 characters.')).toBeInTheDocument();
    expect(posted(calls, 'POST', '/api/v1/vault')).toHaveLength(0);
    await user.clear(within(form).getByLabelText('Vault passphrase'));
    await user.type(within(form).getByLabelText('Vault passphrase'), PASS);
    expect(within(form).getByTestId('strength')).toHaveTextContent(/Strength: (Good|Strong)/);
    await user.type(within(form).getByLabelText('Repeat the passphrase'), `${PASS}x`);
    await user.click(within(form).getByRole('button', { name: 'Create vault' }));
    expect(within(form).getByText('The passphrases do not match.')).toBeInTheDocument();
    await user.clear(within(form).getByLabelText('Repeat the passphrase'));
    await user.type(within(form).getByLabelText('Repeat the passphrase'), PASS);
    await user.click(within(form).getByRole('button', { name: 'Create vault' }));
    expect(await within(screen.getByTestId('vault-status')).findByText('Unlocked')).toBeInTheDocument();
    expect(posted(calls, 'POST', '/api/v1/vault')[0].body).toEqual({ passphrase: PASS });
    expect(document.body.innerHTML).not.toContain(PASS);
    for (const c of calls) expect(c.url).not.toContain(PASS);
    assertNothingStored(PASS);
  });

  it('unlocks with ONE confirmation: the vault passphrase once (attempts left on a wrong one), never the login password first; then locks', async () => {
    const user = userEvent.setup();
    let st = status({ locked: true, unlocked_at: null, lock_at: null });
    const { calls } = mount(
      '#/settings/vault',
      routes({
        'GET /api/v1/vault/status': () => ok(st),
        'GET /api/v1/auth/assurance': () => ok(assurance({ locked: st.locked })),
        'POST /api/v1/auth/confirm': confirmByPassphrase(() => {
          st = status();
        }),
        'POST /api/v1/vault/lock': () => {
          st = status({ locked: true, unlocked_at: null, lock_at: null });
          return ok({ locked: true });
        },
      }),
    );
    const card = await screen.findByTestId('vault-unlock');
    expect(within(screen.getByTestId('vault-status')).getByText('Locked')).toBeInTheDocument();
    expect(within(card).queryByLabelText(/passphrase/i)).toBeNull(); // the passphrase is asked once, in the confirmation
    await user.click(within(card).getByRole('button', { name: 'Unlock' }));
    const sheet = await screen.findByTestId('owner-confirm');
    const field = await within(sheet).findByLabelText('Vault passphrase');
    expect(within(sheet).queryByLabelText('NEBULA password')).toBeNull();
    await user.type(field, 'nope');
    await user.click(within(sheet).getByRole('button', { name: 'Confirm' }));
    expect(await within(sheet).findByRole('alert')).toHaveTextContent('Wrong vault passphrase. 4 attempts left before a temporary lock.');
    expect(field).toHaveValue('');
    await user.type(field, PASS);
    await user.click(within(sheet).getByRole('button', { name: 'Confirm' }));
    expect(await within(screen.getByTestId('vault-status')).findByText('Unlocked')).toBeInTheDocument();
    expect(screen.queryByTestId('owner-confirm')).toBeNull();
    expect(posted(calls, 'POST', '/api/v1/auth/confirm').map((c) => c.body)).toEqual([
      { method: 'vault_passphrase', passphrase: 'nope', unlock_vault: true },
      { method: 'vault_passphrase', passphrase: PASS, unlock_vault: true },
    ]);
    expect(posted(calls, 'POST', '/api/v1/vault/unlock')).toHaveLength(0);
    expect(posted(calls, 'POST', '/api/v1/auth/stepup')).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Lock now' }));
    await waitFor(() => expect(posted(calls, 'POST', '/api/v1/vault/lock')).toHaveLength(1));
    expect(await within(screen.getByTestId('vault-status')).findByText('Locked')).toBeInTheDocument();
    for (const c of calls) expect(c.url).not.toContain(PASS);
    assertNothingStored(PASS);
  });

  it('searches credentials on the server and lists agent access from one grants request', async () => {
    const user = userEvent.setup();
    const { calls } = mount('#/settings/vault', routes());
    expect(await screen.findByRole('link', { name: /GitHub \(work\)/ })).toHaveAttribute('href', '#/settings/vault/entries/e1');
    expect(await screen.findByText('1 active grant')).toBeInTheDocument();
    expect(posted(calls, 'GET', '/api/v1/vault/grants')).toHaveLength(1);
    expect(calls.some((c) => c.path === '/api/v1/agents/a1/vault')).toBe(false);
    await user.type(screen.getByLabelText('Search credentials'), 'git');
    await waitFor(() => expect(calls.some((c) => c.url === '/api/v1/vault/entries?q=git')).toBe(true));
  });

  it('adds a credential with a generated password (Web Crypto) and a normalised website; the password is not kept', async () => {
    const user = userEvent.setup();
    const rnd = vi.spyOn(globalThis.crypto, 'getRandomValues');
    const { calls } = mount(
      '#/settings/vault/new',
      routes({
        'POST /api/v1/vault/entries': (c) => ok({ ...ENTRY, id: 'e9', display_name: (c.body as { display_name: string }).display_name, password: CANARY }, 201),
        'GET /api/v1/vault/entries/e9': () => ok({ ...DETAIL, id: 'e9', display_name: 'GitHub' }),
      }),
    );
    const form = await screen.findByTestId('vault-entry-form');
    await user.click(within(form).getByRole('button', { name: 'Save credential' }));
    expect(within(form).getByText('Enter a name for this credential.')).toBeInTheDocument();
    expect(within(form).getByText('Enter the website, for example github.com.')).toBeInTheDocument();
    await user.type(within(form).getByLabelText(/Service name/), 'GitHub');
    await user.type(within(form).getByLabelText(/Website/), 'github.com');
    expect(within(form).getByText('Saved as https://github.com')).toBeInTheDocument();
    await user.type(within(form).getByLabelText('Username, email or phone'), 'ada@example.com');
    await user.click(within(form).getByRole('button', { name: 'Password generator' }));
    await user.click(within(form).getByRole('button', { name: 'Generate password' }));
    const pwField = within(form).getByLabelText('Password') as HTMLInputElement;
    const pw = pwField.value;
    expect(pwField).toHaveAttribute('type', 'password');
    expect(pw).toHaveLength(20);
    expect(pw).toMatch(/[a-z]/);
    expect(pw).toMatch(/[A-Z]/);
    expect(pw).toMatch(/\d/);
    expect(rnd).toHaveBeenCalled();
    await user.type(within(form).getByLabelText('Tags'), 'work, Dev Ops');
    await user.click(within(form).getByRole('button', { name: 'Save credential' }));
    await waitFor(() => expect(window.location.hash).toBe('#/settings/vault/entries/e9'));
    expect(posted(calls, 'POST', '/api/v1/vault/entries')[0].body).toEqual({
      display_name: 'GitHub',
      credential_type: 'website',
      origin: 'https://github.com',
      username: 'ada@example.com',
      tags: ['work', 'dev-ops'],
      password: pw,
    });
    expect(await screen.findByTestId('vault-username')).toHaveTextContent('ada');
    expect(document.body.innerHTML).not.toContain(pw);
    expect(document.body.innerHTML).not.toContain(CANARY);
    for (const c of calls) expect(c.url).not.toContain(pw);
    assertNothingStored(pw);
  });

  it('password generator: length and character options', () => {
    const digits = generatePassword({ length: 12, lower: false, upper: false, digits: true, symbols: false });
    expect(digits).toMatch(/^[2-9]{12}$/);
    const long = generatePassword({ length: 64, lower: true, upper: true, digits: true, symbols: true });
    expect(long).toHaveLength(64);
    expect(long).toMatch(/[!#$%&*+\-=?@^_~]/);
  });

  it('edits a credential: loads the details (never the password) and sends only what the form holds', async () => {
    const user = userEvent.setup();
    const { calls } = mount('#/settings/vault/entries/e1/edit', routes({ 'PATCH /api/v1/vault/entries/e1': (c) => ok({ ...ENTRY, ...(c.body as object) }) }));
    const name = await screen.findByLabelText(/Service name/);
    await waitFor(() => expect(name).toHaveValue('GitHub (work)'));
    expect(screen.getByLabelText('Username, email or phone')).toHaveValue('ada');
    expect(screen.getByLabelText('Password')).toHaveValue('');
    expect(screen.getByLabelText('Password')).toHaveAccessibleDescription('Leave empty to keep the stored one.');
    expect(document.body.innerHTML).not.toContain(CANARY);
    await user.clear(name);
    await user.type(name, 'GitHub work');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(window.location.hash).toBe('#/settings/vault/entries/e1'));
    const body = posted(calls, 'PATCH', '/api/v1/vault/entries/e1')[0].body as Record<string, unknown>;
    expect(body).toEqual({ display_name: 'GitHub work', credential_type: 'website', origin: 'https://github.com', username: 'ada', tags: ['dev'] });
    expect(body).not.toHaveProperty('password');
  });

  it('deletes a credential only after the confirmation sheet (DELETE ?confirm=true)', async () => {
    const user = userEvent.setup();
    const { calls } = mount('#/settings/vault/entries/e1', routes({ 'DELETE /api/v1/vault/entries/e1': () => ok({ deleted: true, grants_revoked: 1 }) }));
    expect(await screen.findByTestId('vault-username')).toHaveTextContent('ada');
    expect(cleanEntryDetail(DETAIL)).not.toHaveProperty('password');
    expect(document.body.innerHTML).not.toContain(CANARY);
    await user.click(screen.getByRole('button', { name: 'Delete credential' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete GitHub (work)?' });
    expect(posted(calls, 'DELETE', '/api/v1/vault/entries/e1')).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(posted(calls, 'DELETE', '/api/v1/vault/entries/e1')).toHaveLength(1));
    expect(posted(calls, 'DELETE', '/api/v1/vault/entries/e1')[0].url).toBe('/api/v1/vault/entries/e1?confirm=true');
    await waitFor(() => expect(window.location.hash).toBe('#/settings/vault'));
  });

  it('reveal: ONE confirmation (vault passphrase, unlock_vault) before the reveal — no step-up then passphrase — masked with a toggle, wiped on close', async () => {
    const user = userEvent.setup();
    let fresh = false;
    const { calls } = mount(
      '#/settings/vault/entries/e1',
      routes({
        'GET /api/v1/auth/assurance': () => ok(assurance({ fresh, reauth: fresh })),
        'POST /api/v1/auth/confirm': confirmByPassphrase(() => {
          fresh = true;
        }),
        'POST /api/v1/vault/entries/e1/reveal': () => (fresh ? ok({ id: 'e1', field: 'password', value: SECRET }) : apiError(403, 'reauth_required', 'confirm the vault passphrase again to continue')),
      }),
    );
    const row = await screen.findByTestId('vault-password');
    await user.click(within(row).getByRole('button', { name: 'Reveal' }));
    const sheet = await screen.findByTestId('owner-confirm');
    await user.type(await within(sheet).findByLabelText('Vault passphrase'), 'wrong');
    await user.click(within(sheet).getByRole('button', { name: 'Confirm' }));
    expect(await within(sheet).findByRole('alert')).toHaveTextContent('Wrong vault passphrase.');
    await user.type(within(sheet).getByLabelText('Vault passphrase'), PASS);
    await user.click(within(sheet).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(screen.queryByTestId('owner-confirm')).toBeNull());
    await waitFor(() => expect(within(row).getByRole('button', { name: 'Show' })).toBeInTheDocument());
    // confirmed first: the reveal is sent once, and never refused
    expect(posted(calls, 'POST', '/api/v1/vault/entries/e1/reveal')).toHaveLength(1);
    expect(posted(calls, 'POST', '/api/v1/vault/entries/e1/reveal')[0].body).toEqual({ field: 'password' });
    expect(posted(calls, 'POST', '/api/v1/auth/confirm').map((c) => c.body)).toEqual([
      { method: 'vault_passphrase', passphrase: 'wrong', unlock_vault: true },
      { method: 'vault_passphrase', passphrase: PASS, unlock_vault: true },
    ]);
    expect(posted(calls, 'POST', '/api/v1/vault/reauth')).toHaveLength(0);
    // masked until the owner toggles it
    expect(document.body.textContent).not.toContain(SECRET);
    await user.click(within(row).getByRole('button', { name: 'Show' }));
    expect(screen.getByTestId('revealed-password')).toHaveTextContent(SECRET);
    await user.click(within(row).getByRole('button', { name: 'Mask' }));
    expect(document.body.textContent).not.toContain(SECRET);
    await user.click(within(row).getByRole('button', { name: 'Show' }));
    // a second reveal within the confirmation window asks nothing
    await user.click(within(row).getByRole('button', { name: 'Hide' }));
    await user.click(within(row).getByRole('button', { name: 'Reveal' }));
    await waitFor(() => expect(posted(calls, 'POST', '/api/v1/vault/entries/e1/reveal')).toHaveLength(2));
    expect(screen.queryByTestId('owner-confirm')).toBeNull();
    expect(posted(calls, 'POST', '/api/v1/auth/confirm')).toHaveLength(2);
    await user.click(within(row).getByRole('button', { name: 'Show' }));
    // leaving the screen wipes it
    act(() => {
      window.location.hash = '#/settings/vault';
    });
    await screen.findByTestId('vault-status');
    expect(document.body.innerHTML).not.toContain(SECRET);
    assertNothingStored(SECRET, PASS);
  });

  it('copy: writes the password to the clipboard without showing it; the clipboard is cleared later if unchanged', async () => {
    const user = userEvent.setup();
    let clip = '';
    const writeText = vi.fn(async (t: string) => {
      clip = t;
    });
    Object.defineProperty(navigator, 'clipboard', { value: { writeText, readText: vi.fn(async () => clip) }, configurable: true });
    mount('#/settings/vault/entries/e1', routes({ 'POST /api/v1/vault/entries/e1/reveal': () => ok({ id: 'e1', field: 'password', value: SECRET }) }));
    const row = await screen.findByTestId('vault-password');
    await user.click(within(row).getByRole('button', { name: 'Copy password' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(SECRET));
    expect(document.body.textContent).not.toContain(SECRET);
    expect(await screen.findByText('Password copied')).toBeInTheDocument();
    assertNothingStored(SECRET);

    // the clearing itself (short delay): cleared when unchanged, kept when the owner copied something else
    await act(async () => {
      await copySecret('pw-one', 0.05);
      await new Promise((r) => setTimeout(r, 120));
    });
    expect(clip).toBe('');
    await act(async () => {
      await copySecret('pw-two', 0.05);
      clip = 'something the owner copied';
      await new Promise((r) => setTimeout(r, 120));
    });
    expect(clip).toBe('something the owner copied');
  });

  it('agent access: mode, add a grant (website credentials only), change the approval rule, revoke', async () => {
    const user = userEvent.setup();
    let av = { agent_id: 'a1', mode: 'SELECTED', managed_tags: [], grants: [GRANT], recent: [] };
    const { calls } = mount(
      '#/agents/a1/vault',
      routes({
        'GET /api/v1/agents/a1/vault': () => ok(av),
        'GET /api/v1/vault/entries': () => ok([ENTRY, { ...ENTRY, id: 'e2', display_name: 'OpenAI API', origin: null, credential_type: 'api_token' }]),
        'POST /api/v1/agents/a1/vault/grants': (c) => {
          const g = { ...GRANT, id: 'g2', approval_policy: (c.body as { approval_policy: string }).approval_policy };
          av = { ...av, grants: [...av.grants, g] };
          return ok(g, 201);
        },
        'PATCH /api/v1/vault/grants/g1': (c) => ok({ ...GRANT, ...(c.body as object) }),
        'POST /api/v1/vault/grants/g1/revoke': () => {
          av = { ...av, grants: av.grants.map((g) => (g.id === 'g1' ? { ...g, enabled: false } : g)) };
          return ok({ ...GRANT, enabled: false });
        },
        'PUT /api/v1/agents/a1/vault': (c) => ok({ ...av, ...(c.body as object) }),
      }),
    );
    expect(await screen.findByTestId('vault-mode')).toHaveTextContent('Selected credentials');
    expect(screen.getByRole('radio', { name: /Selected credentials/ })).toHaveAttribute('aria-checked', 'true');
    // add
    await user.click(screen.getByRole('button', { name: 'Add' }));
    const sheet = await screen.findByRole('dialog', { name: 'Give Researcher a credential' });
    const select = await within(sheet).findByLabelText('Credential');
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['GitHub (work) — https://github.com']);
    await user.click(within(sheet).getByRole('radio', { name: /Ask once per task/ }));
    await user.click(within(sheet).getByRole('button', { name: 'Give access' }));
    await waitFor(() => expect(posted(calls, 'POST', '/api/v1/agents/a1/vault/grants')).toHaveLength(1));
    expect(posted(calls, 'POST', '/api/v1/agents/a1/vault/grants')[0].body).toEqual({ entry_id: 'e1', approval_policy: 'once_per_task' });
    await waitFor(() => expect(screen.getAllByTestId('vault-grant')).toHaveLength(2));
    // approval rule
    const first = screen.getAllByTestId('vault-grant')[0];
    await user.selectOptions(within(first).getByLabelText('When to ask you'), 'auto');
    await waitFor(() => expect(posted(calls, 'PATCH', '/api/v1/vault/grants/g1')[0]?.body).toEqual({ approval_policy: 'auto' }));
    // revoke (confirmed)
    await user.click(within(first).getByRole('button', { name: 'Revoke' }));
    const dialog = await screen.findByRole('dialog', { name: /Revoke access to GitHub \(work\)/ });
    await user.click(within(dialog).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(posted(calls, 'POST', '/api/v1/vault/grants/g1/revoke')).toHaveLength(1));
    // mode
    await user.click(screen.getByRole('radio', { name: /No vault access/ }));
    await waitFor(() => expect(posted(calls, 'PUT', '/api/v1/agents/a1/vault')[0]?.body).toEqual({ mode: 'NONE', managed_tags: [] }));
  });

  it('settings: auto-lock and agent credential use', async () => {
    const user = userEvent.setup();
    const { calls } = mount('#/settings/vault/settings', routes({ 'PUT /api/v1/vault/settings': (c) => ok(status({ ...(c.body as object) })) }));
    const group = await screen.findByTestId('vault-autolock');
    expect(within(group).getByRole('radio', { name: '15 minutes' })).toHaveAttribute('aria-checked', 'true');
    await user.click(within(group).getByRole('radio', { name: '30 minutes' }));
    await waitFor(() => expect(posted(calls, 'PUT', '/api/v1/vault/settings')[0]?.body).toEqual({ auto_lock_minutes: 30 }));
    await user.click(screen.getByRole('switch', { name: 'Agent credential use' }));
    await waitFor(() => expect(posted(calls, 'PUT', '/api/v1/vault/settings')[1]?.body).toEqual({ broker_enabled: false }));
  });

  it('export (passphrase re-confirmed, share / download / copy) and import (file, export passphrase, confirmation)', async () => {
    const user = userEvent.setup();
    const EXPORT = { header: { format: 'nebula-vault-export', version: 1, created_at: NOW, entry_count: 2, kdf: {} }, nonce: 'bm9uY2U=', ciphertext: 'Y2lwaGVydGV4dA==' };
    let fresh = false;
    let clip = '';
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async (t: string) => void (clip = t)), readText: vi.fn(async () => clip) }, configurable: true });
    const share = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'share', { value: share, configurable: true });
    Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true });
    const { calls } = mount(
      '#/settings/vault/settings',
      routes({
        'GET /api/v1/auth/assurance': () => ok(assurance({ fresh, reauth: fresh })),
        'POST /api/v1/auth/confirm': confirmByPassphrase(() => {
          fresh = true;
        }),
        'POST /api/v1/vault/export': () => (fresh ? ok(EXPORT) : apiError(403, 'reauth_required', 'confirm the vault passphrase again')),
        'POST /api/v1/vault/import': () => ok({ imported: 2 }),
      }),
    );
    await user.type(await screen.findByLabelText('Export passphrase'), 'export-pass-phrase-1');
    await user.type(screen.getByLabelText('Repeat the export passphrase'), 'export-pass-phrase-1');
    await user.click(screen.getByRole('button', { name: 'Export vault' }));
    const sheet = await screen.findByTestId('owner-confirm');
    await user.type(await within(sheet).findByLabelText('Vault passphrase'), PASS);
    await user.click(within(sheet).getByRole('button', { name: 'Confirm' }));
    const ready = await screen.findByTestId('vault-export-ready');
    expect(ready).toHaveTextContent('2 credentials, encrypted.');
    // ONE confirmation before the export: it is sent once
    expect(posted(calls, 'POST', '/api/v1/vault/export').map((c) => c.body)).toEqual([{ export_passphrase: 'export-pass-phrase-1' }]);
    expect(posted(calls, 'POST', '/api/v1/auth/confirm').map((c) => c.body)).toEqual([{ method: 'vault_passphrase', passphrase: PASS, unlock_vault: true }]);
    await user.click(within(ready).getByRole('button', { name: 'Share file' }));
    await waitFor(() => expect(share).toHaveBeenCalled());
    const shared = (share.mock.calls[0] as unknown as [{ files: File[] }])[0];
    expect(shared.files[0].name).toBe('nebula-vault-export.json');
    expect(JSON.parse(await readBlob(shared.files[0]))).toEqual(EXPORT);
    await user.click(within(ready).getByRole('button', { name: 'Copy as text' }));
    await waitFor(() => expect(JSON.parse(clip)).toEqual(EXPORT));
    await user.click(within(ready).getByRole('button', { name: 'Done' }));

    // import
    const file = new File([JSON.stringify(EXPORT)], 'backup.json', { type: 'application/json' });
    await user.upload(screen.getByTestId('vault-import-file'), file);
    expect(await screen.findByText('backup.json · 2 credentials')).toBeInTheDocument();
    const importPass = screen.getAllByLabelText('Export passphrase').at(-1) as HTMLElement;
    await user.type(importPass, 'export-pass-phrase-1');
    await user.click(screen.getByRole('button', { name: 'Import' }));
    const confirm = await screen.findByRole('dialog', { name: 'Import these credentials?' });
    expect(posted(calls, 'POST', '/api/v1/vault/import')).toHaveLength(0);
    await user.click(within(confirm).getByRole('button', { name: 'Import' }));
    await waitFor(() => expect(posted(calls, 'POST', '/api/v1/vault/import')).toHaveLength(1));
    expect(posted(calls, 'POST', '/api/v1/vault/import')[0].body).toEqual({ export_passphrase: 'export-pass-phrase-1', export: EXPORT, confirm: true });
    expect(posted(calls, 'POST', '/api/v1/auth/confirm')).toHaveLength(1); // still confirmed: no second prompt
    expect(await screen.findByText('2 credentials imported')).toBeInTheDocument();
    assertNothingStored('export-pass-phrase-1', PASS);
  });

  it('Smart sign-in: settings, remote PIN and trusted providers (exact https origins only)', async () => {
    const user = userEvent.setup();
    let trust = { builtin: [{ id: 'microsoft', name: 'Microsoft', sign_in_hosts: ['login.microsoftonline.com'], services: ['teams.microsoft.com'] }], relationships: [] as unknown[], verified_sites: [] as unknown[] };
    const { calls } = mount(
      '#/settings/vault/signin',
      routes({
        'GET /api/v1/smart-auth/settings': () => ok({ enabled: true, remote_submission: true, allow_local_network: false, pin: { configured: false, set_at: null, locked_until: null }, local: false }),
        'PUT /api/v1/smart-auth/settings': (c) => ok({ enabled: true, remote_submission: true, allow_local_network: false, pin: { configured: false, set_at: null, locked_until: null }, ...(c.body as object) }),
        'PUT /api/v1/smart-auth/pin': () => ok({ configured: true, set_at: NOW, locked_until: null }),
        'GET /api/v1/smart-auth/trust': () => ok(trust),
        'POST /api/v1/smart-auth/trust/relationships': (c) => {
          trust = { ...trust, relationships: [{ ...(c.body as object), added_at: NOW }] };
          return ok(trust, 201);
        },
        'DELETE /api/v1/smart-auth/trust/relationships': () => {
          trust = { ...trust, relationships: [] };
          return ok(trust);
        },
        'POST /api/v1/smart-auth/trust/sites': (c) => {
          trust = { ...trust, verified_sites: [{ ...(c.body as object), added_at: NOW }] };
          return ok(trust, 201);
        },
      }),
    );
    expect(await screen.findByText('Microsoft')).toBeInTheDocument();
    await user.click(screen.getByRole('switch', { name: 'Answer from outside the Mac' }));
    await waitFor(() => expect(posted(calls, 'PUT', '/api/v1/smart-auth/settings')[0]?.body).toEqual({ remote_submission: false }));
    // remote PIN
    const pin = screen.getByTestId('signin-pin');
    await user.type(within(pin).getByLabelText('PIN'), '846213');
    await user.type(within(pin).getByLabelText('Repeat the PIN'), '846213');
    await user.click(within(pin).getByRole('button', { name: 'Set PIN' }));
    await waitFor(() => expect(posted(calls, 'PUT', '/api/v1/smart-auth/pin')[0]?.body).toEqual({ pin: '846213' }));
    // a relationship: http is refused locally, a bare host becomes https://
    await user.type(screen.getByLabelText('Service (https://…)'), 'teams.example.com');
    await user.type(screen.getByLabelText('Sign-in provider (https://…)'), 'http://login.example.com');
    await user.click(screen.getByRole('button', { name: 'Add relationship' }));
    expect(screen.getByText('Only https:// addresses can be trusted.')).toBeInTheDocument();
    expect(posted(calls, 'POST', '/api/v1/smart-auth/trust/relationships')).toHaveLength(0);
    await user.clear(screen.getByLabelText('Sign-in provider (https://…)'));
    await user.type(screen.getByLabelText('Sign-in provider (https://…)'), 'login.example.com');
    await user.click(screen.getByRole('button', { name: 'Add relationship' }));
    await waitFor(() => expect(posted(calls, 'POST', '/api/v1/smart-auth/trust/relationships')).toHaveLength(1));
    expect(posted(calls, 'POST', '/api/v1/smart-auth/trust/relationships')[0].body).toEqual({ service: 'https://teams.example.com', idp: 'https://login.example.com', first_party: false });
    const remove = await screen.findByRole('button', { name: 'Remove https://teams.example.com → https://login.example.com' });
    await user.click(remove);
    await waitFor(() => expect(posted(calls, 'DELETE', '/api/v1/smart-auth/trust/relationships')).toHaveLength(1));
    expect(posted(calls, 'DELETE', '/api/v1/smart-auth/trust/relationships')[0].url).toBe(
      '/api/v1/smart-auth/trust/relationships?service=https%3A%2F%2Fteams.example.com&idp=https%3A%2F%2Flogin.example.com',
    );
    // a verified site
    await user.type(screen.getByLabelText('Site (https://…)'), 'https://intranet.example.com/login');
    await user.click(screen.getByRole('button', { name: 'Add verified site' }));
    await waitFor(() => expect(posted(calls, 'POST', '/api/v1/smart-auth/trust/sites')[0]?.body).toEqual({ origin: 'https://intranet.example.com' }));
    assertNothingStored('846213');
  });

  it('Smart sign-in: passkey / security key requests — the site’s password option by default, "Ask me first" saves passkey_fallback', async () => {
    const user = userEvent.setup();
    let st: Record<string, unknown> = { enabled: true, remote_submission: true, allow_local_network: false, pin: { configured: false, set_at: null, locked_until: null }, local: false };
    const { calls } = mount(
      '#/settings/vault/signin',
      routes({
        'GET /api/v1/smart-auth/settings': () => ok(st),
        'PUT /api/v1/smart-auth/settings': (c) => {
          st = { ...st, ...(c.body as object) };
          return ok(st);
        },
        'GET /api/v1/smart-auth/trust': () => ok({ builtin: [], relationships: [], verified_sites: [] }),
      }),
    );
    const group = await screen.findByRole('radiogroup', { name: 'When a site asks for a passkey or security key' });
    const auto = within(group).getByRole('radio', { name: /Use the site’s password option automatically \(recommended\)/ });
    const ask = within(group).getByRole('radio', { name: /Ask me first/ });
    expect(auto).toHaveAttribute('aria-checked', 'true'); // an older host without the key: the default
    await user.click(ask);
    await waitFor(() => expect(posted(calls, 'PUT', '/api/v1/smart-auth/settings')[0]?.body).toEqual({ passkey_fallback: 'ask' }));
    await waitFor(() => expect(ask).toHaveAttribute('aria-checked', 'true'));
    expect(auto).toHaveAttribute('aria-checked', 'false');
  });

  it('operators keep the read-only screen (no management controls)', async () => {
    mount('#/settings/vault', routes({ 'GET /api/v1/miniapp/me': () => ok({ ...ME_OWNER, role: 'operator', admin: false }) }));
    expect(await screen.findByText('Vault management is reserved for the NEBULA owner')).toBeInTheDocument();
    expect(screen.queryByTestId('vault-unlock')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Add credential' })).toBeNull();
  });
});
