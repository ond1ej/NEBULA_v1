import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setCsrfToken } from '../../api';
import { ToastProvider } from '../../components/Toast';
import { installFetch, ok } from '../../test/fetchMock';
import { BotNetworkPage } from './BotNetworkPage';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setCsrfToken(null);
});

const TOKEN = '123456789:' + 'A'.repeat(35); // obviously fake

const mainBot = {
  enabled: true,
  configured: true,
  polling: true,
  bot_username: 'nebula_main_bot',
  bot_id: 111,
  last_poll_at: 1_700_000_000,
  last_error: null,
  users: [{ id: 'mu1', telegram_user_id: 42, username: 'owner', display_name: 'Owner', status: 'approved', notify_level: 'important' }],
};

const botRow = (over: Record<string, unknown> = {}) => ({
  id: 'b1',
  agent_id: 'a1',
  agent_name: 'Researcher',
  bot_id: 222,
  username: 'researcher_bot',
  display_name: 'Researcher',
  enabled: true,
  status: 'ACTIVE',
  update_offset: 0,
  last_poll_at: 1_700_000_000,
  last_update_at: null,
  last_error: null,
  created_at: 1_700_000_000,
  updated_at: 1_700_000_000,
  polling: true,
  token_stored: true,
  users: [
    { id: 'bu1', bot_row_id: 'b1', telegram_user_id: 77, chat_id: 77, username: 'friend', display_name: 'Friend', status: 'pending', pairing_id: 'p1', notify_level: 'important', approved_at: null, created_at: 1_700_000_000 },
  ],
  ...over,
});

const agents = [
  { id: 'a1', name: 'Researcher', state: 'READY' },
  { id: 'a2', name: 'Developer', state: 'READY' },
];

function renderPage() {
  return render(
    <ToastProvider>
      <BotNetworkPage />
    </ToastProvider>,
  );
}

describe('Bot Network', () => {
  it('adds an agent bot through the wizard and never renders the token afterwards', async () => {
    setCsrfToken('c');
    const user = userEvent.setup();
    const { calls } = installFetch({
      'GET /api/v1/bots': () => ok({ main: mainBot, agent_bots: [botRow()], status: { bots: 1, polling: 1, errors: 0 } }),
      'GET /api/v1/agents': () => ok(agents),
      'POST /api/v1/bots': () =>
        ok(
          {
            ...botRow({ id: 'b2', agent_id: 'a2', agent_name: 'Developer', username: 'dev_helper_bot', users: [] }),
            metadata: { avatar: 'set it in @BotFather → /setuserpic (not possible through the Bot API)', commands: 'ok', description: 'ok', short_description: 'failed: Too Many Requests' },
          },
          201,
        ),
      'POST /api/v1/bots/b2/pairing': () =>
        ok({ pairing_id: 'p9', code: 'ABCD2345', expires_at: Date.now() / 1000 + 600, deep_link: 'https://t.me/dev_helper_bot?start=ABCD2345', instructions: 'Send /start ABCD2345 to @dev_helper_bot within 10 minutes.' }, 201),
    });
    renderPage();
    await screen.findByText('@researcher_bot');
    await user.click(screen.getAllByRole('button', { name: 'Add agent bot' })[0]);
    const dialog = await screen.findByRole('dialog', { name: 'Add an agent bot' });
    expect(within(dialog).getByText('Send /newbot')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'I have the token' }));

    // only agents without a bot are offered
    const select = within(dialog).getByLabelText(/^Agent/);
    expect(within(select).queryByRole('option', { name: 'Researcher' })).toBeNull();
    await user.selectOptions(select, 'a2');
    const tokenInput = within(dialog).getByLabelText(/^Bot token/);
    expect(tokenInput).toHaveAttribute('type', 'password');
    await user.type(tokenInput, TOKEN);
    await user.click(within(dialog).getByRole('button', { name: 'Validate & bind' }));

    expect(await within(dialog).findByText('@dev_helper_bot is bound to Developer')).toBeInTheDocument();
    const post = calls.find((c) => c.method === 'POST' && c.path === '/api/v1/bots');
    expect(post?.body).toEqual({ agent_id: 'a2', token: TOKEN, configure: true });
    expect(post?.headers['x-csrf-token']).toBe('c');
    // the token is gone from every input and from the rendered text
    expect(screen.queryByDisplayValue(TOKEN)).toBeNull();
    expect(document.body.textContent).not.toContain(TOKEN);
    expect(document.body.innerHTML).not.toContain(TOKEN);
    // metadata results incl. the manual avatar step
    expect(within(dialog).getByText(/Manual step: set it in @BotFather/)).toBeInTheDocument();
    expect(within(dialog).getByText('failed: Too Many Requests')).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Create pairing code' }));
    const pairing = await within(dialog).findByTestId('bot-pairing');
    expect(within(pairing).getByText('ABCD2345')).toBeInTheDocument();
    expect(within(pairing).getByRole('link', { name: /t\.me\/dev_helper_bot\?start=ABCD2345/ })).toBeInTheDocument();
    expect(within(pairing).getByRole('timer')).toHaveTextContent(/Expires in/);
    expect(within(pairing).getByText(/approved automatically/)).toBeInTheDocument();
  });

  it('changes the notification level of a paired user', async () => {
    setCsrfToken('c');
    const user = userEvent.setup();
    const { calls } = installFetch({
      'GET /api/v1/bots': () => ok({ main: mainBot, agent_bots: [], status: { bots: 0, polling: 0, errors: 0 } }),
      'GET /api/v1/agents': () => ok(agents),
      'PATCH /api/v1/telegram/users/mu1/notify': (c) => ok({ id: 'mu1', notify_level: (c.body as { level: string }).level }),
    });
    renderPage();
    const select = await screen.findByLabelText('Notification level for Owner');
    expect(select).toHaveValue('important');
    await user.selectOptions(select, 'errors');
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ level: 'errors' }));
    expect(calls.find((c) => c.method === 'PATCH')?.path).toBe('/api/v1/telegram/users/mu1/notify');
    expect(await screen.findByText('Notifications for Owner: Errors only')).toBeInTheDocument();
    expect(select).toHaveValue('errors');
  });

  it('approves a pending user and asks before removing a binding', async () => {
    setCsrfToken('c');
    const user = userEvent.setup();
    const approved = botRow({ users: [{ ...botRow().users[0], status: 'approved', approved_at: 1_700_000_100 }] });
    const { calls } = installFetch({
      'GET /api/v1/bots': () => ok({ main: mainBot, agent_bots: [botRow()], status: { bots: 1, polling: 1, errors: 0 } }),
      'GET /api/v1/agents': () => ok(agents),
      'POST /api/v1/bots/b1/users/bu1/approve': () => ok(approved),
      'DELETE /api/v1/bots/b1': () => ok({ removed: 'b1', note: 'the bot still exists in Telegram' }),
    });
    renderPage();
    await screen.findByText('@researcher_bot');
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/api/v1/bots/b1/users/bu1/approve')).toBe(true));
    expect(await screen.findByLabelText('Notification level for Friend')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Remove binding' }));
    const dlg = await screen.findByRole('dialog', { name: 'Remove the binding for @researcher_bot?' });
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    await user.click(within(dlg).getByRole('button', { name: 'Remove binding' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'DELETE')?.url).toBe('/api/v1/bots/b1?confirm=true'));
  });
});
