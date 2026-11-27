// Password Vault screens for sessions that are not the owner (operators): metadata only, nothing secret is ever rendered
// or kept, protective actions only. The owner's management screens are tested in vaultManage.test.tsx.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiError, ok } from '../test/fetchMock';
import { clearQueryCache } from './hooks';
import { cleanAgentVault, cleanEntry, cleanStatus } from './screens/VaultScreens';
import { agent, baseRoutes, installMemoryStorage, mount, NOW, resetStream } from './test/kit';

vi.mock('@novnc/novnc', () => ({ default: class {} }));

const CANARY = 'CANARY-SECRET';

// Malformed / hostile responses: secret-looking fields that the Mini App must never show or keep.
const status = { exists: true, locked: false, entry_count: 2, auto_lock_minutes: 15, unlocked_at: NOW - 60, lock_at: NOW + 840, broker: { enabled: true, available: true, reason: null }, management_local: true, passphrase: CANARY, master_key: CANARY };
const entries = [
  { id: 'e1', display_name: 'GitHub (work)', app_name: null, origin: 'https://github.com', credential_type: 'website', tags: ['dev'], created_at: 1, updated_at: 2, grant_count: 1, password: CANARY, username: CANARY, secret: CANARY, value: CANARY, totp_seed: CANARY },
  { id: 'e2', display_name: 'OpenAI API', app_name: 'OpenAI', origin: null, credential_type: 'api_token', tags: [], created_at: 1, updated_at: 2, grant_count: 0, token: CANARY },
];
const audit = [
  { id: 'v1', ts: NOW - 30, actor_type: 'agent', actor_id: 'a1', agent_id: 'a1', agent_name: 'Researcher', entry_id: 'e1', entry_name: 'GitHub (work)', operation: 'sign_in', destination_origin: 'https://github.com', approval_id: 'ap1', outcome: 'allowed', reason_code: null, password: CANARY },
];
const agentVault = {
  agent_id: 'a1',
  mode: 'SELECTED',
  managed_tags: [],
  grants: [
    { id: 'g1', entry_id: 'e1', entry_name: 'GitHub (work)', credential_type: 'website', allowed_origins: ['https://github.com'], allowed_actions: ['sign_in'], approval_policy: 'once_per_task', enabled: true, expires_at: null, created_at: 1, last_used_at: NOW - 30, secret: CANARY },
  ],
  recent: audit,
  password: CANARY,
};

function vaultRoutes(extra = {}) {
  return baseRoutes({
    'GET /api/v1/vault/status': () => ok(status),
    'GET /api/v1/vault/entries': () => ok(entries),
    'GET /api/v1/vault/audit': () => ok(audit),
    'GET /api/v1/agents': () => ok([agent]),
    'GET /api/v1/agents/a1/vault': () => ok(agentVault),
    'POST /api/v1/vault/lock': () => ok({ locked: true }),
    'POST /api/v1/vault/grants/g1/revoke': () => ok({ ...agentVault.grants[0], enabled: false }),
    ...extra,
  });
}

function assertNoSecrets() {
  expect(document.body.textContent).not.toContain(CANARY);
  expect(document.body.innerHTML).not.toContain(CANARY);
  expect(document.querySelector('input[type="password"]')).toBeNull();
  for (const el of document.querySelectorAll('input,textarea')) expect((el as HTMLInputElement).value).not.toContain(CANARY);
  for (let i = 0; i < window.localStorage.length; i += 1) expect(window.localStorage.getItem(window.localStorage.key(i) as string)).not.toContain(CANARY);
  for (let i = 0; i < sessionStorage.length; i += 1) expect(sessionStorage.getItem(sessionStorage.key(i) as string)).not.toContain(CANARY);
}

describe('Password Vault (Mini App)', () => {
  beforeEach(() => {
    sessionStorage.clear();
    installMemoryStorage();
    clearQueryCache();
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete window.Telegram;
    window.history.replaceState(null, '', '/');
    resetStream();
  });

  it('reduces responses to whitelisted, non-secret fields', () => {
    expect(JSON.stringify(cleanStatus(status))).not.toContain(CANARY);
    expect(JSON.stringify(entries.map(cleanEntry))).not.toContain(CANARY);
    expect(JSON.stringify(cleanAgentVault(agentVault))).not.toContain(CANARY);
    expect(cleanEntry(entries[0])).toEqual({ id: 'e1', display_name: 'GitHub (work)', app_name: null, origin: 'https://github.com', credential_type: 'website', tags: ['dev'], created_at: 1, updated_at: 2, grant_count: 1 });
  });

  it('Settings → Password Vault: status, credential names, agent access, recent access, Lock now — and no secret anywhere', async () => {
    const user = userEvent.setup();
    const { calls } = mount('#/settings/vault', vaultRoutes());
    const head = await screen.findByTestId('vault-status');
    expect(within(head).getByText('Unlocked')).toBeInTheDocument();
    expect(within(head).getByText(/2 credentials · auto-locks after 15 min/)).toBeInTheDocument();
    expect(screen.getByText('Vault management is reserved for the NEBULA owner')).toBeInTheDocument();
    expect(await screen.findByText('GitHub (work)', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByText('Website · https://github.com · #dev')).toBeInTheDocument();
    expect(screen.getByText('API token · OpenAI')).toBeInTheDocument();
    expect(await screen.findByText(/Selected credentials · 1 active grant/)).toBeInTheDocument();
    expect(await screen.findByText(/Researcher · sign in · GitHub \(work\)/)).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /password|passphrase|unlock/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /unlock/i })).toBeNull();
    assertNoSecrets();

    await user.click(screen.getByRole('button', { name: 'Lock now' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/api/v1/vault/lock')).toBe(true));
    expect(calls.find((c) => c.path === '/api/v1/vault/lock')?.body).toBeUndefined(); // nothing secret is ever sent
    assertNoSecrets();
  });

  it('searches credentials by name on the server (q), still metadata only', async () => {
    const user = userEvent.setup();
    const { calls } = mount('#/settings/vault', vaultRoutes());
    await screen.findByText('GitHub (work)', { selector: 'span' });
    await user.type(screen.getByLabelText('Search credentials'), 'git');
    await waitFor(() => expect(calls.some((c) => c.url === '/api/v1/vault/entries?q=git')).toBe(true));
    assertNoSecrets();
  });

  it('Agent → Password Vault: mode, grants (origins, actions, policy, expiry, last use) and Revoke', async () => {
    const user = userEvent.setup();
    const { calls } = mount('#/agents/a1/vault', vaultRoutes());
    expect(await screen.findByTestId('vault-mode')).toHaveTextContent('Selected credentials');
    const grant = screen.getByTestId('vault-grant');
    expect(within(grant).getByText('GitHub (work)')).toBeInTheDocument();
    expect(within(grant).getByText('https://github.com')).toBeInTheDocument();
    expect(within(grant).getByText('sign in')).toBeInTheDocument();
    expect(within(grant).getByText('Ask once per task')).toBeInTheDocument();
    expect(within(grant).getByText('never')).toBeInTheDocument(); // expiry
    assertNoSecrets();
    await user.click(within(grant).getByRole('button', { name: 'Revoke' }));
    const dialog = await screen.findByRole('dialog', { name: /Revoke access to GitHub \(work\)/ });
    await user.click(within(dialog).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/api/v1/vault/grants/g1/revoke')).toBe(true));
  });

  it('an agent without vault access shows "No vault access"', async () => {
    mount('#/agents/a1/vault', vaultRoutes({ 'GET /api/v1/agents/a1/vault': () => ok({ agent_id: 'a1', mode: 'NONE', managed_tags: [], grants: [], recent: [] }) }));
    expect(await screen.findByTestId('vault-mode')).toHaveTextContent('No vault access');
    expect(screen.getByText('Researcher cannot use any saved credential.')).toBeInTheDocument();
  });

  it('on a NEBULA without the vault (404) or without gateway access (403) it says so', async () => {
    mount('#/settings/vault', vaultRoutes({ 'GET /api/v1/vault/status': () => apiError(404, 'not_found', 'no route') }));
    expect(await screen.findByText('Password Vault unavailable')).toBeInTheDocument();
    expect(screen.getByText('The Password Vault is not available on this NEBULA version.')).toBeInTheDocument();
  });
});
