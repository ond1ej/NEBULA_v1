// Fix round "ui": owner-only approvals and sign-in answers in the Mini App (step-up retry kept), the agent-bot Mini App
// (only that agent's chat and tasks), "Make this my account" on the Dashboard's Telegram page, the host folder network
// default and its note. Build output and the Apple texts: fixround_ui_node.test.ts (Node environment).
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setCsrfToken } from '../api';
import { ToastProvider } from '../components/Toast';
import { FolderPicker, NETWORK_NOTE, RootOptionsFields } from '../features/hostaccess/FolderPicker';
import { agentBotFullScreen, agentBotParent, agentBotView } from '../mini/agentBot';
import { clearAllPending } from '../mini/chat/pending';
import { MiniClient } from '../mini/client';
import { canDecide, isAgentBot, sessionRole, type MiniContextValue } from '../mini/context';
import { clearQueryCache } from '../mini/hooks';
import { navigate } from '../mini/router';
import { agent, baseRoutes, conversation, installMemoryStorage, message, mount, NOW, PERMS, resetStream, session, telegram } from '../mini/test/kit';
import type { MiniMe } from '../mini/types';
import { TelegramPage } from '../pages/TelegramPage';
import type { Task, TelegramStatus, TelegramUser } from '../types';
import { apiError, installFetch, ok, type RecordedCall } from './fetchMock';

vi.mock('@novnc/novnc', () => ({ default: class {} }));

const posts = (calls: RecordedCall[], path: string) => calls.filter((c) => c.method === 'POST' && c.path === path);

// ---------------------------------------------------------------- roles (pure)
describe('Mini App roles', () => {
  const ctx = (me: Partial<MiniMe> | null, bot = 'main', mode: 'telegram' | 'cookie' = 'telegram'): Pick<MiniContextValue, 'me' | 'session' | 'client'> => ({
    client: new MiniClient(mode === 'telegram' ? { mode, token: 't', csrf: 'c' } : { mode, csrf: 'c' }),
    session: { ...session, bot, permissions: me?.permissions ?? PERMS },
    me: me ? ({ permissions: PERMS, ...me } as MiniMe) : null,
  });

  it('only the owner decides approvals and answers sign-ins; operators and agent bots never do', () => {
    expect(canDecide(ctx({ role: 'owner' }))).toBe(true);
    expect(canDecide(ctx({ role: 'operator' }))).toBe(false); // even with "approvals" in the permission list
    expect(canDecide(ctx({ role: 'agent_bot' }, 'b1'))).toBe(false);
    expect(canDecide(ctx({ role: 'owner', permissions: ['tasks'] }))).toBe(false);
    expect(canDecide(ctx({}))).toBe(false); // role unknown: no owner-only controls
    expect(canDecide(ctx(null))).toBe(false);
    expect(canDecide(ctx(null, 'main', 'cookie'))).toBe(true); // the Dashboard session on the Mac is the owner
  });

  it('an agent bot is recognised by its role, or by its bot key when /miniapp/me did not answer', () => {
    expect(isAgentBot(ctx({ role: 'agent_bot' }, 'b1'))).toBe(true);
    expect(isAgentBot(ctx(null, 'b1'))).toBe(true);
    expect(sessionRole(ctx(null, 'main'))).toBeNull();
    expect(isAgentBot(ctx({ role: 'owner' }))).toBe(false);
    expect(isAgentBot(ctx(null, 'b1', 'cookie'))).toBe(false);
  });

  it('agent-bot routes: the agent’s chat is home, its tasks and task details, nothing of other agents', () => {
    expect(agentBotView([], 'a1')).toEqual({ kind: 'chat', agentId: 'a1' });
    expect(agentBotView(['agents'], 'a1')).toEqual({ kind: 'chat', agentId: 'a1' });
    expect(agentBotView(['agents', 'a1', 'chat'], 'a1')).toEqual({ kind: 'chat', agentId: 'a1' });
    expect(agentBotView(['chats', 'c9'], 'a1')).toEqual({ kind: 'chat', conversationId: 'c9' });
    expect(agentBotView(['agents', 'a1', 'details'], 'a1')).toEqual({ kind: 'tasks', agentId: 'a1' });
    expect(agentBotView(['agents', 'a1', 'memory'], 'a1')).toEqual({ kind: 'tasks', agentId: 'a1' });
    expect(agentBotView(['agents', 'a1', 'desktop'], 'a1')).toEqual({ kind: 'desktop', agentId: 'a1' });
    expect(agentBotView(['tasks'], 'a1')).toEqual({ kind: 'tasks', agentId: 'a1' });
    expect(agentBotView(['tasks', 't1'], 'a1')).toEqual({ kind: 'task', taskId: 't1' });
    for (const p of [['agents', 'a2'], ['agents', 'a2', 'desktop'], ['settings'], ['approvals'], ['files'], ['admin'], ['settings', 'vault'], ['notifications'], ['auth', 'as_1']]) {
      expect(agentBotView(p, 'a1')).toEqual({ kind: 'unavailable' });
    }
    expect(agentBotParent([])).toBeNull();
    expect(agentBotParent(['agents', 'a1'])).toBeNull();
    expect(agentBotParent(['tasks', 't1'])).toBe('/tasks');
    expect(agentBotParent(['agents', 'a1', 'details'])).toBe('/');
    expect(agentBotParent(['settings'])).toBe('/');
    expect(agentBotFullScreen(['agents', 'a1'])).toBe(true);
    expect(agentBotFullScreen(['agents', 'a1', 'desktop'])).toBe(true);
    expect(agentBotFullScreen(['tasks'])).toBe(false);
  });
});

// ---------------------------------------------------------------- Mini App screens
const PENDING_CENTER = {
  pending: [
    {
      kind: 'task',
      id: 'ap1',
      task_id: 't1',
      agent_id: 'a1',
      agent_name: 'Researcher',
      tool: 'browser.submit',
      action_summary: 'Submit the order form on shop.example',
      reason: null,
      prompt: 'Buy paper',
      environment: 'vm',
      created_at: 1,
      expires_at: Date.now() / 1000 + 600,
    },
  ],
  recent: [],
  sign_ins: [],
};

const task = (over: Partial<Task> = {}): Task => ({
  id: 't1',
  agent_id: 'a1',
  agent_name: 'Researcher',
  prompt: 'Summarise the release notes',
  state: 'COMPLETED',
  current_step: 3,
  retry_count: 0,
  tool_calls_done: 2,
  max_steps: 20,
  checkpoint_id: null,
  requires_approval: false,
  pause_requested: null,
  source_channel: 'telegram',
  reply_target: null,
  result: null,
  failure_reason: null,
  created_at: NOW - 600,
  updated_at: NOW - 60,
  started_at: NOW - 590,
  finished_at: NOW - 60,
  ...over,
});

describe('Mini App: owner-only decisions and the agent bot', () => {
  beforeEach(() => {
    sessionStorage.clear();
    installMemoryStorage();
    clearQueryCache();
    clearAllPending();
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete window.Telegram;
    window.history.replaceState(null, '', '/');
    resetStream();
  });

  it('an operator sees a pending approval but no Approve / Deny, and the tab bar never polls the approval center', async () => {
    const operator = () => ok({ session_id: 's1', telegram_user_id: 42, bot: 'main', permissions: ['tasks', 'commands', 'screenshot'], expires_in: 3600, role: 'operator', admin: false });
    const { calls } = mount(
      '#/',
      baseRoutes({
        'POST /api/mini/auth': () => ok({ ...session, permissions: ['tasks', 'commands', 'screenshot'] }),
        'GET /api/v1/miniapp/me': operator,
        'GET /api/v1/approval-center': () => ok(PENDING_CENTER),
        'GET /api/v1/conversations': () => ok([]),
        'GET /api/v1/agents': () => ok([agent]),
        'GET /api/v1/tasks': () => ok([]),
        'GET /api/v1/workflow-runs': () => ok([]),
      }),
    );
    expect(await screen.findByRole('link', { name: 'Activity' })).toBeInTheDocument();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(calls.some((c) => c.path === '/api/v1/approval-center')).toBe(false); // no badge for someone who cannot decide

    act(() => navigate('/approvals'));
    const summary = await screen.findByTestId('approval-summary');
    expect(summary).toHaveTextContent('Submit the order form on shop.example');
    const card = summary.closest('li') as HTMLElement;
    expect(within(card).queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(within(card).queryByRole('button', { name: 'Deny' })).toBeNull();
    expect(within(card).getByTestId('owner-only-approval')).toHaveTextContent('Only the NEBULA owner can approve or deny this');
    expect(posts(calls, '/api/v1/approvals/ap1')).toHaveLength(0);
  });

  it('the owner approves; a non-fresh owner gets stepup_required, confirms once and the approval is retried once', async () => {
    const user = userEvent.setup();
    let n = 0;
    const { calls } = mount(
      '#/approvals',
      baseRoutes({
        'GET /api/v1/miniapp/me': () => ok({ session_id: 's1', telegram_user_id: 42, bot: 'main', permissions: PERMS, expires_in: 3600, role: 'owner', admin: true, assurance: { fresh_until: null } }),
        'GET /api/v1/auth/assurance': () =>
          ok({ interface: 'miniapp', role: 'owner', fresh_until: null, fresh: false, methods: { password: true, biometric: { enrolled: false, devices: [] }, vault_passphrase: false }, vault: { exists: false, locked: true, reauth_until: null } }),
        'GET /api/v1/approval-center': () => ok(PENDING_CENTER),
        'GET /api/v1/tasks': () => ok([]),
        'GET /api/v1/workflow-runs': () => ok([]),
        'POST /api/v1/approvals/ap1': () => (++n === 1 ? apiError(403, 'stepup_required', 'Confirm it’s you', { level: 'fresh', methods: ['password'] }) : ok({ id: 'ap1', decision: 'approved' })),
        'POST /api/v1/auth/confirm': () => ok({ fresh_until: NOW + 300, vault: null, vault_unlock_needed: false }),
      }),
    );
    const card = (await screen.findByTestId('approval-summary')).closest('li') as HTMLElement;
    expect(screen.getByRole('link', { name: /Activity, 1 pending/ })).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: 'Approve' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Approve' }));
    const sheet = await screen.findByTestId('owner-confirm');
    await user.type(await within(sheet).findByLabelText('NEBULA password'), 'correct horse');
    await user.click(within(sheet).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(posts(calls, '/api/v1/approvals/ap1')).toHaveLength(2));
    expect(posts(calls, '/api/v1/approvals/ap1').map((c) => c.body)).toEqual([{ decision: 'approved' }, { decision: 'approved' }]);
    expect(posts(calls, '/api/v1/auth/confirm')).toHaveLength(1);
    expect(await screen.findByText('Approved')).toBeInTheDocument();
  });

  it('an operator’s sign-in card offers details only (no Continue sign-in, no Cancel)', async () => {
    const signIn = {
      id: 'as_0123456789abcdef01234567',
      agent_id: 'a1',
      agent_name: 'Researcher',
      task_id: 't1',
      conversation_id: 'c1',
      site: 'github.com',
      origin: 'https://github.com',
      state: 'WAITING_FOR_USER',
      created_at: NOW - 60,
      updated_at: NOW - 30,
      expires_at: NOW + 600,
      request: null,
    };
    mount(
      '#/chats/c1',
      baseRoutes({
        'GET /api/v1/miniapp/me': () => ok({ session_id: 's1', telegram_user_id: 42, bot: 'main', permissions: ['tasks', 'commands', 'screenshot'], expires_in: 3600, role: 'operator', admin: false }),
        'GET /api/v1/conversations/c1': () => ok(conversation()),
        'GET /api/v1/conversations/c1/messages': () => ok({ items: [message()], has_more: false }),
        'GET /api/v1/smart-auth/sessions': () => ok([signIn]),
      }),
    );
    const card = await screen.findByTestId('auth-card');
    expect(within(card).getByRole('button', { name: 'Show details' })).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: 'Continue sign-in' })).toBeNull();
    expect(within(card).queryByRole('button', { name: 'Cancel' })).toBeNull();
  });

  it('an agent’s own bot opens straight into that agent’s chat, with no tab bar and no request outside its allowlist', async () => {
    const wa = telegram();
    const botSession = { ...session, bot: 'b1', permissions: ['commands', 'screenshot', 'tasks'] };
    const { calls } = mount(
      '#/',
      {
        ...baseRoutes({
          'POST /api/mini/auth': () => ok(botSession),
          'GET /api/v1/miniapp/me': () => ok({ session_id: 's1', telegram_user_id: 42, bot: 'b1', permissions: ['commands', 'screenshot', 'tasks'], expires_in: 3600, role: 'agent_bot', admin: false }),
          'GET /api/v1/agents': () => ok([agent]),
          'GET /api/v1/agents/a1/conversation': () => ok(conversation()),
          'GET /api/v1/conversations/c1/messages': () => ok({ items: [message()], has_more: false }),
          'GET /api/v1/agents/a1/tasks': () => ok([task()]),
        }),
        // the host refuses these for an agent bot; the Mini App must not even ask
        'GET /api/v1/approval-center': () => apiError(403, 'not_available_to_agent_bot', 'no'),
      },
      wa,
    );
    expect(await screen.findByText('Hello, how can I help?')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Researcher' })).toBeInTheDocument();
    expect(document.querySelector('nav.mini-tabbar')).toBeNull();
    await waitFor(() => expect(wa.BackButton.hide).toHaveBeenCalled()); // the chat is home

    // the chat header opens the agent's tasks
    act(() => navigate('/agents/a1/details'));
    expect(await screen.findByText('Summarise the release notes')).toBeInTheDocument();
    expect(screen.getByText(/This bot reaches only Researcher’s chat and tasks/)).toBeInTheDocument();

    // everything else is explained, never requested
    for (const path of ['/settings', '/approvals', '/files', '/admin', '/agents/a2']) {
      act(() => navigate(path));
      expect(await screen.findByText('Not available in this bot')).toBeInTheDocument();
    }
    act(() => navigate('/'));
    expect(await screen.findByText('Hello, how can I help?')).toBeInTheDocument();

    const forbidden = ['/api/v1/approval-center', '/api/v1/notifications', '/api/v1/overview', '/api/v1/workflow-runs', '/api/v1/files/roots', '/api/v1/vault/status', '/api/v1/agents/a2'];
    expect(calls.filter((c) => forbidden.includes(c.path) || c.path.startsWith('/api/v1/smart-auth/')).map((c) => c.path)).toEqual([]);
  });
});

// ---------------------------------------------------------------- Dashboard: Telegram owner account
const tgUser = (over: Partial<TelegramUser>): TelegramUser => ({
  id: 'u1',
  telegram_user_id: 1001,
  chat_id: 1001,
  username: 'ada',
  display_name: 'Ada',
  status: 'approved',
  permissions: ['tasks', 'commands', 'screenshot'],
  selected_agent_id: null,
  pairing_id: 'p1',
  approved_at: NOW - 3600,
  created_at: NOW - 7200,
  owner: false,
  ...over,
});

const tgStatus = (users: TelegramUser[], owner: number | null, designated: number | null = owner): TelegramStatus => ({
  enabled: true,
  configured: true,
  polling: true,
  bot_username: 'nebula_test_bot',
  bot_id: 1,
  topics_mode: 'private_topics',
  has_topics_enabled: true,
  update_offset: 0,
  last_poll_at: null,
  last_error: null,
  users,
  topics: [],
  note: '',
  owner_telegram_user_id: owner,
  designated_owner_telegram_user_id: designated,
});

const voiceOff = { backend: null, local: { binary: null, model: null, ffmpeg: true }, cloud: { provider_connected: false, consent: false, model: 'whisper-1' }, setup_hint: null };

function renderTelegram(routes: Record<string, (c: RecordedCall) => Response | Promise<Response>>) {
  const net = installFetch({ 'GET /api/v1/agents': () => ok([]), 'GET /api/v1/voice/stt': () => ok(voiceOff), ...routes });
  render(
    <ToastProvider>
      <TelegramPage />
    </ToastProvider>,
  );
  return net;
}

describe('Dashboard Telegram page: the owner’s account', () => {
  beforeEach(() => setCsrfToken('csrf'));
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    setCsrfToken(null);
  });

  it('marks the owner’s account and designates another one only after a confirmation', async () => {
    const user = userEvent.setup();
    const ada = tgUser({ id: 'u1', telegram_user_id: 1001, owner: true });
    const bob = tgUser({ id: 'u2', telegram_user_id: 2002, chat_id: 2002, username: 'bob', display_name: 'Bob', pairing_id: 'p2' });
    let status = tgStatus([ada, bob], 1001);
    const { calls } = renderTelegram({
      'GET /api/v1/telegram': () => ok(status),
      'POST /api/v1/telegram/pairing/u2/approve': () => {
        status = tgStatus([{ ...ada, owner: false }, { ...bob, owner: true }], 2002);
        return ok({ ...bob, owner: true });
      },
    });
    const table = await screen.findByRole('table', { name: 'Approved Telegram users' });
    const row = (name: string) => within(table).getByText(name).closest('tr') as HTMLElement;
    expect(within(row('Ada')).getByText('Owner · your account')).toBeInTheDocument();
    expect(within(row('Ada')).queryByRole('button', { name: /Make this my account/ })).toBeNull();
    expect(within(row('Bob')).queryByText('Owner · your account')).toBeNull();
    expect(screen.getByTestId('telegram-owner-status')).toHaveTextContent('Your account: Ada (ID 1001)');

    await user.click(within(row('Bob')).getByRole('button', { name: /Make this my account/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Make this your Telegram account?' });
    expect(dialog).toHaveTextContent('Telegram user 2002 (@bob) becomes the NEBULA owner’s account');
    expect(dialog).toHaveTextContent('Your current account (ID 1001) becomes an operator');
    expect(posts(calls, '/api/v1/telegram/pairing/u2/approve')).toHaveLength(0); // nothing before the confirmation
    await user.click(within(dialog).getByRole('button', { name: 'Make this my account' }));
    await waitFor(() => expect(posts(calls, '/api/v1/telegram/pairing/u2/approve')).toHaveLength(1));
    expect(posts(calls, '/api/v1/telegram/pairing/u2/approve')[0].body).toEqual({ owner: true });
    await waitFor(() => expect(within(row('Bob')).getByText('Owner · your account')).toBeInTheDocument());
    expect(within(row('Ada')).getByRole('button', { name: /Make this my account/ })).toBeInTheDocument();
  });

  it('says so when no approved account is the owner’s (e.g. after revoking it)', async () => {
    renderTelegram({ 'GET /api/v1/telegram': () => ok(tgStatus([tgUser({ id: 'u2', telegram_user_id: 2002 })], null, 1001)) });
    const status = await screen.findByTestId('telegram-owner-status');
    expect(status).toHaveTextContent('None of these accounts is yours yet');
    expect(status).toHaveTextContent('The account you chose as yours (ID 1001) is no longer approved');
    expect(screen.getByRole('button', { name: /Make this my account/ })).toBeInTheDocument();
  });

  it('cancelling the confirmation sends nothing', async () => {
    const user = userEvent.setup();
    const { calls } = renderTelegram({ 'GET /api/v1/telegram': () => ok(tgStatus([tgUser({ id: 'u2', telegram_user_id: 2002 })], null, null)) });
    await user.click(await screen.findByRole('button', { name: /Make this my account/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Make this your Telegram account?' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- Dashboard: host folder network
describe('Host folder network access', () => {
  beforeEach(() => setCsrfToken('csrf'));
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    setCsrfToken(null);
  });

  it('the note says what stays blocked and what stays reachable', () => {
    render(<RootOptionsFields mode="read_write" setMode={() => {}} network={false} setNetwork={() => {}} tools={[]} setTools={() => {}} detected={{}} />);
    const sw = screen.getByRole('switch', { name: 'Network access' });
    expect(sw).toHaveAccessibleDescription(NETWORK_NOTE);
    expect(NETWORK_NOTE).toMatch(/Off by default/);
    expect(NETWORK_NOTE).toMatch(/Loopback \(localhost\) and unix sockets/);
    expect(NETWORK_NOTE).toMatch(/Docker daemon and the VM control socket, stay blocked either way/);
    expect(NETWORK_NOTE).toMatch(/your local network, including services this Mac offers on its LAN address/);
  });

  it('a new folder is authorised without network unless the owner turns it on', async () => {
    const user = userEvent.setup();
    const { calls } = installFetch({
      'GET /api/v1/host/browse': () =>
        ok({ path: '/Users/me', parent: null, dirs: [{ name: 'App', path: '/Users/me/App', authorisable: true, reason: null, git: true, project_markers: [] }] }),
      'POST /api/v1/host/roots': (c) => ok({ id: 'r9', ...(c.body as object), enabled: true, created_by: 'owner', created_at: 1, updated_at: 1 }, 201),
    });
    const onAdded = vi.fn();
    render(
      <ToastProvider>
        <FolderPicker open onClose={() => {}} onAdded={onAdded} existing={[]} detected={{}} />
      </ToastProvider>,
    );
    await user.click(await screen.findByRole('button', { name: 'Choose App' }));
    const form = await screen.findByRole('dialog', { name: 'Authorise this folder' });
    const sw = within(form).getByRole('switch', { name: 'Network access' });
    expect(sw).toHaveAttribute('aria-checked', 'false');
    await user.click(within(form).getByRole('button', { name: 'Authorise folder' }));
    await waitFor(() => expect(onAdded).toHaveBeenCalled());
    expect(posts(calls, '/api/v1/host/roots')[0].body).toMatchObject({ path: '/Users/me/App', allow_network: false });
  });
});
