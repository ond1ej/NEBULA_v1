import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setCsrfToken } from '../../api';
import { ToastProvider } from '../../components/Toast';
import { EventHub, EventsProvider } from '../../hooks/useEvents';
import { downloadBlob } from '../../lib/format';
import { apiError, installFetch, ok, type RecordedCall } from '../../test/fetchMock';
import { VaultPage } from './VaultPage';

// The export is handed to the browser as a Blob download; capture it instead of touching URL / anchors.
vi.mock('../../lib/format', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../lib/format')>()), downloadBlob: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setCsrfToken(null);
});

const now = () => Date.now() / 1000;
const T0 = now();

const broker = { enabled: true, available: true, reason: null, mechanism: 'isolated_login_session_handoff', environments: ['vm'] };

const status = (over: Record<string, unknown> = {}) => ({
  exists: true,
  locked: false,
  entry_count: 1,
  auto_lock_minutes: 15,
  unlocked_at: T0 - 30,
  lock_at: now() + 900,
  lockout_until: null,
  kdf: { alg: 'argon2id', time_cost: 3, memory_kib: 131072, parallelism: 2, calibrated_ms: 310 },
  broker,
  management_local: true,
  settings: { allow_lan_https: false, broker_enabled: true },
  ...over,
});

const core = (over: Record<string, unknown> = {}) => {
  const { broker: _b, management_local: _m, ...rest } = status(over);
  return rest;
};

const github = {
  id: 'e1',
  display_name: 'GitHub',
  app_name: 'GitHub web',
  origin: 'https://github.com',
  credential_type: 'website',
  tags: ['work'],
  created_at: 1_700_000_000,
  updated_at: 1_700_000_100,
  grant_count: 1,
};

const detail = { ...github, username: 'octo-owner', has_password: true, has_notes: true, login_url: 'https://github.com/login' };

function renderPage(hub?: EventHub) {
  return render(
    <ToastProvider>
      {hub ? (
        <EventsProvider hub={hub}>
          <VaultPage />
        </EventsProvider>
      ) : (
        <VaultPage />
      )}
    </ToastProvider>,
  );
}

let seq = 0;
function emit(hub: EventHub, type: string, payload: Record<string, unknown>) {
  seq += 1;
  act(() => {
    hub.handle(new MessageEvent(type, { data: JSON.stringify({ id: `ev${seq}`, sequence: seq, type, agent_id: null, task_id: null, timestamp: now(), payload }) }));
  });
}

/** No secret may appear in a URL / query string of any request. */
function expectNoSecretInUrls(calls: RecordedCall[], secrets: string[]) {
  for (const c of calls) {
    for (const s of secrets) {
      expect(c.url).not.toContain(s);
      expect(c.url).not.toContain(encodeURIComponent(s));
    }
  }
}

function spyLeaks() {
  const setItem = vi.spyOn(Storage.prototype, 'setItem');
  const consoles = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m));
  return {
    assertClean(secrets: string[]) {
      expect(setItem).not.toHaveBeenCalled();
      const dump = consoles.flatMap((s) => s.mock.calls.map((args) => args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '))).join('\n');
      for (const s of secrets) expect(dump).not.toContain(s);
    },
  };
}

describe('Password Vault: set-up, unlock and lock', () => {
  it('creates the vault with a clear no-recovery warning; the passphrase goes only into the POST body', async () => {
    setCsrfToken('c');
    const user = userEvent.setup();
    const leaks = spyLeaks();
    const PASS = 'Correct-Horse-Battery-Staple-77';
    let current = status({ exists: false, locked: true, entry_count: 0, unlocked_at: null, lock_at: null, kdf: null });
    const { calls } = installFetch({
      'GET /api/v1/vault/status': () => ok(current),
      'GET /api/v1/vault/entries': () => ok([]),
      'POST /api/v1/vault': (c) => {
        if ((c.body as { passphrase: string }).passphrase === 'my-login-password-1') return apiError(400, 'passphrase_reused', 'use a dedicated vault passphrase, not your NEBULA login password');
        current = status({ entry_count: 0 });
        return ok(core({ entry_count: 0 }), 201);
      },
    });
    renderPage();
    expect(await screen.findByText('Set up the Password Vault')).toBeInTheDocument();
    expect(screen.getByText(/If you lose this passphrase the vault cannot be decrypted — there is no recovery or backdoor/)).toBeInTheDocument();

    const p1 = screen.getByLabelText(/^Vault passphrase/, { selector: 'input' });
    const p2 = screen.getByLabelText(/^Repeat the passphrase/, { selector: 'input' });
    expect(p1).toHaveAttribute('autocomplete', 'new-password');
    expect(p1).toHaveAttribute('type', 'password');
    expect(p2).toHaveAttribute('autocomplete', 'new-password');

    // The host's error message is shown (never a secret).
    await user.type(p1, 'my-login-password-1');
    await user.type(p2, 'my-login-password-1');
    expect(screen.getByText(/Strength:/)).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: /cannot be recovered/ }));
    await user.click(screen.getByRole('button', { name: 'Create vault' }));
    expect(await screen.findByText('use a dedicated vault passphrase, not your NEBULA login password')).toBeInTheDocument();
    // Cleared after the failed attempt.
    expect(p1).toHaveValue('');

    await user.type(p1, PASS);
    await user.type(p2, 'mismatch-mismatch');
    expect(screen.getByRole('button', { name: /Create vault/ })).toBeDisabled();
    await user.clear(p2);
    await user.type(p2, PASS);
    await user.click(screen.getByRole('button', { name: 'Create vault' }));

    expect(await screen.findByRole('button', { name: 'Lock now' })).toBeInTheDocument();
    expect(screen.getByText('Unlocked')).toBeInTheDocument();
    const creates = calls.filter((c) => c.method === 'POST' && c.path === '/api/v1/vault');
    expect(creates.at(-1)?.body).toEqual({ passphrase: PASS });
    expect(creates.at(-1)?.headers['x-csrf-token']).toBe('c');
    expectNoSecretInUrls(calls, [PASS]);
    leaks.assertClean([PASS]);
    expect(document.body.textContent).not.toContain(PASS);
  });

  it('shows attempts left after a wrong passphrase and a lockout countdown when rate limited', async () => {
    setCsrfToken('c');
    const user = userEvent.setup();
    let n = 0;
    installFetch({
      'GET /api/v1/vault/status': () => ok(status({ locked: true, unlocked_at: null, lock_at: null })),
      'GET /api/v1/vault/entries': () => ok([github]),
      'POST /api/v1/vault/unlock': () => {
        n += 1;
        return n === 1
          ? apiError(401, 'wrong_passphrase', 'wrong vault passphrase', { attempts_left: 2 })
          : apiError(429, 'rate_limited', 'too many wrong passphrases — try again in 90 s', { retry_after: 90 });
      },
    });
    renderPage();
    const input = await screen.findByLabelText('Vault passphrase', { selector: 'input' });
    expect(input).toHaveAttribute('autocomplete', 'new-password');
    // Metadata stays visible while locked.
    expect(await screen.findByText('GitHub', { selector: 'p' })).toBeInTheDocument();

    await user.type(input, 'not-the-passphrase');
    await user.click(screen.getByRole('button', { name: 'Unlock vault' }));
    expect(await screen.findByText('wrong vault passphrase')).toBeInTheDocument();
    expect(screen.getByText('2 attempts left before a temporary lockout.')).toBeInTheDocument();
    expect(input).toHaveValue('');

    await user.type(input, 'still-not-it');
    await user.click(screen.getByRole('button', { name: 'Unlock vault' }));
    expect(await screen.findByText(/Too many wrong passphrases\. Try again in/)).toBeInTheDocument();
    expect(screen.getByText(/^1:(30|29)$/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Unlock vault/ })).toBeDisabled();
    expect(screen.getByLabelText('Vault passphrase', { selector: 'input' })).toBeDisabled();
  });

  it('shows a lockout that is already running (lockout_until from the status)', async () => {
    installFetch({
      'GET /api/v1/vault/status': () => ok(status({ locked: true, unlocked_at: null, lock_at: null, lockout_until: now() + 61 })),
      'GET /api/v1/vault/entries': () => ok([]),
    });
    renderPage();
    expect(await screen.findByText(/Try again in/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Unlock vault/ })).toBeDisabled();
  });

  it('unlocks, shows the auto-lock countdown, and locks again with Lock now', async () => {
    setCsrfToken('c');
    const user = userEvent.setup();
    let current = status({ locked: true, unlocked_at: null, lock_at: null });
    const { calls } = installFetch({
      'GET /api/v1/vault/status': () => ok(current),
      'GET /api/v1/vault/entries': () => ok([github]),
      'POST /api/v1/vault/unlock': () => {
        current = status({ lock_at: now() + 14 * 60 + 30 });
        return ok(core({ lock_at: now() + 14 * 60 + 30 }));
      },
      'POST /api/v1/vault/lock': () => {
        current = status({ locked: true, unlocked_at: null, lock_at: null });
        return ok({ locked: true, expired_approvals: 0 });
      },
    });
    renderPage();
    await user.type(await screen.findByLabelText('Vault passphrase', { selector: 'input' }), 'the right passphrase');
    await user.click(screen.getByRole('button', { name: 'Unlock vault' }));
    expect(await screen.findByRole('timer')).toHaveTextContent(/Auto-lock in 14:(30|29|28)/);
    expect(calls.find((c) => c.path === '/api/v1/vault/unlock')?.body).toEqual({ passphrase: 'the right passphrase' });

    await user.click(screen.getByRole('button', { name: 'Lock now' }));
    expect(await screen.findByRole('button', { name: /Unlock vault/ })).toBeInTheDocument();
    expect(screen.getByText('Locked')).toBeInTheDocument();
    expect(screen.queryByRole('timer')).toBeNull();
  });

  it('shows the local-only notice and no management controls when management_local is false', async () => {
    installFetch({
      'GET /api/v1/vault/status': () => ok(status({ locked: true, unlocked_at: null, lock_at: null, management_local: false })),
      'GET /api/v1/vault/entries': () => ok([github]),
    });
    renderPage();
    expect(await screen.findByText('Vault management is only available on this Mac')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Unlock vault/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Add credential/ })).toBeDisabled();
    expect(await screen.findByText('GitHub', { selector: 'p' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit GitHub' })).toBeNull();
  });
});

describe('Password Vault: credentials', () => {
  it('renders metadata only — a secret in a malformed response never reaches the screen', async () => {
    const user = userEvent.setup();
    installFetch({
      'GET /api/v1/vault/status': () => ok(status()),
      'GET /api/v1/vault/entries': () => ok([{ ...github, password: 'CANARY-SECRET', notes: 'CANARY-SECRET', username: 'CANARY-SECRET' }]),
      'GET /api/v1/vault/entries/e1': () => ok({ ...detail, password: 'CANARY-SECRET', notes: 'CANARY-SECRET' }),
    });
    renderPage();
    expect(await screen.findByText('https://github.com')).toBeInTheDocument();
    expect(screen.getByText('work')).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain('CANARY-SECRET');

    await user.click(screen.getByRole('row', { name: 'Open GitHub' }));
    const drawer = await screen.findByRole('dialog', { name: 'GitHub' });
    expect(await within(drawer).findByText('octo-owner')).toBeInTheDocument();
    expect(within(drawer).getByLabelText('Password hidden')).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain('CANARY-SECRET');
  });

  it('reveals only on click, asks for the passphrase on reauth_required, and hides the value on a lock event', async () => {
    setCsrfToken('c');
    const user = userEvent.setup();
    const hub = new EventHub();
    const leaks = spyLeaks();
    const SECRET = 'hunter2-REVEALED-value';
    let reauthed = false;
    let current = status();
    const { calls } = installFetch({
      'GET /api/v1/vault/status': () => ok(current),
      'GET /api/v1/vault/entries': () => ok([github]),
      'GET /api/v1/vault/entries/e1': () => ok(detail),
      'POST /api/v1/vault/entries/e1/reveal': () =>
        reauthed ? ok({ id: 'e1', field: 'password', value: SECRET }) : apiError(403, 'reauth_required', 'confirm the vault passphrase again to continue'),
      'POST /api/v1/vault/reauth': (c) => {
        if ((c.body as { passphrase: string }).passphrase !== 'vault passphrase ok') return apiError(401, 'wrong_passphrase', 'wrong vault passphrase');
        reauthed = true;
        return ok({ reauth_until: now() + 300 });
      },
    });
    renderPage(hub);
    await user.click(await screen.findByRole('row', { name: 'Open GitHub' }));
    const drawer = await screen.findByRole('dialog', { name: 'GitHub' });
    await within(drawer).findByText('octo-owner');
    expect(calls.some((c) => c.path.endsWith('/reveal'))).toBe(false);

    await user.click(within(drawer).getByRole('button', { name: 'Reveal password' }));
    const confirm = await screen.findByRole('dialog', { name: 'Confirm the vault passphrase' });
    const pass = within(confirm).getByLabelText('Vault passphrase', { selector: 'input' });
    expect(pass).toHaveAttribute('autocomplete', 'new-password');
    await user.type(pass, 'wrong one');
    await user.click(within(confirm).getByRole('button', { name: 'Confirm' }));
    expect(await within(confirm).findByText('wrong vault passphrase')).toBeInTheDocument();
    await user.type(within(confirm).getByLabelText('Vault passphrase', { selector: 'input' }), 'vault passphrase ok');
    await user.click(within(confirm).getByRole('button', { name: 'Confirm' }));

    expect(await screen.findByTestId('revealed-password')).toHaveTextContent(SECRET);
    expect(screen.queryByRole('dialog', { name: 'Confirm the vault passphrase' })).toBeNull();
    const reveals = calls.filter((c) => c.path.endsWith('/reveal'));
    expect(reveals).toHaveLength(2); // refused, then retried once after the passphrase confirmation
    expect(reveals[1].body).toEqual({ field: 'password' });
    expect(calls.filter((c) => c.path === '/api/v1/vault/reauth').at(-1)?.body).toEqual({ passphrase: 'vault passphrase ok' });

    current = status({ locked: true, unlocked_at: null, lock_at: null });
    emit(hub, 'vault.status.changed', { exists: true, locked: true, entry_count: 1 });
    await waitFor(() => expect(document.body.textContent).not.toContain(SECRET));
    expect(screen.queryByTestId('revealed-password')).toBeNull();
    expect(await screen.findByRole('button', { name: /Unlock vault/ })).toBeInTheDocument();
    expectNoSecretInUrls(calls, [SECRET, 'vault passphrase ok']);
    leaks.assertClean([SECRET, 'vault passphrase ok']);
    hub.stop();
  });

  it('hides a revealed value after 30 seconds and drops it when the drawer closes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const SECRET = 'auto-hide-SECRET-1';
    const { calls } = installFetch({
      'GET /api/v1/vault/status': () => ok(status()),
      'GET /api/v1/vault/entries': () => ok([github]),
      'GET /api/v1/vault/entries/e1': () => ok(detail),
      'POST /api/v1/vault/entries/e1/reveal': (c) => ok({ id: 'e1', field: (c.body as { field: string }).field, value: SECRET }),
    });
    renderPage();
    await user.click(await screen.findByRole('row', { name: 'Open GitHub' }));
    const drawer = await screen.findByRole('dialog', { name: 'GitHub' });
    await user.click(await within(drawer).findByRole('button', { name: 'Reveal password' }));
    expect(await screen.findByTestId('revealed-password')).toHaveTextContent(SECRET);
    expect(screen.getByText(/Hides in \d+ s/)).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(30_500);
    });
    expect(screen.queryByTestId('revealed-password')).toBeNull();
    expect(document.body.textContent).not.toContain(SECRET);

    // Reveal again, close the drawer, reopen: the value is gone (component state dropped on unmount).
    await user.click(within(drawer).getByRole('button', { name: 'Reveal password' }));
    expect(await screen.findByTestId('revealed-password')).toHaveTextContent(SECRET);
    await user.click(within(screen.getByRole('dialog', { name: 'GitHub' })).getByRole('button', { name: 'Close' }));
    expect(document.body.textContent).not.toContain(SECRET);
    await user.click(screen.getByRole('row', { name: 'Open GitHub' }));
    const again = await screen.findByRole('dialog', { name: 'GitHub' });
    expect(await within(again).findByLabelText('Password hidden')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(SECRET);
    expect(calls.filter((c) => c.path.endsWith('/reveal'))).toHaveLength(2);
  });

  it('copies a password only on click, without showing it, and says so', async () => {
    const user = userEvent.setup();
    const SECRET = 'copy-me-SECRET-9';
    installFetch({
      'GET /api/v1/vault/status': () => ok(status()),
      'GET /api/v1/vault/entries': () => ok([github]),
      'GET /api/v1/vault/entries/e1': () => ok(detail),
      'POST /api/v1/vault/entries/e1/reveal': () => ok({ id: 'e1', field: 'password', value: SECRET }),
    });
    renderPage();
    await user.click(await screen.findByRole('row', { name: 'Open GitHub' }));
    const drawer = await screen.findByRole('dialog', { name: 'GitHub' });
    await within(drawer).findByText('octo-owner');
    expect(await navigator.clipboard.readText()).toBe('');
    await user.click(within(drawer).getByRole('button', { name: 'Copy password' }));
    expect(await screen.findByText('Password copied to the clipboard')).toBeInTheDocument();
    expect(await navigator.clipboard.readText()).toBe(SECRET);
    expect(screen.queryByTestId('revealed-password')).toBeNull();
    expect(document.body.textContent).not.toContain(SECRET);
  });

  it('adds a credential with a generated password; secrets only in the POST body', async () => {
    setCsrfToken('c');
    const user = userEvent.setup();
    const leaks = spyLeaks();
    const { calls } = installFetch({
      'GET /api/v1/vault/status': () => ok(status({ entry_count: 0 })),
      'GET /api/v1/vault/entries': () => ok([]),
      'POST /api/v1/vault/entries': (c) => ok({ ...github, id: 'e2', display_name: (c.body as { display_name: string }).display_name }, 201),
    });
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Add credential' }));
    const drawer = await screen.findByRole('dialog', { name: 'Add credential' });
    await user.type(within(drawer).getByLabelText(/Display name/), 'Shop');
    await user.type(within(drawer).getByLabelText(/^Origin/), 'https://shop.example');
    await user.type(within(drawer).getByLabelText('Username'), 'me@example.com');
    await user.click(within(drawer).getByRole('button', { name: 'Generate' }));
    const pw = within(drawer).getByLabelText('Password', { selector: 'input' });
    expect(pw).toHaveAttribute('type', 'password');
    expect(pw).toHaveAttribute('autocomplete', 'new-password');
    const generated = (pw as HTMLInputElement).value;
    expect(generated).toHaveLength(20);
    expect(generated).toMatch(/[a-z]/);
    expect(generated).toMatch(/[A-Z]/);
    expect(generated).toMatch(/[0-9]/);
    await user.type(within(drawer).getByLabelText('Notes'), 'recovery: 1234-5678');
    await user.type(within(drawer).getByLabelText('Tags'), 'Shopping, home');
    await user.click(within(drawer).getByRole('button', { name: 'Add credential' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add credential' })).toBeNull());
    const post = calls.find((c) => c.method === 'POST' && c.path === '/api/v1/vault/entries');
    expect(post?.body).toEqual({
      display_name: 'Shop',
      credential_type: 'website',
      origin: 'https://shop.example',
      username: 'me@example.com',
      password: generated,
      notes: 'recovery: 1234-5678',
      tags: ['shopping', 'home'],
    });
    expect(await screen.findByText('Credential added')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(generated);
    expectNoSecretInUrls(calls, [generated]);
    leaks.assertClean([generated, 'recovery: 1234-5678']);
  });

  it('deletes a credential only after confirmation', async () => {
    setCsrfToken('c');
    const user = userEvent.setup();
    const { calls } = installFetch({
      'GET /api/v1/vault/status': () => ok(status()),
      'GET /api/v1/vault/entries': () => ok([github]),
      'DELETE /api/v1/vault/entries/e1': () => ok({ deleted: true, grants_revoked: 1 }),
    });
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Delete GitHub' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete “GitHub”?' });
    expect(within(dialog).getByText(/cannot be undone/)).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    await user.click(within(dialog).getByRole('button', { name: 'Delete credential' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'DELETE')?.url).toBe('/api/v1/vault/entries/e1?confirm=true'));
  });
});

describe('Password Vault: agent access overview', () => {
  const grant = {
    id: 'g1',
    entry_id: 'e1',
    entry_name: 'GitHub',
    credential_type: 'website',
    agent_id: 'a1',
    allowed_origins: ['https://github.com'],
    allowed_actions: ['sign_in'],
    approval_policy: 'always_ask',
    enabled: true,
    expires_at: null,
    created_at: 1_700_000_000,
    last_used_at: null,
  };

  it('lists grants of all agents and revokes / deletes them', async () => {
    setCsrfToken('c');
    const user = userEvent.setup();
    let grants = [grant];
    const { calls } = installFetch({
      'GET /api/v1/vault/status': () => ok(status()),
      'GET /api/v1/vault/entries': () => ok([github]),
      'GET /api/v1/vault/grants': () => ok(grants),
      'GET /api/v1/agents': () => ok([{ id: 'a1', name: 'Researcher' }]),
      'POST /api/v1/vault/grants/g1/revoke': () => {
        grants = [{ ...grant, enabled: false }];
        return ok(grants[0]);
      },
      'DELETE /api/v1/vault/grants/g1': () => {
        grants = [];
        return ok({ deleted: true });
      },
    });
    renderPage();
    await user.click(await screen.findByRole('tab', { name: 'Agent access' }));
    const table = await screen.findByRole('table', { name: 'All agent grants' });
    expect(within(table).getByRole('link', { name: 'Researcher' })).toHaveAttribute('href', '#/agents/a1/security');
    expect(within(table).getByText('Always ask')).toBeInTheDocument();

    await user.click(within(table).getByRole('button', { name: 'Revoke grant for GitHub' }));
    expect(await within(table).findByText('Revoked')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST' && c.path === '/api/v1/vault/grants/g1/revoke')).toBe(true);

    await user.click(within(table).getByRole('button', { name: 'Delete grant for GitHub' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete this grant?' });
    await user.click(within(dialog).getByRole('button', { name: 'Delete grant' }));
    expect(await screen.findByText('No agent has access to a credential')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/v1/vault/grants/g1')).toBe(true);
  });

  it('shows the redacted history', async () => {
    const user = userEvent.setup();
    installFetch({
      'GET /api/v1/vault/status': () => ok(status()),
      'GET /api/v1/vault/entries': () => ok([github]),
      'GET /api/v1/vault/audit': () =>
        ok([
          { id: 'r1', ts: now() - 60, actor_type: 'agent', actor_id: 'agent:a1', agent_id: 'a1', agent_name: 'Researcher', entry_id: 'e1', entry_name: 'GitHub', task_id: 't1', operation: 'use.sign_in', destination_origin: 'https://github.com', approval_id: null, outcome: 'denied', reason_code: 'origin_not_allowed' },
          { id: 'r2', ts: now() - 120, actor_type: 'owner', actor_id: 'user:1', agent_id: null, agent_name: null, entry_id: 'e1', entry_name: 'GitHub', task_id: null, operation: 'reveal.password', destination_origin: null, approval_id: null, outcome: 'ok', reason_code: null },
        ]),
    });
    renderPage();
    await user.click(await screen.findByRole('tab', { name: 'History' }));
    const table = await screen.findByRole('table', { name: 'Vault history' });
    expect(within(table).getByText('Agent sign-in')).toBeInTheDocument();
    expect(within(table).getByText('origin_not_allowed')).toBeInTheDocument();
    expect(within(table).getByText('Password revealed')).toBeInTheDocument();
  });
});

describe('Password Vault: settings', () => {
  const exportFile = { header: { format: 'nebula-vault-export', version: 1, created_at: 1_700_000_000, entry_count: 2, kdf: { alg: 'argon2id' } }, nonce: 'bm9uY2U=', ciphertext: 'Y2lwaGVydGV4dA==' };

  it('changes auto-lock, downloads an encrypted export as a file, and imports only after an explicit confirmation', async () => {
    setCsrfToken('c');
    const user = userEvent.setup();
    const leaks = spyLeaks();
    const download = vi.mocked(downloadBlob);
    download.mockClear();
    let current = status();
    const { calls } = installFetch({
      'GET /api/v1/vault/status': () => ok(current),
      'GET /api/v1/vault/entries': () => ok([github]),
      'PUT /api/v1/vault/settings': (c) => {
        const b = c.body as { auto_lock_minutes?: number; allow_lan_https?: boolean };
        current = status({
          auto_lock_minutes: b.auto_lock_minutes ?? current.auto_lock_minutes,
          settings: { ...current.settings, ...(b.allow_lan_https === undefined ? {} : { allow_lan_https: b.allow_lan_https }) },
        });
        return ok(current);
      },
      'POST /api/v1/vault/export': () => ok(exportFile),
      'POST /api/v1/vault/import': () => ok({ imported: 2 }),
    });
    renderPage();
    await user.click(await screen.findByRole('tab', { name: 'Settings' }));
    expect(await screen.findByText(/Agents never see passwords;/)).toBeInTheDocument();
    expect(screen.getByText(/NEBULA signs in separately and hands over only the session/)).toBeInTheDocument();

    // Auto-lock
    await user.click(screen.getByRole('radio', { name: '30 min' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT' && (c.body as { auto_lock_minutes?: number }).auto_lock_minutes === 30)).toBe(true));

    // LAN HTTPS management: read from the status (no extra request), enabling needs a confirmation
    const lan = await screen.findByRole('switch', { name: 'Allow management over LAN HTTPS' });
    expect(lan).toHaveAttribute('aria-checked', 'false');
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1); // only the auto-lock change, no settings read via PUT {}
    await user.click(lan);
    const lanDialog = await screen.findByRole('dialog', { name: 'Allow vault management over LAN HTTPS?' });
    expect(calls.some((c) => (c.body as { allow_lan_https?: boolean } | undefined)?.allow_lan_https === true)).toBe(false);
    await user.click(within(lanDialog).getByRole('button', { name: 'Allow over LAN HTTPS' }));
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Allow management over LAN HTTPS' })).toHaveAttribute('aria-checked', 'true'));
    expect(calls.filter((c) => c.method === 'PUT').at(-1)?.body).toEqual({ allow_lan_https: true });

    // Export
    const EXPORT_PASS = 'export passphrase 2026';
    const exportForm = screen.getByRole('form', { name: 'Export the vault' });
    await user.type(within(exportForm).getByLabelText('Export passphrase', { selector: 'input' }), EXPORT_PASS);
    await user.type(within(exportForm).getByLabelText('Repeat the export passphrase', { selector: 'input' }), EXPORT_PASS);
    await user.click(within(exportForm).getByRole('button', { name: 'Download encrypted export' }));
    await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
    expect(calls.find((c) => c.path === '/api/v1/vault/export')?.body).toEqual({ export_passphrase: EXPORT_PASS });
    const [blob, filename] = download.mock.calls[0];
    expect(blob.type).toBe('application/json');
    expect(filename).toMatch(/^nebula-vault-export-\d{8}-\d{4}\.json$/);
    const text = await new Promise<string>((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.readAsText(blob);
    });
    expect(JSON.parse(text)).toEqual(exportFile);
    expect(await screen.findByText('Encrypted export downloaded')).toBeInTheDocument();
    expect(screen.getAllByLabelText(/export passphrase/i, { selector: 'input' }).every((i) => (i as HTMLInputElement).value === '')).toBe(true);

    // Import: file + passphrase + explicit confirmation step
    const importPass = screen.getAllByLabelText('Export passphrase', { selector: 'input' }).at(-1) as HTMLInputElement;
    await user.upload(screen.getByLabelText('Export file'), new File([JSON.stringify(exportFile)], 'backup.json', { type: 'application/json' }));
    expect(await screen.findByText('backup.json')).toBeInTheDocument();
    await user.type(importPass, EXPORT_PASS);
    await user.click(screen.getByRole('button', { name: 'Import…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Import 2 credentials?' });
    expect(calls.some((c) => c.path === '/api/v1/vault/import')).toBe(false);
    await user.click(within(dialog).getByRole('button', { name: 'Import' }));
    await waitFor(() => expect(calls.find((c) => c.path === '/api/v1/vault/import')?.body).toEqual({ export_passphrase: EXPORT_PASS, export: exportFile, confirm: true }));
    expect(await screen.findByText('Imported 2 credentials')).toBeInTheDocument();

    expectNoSecretInUrls(calls, [EXPORT_PASS]);
    leaks.assertClean([EXPORT_PASS]);
  });

  it('reflects allow_lan_https from the status', async () => {
    const user = userEvent.setup();
    const { calls } = installFetch({
      'GET /api/v1/vault/status': () => ok(status({ settings: { allow_lan_https: true, broker_enabled: true } })),
      'GET /api/v1/vault/entries': () => ok([]),
    });
    renderPage();
    await user.click(await screen.findByRole('tab', { name: 'Settings' }));
    expect(await screen.findByRole('switch', { name: 'Allow management over LAN HTTPS' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText(/can manage — and reveal — vault credentials over HTTPS/)).toBeInTheDocument();
    expect(calls.some((c) => c.method !== 'GET')).toBe(false);
  });

  it('turns agent sign-in (credential broker) off and on, showing availability and the reason', async () => {
    setCsrfToken('c');
    const user = userEvent.setup();
    const reason = 'isolation self-test failed';
    let current = status({ broker: { ...broker, available: false, reason } });
    const { calls } = installFetch({
      'GET /api/v1/vault/status': () => ok(current),
      'GET /api/v1/vault/entries': () => ok([]),
      'PUT /api/v1/vault/settings': (c) => {
        const on = (c.body as { broker_enabled: boolean }).broker_enabled;
        current = status({
          broker: { ...broker, enabled: on, available: false, reason: on ? reason : 'disabled by the owner' },
          settings: { allow_lan_https: false, broker_enabled: on },
        });
        return ok(current);
      },
    });
    renderPage();
    await user.click(await screen.findByRole('tab', { name: 'Settings' }));
    const sw = await screen.findByRole('switch', { name: 'Agent sign-in (credential broker)' });
    expect(sw).toHaveAttribute('aria-checked', 'true');
    expect(sw).toHaveAccessibleDescription(/agents cannot use any vault credential.*pending sign-in requests are cancelled/i);
    expect(screen.getByText('Broker unavailable')).toBeInTheDocument();
    expect(screen.getByText(reason)).toBeInTheDocument();

    await user.click(sw);
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ broker_enabled: false }));
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Agent sign-in (credential broker)' })).toHaveAttribute('aria-checked', 'false'));
    expect(screen.getByText('Off')).toBeInTheDocument();
    expect(screen.getByText('disabled by the owner')).toBeInTheDocument();
    expect(await screen.findByText('Agent sign-in turned off')).toBeInTheDocument();

    await user.click(screen.getByRole('switch', { name: 'Agent sign-in (credential broker)' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'PUT').at(-1)?.body).toEqual({ broker_enabled: true }));
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Agent sign-in (credential broker)' })).toHaveAttribute('aria-checked', 'true'));
  });

  it('cannot toggle agent sign-in from a non-local session', async () => {
    const user = userEvent.setup();
    installFetch({
      'GET /api/v1/vault/status': () => ok(status({ locked: true, unlocked_at: null, lock_at: null, management_local: false })),
      'GET /api/v1/vault/entries': () => ok([]),
    });
    renderPage();
    await user.click(await screen.findByRole('tab', { name: 'Settings' }));
    expect(await screen.findByRole('switch', { name: 'Agent sign-in (credential broker)' })).toBeDisabled();
    expect(screen.getByRole('switch', { name: 'Allow management over LAN HTTPS' })).toBeDisabled();
  });
});

describe('Password Vault: live history', () => {
  const row = (id: string, operation: string, actor_type = 'owner') => ({
    id, ts: now(), actor_type, actor_id: actor_type === 'agent' ? 'agent:a1' : 'user:1', agent_id: actor_type === 'agent' ? 'a1' : null, agent_name: actor_type === 'agent' ? 'Researcher' : null,
    entry_id: 'e1', entry_name: 'GitHub', task_id: null, operation, destination_origin: null, approval_id: null, outcome: 'ok', reason_code: null,
  });

  it('refreshes the history table on vault.access events', async () => {
    const user = userEvent.setup();
    const hub = new EventHub();
    let rows = [row('r1', 'unlock')];
    const { calls } = installFetch({
      'GET /api/v1/vault/status': () => ok(status()),
      'GET /api/v1/vault/entries': () => ok([github]),
      'GET /api/v1/vault/audit': () => ok(rows),
    });
    renderPage(hub);
    await user.click(await screen.findByRole('tab', { name: 'History' }));
    const table = await screen.findByRole('table', { name: 'Vault history' });
    expect(within(table).getByText('Unlock')).toBeInTheDocument();
    expect(within(table).queryByText('Export')).toBeNull();

    rows = [row('r2', 'export'), ...rows];
    emit(hub, 'vault.access', { operation: 'export', outcome: 'ok', reason_code: 'entries_1', destination_origin: null, entry_id: null, actor_type: 'owner' });
    expect(await within(table).findByText('Export')).toBeInTheDocument();
    expect(calls.filter((c) => c.path === '/api/v1/vault/audit').length).toBeGreaterThanOrEqual(2);
    hub.stop();
  });
});

