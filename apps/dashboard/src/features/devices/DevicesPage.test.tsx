// Devices (V4.0): paired NEBULA apps for iPhone / Mac — the list (badges, key protection, last seen, pending devices
// with their 6-digit code), pairing (QR code only as an <img> data URL, countdown, copyable link, 2 s polling that
// stops on close / expiry / claim, approve / reject), remote access off (409), inline rename, remove with an
// explanation, and live refresh on `app.device.changed`.
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setCsrfToken } from '../../api';
import { ToastProvider } from '../../components/Toast';
import { EventHub, EventsProvider } from '../../hooks/useEvents';
import { apiError, installFetch, ok, type RecordedCall } from '../../test/fetchMock';
import { qrDataUrl, type AppDevice } from './api';
import { DevicesPage } from './DevicesPage';

const now = () => Math.floor(Date.now() / 1000);
const FP = 'a1b2c3d4e5f60718293a';
const URL_ = 'nebula://pair?v=1&u=https%3A%2F%2Fnebula.example.ts.net&p=pr_1&c=FAKE-PAIRING-CODE&f=a1b2c3d4e5f60718293a';
// hostile markup inside the QR: it must never become DOM
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><script>window.__pwned = 1</script><rect width="10" height="10"/></svg>';

function dev(over: Partial<AppDevice> = {}): AppDevice {
  return {
    id: 'adv_1',
    name: 'Ada iPhone',
    platform: 'ios',
    model: 'iPhone 16 Pro',
    app_version: '1.0.0',
    key_protection: 'secure_enclave',
    status: 'active',
    created_at: now() - 86400,
    approved_at: now() - 86000,
    last_seen_at: now() - 300,
    revoked_at: null,
    key_fingerprint: '0123456789abcdef',
    push: true,
    vault_key: true,
    ...over,
  };
}

const MAC = dev({ id: 'adv_2', name: 'MacBook', platform: 'macos', model: 'MacBook Air', key_protection: 'keychain', vault_key: false, push: false, last_seen_at: null });
const PENDING = dev({ id: 'adv_3', name: 'iPad', status: 'pending', approved_at: null, vault_key: false, verification_code: '123456', created_at: now() - 30 });

const offer = (over: Record<string, unknown> = {}) => ({
  pairing_id: 'pr_1',
  code: 'FAKE-PAIRING-CODE',
  url: URL_,
  qr_svg: SVG,
  expires_at: now() + 300,
  gateway_url: 'https://nebula.example.ts.net',
  server_fingerprint: FP,
  ...over,
});

type Handler = (c: RecordedCall) => Response | Promise<Response>;

function renderPage(routes: Record<string, Handler>, hub = new EventHub()) {
  const net = installFetch(routes);
  const view = render(
    <ToastProvider>
      <EventsProvider hub={hub}>
        <DevicesPage />
      </EventsProvider>
    </ToastProvider>,
  );
  return { ...net, view, hub };
}

const count = (calls: RecordedCall[], method: string, path: string) => calls.filter((c) => c.method === method && c.path === path).length;
const tick = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

describe('Devices (paired NEBULA apps)', () => {
  beforeEach(() => {
    setCsrfToken('csrf');
    window.history.replaceState(null, '', '/');
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    setCsrfToken(null);
  });

  it('lists paired devices (badges, key protection, last seen) and pending ones with their code; approving reloads the list', async () => {
    const user = userEvent.setup();
    let devices = [dev(), MAC, PENDING];
    const { calls } = renderPage({
      'GET /api/v1/devices': () => ok({ devices, gateway_url: 'https://nebula.example.ts.net', server_fingerprint: FP }),
      'POST /api/v1/devices/adv_3/approve': () => {
        devices = [dev(), MAC, { ...PENDING, status: 'active', verification_code: undefined }];
        return ok({ ...PENDING, status: 'active' });
      },
    });
    expect(await screen.findByRole('heading', { name: 'Devices' })).toBeInTheDocument();
    const paired = await screen.findByRole('list', { name: 'Paired devices' });
    const rows = within(paired).getAllByTestId('device-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Ada iPhone');
    expect(rows[0]).toHaveTextContent('iPhone 16 Pro · NEBULA 1.0.0');
    expect(within(rows[0]).getByText('Face ID / Touch ID for the vault')).toBeInTheDocument();
    expect(within(rows[0]).getByText('Secure Enclave')).toBeInTheDocument();
    expect(rows[0]).toHaveTextContent('Last online: 5 min ago');
    expect(within(rows[1]).getByText('Keychain')).toBeInTheDocument();
    expect(within(rows[1]).queryByText('Face ID / Touch ID for the vault')).toBeNull();
    expect(rows[1]).toHaveTextContent('Last online: never');
    const pending = screen.getByRole('list', { name: 'Devices waiting for approval' });
    expect(within(pending).getByTestId('verification-code')).toHaveTextContent('123 456');
    expect(within(pending).getByText('Check that your phone shows the same code')).toBeInTheDocument();
    expect(screen.getByText(FP)).toBeInTheDocument();
    await user.click(within(pending).getByRole('button', { name: 'Approve iPad' }));
    await waitFor(() => expect(count(calls, 'POST', '/api/v1/devices/adv_3/approve')).toBe(1));
    await waitFor(() => expect(screen.queryByRole('list', { name: 'Devices waiting for approval' })).toBeNull());
    expect(within(screen.getByRole('list', { name: 'Paired devices' })).getAllByTestId('device-row')).toHaveLength(3);
  });

  it('pairing: the QR code only as an <img> data URL, countdown, copyable link; polled every 2 s; claimed → the code large, approve', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    let st: Record<string, unknown> = { pairing_id: 'pr_1', status: 'open', expires_at: now() + 300, device: null };
    const { calls } = renderPage({
      'GET /api/v1/devices': () => ok({ devices: [], gateway_url: 'https://nebula.example.ts.net', server_fingerprint: FP }),
      'POST /api/v1/devices/pairing': () => ok(offer(), 201),
      'GET /api/v1/devices/pairing/pr_1': () => ok(st),
      'POST /api/v1/devices/adv_9/approve': () => ok(dev({ id: 'adv_9' })),
      'DELETE /api/v1/devices/pairing/pr_1': () => ok({ status: 'cancelled' }),
    });
    await user.click((await screen.findAllByRole('button', { name: 'Pair an iPhone or Mac' }))[0]);
    const dialog = await screen.findByRole('dialog', { name: 'Pair an iPhone or Mac' });
    const img = await within(dialog).findByRole('img', { name: 'QR code for pairing the NEBULA app' });
    expect(img).toHaveAttribute('src', qrDataUrl(SVG));
    expect(img.getAttribute('src')?.startsWith('data:image/svg+xml;charset=utf-8,%3Csvg')).toBe(true);
    expect(dialog.querySelector('script')).toBeNull(); // never inserted as markup
    expect(dialog.querySelector('svg[viewBox="0 0 10 10"]')).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    expect(within(dialog).getByTestId('pairing-countdown')).toHaveTextContent(/Code expires in (5:00|4:59)/);
    expect(dialog).toHaveTextContent('Open the NEBULA app on your iPhone.');
    expect(dialog).toHaveTextContent('Tap “Connect to NEBULA”.');
    expect(dialog).toHaveTextContent('Scan this QR code.');
    const link = within(dialog).getByLabelText('On a Mac: copy the link and paste it into the NEBULA app');
    expect(link).toHaveValue(URL_);
    expect(link).toHaveAttribute('readonly');
    await user.click(within(dialog).getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith(URL_);
    const polls = () => count(calls, 'GET', '/api/v1/devices/pairing/pr_1');
    const before = polls();
    await tick(2000);
    expect(polls()).toBe(before + 1);
    await tick(2000);
    expect(polls()).toBe(before + 2);
    // the app claims the offer
    st = { pairing_id: 'pr_1', status: 'claimed', expires_at: now() + 290, device: { ...PENDING, id: 'adv_9', name: 'Ada iPhone', verification_code: '654321' } };
    await tick(2000);
    const approve = await screen.findByRole('dialog', { name: 'Approve new device' });
    expect(within(approve).getByTestId('verification-code')).toHaveTextContent('654 321');
    expect(approve).toHaveTextContent('Check that your phone shows the same code');
    const after = polls();
    await tick(6000);
    expect(polls()).toBe(after); // polling stopped once claimed
    await user.click(within(approve).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(count(calls, 'POST', '/api/v1/devices/adv_9/approve')).toBe(1);
    expect(count(calls, 'DELETE', '/api/v1/devices/pairing/pr_1')).toBe(0); // a claimed offer is not cancelled
  });

  it('closing the dialog stops the polling and cancels the open offer; rejecting a claimed device', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    let st: Record<string, unknown> = { pairing_id: 'pr_1', status: 'open', expires_at: now() + 300, device: null };
    const { calls } = renderPage({
      'GET /api/v1/devices': () => ok({ devices: [], gateway_url: 'https://nebula.example.ts.net', server_fingerprint: FP }),
      'POST /api/v1/devices/pairing': () => ok(offer(), 201),
      'GET /api/v1/devices/pairing/pr_1': () => ok(st),
      'DELETE /api/v1/devices/pairing/pr_1': () => ok({ status: 'cancelled' }),
      'POST /api/v1/devices/adv_9/reject': () => ok({ status: 'rejected' }),
    });
    await user.click((await screen.findAllByRole('button', { name: 'Pair an iPhone or Mac' }))[0]);
    let dialog = await screen.findByRole('dialog', { name: 'Pair an iPhone or Mac' });
    await within(dialog).findByTestId('pairing-offer');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(count(calls, 'DELETE', '/api/v1/devices/pairing/pr_1')).toBe(1);
    const polls = count(calls, 'GET', '/api/v1/devices/pairing/pr_1');
    await tick(6000);
    expect(count(calls, 'GET', '/api/v1/devices/pairing/pr_1')).toBe(polls);

    // again, and this time the app claims it: the owner rejects
    await user.click((await screen.findAllByRole('button', { name: 'Pair an iPhone or Mac' }))[0]);
    dialog = await screen.findByRole('dialog', { name: 'Pair an iPhone or Mac' });
    await within(dialog).findByTestId('pairing-offer');
    st = { pairing_id: 'pr_1', status: 'claimed', expires_at: now() + 290, device: { ...PENDING, id: 'adv_9', verification_code: '654321' } };
    await tick(2000);
    const decide = await screen.findByRole('dialog', { name: 'Approve new device' });
    await user.click(within(decide).getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(count(calls, 'POST', '/api/v1/devices/adv_9/reject')).toBe(1);
    expect(count(calls, 'DELETE', '/api/v1/devices/pairing/pr_1')).toBe(1);
  });

  it('expiry: after 5 minutes the polling stops and a new code can be created', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    let n = 0;
    const { calls } = renderPage({
      'GET /api/v1/devices': () => ok({ devices: [], gateway_url: 'https://nebula.example.ts.net', server_fingerprint: FP }),
      'POST /api/v1/devices/pairing': () => ok(offer({ pairing_id: 'pr_1', expires_at: now() + (++n === 1 ? 5 : 300) }), 201),
      'GET /api/v1/devices/pairing/pr_1': () => ok({ pairing_id: 'pr_1', status: 'open', expires_at: now() + 1, device: null }),
    });
    await user.click((await screen.findAllByRole('button', { name: 'Pair an iPhone or Mac' }))[0]);
    const dialog = await screen.findByRole('dialog', { name: 'Pair an iPhone or Mac' });
    await within(dialog).findByTestId('pairing-offer');
    await tick(7000);
    expect(await within(dialog).findByText('The code has expired')).toBeInTheDocument();
    const polls = count(calls, 'GET', '/api/v1/devices/pairing/pr_1');
    await tick(6000);
    expect(count(calls, 'GET', '/api/v1/devices/pairing/pr_1')).toBe(polls);
    await user.click(within(dialog).getByRole('button', { name: 'Create a new code' }));
    expect(await within(dialog).findByTestId('pairing-offer')).toBeInTheDocument();
    expect(count(calls, 'POST', '/api/v1/devices/pairing')).toBe(2);
  });

  it('remote access off: the page says so, and pairing (409 gateway_not_configured) links to the remote-access settings', async () => {
    const user = userEvent.setup();
    renderPage({
      'GET /api/v1/devices': () => ok({ devices: [], gateway_url: null, server_fingerprint: FP }),
      'POST /api/v1/devices/pairing': () => apiError(409, 'gateway_not_configured', 'Turn on remote access first (Settings → Remote access)'),
    });
    expect(await screen.findByText('Remote access is off')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Set up remote access' })).toHaveAttribute('href', '#/remote');
    expect(screen.getByText('No paired devices yet')).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'Pair an iPhone or Mac' })[0]);
    const dialog = await screen.findByRole('dialog', { name: 'Pair an iPhone or Mac' });
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('Turn on remote access first');
    expect(within(alert).getByRole('link', { name: 'Open Remote Access' })).toHaveAttribute('href', '#/remote');
    expect(within(dialog).queryByRole('img')).toBeNull();
  });

  it('renames inline and removes a device only after a confirmation that explains the sign-out and the vault key', async () => {
    const user = userEvent.setup();
    let devices = [dev(), MAC];
    const { calls } = renderPage({
      'GET /api/v1/devices': () => ok({ devices, gateway_url: 'https://nebula.example.ts.net', server_fingerprint: FP }),
      'PATCH /api/v1/devices/adv_1': (c) => ok(dev({ name: (c.body as { name: string }).name })),
      'DELETE /api/v1/devices/adv_1': () => {
        devices = [MAC];
        return ok({ device_id: 'adv_1', status: 'revoked', sessions_ended: 2 });
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Rename Ada iPhone' }));
    const input = screen.getByLabelText('Device name');
    await user.clear(input);
    await user.type(input, 'Work iPhone{Enter}');
    expect(await screen.findByText('Work iPhone')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ name: 'Work iPhone' });

    await user.click(screen.getByRole('button', { name: 'Remove Work iPhone' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove Work iPhone?' });
    expect(dialog).toHaveTextContent('signed out');
    expect(dialog).toHaveTextContent('Password Vault key');
    expect(count(calls, 'DELETE', '/api/v1/devices/adv_1')).toBe(0);
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(count(calls, 'DELETE', '/api/v1/devices/adv_1')).toBe(1));
    await waitFor(() => expect(screen.queryByText('Work iPhone')).toBeNull());
    expect(within(screen.getByRole('list', { name: 'Paired devices' })).getAllByTestId('device-row')).toHaveLength(1);
  });

  it('refreshes the list on app.device.changed', async () => {
    let devices: AppDevice[] = [];
    const hub = new EventHub();
    const { calls } = renderPage({ 'GET /api/v1/devices': () => ok({ devices, gateway_url: 'https://nebula.example.ts.net', server_fingerprint: FP }) }, hub);
    expect(await screen.findByText('No paired devices yet')).toBeInTheDocument();
    devices = [PENDING];
    act(() => {
      hub.handle(new MessageEvent('app.device.changed', { data: JSON.stringify({ id: 'e1', sequence: 1, type: 'app.device.changed', agent_id: null, task_id: null, timestamp: now(), payload: { device_id: 'adv_3', status: 'pending' } }) }));
    });
    expect(await screen.findByRole('list', { name: 'Devices waiting for approval' })).toBeInTheDocument();
    expect(count(calls, 'GET', '/api/v1/devices')).toBe(2);
  });
});
