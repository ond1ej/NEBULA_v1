// Administration area (V3.3): the verified owner gets the Dashboard's pages inside the Mini App (#/admin/…), lazily
// loaded, authenticated with the Mini App session (Bearer), linking inside the Mini App; everyone else keeps today's
// read-only screens. Settings / Agents open the matching administration page for the owner only.
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authSession } from '../features/smartauth/core/fixtures';
import { getRouteBase } from '../hooks/useHashRoute';
import { getTransport } from '../lib/http';
import { apiError, ok, type RecordedCall } from '../test/fetchMock';
import { clearQueryCache } from './hooks';
import { agent, baseRoutes, installMemoryStorage, mount, PERMS, resetStream, telegram } from './test/kit';

vi.mock('@novnc/novnc', () => ({ default: class {} }));

type Handler = (c: RecordedCall) => Response | Promise<Response>;

const ME_OWNER = { session_id: 's1', telegram_user_id: 42, bot: 'main', permissions: [...PERMS, 'agents'], expires_in: 3600, role: 'owner', admin: true, assurance: { fresh_until: null } };
const ME_OPERATOR = { session_id: 's1', telegram_user_id: 42, bot: 'main', permissions: PERMS, expires_in: 3600, role: 'operator', admin: false, assurance: { fresh_until: null } };

function routes(me: object, extra: Record<string, Handler> = {}) {
  return baseRoutes({
    'GET /api/v1/miniapp/me': () => ok(me),
    // providers the Dashboard pages need (health is in baseRoutes)
    'GET /api/v1/approvals': () => ok([]),
    'GET /api/v1/owner-approvals': () => ok([]),
    ...extra,
  });
}

describe('Mini App administration area', () => {
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

  it('the hub lists every Dashboard section (vault: the native Mini App screen) and scopes the admin stylesheet', async () => {
    mount('#/admin', routes(ME_OWNER));
    expect(await screen.findByRole('heading', { name: 'Administration' })).toBeInTheDocument();
    const main = screen.getByRole('main');
    for (const [name, href] of [
      ['Agents', '#/admin/agents'],
      ['AI Providers', '#/admin/providers'],
      ['AI Companies', '#/admin/companies'],
      ['Teams', '#/admin/teams'],
      ['Workflows', '#/admin/workflows'],
      ['Schedules', '#/admin/schedules'],
      ['Tasks', '#/admin/tasks'],
      ['Approvals', '#/admin/approvals'],
      ['Files', '#/admin/files'],
      ['Skills', '#/admin/skills'],
      ['Memory', '#/admin/memory'],
      ['Telegram', '#/admin/telegram'],
      ['Bot Network', '#/admin/bots'],
      ['Voice', '#/admin/voice'],
      ['Remote Access', '#/admin/remote'],
      ['Host Access', '#/admin/host'],
      ['Settings & Security', '#/admin/settings'],
      ['System', '#/admin/system'],
      ['Resources', '#/admin/resources'],
      ['Devices', '#/admin/devices'],
      ['Password Vault', '#/settings/vault'],
    ]) {
      expect(within(main).getByRole('link', { name: new RegExp(`^${name.replace(/[&]/g, '\\$&')}`) })).toHaveAttribute('href', href);
    }
    expect(document.documentElement.dataset.nbAdmin).toBe('1');
    expect(getRouteBase()).toBe('/admin');
  });

  it('a Dashboard page renders lazily with the Bearer session and links stay inside the Mini App', async () => {
    const { calls } = mount(
      '#/admin/agents',
      routes(ME_OWNER, {
        'GET /api/v1/agents': () => ok([{ ...agent, current_task: null }]),
        'GET /api/v1/providers': () => ok([]),
      }),
    );
    const page = await screen.findByTestId('admin-page');
    // the Dashboard's AgentsPage (its own chunk)
    expect(await within(page).findByRole('button', { name: /Create Agent/ })).toBeInTheDocument();
    const name = await within(page).findByText('Researcher');
    const links = within(page)
      .getAllByRole('link')
      .map((a) => a.getAttribute('href') ?? '');
    expect(links.some((h) => h.startsWith('#/admin/agents/a1'))).toBe(true);
    expect(links.filter((h) => h.startsWith('#/') && !h.startsWith('#/admin'))).toEqual([]);
    expect(name).toBeInTheDocument();
    const list = calls.find((c) => c.method === 'GET' && c.path === '/api/v1/agents');
    expect(list?.headers.authorization).toBe('Bearer tok-1');
    expect(list?.init.credentials).toBe('omit');
    expect(getTransport().kind).toBe('bearer');
    // Dashboard pages use the Mini App's event stream: one GET /events, no EventSource
    expect(calls.filter((c) => c.path === '/api/v1/events')).toHaveLength(1);
  });

  it('a link inside a page navigates within the administration area; leaving it removes the base and the style scope', async () => {
    const user = userEvent.setup();
    mount('#/admin/agents', routes(ME_OWNER, { 'GET /api/v1/agents': () => ok([]), 'GET /api/v1/providers': () => ok([]) }));
    await user.click(await screen.findByRole('button', { name: /Create Agent/ }));
    await waitFor(() => expect(window.location.hash).toBe('#/admin/agents/new'));
    window.location.hash = '#/settings';
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    await waitFor(() => expect(document.documentElement.dataset.nbAdmin).toBeUndefined());
    expect(getRouteBase()).toBe('');
  });

  it('#/admin/vault opens the native Password Vault screen; Live Desktop opens the native viewer', async () => {
    mount('#/admin/vault', routes(ME_OWNER));
    await waitFor(() => expect(window.location.hash).toBe('#/settings/vault'));
    window.history.replaceState(null, '', '/mini/#/admin/agents/a1/live');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await waitFor(() => expect(window.location.hash).toBe('#/agents/a1/desktop'));
  });

  it('Telegram BackButton closes the top-most Dashboard dialog first (confirm dialog, sign-in modal), then navigates back', async () => {
    const user = userEvent.setup();
    const wa = telegram();
    const s = authSession();
    mount(
      '#/admin/approvals',
      routes(ME_OWNER, {
        'GET /api/v1/approval-center': () => ok({ pending: [], recent: [], sign_ins: [{ ...s, kind: 'sign_in' }] }),
        [`GET /api/v1/smart-auth/sessions/${s.id}`]: () => ok(s),
      }),
      wa,
    );
    const back = () => act(() => (vi.mocked(wa.BackButton.onClick).mock.calls.at(-1)?.[0] as () => void)());
    const card = await screen.findByTestId('signin-card', {}, { timeout: 3000 });
    // a confirmation dialog of the Dashboard page
    await user.click(within(card).getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByRole('dialog', { name: 'Cancel this sign-in?' })).toBeInTheDocument();
    back();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Cancel this sign-in?' })).toBeNull());
    expect(window.location.hash).toBe('#/admin/approvals');
    // the sign-in modal (AuthModal) rendered inside the Mini App
    await user.click(within(card).getByRole('button', { name: 'Continue sign-in' }));
    expect(await screen.findByRole('dialog', { name: 'Sign in to github.com' })).toBeInTheDocument();
    back();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Sign in to github.com' })).toBeNull());
    expect(window.location.hash).toBe('#/admin/approvals');
    // no dialog left: Back navigates
    back();
    await waitFor(() => expect(window.location.hash).toBe('#/admin'));
  });

  it('an owner session costs no extra request at start (administration and confirmations load on demand)', async () => {
    const { calls } = mount('#/', routes(ME_OWNER, { 'GET /api/v1/conversations': () => ok([]) }));
    await screen.findByRole('heading', { name: 'Chats' });
    await new Promise((r) => setTimeout(r, 50));
    const paths = calls.map((c) => c.path);
    for (const p of ['/api/v1/auth/assurance', '/api/v1/approvals', '/api/v1/owner-approvals', '/api/v1/agents']) expect(paths).not.toContain(p);
    expect(document.documentElement.dataset.nbAdmin).toBeUndefined();
  });

  it('Devices: the Devices page works inside the administration area; pairing asks ONE owner confirmation and is retried once', async () => {
    const user = userEvent.setup();
    let n = 0;
    const { calls } = mount(
      '#/admin/devices',
      routes(ME_OWNER, {
        'GET /api/v1/devices': () => ok({ devices: [], gateway_url: 'https://nebula.example.ts.net', server_fingerprint: 'a1b2c3d4e5f60718293a' }),
        'POST /api/v1/devices/pairing': () =>
          ++n === 1
            ? apiError(403, 'stepup_required', 'confirm it’s you', { level: 'fresh', methods: ['password', 'vault_passphrase'] })
            : ok({ pairing_id: 'pr_1', code: 'FAKE', url: 'nebula://pair?v=1&p=pr_1&c=FAKE', qr_svg: '<svg xmlns="http://www.w3.org/2000/svg"/>', expires_at: Date.now() / 1000 + 300, gateway_url: 'https://nebula.example.ts.net', server_fingerprint: 'a1b2c3d4e5f60718293a' }, 201),
        'GET /api/v1/devices/pairing/pr_1': () => ok({ pairing_id: 'pr_1', status: 'open', expires_at: Date.now() / 1000 + 300, device: null }),
        'DELETE /api/v1/devices/pairing/pr_1': () => ok({ status: 'cancelled' }),
        'POST /api/v1/auth/confirm': () => ok({ fresh_until: Date.now() / 1000 + 300, vault: null, vault_unlock_needed: false }),
      }),
    );
    const page = await screen.findByTestId('admin-page');
    expect(await within(page).findByRole('heading', { name: 'Devices' })).toBeInTheDocument();
    expect(calls.find((c) => c.path === '/api/v1/devices')?.headers.authorization).toBe('Bearer tok-1');
    await user.click((await within(page).findAllByRole('button', { name: 'Pair an iPhone or Mac' }))[0]);
    const sheet = await screen.findByTestId('owner-confirm');
    await user.type(await within(sheet).findByLabelText('Vault passphrase'), 'Fake-Vault-Passphrase-9');
    await user.click(within(sheet).getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByRole('img', { name: 'QR code for pairing the NEBULA app' })).toBeInTheDocument();
    expect(calls.filter((c) => c.method === 'POST' && c.path === '/api/v1/devices/pairing')).toHaveLength(2);
    expect(calls.filter((c) => c.path === '/api/v1/auth/confirm').map((c) => c.body)).toEqual([{ method: 'vault_passphrase', passphrase: 'Fake-Vault-Passphrase-9' }]);
    // links of the page stay inside the Mini App
    expect(within(page).queryAllByRole('link').filter((a) => (a.getAttribute('href') ?? '').startsWith('#/') && !(a.getAttribute('href') ?? '').startsWith('#/admin'))).toEqual([]);
  });

  it('a non-owner session sees no administration', async () => {
    const { calls } = mount('#/admin/agents', routes(ME_OPERATOR, { 'GET /api/v1/agents': () => ok([agent]) }));
    expect(await screen.findByText('Only for the NEBULA owner')).toBeInTheDocument();
    expect(calls.some((c) => c.path === '/api/v1/agents')).toBe(false);
  });

  it('Settings: the owner gets Administration and the local-only items open their administration page', async () => {
    mount('#/settings', routes(ME_OWNER));
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    const main = screen.getByRole('main');
    expect(within(main).getByRole('link', { name: /^Administration/ })).toHaveAttribute('href', '#/admin');
    expect(within(main).getByRole('link', { name: /^Backups/ })).toHaveAttribute('href', '#/admin/system');
    expect(within(main).getByRole('link', { name: /^Bot network/ })).toHaveAttribute('href', '#/admin/bots');
    expect(within(main).getByRole('link', { name: /^Logs & diagnostics/ })).toHaveAttribute('href', '#/admin/system');
    expect(within(main).queryByLabelText(/Only in the local Dashboard/)).toBeNull();
  });

  it('Settings: an operator keeps the local-only items and gets no Administration', async () => {
    mount('#/settings', routes(ME_OPERATOR));
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^Administration/ })).toBeNull();
    expect(screen.getByLabelText('Backups: Only in the local Dashboard')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByLabelText('Bot network: Manage in the local Dashboard')).toHaveAttribute('aria-disabled', 'true');
  });

  it('Settings sub-pages: "Manage …" opens Administration for the owner, the local note stays for others', async () => {
    mount('#/settings/providers', routes(ME_OWNER));
    expect(await screen.findByRole('link', { name: /^Manage AI providers/ })).toHaveAttribute('href', '#/admin/providers');
  });

  it('Agents: the owner deletes an agent through its administration page; others still cannot', async () => {
    const user = userEvent.setup();
    mount('#/agents', routes(ME_OWNER, { 'GET /api/v1/agents': () => ok([agent]) }));
    await user.click(await screen.findByRole('button', { name: 'More actions for Researcher' }));
    const sheet = await screen.findByRole('dialog', { name: 'Researcher' });
    await user.click(within(sheet).getByRole('button', { name: /^Delete agent/ }));
    await waitFor(() => expect(window.location.hash).toBe('#/admin/agents/a1/settings'));
  });

  it('Agents: an operator still sees Delete as local-only', async () => {
    const user = userEvent.setup();
    mount('#/agents', routes(ME_OPERATOR, { 'GET /api/v1/agents': () => ok([agent]) }));
    await user.click(await screen.findByRole('button', { name: 'More actions for Researcher' }));
    const sheet = await screen.findByRole('dialog', { name: 'Researcher' });
    expect(within(sheet).getByRole('button', { name: /^Delete agent/ })).toBeDisabled();
  });
});
