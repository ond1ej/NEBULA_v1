import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setCsrfToken } from '../../api';
import { ToastProvider } from '../../components/Toast';
import { installFetch, ok } from '../../test/fetchMock';
import { RemoteAccessPage } from './RemoteAccessPage';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setCsrfToken(null);
});

const status = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  port: 3102,
  public_url: null,
  tunnel: 'none',
  rate_limit_per_min: 240,
  listening: true,
  local_url: 'http://127.0.0.1:3102/mini/',
  public_mini_url: null,
  last_error: null,
  tools: { tailscale: true, cloudflared: true },
  tunnel_running: false,
  stats: { requests: 12, denied: 3, rate_limited: 0 },
  sessions: [],
  setup_required: 'Telegram only opens Mini Apps from a public HTTPS address. Choose one: Tailscale Funnel …',
  ...over,
});

const sessions = [
  { id: 's1', created_at: 1_700_000_000, expires_at: Date.now() / 1000 + 600, last_seen_at: Date.now() / 1000 - 20, active: true, telegram_user_id: '4242', bot: 'main' },
];

function renderPage() {
  return render(
    <ToastProvider>
      <RemoteAccessPage />
    </ToastProvider>,
  );
}

describe('Remote Access', () => {
  it('explains the architecture and only starts a tunnel after an explicit Internet-exposure confirmation', async () => {
    setCsrfToken('c');
    const user = userEvent.setup();
    const { calls } = installFetch({
      'GET /api/v1/remote': () => ok(status()),
      'GET /api/v1/miniapp/sessions': () => ok(sessions),
      'POST /api/v1/remote/tunnel/start': () =>
        ok(status({ tunnel: 'cloudflared_quick', tunnel_running: true, public_url: 'https://abc-def.trycloudflare.com', public_mini_url: 'https://abc-def.trycloudflare.com/mini/', setup_required: null })),
    });
    renderPage();
    expect(await screen.findByText('How remote access works')).toBeInTheDocument();
    expect(screen.getByText(/Telegram only opens Mini Apps from a public HTTPS address/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Local preview/ })).toHaveAttribute('href', '/mini/');

    const options = screen.getByRole('list', { name: 'Tunnel options' });
    const cf = within(options).getByText('Cloudflare quick tunnel').closest('li') as HTMLElement;
    await user.click(within(cf).getByRole('button', { name: 'Start' }));

    const dlg = await screen.findByRole('dialog', { name: 'Make the Mini App gateway reachable from the Internet?' });
    expect(within(dlg).getByText(/It becomes reachable from the Internet/)).toBeInTheDocument();
    const confirm = within(dlg).getByRole('button', { name: /Start tunnel/ });
    expect(confirm).toBeDisabled();
    await user.click(confirm);
    expect(calls.some((c) => c.path === '/api/v1/remote/tunnel/start')).toBe(false);

    expect(within(dlg).getByText(/Owner administration becomes reachable through it/)).toBeInTheDocument();
    await user.click(within(dlg).getByLabelText('I understand that the Mini App gateway will be reachable from the Internet'));
    expect(within(dlg).getByRole('button', { name: /Start tunnel/ })).toBeDisabled(); // both statements are required
    await user.click(within(dlg).getByLabelText('I understand that owner administration becomes reachable behind the gateway sign-in'));
    await user.click(within(dlg).getByRole('button', { name: 'Start tunnel' }));
    await waitFor(() => expect(calls.find((c) => c.path === '/api/v1/remote/tunnel/start')?.body).toEqual({ kind: 'cloudflared_quick', confirm: true }));
    expect(await screen.findByText(/reachable from the Internet through Cloudflare quick tunnel/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop tunnel' })).toBeInTheDocument();
  });

  it('recommends Tailscale Serve (tailnet-only): a plain confirmation, no Internet-exposure wording, and Funnel is labelled public', async () => {
    setCsrfToken('c');
    const user = userEvent.setup();
    const { calls } = installFetch({
      'GET /api/v1/remote': () => ok(status()),
      'GET /api/v1/miniapp/sessions': () => ok(sessions),
      'POST /api/v1/remote/tunnel/start': () =>
        ok(status({ tunnel: 'tailscale_serve', tunnel_running: true, public_url: 'https://mac.tail1234.ts.net', public_mini_url: 'https://mac.tail1234.ts.net/mini/', setup_required: null })),
    });
    renderPage();
    const options = await screen.findByRole('list', { name: 'Tunnel options' });
    const titles = within(options)
      .getAllByRole('listitem')
      .map((li) => li.querySelector('p')?.textContent ?? '');
    expect(titles[0]).toMatch(/^Tailscale Serve/);
    expect(titles[0]).toMatch(/Recommended/);
    expect(titles[1]).toMatch(/^Tailscale Funnel.*Public Internet/);
    const serve = within(options).getByText('Tailscale Serve').closest('li') as HTMLElement;
    expect(within(serve).getByText(/Not on the public Internet/)).toBeInTheDocument();

    await user.click(within(serve).getByRole('button', { name: 'Start' }));
    const dlg = await screen.findByRole('dialog', { name: 'Share the app gateway with your tailnet?' });
    expect(within(dlg).queryByRole('checkbox')).toBeNull();
    expect(within(dlg).getByText(/not reachable from the public Internet/)).toBeInTheDocument();
    await user.click(within(dlg).getByRole('button', { name: 'Start Serve' }));
    await waitFor(() => expect(calls.find((c) => c.path === '/api/v1/remote/tunnel/start')?.body).toEqual({ kind: 'tailscale_serve', confirm: true }));
    expect(await screen.findByText(/reachable from devices on your tailnet through Tailscale Serve — not from the public Internet/)).toBeInTheDocument();
    expect(screen.getByText('Tailnet only')).toBeInTheDocument();
  });

  it('refuses tunnels while the gateway is disabled and revokes sessions', async () => {
    setCsrfToken('c');
    const user = userEvent.setup();
    const { calls } = installFetch({
      'GET /api/v1/remote': () => ok(status({ enabled: false, listening: false, stats: null })),
      'GET /api/v1/miniapp/sessions': () => ok(sessions),
      'DELETE /api/v1/miniapp/sessions/s1': () => ok({ revoked: 1 }),
    });
    renderPage();
    const options = await screen.findByRole('list', { name: 'Tunnel options' });
    for (const b of within(options).getAllByRole('button', { name: /Start/ })) expect(b).toBeDisabled();
    await screen.findByText('4242');
    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/v1/miniapp/sessions/s1')).toBe(true));
  });
});
