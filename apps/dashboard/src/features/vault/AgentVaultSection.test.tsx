import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setCsrfToken } from '../../api';
import { ToastProvider } from '../../components/Toast';
import { installFetch, ok } from '../../test/fetchMock';
import { AgentVaultSection } from './AgentVaultSection';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setCsrfToken(null);
});

const T0 = Date.now() / 1000;
const broker = { enabled: true, available: true, reason: null, mechanism: 'isolated_login_session_handoff', environments: ['vm'] };
const status = (over: Record<string, unknown> = {}) => ({
  exists: true,
  locked: false,
  entry_count: 2,
  auto_lock_minutes: 15,
  unlocked_at: T0 - 30,
  lock_at: T0 + 900,
  lockout_until: null,
  kdf: null,
  broker,
  management_local: true,
  ...over,
});

const entries = [
  { id: 'e1', display_name: 'GitHub', app_name: '', origin: 'https://github.com', credential_type: 'website', tags: ['work'], created_at: 1, updated_at: 1, grant_count: 0 },
  { id: 'e2', display_name: 'Stripe key', app_name: '', origin: null, credential_type: 'api_token', tags: [], created_at: 1, updated_at: 1, grant_count: 0 },
];

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
  last_used_at: T0 - 3600,
};

const view = (over: Record<string, unknown> = {}) => ({ agent_id: 'a1', mode: 'NONE', managed_tags: [], grants: [], recent: [], ...over });

function renderSection() {
  return render(
    <ToastProvider>
      <AgentVaultSection agent={{ id: 'a1', name: 'Researcher' }} />
    </ToastProvider>,
  );
}

describe('Agent → Security → Password Vault', () => {
  it('defaults to NONE ("No vault access") and offers no grant until access is enabled', async () => {
    installFetch({
      'GET /api/v1/vault/status': () => ok(status()),
      'GET /api/v1/agents/a1/vault': () => ok(view()),
      'GET /api/v1/vault/entries': () => ok(entries),
    });
    renderSection();
    const none = await screen.findByRole('radio', { name: /No vault access/ });
    expect(none).toBeChecked();
    expect(screen.getByRole('radio', { name: /Selected credentials/ })).not.toBeChecked();
    expect(screen.getByRole('radio', { name: /Selected credentials/ })).toHaveAccessibleName(expect.stringContaining('Recommended'));
    expect(screen.getByRole('button', { name: /Add grant/ })).toBeDisabled();
    expect(screen.getByText('Researcher has no vault access.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Save vault access/ })).toBeDisabled();
  });

  it('switches to SELECTED and warns before MANAGED', async () => {
    setCsrfToken('c');
    const user = userEvent.setup();
    const { calls } = installFetch({
      'GET /api/v1/vault/status': () => ok(status()),
      'GET /api/v1/agents/a1/vault': () => ok(view()),
      'GET /api/v1/vault/entries': () => ok(entries),
      'PUT /api/v1/agents/a1/vault': (c) => ok(view({ mode: (c.body as { mode: string }).mode })),
    });
    renderSection();
    await user.click(await screen.findByRole('radio', { name: /Managed collection/ }));
    expect(screen.getByText('Managed access is broader')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Save vault access/ })).toBeDisabled(); // no collection tag yet
    await user.click(screen.getByRole('radio', { name: /Selected credentials/ }));
    await user.click(screen.getByRole('button', { name: 'Save vault access' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ mode: 'SELECTED', managed_tags: [] }));
    expect(await screen.findByRole('button', { name: 'Add grant' })).toBeEnabled();
  });

  it('creates a grant with the credential origin and offers Automatic only for a single origin', async () => {
    setCsrfToken('c');
    const user = userEvent.setup();
    let grants: unknown[] = [];
    const { calls } = installFetch({
      'GET /api/v1/vault/status': () => ok(status()),
      'GET /api/v1/agents/a1/vault': () => ok(view({ mode: 'SELECTED', grants })),
      'GET /api/v1/vault/entries': () => ok(entries),
      'POST /api/v1/agents/a1/vault/grants': (c) => {
        const b = c.body as { allowed_origins: string[]; approval_policy: string };
        grants = [{ ...grant, allowed_origins: b.allowed_origins, approval_policy: b.approval_policy }];
        return ok(grants[0], 201);
      },
    });
    renderSection();
    await user.click(await screen.findByRole('button', { name: 'Add grant' }));
    const dialog = await screen.findByRole('dialog', { name: 'Grant a credential to Researcher' });

    // Only website credentials can be granted.
    const credential = within(dialog).getByRole('combobox', { name: /Credential/ });
    expect(within(credential).getAllByRole('option').map((o) => o.textContent)).toEqual(['GitHub — https://github.com']);
    // The credential's own origin is pre-filled and fixed.
    const origins = within(dialog).getByRole('list', { name: 'Allowed origins' });
    expect(within(origins).getByText('https://github.com')).toBeInTheDocument();
    expect(within(origins).getByText('credential origin')).toBeInTheDocument();

    const policy = within(dialog).getByRole('combobox', { name: 'Approval' });
    expect(policy).toHaveValue('always_ask');
    const labels = () => within(policy).getAllByRole('option').map((o) => o.textContent);
    expect(labels()).toEqual(['Always ask (default)', 'Ask once per task', 'Automatic']);

    // A second origin only when added explicitly — and then Automatic is no longer offered.
    await user.type(within(dialog).getByLabelText('Add another origin (optional)'), 'https://gist.github.com/x');
    await user.click(within(dialog).getByRole('button', { name: 'Add' }));
    expect(within(origins).getByText('https://gist.github.com')).toBeInTheDocument();
    expect(labels()).toEqual(['Always ask (default)', 'Ask once per task']);
    await user.click(within(dialog).getByRole('button', { name: 'Remove origin https://gist.github.com' }));
    expect(labels()).toContain('Automatic');

    await user.selectOptions(policy, 'once_per_task');
    await user.click(within(dialog).getByRole('button', { name: 'Create grant' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
        entry_id: 'e1',
        allowed_origins: ['https://github.com'],
        allowed_actions: ['sign_in'],
        approval_policy: 'once_per_task',
      }),
    );
    const table = await screen.findByRole('table', { name: 'Grants of Researcher' });
    expect(within(table).getByText('Ask once per task')).toBeInTheDocument();
  });

  it('sends extra origins explicitly and never Automatic for several origins', async () => {
    setCsrfToken('c');
    const user = userEvent.setup();
    const { calls } = installFetch({
      'GET /api/v1/vault/status': () => ok(status()),
      'GET /api/v1/agents/a1/vault': () => ok(view({ mode: 'SELECTED' })),
      'GET /api/v1/vault/entries': () => ok(entries),
      'POST /api/v1/agents/a1/vault/grants': () => ok(grant, 201),
    });
    renderSection();
    await user.click(await screen.findByRole('button', { name: 'Add grant' }));
    const dialog = await screen.findByRole('dialog', { name: 'Grant a credential to Researcher' });
    const policy = within(dialog).getByRole('combobox', { name: 'Approval' });
    await user.selectOptions(policy, 'auto');
    expect(within(dialog).getByText(/can sign in without asking you/)).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('Add another origin (optional)'), 'https://login.github.com{Enter}');
    // Adding a second origin resets Automatic to the safe default.
    expect(policy).toHaveValue('always_ask');
    await user.click(within(dialog).getByRole('button', { name: 'Create grant' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
        entry_id: 'e1',
        allowed_origins: ['https://github.com', 'https://login.github.com'],
        allowed_actions: ['sign_in'],
        approval_policy: 'always_ask',
      }),
    );
  });

  it('revokes a grant (works while locked) and shows an inline unlock prompt', async () => {
    setCsrfToken('c');
    const user = userEvent.setup();
    let grants = [grant];
    const { calls } = installFetch({
      'GET /api/v1/vault/status': () => ok(status({ locked: true, unlocked_at: null, lock_at: null })),
      'GET /api/v1/agents/a1/vault': () => ok(view({ mode: 'SELECTED', grants })),
      'GET /api/v1/vault/entries': () => ok(entries),
      'POST /api/v1/vault/grants/g1/revoke': () => {
        grants = [{ ...grant, enabled: false }];
        return ok(grants[0]);
      },
    });
    renderSection();
    expect(await screen.findByText('The vault is locked')).toBeInTheDocument();
    expect(screen.getByRole('form', { name: 'Unlock the Password Vault' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Add grant/ })).toBeDisabled();
    const table = screen.getByRole('table', { name: 'Grants of Researcher' });
    expect(within(table).getByRole('button', { name: /Edit grant for GitHub/ })).toBeDisabled();
    await user.click(within(table).getByRole('button', { name: 'Revoke grant for GitHub' }));
    expect(await within(table).findByText('Revoked')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST' && c.path === '/api/v1/vault/grants/g1/revoke')).toBe(true);
  });

  it('edits a grant: only the changed fields are sent', async () => {
    setCsrfToken('c');
    const user = userEvent.setup();
    const { calls } = installFetch({
      'GET /api/v1/vault/status': () => ok(status()),
      'GET /api/v1/agents/a1/vault': () => ok(view({ mode: 'SELECTED', grants: [grant] })),
      'GET /api/v1/vault/entries': () => ok(entries),
      'PATCH /api/v1/vault/grants/g1': () => ok({ ...grant, approval_policy: 'once_per_task', enabled: false }),
    });
    renderSection();
    await user.click(await screen.findByRole('button', { name: 'Edit grant for GitHub' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit grant · GitHub' });
    expect(within(dialog).getByRole('button', { name: /Save grant/ })).toBeDisabled(); // no changes yet
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Approval' }), 'once_per_task');
    await user.click(within(dialog).getByRole('switch', { name: 'Grant enabled' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save grant' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ approval_policy: 'once_per_task', enabled: false }));
  });

  it('explains that management is local-only when management_local is false', async () => {
    installFetch({
      'GET /api/v1/vault/status': () => ok(status({ management_local: false })),
      'GET /api/v1/agents/a1/vault': () => ok(view({ mode: 'SELECTED', grants: [grant] })),
      'GET /api/v1/vault/entries': () => ok(entries),
    });
    renderSection();
    expect(await screen.findByText('Only on this Mac')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Add grant/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Delete grant for GitHub/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Revoke grant for GitHub' })).toBeEnabled();
  });
});
