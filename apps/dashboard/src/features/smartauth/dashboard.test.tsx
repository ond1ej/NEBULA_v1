// Smart Authentication in the Dashboard: the global notice on `auth.request` + the sign-in modal (local: no PIN),
// sign-ins in the Approval Center and the agent chat, and Password Vault → Smart sign-in settings (PIN set / change /
// remove, limits).
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setCsrfToken } from '../../api';
import { ToastProvider } from '../../components/Toast';
import { EventHub, EventsProvider } from '../../hooks/useEvents';
import { apiError, installFetch, ok, type RecordedCall } from '../../test/fetchMock';
import { ApprovalCenterPage } from '../approvals/ApprovalCenterPage';
import { authSession, V34 } from './core/fixtures';
import type { SmartAuthSettings } from './core/types';
import { AgentSignIns, SignInRequestsCard } from './SignIns';
import { SmartAuthProvider } from './SmartAuthProvider';
import { SmartAuthSettingsCard } from './SmartAuthSettingsCard';
import { SmartAuthTrustCard, trustOrigin } from './SmartAuthTrustCard';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setCsrfToken(null);
});

const SID = 'as_0123456789abcdef01234567';

let seq = 0;
function emit(hub: EventHub, type: string, payload: Record<string, unknown>, agent_id: string | null = 'a1') {
  seq += 1;
  act(() => {
    hub.handle(new MessageEvent(type, { data: JSON.stringify({ id: `ev${seq}`, sequence: seq, type, agent_id, task_id: 't1', timestamp: Date.now() / 1000, payload }) }));
  });
}

function renderWith(ui: React.ReactNode, hub = new EventHub()) {
  vi.spyOn(hub, 'start').mockImplementation(() => {});
  const view = render(
    <ToastProvider>
      <EventsProvider hub={hub}>
        <SmartAuthProvider>{ui}</SmartAuthProvider>
      </EventsProvider>
    </ToastProvider>,
  );
  return { hub, view };
}

describe('Smart Authentication (Dashboard)', () => {
  it('auth.request shows a notice; Open loads the session into a modal with the shared form (local: no PIN)', async () => {
    const user = userEvent.setup();
    const { calls } = installFetch({ [`GET /api/v1/smart-auth/sessions/${SID}`]: () => ok(authSession()) });
    const { hub } = renderWith(<p>page</p>);
    expect(calls).toHaveLength(0); // event-driven: nothing is loaded up front
    emit(hub, 'auth.request', { session_id: SID, state: 'IDENTIFIER_AND_PASSWORD_REQUIRED', site: 'github.com', origin: 'https://github.com', agent_name: 'Researcher', request_type: 'credentials' });
    const notice = await screen.findByTestId('auth-notice');
    expect(notice).toHaveTextContent('Authentication required — Researcher needs you to sign in to github.com');
    await user.click(within(notice).getByRole('button', { name: 'Open' }));
    const dialog = await screen.findByRole('dialog', { name: 'Sign in to github.com' });
    expect(within(dialog).getByLabelText('Email')).toBeInTheDocument();
    expect(within(dialog).queryByLabelText('Remote sign-in PIN')).toBeNull();
    expect(screen.queryByTestId('auth-notice')).toBeNull();
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET /api/v1/smart-auth/sessions/${SID}`]);
  });

  it('the notice disappears when the sign-in is answered elsewhere', async () => {
    installFetch({});
    const { hub } = renderWith(<p>page</p>);
    emit(hub, 'auth.request', { session_id: SID, state: 'IDENTIFIER_AND_PASSWORD_REQUIRED', site: 'github.com', agent_name: 'Researcher' });
    expect(await screen.findByTestId('auth-notice')).toBeInTheDocument();
    emit(hub, 'auth.session.updated', { session_id: SID, state: 'SUBMITTING', site: 'github.com' });
    await waitFor(() => expect(screen.queryByTestId('auth-notice')).toBeNull());
  });

  it('modal submit: token then submit, local body without PIN', async () => {
    const user = userEvent.setup();
    const order: string[] = [];
    const { calls } = installFetch({
      [`GET /api/v1/smart-auth/sessions/${SID}`]: () => ok(authSession()),
      [`POST /api/v1/smart-auth/sessions/${SID}/token`]: () => {
        order.push('token');
        return ok({ request_id: 'ar_1', token: 'tok_abcdefghijklmnopqrstuvwxyz', expires_at: Date.now() / 1000 + 120 });
      },
      [`POST /api/v1/smart-auth/sessions/${SID}/submit`]: () => {
        order.push('submit');
        return ok(authSession({ state: 'SUBMITTING' }, null), 202);
      },
    });
    const { hub } = renderWith(<p>page</p>);
    emit(hub, 'auth.request', { session_id: SID, state: 'IDENTIFIER_AND_PASSWORD_REQUIRED', site: 'github.com', agent_name: 'Researcher' });
    await user.click(within(await screen.findByTestId('auth-notice')).getByRole('button', { name: 'Open' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Email'), 'ada@example.com');
    await user.type(within(dialog).getByLabelText('Password'), 'pw-123456');
    await user.click(within(dialog).getByRole('button', { name: 'Sign in' }));
    expect(await within(dialog).findByText('Signing in…')).toBeInTheDocument();
    expect(order).toEqual(['token', 'submit']);
    const body = (calls.find((c) => c.path.endsWith('/submit')) as RecordedCall).body as Record<string, unknown>;
    expect(body).toEqual({ request_id: 'ar_1', token: 'tok_abcdefghijklmnopqrstuvwxyz', action: 'credentials', values: { f1: 'ada@example.com', f2: 'pw-123456' }, save: 'once' });
  });

  it('Approval Center lists active sign-ins from approval-center and opens them', async () => {
    const user = userEvent.setup();
    const s = authSession();
    installFetch({
      'GET /api/v1/approval-center': () => ok({ pending: [], recent: [], sign_ins: [{ ...s, kind: 'sign_in' }] }),
      [`GET /api/v1/smart-auth/sessions/${SID}`]: () => ok(s),
    });
    renderWith(<ApprovalCenterPage />);
    const card = await screen.findByTestId('signin-card');
    expect(card).toHaveTextContent('Authentication required');
    expect(card).toHaveTextContent('Researcher needs you to sign in to https://github.com');
    expect(screen.getByRole('heading', { name: /Sign-in requests/ })).toBeInTheDocument();
    expect(screen.queryByText('Nothing waits for you')).toBeNull();
    await user.click(within(card).getByRole('button', { name: 'Continue sign-in' }));
    expect(await screen.findByRole('dialog', { name: 'Sign in to github.com' })).toBeInTheDocument();
  });

  it('agent chat: shows the agent’s active sign-ins (agent_id + active=true) and refreshes on its auth events', async () => {
    let list = [authSession()];
    const { calls } = installFetch({ 'GET /api/v1/smart-auth/sessions': () => ok(list) });
    const { hub } = renderWith(<AgentSignIns agentId="a1" />);
    expect(await screen.findByTestId('signin-card')).toBeInTheDocument();
    const url = calls[0].url;
    expect(url).toContain('agent_id=a1');
    expect(url).toContain('active=true');
    list = [];
    emit(hub, 'auth.session.updated', { session_id: SID, state: 'AUTHENTICATED', site: 'github.com' });
    await waitFor(() => expect(screen.queryByTestId('signin-card')).toBeNull());
  });

  it('agent chat stays quiet on hosts without Smart Authentication', async () => {
    installFetch({ 'GET /api/v1/smart-auth/sessions': () => apiError(404, 'not_found', 'Not Found') });
    renderWith(<AgentSignIns agentId="a1" />);
    await act(async () => new Promise((r) => setTimeout(r, 30)));
    expect(screen.queryByTestId('agent-signins')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('Password Vault: recent sign-in requests with state, site, agent and time', async () => {
    installFetch({
      'GET /api/v1/smart-auth/sessions': () =>
        ok([authSession({ id: 'as_1', state: 'AUTHENTICATED', request: null }), authSession({ id: 'as_2', state: 'FAILED', error_code: 'too_many_attempts', site: 'gitlab.com', request: null })]),
    });
    renderWith(<SignInRequestsCard />);
    const list = await screen.findByTestId('signin-requests');
    const rows = within(list).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('Signed in');
    expect(rows[0]).toHaveTextContent('github.com');
    expect(rows[0]).toHaveTextContent('Researcher');
    expect(rows[1]).toHaveTextContent('Failed');
    expect(rows[1]).toHaveTextContent('gitlab.com');
  });
  it('the sign-in modal (session detail) shows a collapsed Diagnostics section with the step history and events', async () => {
    const user = userEvent.setup();
    installFetch({ [`GET /api/v1/smart-auth/sessions/${SID}`]: () => ok(V34.detail()) });
    const { hub } = renderWith(<p>page</p>);
    emit(hub, 'auth.request', { session_id: SID, state: 'EMAIL_REQUIRED', site: 'github.com', agent_name: 'Researcher', request_type: 'credentials' });
    await user.click(within(await screen.findByTestId('auth-notice')).getByRole('button', { name: 'Open' }));
    const dialog = await screen.findByRole('dialog', { name: 'Sign in to github.com' });
    expect(await within(dialog).findByTestId('auth-step-heading')).toHaveTextContent('Email required');
    const toggle = within(dialog).getByRole('button', { name: /Diagnostics/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(within(dialog).queryByTestId('auth-diag-events')).toBeNull();
    await user.click(toggle);
    expect(within(dialog).getByTestId('auth-diag-history')).toHaveTextContent('login.microsoftonline.com');
    expect(within(dialog).getByTestId('auth-diag-events')).toHaveTextContent('step.detected');
  });

  it('Password Vault: V3.4 states read clearly in the recent sign-ins (old DEVICE_APPROVAL_REQUIRED rows included)', async () => {
    installFetch({
      'GET /api/v1/smart-auth/sessions': () =>
        ok([
          { ...V34.loginError(), id: 'as_1' },
          { ...V34.authenticator('42'), id: 'as_2', state: 'DEVICE_APPROVAL_REQUIRED' },
          { ...V34.failed('vm_unreachable'), id: 'as_3' },
        ]),
    });
    renderWith(<SignInRequestsCard />);
    const rows = within(await screen.findByTestId('signin-requests')).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('Waiting for you');
    expect(within(rows[0]).getByRole('button', { name: 'Continue' })).toBeInTheDocument();
    expect(rows[1]).toHaveTextContent('Waiting for you');
    expect(within(rows[1]).getByRole('button', { name: 'Continue' })).toBeInTheDocument();
    expect(rows[2]).toHaveTextContent('Failed');
  });
});

// ---------------------------------------------------------------- settings
const settings = (over: Partial<SmartAuthSettings> = {}): SmartAuthSettings => ({
  enabled: true,
  remote_submission: true,
  request_ttl_s: 600,
  otp_ttl_s: 120,
  token_ttl_s: 120,
  max_retries: 2,
  max_per_agent: 1,
  max_global: 5,
  max_credential_attempts: 3,
  max_otp_attempts: 3,
  session_max_s: 1800,
  pin: { configured: false, set_at: null, locked_until: null },
  local: true,
  ...over,
});

describe('Password Vault → Smart sign-in settings', () => {
  it('sets a PIN (with a strength hint), then changes it with the current PIN and removes it', async () => {
    const user = userEvent.setup();
    let pinSet = false;
    const { calls } = installFetch({
      'GET /api/v1/smart-auth/settings': () => ok(settings()),
      'PUT /api/v1/smart-auth/pin': (c) => {
        const b = c.body as { pin: string; current_pin?: string };
        if (pinSet && b.current_pin !== '739184') return apiError(403, 'pin_invalid', 'Wrong PIN.', { attempts_left: 4 });
        pinSet = true;
        return ok({ configured: true, set_at: Date.now() / 1000, locked_until: null });
      },
      'DELETE /api/v1/smart-auth/pin': () => {
        pinSet = false;
        return ok({ configured: false, set_at: null, locked_until: null });
      },
    });
    renderWith(<SmartAuthSettingsCard />);
    const section = await screen.findByTestId('pin-section');
    expect(within(section).getByText('Not set')).toBeInTheDocument();
    // weak PIN: hint + disabled
    await user.type(within(section).getByLabelText('PIN'), '123456');
    expect(within(section).getByTestId('pin-strength')).toHaveTextContent('Too predictable');
    expect(within(section).getByRole('button', { name: /Set PIN/ })).toBeDisabled();
    await user.clear(within(section).getByLabelText('PIN'));
    await user.type(within(section).getByLabelText('PIN'), '739184');
    await user.type(within(section).getByLabelText('Repeat the PIN'), '739184');
    await user.click(within(section).getByRole('button', { name: 'Set PIN' }));
    await waitFor(() => expect(within(section).getByLabelText('Current PIN')).toBeInTheDocument());
    expect(calls.find((c) => c.method === 'PUT' && c.path === '/api/v1/smart-auth/pin')?.body).toEqual({ pin: '739184' });
    expect(within(section).getByLabelText('New PIN')).toHaveValue('');

    // change: needs the current PIN
    await user.type(within(section).getByLabelText('New PIN'), 'k9-Ladder-42');
    await user.type(within(section).getByLabelText('Repeat the new PIN'), 'k9-Ladder-42');
    expect(within(section).getByRole('button', { name: /Change PIN/ })).toBeDisabled();
    await user.type(within(section).getByLabelText('Current PIN'), '739184');
    await user.click(within(section).getByRole('button', { name: 'Change PIN' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'PUT' && c.path === '/api/v1/smart-auth/pin')).toHaveLength(2));
    expect(calls.filter((c) => c.path === '/api/v1/smart-auth/pin').at(-1)?.body).toEqual({ pin: 'k9-Ladder-42', current_pin: '739184' });

    // remove (asks first)
    await user.click(within(section).getByRole('button', { name: 'Remove PIN' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove the remote sign-in PIN?' });
    await user.click(within(dialog).getByRole('button', { name: 'Remove PIN' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/v1/smart-auth/pin')).toBe(true));
    await waitFor(() => expect(within(section).getByText('Not set')).toBeInTheDocument());
    // no PIN in any URL
    for (const c of calls) expect(c.url).not.toMatch(/739184|Ladder/);
  });

  it('switches and limits: PUT only what changed, values bounded', async () => {
    const user = userEvent.setup();
    const { calls } = installFetch({
      'GET /api/v1/smart-auth/settings': () => ok(settings()),
      'PUT /api/v1/smart-auth/settings': (c) => ok({ ...settings(), ...(c.body as object), local: undefined }),
    });
    renderWith(<SmartAuthSettingsCard />);
    await user.click(await screen.findByRole('switch', { name: 'Allow answers from outside this Mac' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ remote_submission: false }));
    const otp = screen.getByLabelText('Code attempts');
    expect(otp).toHaveAttribute('min', '1');
    expect(otp).toHaveAttribute('max', '5');
    await user.clear(otp);
    await user.type(otp, '9');
    expect(screen.getByText('Between 1 and 5')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Save limits/ })).toBeDisabled();
    await user.clear(otp);
    await user.type(otp, '4');
    await user.click(screen.getByRole('button', { name: 'Save limits' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'PUT').at(-1)?.body).toEqual({ max_otp_attempts: 4 }));
  });

  it('passkey / security key: "use the site’s password option" by default; "Ask me first" PUTs passkey_fallback', async () => {
    const user = userEvent.setup();
    let current = settings();
    const { calls } = installFetch({
      'GET /api/v1/smart-auth/settings': () => ok(current),
      'PUT /api/v1/smart-auth/settings': (c) => {
        current = { ...current, ...(c.body as object) };
        return ok({ ...current, local: undefined });
      },
    });
    renderWith(<SmartAuthSettingsCard />);
    const group = await screen.findByRole('group', { name: 'When a site asks for a passkey or security key' });
    const auto = within(group).getByRole('radio', { name: /Use the site’s password option automatically \(recommended\)/ });
    const ask = within(group).getByRole('radio', { name: /Ask me first/ });
    expect(auto).toBeChecked(); // no value from an older host: the default
    expect(ask).not.toBeChecked();
    await user.click(ask);
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ passkey_fallback: 'ask' }));
    await waitFor(() => expect(ask).toBeChecked());
    await user.click(auto);
    await waitFor(() => expect(calls.filter((c) => c.method === 'PUT').at(-1)?.body).toEqual({ passkey_fallback: 'password' }));
  });

  it('read-only away from the Mac', async () => {
    installFetch({ 'GET /api/v1/smart-auth/settings': () => ok(settings({ local: false, pin: { configured: true, set_at: 1, locked_until: null } })) });
    renderWith(<SmartAuthSettingsCard />);
    expect(await screen.findByText('Only on this Mac')).toBeInTheDocument();
    expect(screen.queryByLabelText('Current PIN')).toBeNull();
    expect(screen.queryByRole('button', { name: /Save limits/ })).toBeNull();
    expect(screen.getByRole('switch', { name: 'Sign-in assistance' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: /Ask me first/ })).toBeDisabled();
  });

  it('trusted sign-in providers: built-in list, relationships and verified sites (exact https origins only)', async () => {
    const user = userEvent.setup();
    let trust = { builtin: [{ id: 'microsoft', name: 'Microsoft', sign_in_hosts: ['login.microsoftonline.com'], services: [] }], relationships: [] as object[], verified_sites: [] as object[] };
    const { calls } = installFetch({
      'GET /api/v1/smart-auth/trust': () => ok(trust),
      'POST /api/v1/smart-auth/trust/relationships': (c) => {
        trust = { ...trust, relationships: [{ ...(c.body as object), added_at: 1 }] };
        return ok(trust, 201);
      },
      'DELETE /api/v1/smart-auth/trust/relationships': () => {
        trust = { ...trust, relationships: [] };
        return ok(trust);
      },
      'POST /api/v1/smart-auth/trust/sites': (c) => {
        trust = { ...trust, verified_sites: [{ ...(c.body as object), added_at: 1 }] };
        return ok(trust, 201);
      },
    });
    renderWith(<SmartAuthTrustCard />);
    expect(await screen.findByText('Microsoft')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Service (https://…)'), 'teams.example.com');
    await user.type(screen.getByLabelText('Sign-in provider (https://…)'), 'http://login.example.com');
    await user.click(screen.getByRole('button', { name: 'Add relationship' }));
    expect(screen.getByText('Only https:// addresses can be trusted')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    await user.clear(screen.getByLabelText('Sign-in provider (https://…)'));
    await user.type(screen.getByLabelText('Sign-in provider (https://…)'), 'https://login.example.com/path');
    await user.click(screen.getByRole('button', { name: 'Add relationship' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ service: 'https://teams.example.com', idp: 'https://login.example.com', first_party: false }));
    await user.click(await screen.findByRole('button', { name: 'Remove https://teams.example.com → https://login.example.com' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url.includes('service=https%3A%2F%2Fteams.example.com'))).toBe(true));
    await user.type(screen.getByLabelText('Site (https://…)'), 'intranet.example.com');
    await user.click(screen.getByRole('button', { name: 'Verify site' }));
    await waitFor(() => expect(calls.find((c) => c.path === '/api/v1/smart-auth/trust/sites')?.body).toEqual({ origin: 'https://intranet.example.com' }));
    expect(trustOrigin('http://x.example')).toBe('');
  });
});
