import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiError, installFetch, ok } from '../test/fetchMock';
import { clearAllPending } from './chat/pending';
import { clearQueryCache } from './hooks';
import { agent, baseRoutes, conversation, env, installMemoryStorage, installXhrOverFetch, message, mount, NOW, renderApp, resetStream, telegram } from './test/kit';

vi.mock('@novnc/novnc', () => ({ default: class {} }));

describe('Telegram Mini App shell', () => {
  beforeEach(() => {
    sessionStorage.clear();
    installMemoryStorage();
    clearQueryCache();
    clearAllPending();
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {}); // jsdom has no scrolling
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete window.Telegram;
    window.history.replaceState(null, '', '/');
    document.documentElement.removeAttribute('style');
    delete document.documentElement.dataset.theme;
    resetStream();
  });

  it('opens a Telegram deep link to the Live Desktop with Bearer auth, NEBULA theme, BackButton and no auto-connect', async () => {
    const wa = telegram();
    const { calls } = mount('#/agents/a1/desktop?tgWebAppData=x&tgWebAppVersion=8.0', baseRoutes(), wa);

    expect(await screen.findByText('Desktop stream is inactive')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Connect' }).length).toBeGreaterThan(0);
    expect(window.location.hash).toBe('#/agents/a1/desktop');

    const auth = calls.filter((c) => c.path === '/api/mini/auth');
    expect(auth).toHaveLength(1);
    const get = calls.find((c) => c.path === '/api/v1/agents/a1');
    expect(get?.headers.authorization).toBe('Bearer tok-1');
    expect(get?.init.credentials).toBe('omit');
    expect(calls.some((c) => c.path.includes('/live/'))).toBe(false); // never streams without Connect

    expect(wa.ready).toHaveBeenCalled();
    expect(wa.expand).toHaveBeenCalled();
    // NEBULA's own palette (Telegram dark → dark tokens), Telegram's chrome tinted to match
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(wa.setHeaderColor).toHaveBeenCalledWith('#101114');
    expect(wa.setBackgroundColor).toHaveBeenCalledWith('#101114');
    expect(document.documentElement.style.getPropertyValue('--mini-vh')).toBe('700px');
    expect(document.documentElement.style.getPropertyValue('--mini-tg-inset-bottom')).toBe('34px');
    await waitFor(() => expect(wa.disableVerticalSwipes).toHaveBeenCalled()); // effects may flush after the DOM update
    // the full-screen viewer hides the tab bar
    expect(document.querySelector('nav.mini-tabbar')).toHaveAttribute('data-hidden', '1');

    // native BackButton is shown off the tab roots and, without in-app history, closes the viewer back into the chat
    await waitFor(() => expect(wa.BackButton.show).toHaveBeenCalled());
    installFetch(
      baseRoutes({
        'GET /api/v1/agents/a1/conversation': () => ok(conversation()),
        'GET /api/v1/conversations/c1/messages': () => ok({ items: [message()], has_more: false }),
      }),
    );
    const onBack = () => vi.mocked(wa.BackButton.onClick).mock.calls.at(-1)?.[0] as () => void;
    act(() => onBack()());
    expect(window.location.hash).toBe('#/agents/a1');
    expect(await screen.findByText('Hello, how can I help?')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Researcher' })).toBeInTheDocument();
    // and from the chat to the Chats list (a tab root: Telegram's BackButton hides)
    act(() => onBack()());
    expect(window.location.hash).toBe('#/');
    await waitFor(() => expect(wa.BackButton.hide).toHaveBeenCalled());
  });

  it('shows Mac mini agents honestly: no Live Desktop for host execution', async () => {
    mount('#/agents/a1/desktop', baseRoutes({ 'GET /api/v1/agents/a1/environment': () => ok(env('host')) }));
    expect(await screen.findByText('No Live Desktop on the Mac mini')).toBeInTheDocument();
    expect(screen.queryByText('Desktop stream is inactive')).not.toBeInTheDocument();
  });

  it('a 401 later in the session shows "Reopen the Mini App from Telegram"', async () => {
    mount('#/agents/a1/chat', baseRoutes({ 'GET /api/v1/agents/a1/conversation': () => apiError(401, 'unauthenticated', 'Mini App session required') }));
    expect(await screen.findByRole('heading', { name: 'Reopen the Mini App from Telegram' })).toBeInTheDocument();
    expect(sessionStorage.length).toBe(0);
  });

  it('refused initData asks to reopen the Mini App (single-use launch data)', async () => {
    mount('#/', { 'POST /api/mini/auth': () => apiError(401, 'replayed', 'this initData was already used; reopen the Mini App') });
    expect(await screen.findByRole('heading', { name: 'Reopen the Mini App from Telegram' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close Mini App' })).toBeInTheDocument();
  });

  it('local preview without a Dashboard login links to the Dashboard', async () => {
    window.history.replaceState(null, '', '/mini/');
    installFetch({ 'GET /api/v1/auth/state': () => ok({ initialized: true, authenticated: false, user: null, csrf_token: null }) });
    renderApp(null);
    expect(await screen.findByRole('heading', { name: 'Sign in to the NEBULA Dashboard' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the Dashboard' })).toHaveAttribute('href', '/');
  });

  it('Chats is the first screen: conversations with preview, time, unread and running task from allow-listed endpoints only', async () => {
    const list = [
      conversation({ unread_count: 2, last_message: { role: 'assistant', content: 'Here is **the summary** of `today`', created_at: NOW - 60 } }),
      conversation({
        id: 'c2',
        agent_id: 'a2',
        agent_name: 'Coder',
        title: 'Refactor billing',
        is_default: false,
        unread_count: 0,
        last_message: { role: 'user', content: 'Please refactor the billing module', created_at: NOW - 600 },
        last_message_at: NOW - 600,
        running_task: { id: 't9', state: 'EXECUTING' },
      }),
    ];
    const { calls } = mount('#/', baseRoutes({ 'GET /api/v1/conversations': () => ok(list) }));
    const rows = await screen.findAllByTestId('chat-preview');
    expect(rows.map((r) => r.textContent)).toEqual(['Here is the summary of today', 'You: Please refactor the billing module']);
    // unread badge on the first, running indicator on the second
    const first = screen.getByRole('link', { name: /^Researcher, 2 unread/ });
    expect(within(first).getByTestId('unread-badge')).toHaveTextContent('2');
    expect(within(first).queryByTestId('running-indicator')).toBeNull();
    const second = screen.getByRole('link', { name: /^Coder, Refactor billing, task running/ });
    expect(within(second).getByTestId('running-indicator')).toBeInTheDocument();
    expect(within(second).getByText('· Refactor billing')).toBeInTheDocument();
    expect(first).toHaveAttribute('href', '#/chats/c1');
    // tab bar: Chats first and active, unread count from the already loaded list
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    expect(within(nav).getAllByRole('link').map((a) => a.querySelector('span')?.textContent)).toEqual(['Chats', 'Agents', 'Activity', 'Settings']);
    expect(within(nav).getByRole('link', { name: 'Chats, 1 unread' })).toHaveAttribute('aria-current', 'page');
    // the system status dot links to Settings → System
    await waitFor(() => expect(screen.getByRole('link', { name: /System status: NEBULA is healthy/ })).toHaveAttribute('href', '#/settings/system'));
    // no monitoring requests on Chats
    const paths = new Set(calls.map((c) => c.path));
    expect(paths.has('/api/v1/overview')).toBe(false);
    expect(paths.has('/api/v1/resources')).toBe(false);
    expect(paths.has('/api/v1/companies')).toBe(false);
    expect(calls.find((c) => c.path === '/api/v1/conversations')?.url).toBe('/api/v1/conversations?archived=false&limit=100');
  });

  it('Chats searches agents and message content through the search endpoint', async () => {
    const user = userEvent.setup();
    const { calls } = mount(
      '#/',
      baseRoutes({
        'GET /api/v1/conversations': () => ok([conversation()]),
        'GET /api/v1/conversations/search': () =>
          ok({ conversations: [], messages: [{ message_id: 'm7', conversation_id: 'c1', agent_id: 'a1', agent_name: 'Researcher', role: 'assistant', snippet: '…the flight to Prague leaves at 9…', created_at: NOW - 30 }] }),
      }),
    );
    await screen.findAllByTestId('chat-preview');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await user.type(screen.getByLabelText('Search chats and messages'), 'prague');
    expect(await screen.findByText('Prague', { selector: 'mark' })).toBeInTheDocument();
    expect(calls.some((c) => c.url === '/api/v1/conversations/search?q=prague&limit=30')).toBe(true);
    expect(screen.getByText('Prague', { selector: 'mark' }).closest('a')).toHaveAttribute('href', '#/chats/c1');
  });

  it('new conversation: pick an agent in the sheet → POST /conversations → opens it', async () => {
    const user = userEvent.setup();
    const created = conversation({ id: 'c9', title: 'New chat', is_default: false, last_message: null, last_message_at: null });
    const { calls } = mount(
      '#/',
      baseRoutes({
        'GET /api/v1/conversations': () => ok([conversation()]),
        'GET /api/v1/agents': () => ok([agent]),
        'POST /api/v1/conversations': () => ok(created, 201),
        'GET /api/v1/conversations/c9': () => ok(created),
        'GET /api/v1/conversations/c9/messages': () => ok({ items: [], has_more: false }),
      }),
    );
    await screen.findAllByTestId('chat-preview');
    await user.click(screen.getByRole('button', { name: 'New conversation' }));
    const sheet = await screen.findByRole('dialog', { name: 'New conversation' });
    await user.click(await within(sheet).findByRole('button', { name: /Researcher/ }));
    await waitFor(() => expect(window.location.hash).toBe('#/chats/c9'));
    expect(calls.find((c) => c.method === 'POST' && c.path === '/api/v1/conversations')?.body).toEqual({ agent_id: 'a1' });
    expect(await screen.findByText(/Ask anything or give Researcher a task/)).toBeInTheDocument();
  });

  it('without the conversation API (older host / gateway) Chats falls back to one chat per agent', async () => {
    mount('#/', baseRoutes({ 'GET /api/v1/conversations': () => apiError(404, 'not_found', 'no route'), 'GET /api/v1/agents': () => ok([agent]) }));
    const row = await screen.findByRole('link', { name: /Researcher/ });
    expect(row).toHaveAttribute('href', '#/agents/a1');
  });

  it('Activity: approvals show the exact summary and post the owner decision (Approve / Deny with confirmation)', async () => {
    const user = userEvent.setup();
    const taskSummary = 'Submit the order form on shop.example (total 12.00 EUR)';
    const ownerSummary = 'Run workflow “Nightly backup” (deletes files older than 30 days)';
    const center = {
      pending: [
        {
          kind: 'task',
          id: 'ap1',
          task_id: 't1',
          agent_id: 'a1',
          agent_name: 'Researcher',
          tool: 'browser.submit',
          action_summary: taskSummary,
          reason: 'checkout',
          prompt: 'Buy paper',
          environment: 'vm',
          created_at: 1,
          expires_at: Date.now() / 1000 + 600,
        },
        { kind: 'workflow', id: 'oa1', summary: ownerSummary, ref: {}, preview: null, created_at: 1, expires_at: Date.now() / 1000 + 600 },
      ],
      recent: [],
    };
    const wa = telegram();
    const { calls } = mount(
      '#/approvals',
      baseRoutes({
        'GET /api/v1/approval-center': () => ok(center),
        'GET /api/v1/tasks': () => ok([]),
        'GET /api/v1/workflow-runs': () => ok([]),
        'POST /api/v1/owner-approvals/oa1': () => ok({ id: 'oa1', decision: 'approved' }),
        'POST /api/v1/approvals/ap1': () => ok({ id: 'ap1', decision: 'denied' }),
      }),
      wa,
    );
    const summaries = await screen.findAllByTestId('approval-summary');
    expect(summaries.map((s) => s.textContent)).toEqual([taskSummary, ownerSummary]);
    expect(screen.getByRole('link', { name: /Activity, 2 pending/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Approvals' })).toBeInTheDocument();

    const cards = summaries.map((s) => s.closest('li') as HTMLElement);
    await user.click(within(cards[1]).getByRole('button', { name: 'Approve' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId('decide-summary')).toHaveTextContent(ownerSummary);
    await user.click(within(dialog).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/api/v1/owner-approvals/oa1')).toBe(true));
    const post = calls.find((c) => c.path === '/api/v1/owner-approvals/oa1');
    expect(post?.body).toEqual({ decision: 'approved' });
    expect(post?.headers.authorization).toBe('Bearer tok-1');
    expect(wa.HapticFeedback.notificationOccurred).toHaveBeenCalledWith('success');

    await user.click(within(cards[0]).getByRole('button', { name: 'Deny' }));
    const d2 = await screen.findByRole('dialog');
    expect(within(d2).getByTestId('decide-summary')).toHaveTextContent(taskSummary);
    await user.click(within(d2).getByRole('button', { name: 'Deny' }));
    await waitFor(() => expect(calls.find((c) => c.path === '/api/v1/approvals/ap1')?.body).toEqual({ decision: 'denied' }));
  });

  it('a Password Vault sign-in approval shows agent, credential, destination and "Approve once" — never other preview fields', async () => {
    const user = userEvent.setup();
    const center = {
      pending: [
        {
          kind: 'task',
          id: 'ap7',
          task_id: 't7',
          agent_id: 'a1',
          agent_name: 'Researcher',
          tool: 'vault_sign_in',
          action_summary: 'Sign in to github.com with “GitHub (work)”',
          action_preview: {
            kind: 'vault_sign_in',
            agent_name: 'Researcher',
            credential_name: 'GitHub (work)',
            origin: 'https://github.com',
            operation: 'sign_in',
            task_id: 't7',
            expires_at: Date.now() / 1000 + 300,
            password: 'CANARY-SECRET',
          },
          reason: null,
          prompt: 'Open my notifications',
          environment: 'vm',
          created_at: 1,
          expires_at: Date.now() / 1000 + 300,
        },
      ],
      recent: [],
    };
    const { calls } = mount(
      '#/activity',
      baseRoutes({
        'GET /api/v1/approval-center': () => ok(center),
        'GET /api/v1/tasks': () => ok([]),
        'GET /api/v1/workflow-runs': () => ok([]),
        'POST /api/v1/approvals/ap7': () => ok({ id: 'ap7', decision: 'approved' }),
      }),
    );
    const card = (await screen.findByTestId('vault-approval')).closest('li') as HTMLElement;
    expect(within(card).getByText('GitHub (work)')).toBeInTheDocument();
    expect(within(card).getByText('https://github.com')).toBeInTheDocument();
    expect(within(card).getByText('Sign in')).toBeInTheDocument();
    expect(within(card).getByRole('link', { name: 't7' })).toHaveAttribute('href', '#/tasks/t7');
    expect(document.body.textContent).not.toContain('CANARY-SECRET');
    await user.click(within(card).getByRole('button', { name: 'Approve once' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Approve once' }));
    await waitFor(() => expect(calls.find((c) => c.path === '/api/v1/approvals/ap7')?.body).toEqual({ decision: 'approved' }));
    expect(within(card).queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('chat: uploads an attachment with progress (multipart "file") and sends it with the message (conversation API)', async () => {
    const user = userEvent.setup();
    installXhrOverFetch();
    const sent = message({ id: 'm2', role: 'user', content: 'Summarise the notes', client_id: null, task_id: 'task-9', created_at: NOW });
    const routes = baseRoutes({
      'GET /api/v1/agents/a1/conversation': () => ok(conversation()),
      'GET /api/v1/conversations/c1/messages': () => ok({ items: [message()], has_more: false }),
      'POST /api/v1/agents/a1/attachments': () => ok({ id: 'att-1', name: 'notes.txt', kind: 'text', mime: 'text/plain', size: 5, status: 'PROCESSED', created_at: 1 }, 201),
      'POST /api/v1/conversations/c1/messages': (c) => ok({ message: { ...sent, client_id: (c.body as { client_id: string }).client_id }, task: { id: 'task-9', state: 'QUEUED' } }, 201),
    });
    const { calls } = mount('#/agents/a1/chat', routes);
    expect(await screen.findByText('Hello, how can I help?')).toBeInTheDocument();

    await user.upload(screen.getByLabelText('Choose files to attach'), new File(['hello'], 'notes.txt', { type: 'text/plain' }));
    await waitFor(() => expect(screen.getByTestId('attachment-chip')).toHaveAttribute('data-status', 'ready'));
    const up = calls.find((c) => c.path === '/api/v1/agents/a1/attachments');
    expect(up?.init.body).toBeInstanceOf(FormData);
    expect(((up?.init.body as FormData).get('file') as File).name).toBe('notes.txt');
    expect(up?.headers.authorization).toBe('Bearer tok-1');

    await user.type(screen.getByLabelText('Message to Researcher'), 'Summarise the notes');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/api/v1/conversations/c1/messages')).toBe(true));
    const post = calls.find((c) => c.method === 'POST' && c.path === '/api/v1/conversations/c1/messages');
    const body = post?.body as { content: string; client_id: string; attachment_ids: string[] };
    expect(body.content).toBe('Summarise the notes');
    expect(body.attachment_ids).toEqual(['att-1']);
    expect(body.client_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(post?.headers['idempotency-key']).toBe(body.client_id);
    // the composer is cleared, the message stays with its task status
    expect(screen.getByLabelText('Message to Researcher')).toHaveValue('');
    expect(await screen.findByTestId('task-inline')).toHaveAttribute('data-state', 'QUEUED');
  });

  it('legacy chat (no conversation API on the host): sends through POST /agents/{id}/tasks with the client id as Idempotency-Key', async () => {
    const user = userEvent.setup();
    const { calls } = mount(
      '#/agents/a1',
      baseRoutes({
        'GET /api/v1/agents/a1/messages': () => ok([{ id: 'm1', agent_id: 'a1', task_id: null, role: 'assistant', channel: 'web', content: 'Old hello', attachments: [], created_at: 1 }]),
        'POST /api/v1/agents/a1/tasks': () => ok({ id: 'task-3', state: 'QUEUED', started_at: null, finished_at: null, failure_reason: null }, 201),
      }),
    );
    expect(await screen.findByText('Old hello')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Message to Researcher'), 'Do it');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/api/v1/agents/a1/tasks')).toBe(true));
    const post = calls.find((c) => c.method === 'POST' && c.path === '/api/v1/agents/a1/tasks');
    expect(post?.body).toEqual({ prompt: 'Do it', attachment_ids: [] });
    expect(post?.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(await screen.findByText('Do it')).toBeInTheDocument();
  });
});
