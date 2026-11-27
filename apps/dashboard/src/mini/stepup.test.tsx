// Owner confirmations (V4.0: ONE confirmation instead of two secrets). A 403 `stepup_required` / `reauth_required` from
// MiniClient calls and from the Dashboard pages' transport, or a screen's useOwnerConfirm(), opens ONE sheet: Face ID via
// Telegram's BiometricManager (the real prompt; with the vault key on this device it also unlocks the vault), the vault
// passphrase once together with Face ID the first time on a device ("Next time, Face ID only"), or — without biometrics — a
// single field (the vault passphrase, else the NEBULA password). Exactly one POST /auth/confirm per attempt; the rotated
// device token is stored at once (also from an error's details). After a confirmation every waiting request is retried
// exactly once; a cancel fails them with the original error. Settings → Security enrols this device.
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../components/Toast';
import { request, setTransport } from '../lib/http';
import { apiError, installFetch, ok, type RecordedCall } from '../test/fetchMock';
import { createMiniApi } from './api';
import { MiniClient } from './client';
import { MiniProvider, type MiniContextValue } from './context';
import { clearQueryCache } from './hooks';
import { markBiometricStale, rememberDevice } from './stepup/biometric';
import { StepUpProvider, useOwnerConfirm, type OwnerConfirmOptions } from './stepup/StepUpProvider';
import type { TgBiometricManager } from './telegram';
import { baseRoutes, installMemoryStorage, mount, PERMS, resetStream, session, telegram } from './test/kit';

vi.mock('@novnc/novnc', () => ({ default: class {} }));

type Handler = (c: RecordedCall) => Response | Promise<Response>;
const NOW = () => Math.floor(Date.now() / 1000);
const STEPUP = (methods = ['password']) => apiError(403, 'stepup_required', 'Confirm this change', { level: 'fresh', methods });
const PASS = 'Fake-Vault-Passphrase-42';

function biometrics(over: Partial<TgBiometricManager> = {}) {
  const bm = {
    isInited: true,
    isBiometricAvailable: true,
    biometricType: 'face' as const,
    isAccessRequested: true,
    isAccessGranted: true,
    isBiometricTokenSaved: true,
    deviceId: 'tg-device',
    init: vi.fn((cb?: () => void) => cb?.()),
    requestAccess: vi.fn((_p: { reason?: string }, cb?: (granted: boolean) => void) => cb?.(true)),
    authenticate: vi.fn((_p: { reason?: string }, cb?: (ok: boolean, token?: string) => void) => cb?.(true, 'nebula1.dev1.tok-A')),
    updateBiometricToken: vi.fn((_t: string, cb?: (ok: boolean) => void) => cb?.(true)),
    openSettings: vi.fn(),
    ...over,
  };
  return bm;
}

/** GET /auth/assurance of the owner on the phone. */
function assurance(over: { devices?: object[]; locked?: boolean; fresh?: boolean; reauth?: boolean; vaultPassphrase?: boolean; exists?: boolean } = {}) {
  const devices = over.devices ?? [];
  return {
    interface: 'miniapp',
    role: 'owner',
    fresh_until: over.fresh ? NOW() + 300 : null,
    fresh: Boolean(over.fresh),
    methods: { password: true, biometric: { enrolled: devices.length > 0, devices }, vault_passphrase: over.vaultPassphrase ?? over.exists !== false },
    vault: { exists: over.exists !== false, locked: over.locked ?? true, reauth_until: over.reauth ? NOW() + 300 : null },
  };
}

const device = (vaultKey: boolean, id = 'dev1') => ({ id, name: 'iPhone / iPad · Telegram', created_at: NOW() - 86400, last_used_at: null, vault_key: vaultKey });
const confirmed = (over: Record<string, unknown> = {}) =>
  ok({ fresh_until: NOW() + 300, vault: { exists: true, locked: false, entry_count: 2, result: 'unlocked', reauth_until: NOW() + 300, device_key: false }, vault_unlock_needed: false, ...over });

/** A screen that confirms explicitly (useOwnerConfirm) and shows the result. */
function Probe({ opts }: { opts: OwnerConfirmOptions }) {
  const confirm = useOwnerConfirm();
  const [r, setR] = useState('idle');
  return (
    <>
      <button type="button" onClick={() => void confirm(opts).then((v) => setR(v ? 'confirmed' : 'cancelled'))}>
        run
      </button>
      <output data-testid="probe">{r}</output>
    </>
  );
}

/** StepUpProvider around a probe: requests are started by the test through the client / lib/http or the probe. */
function harness(routes: Record<string, Handler>, bm: ReturnType<typeof biometrics> | null = null, opts: OwnerConfirmOptions = {}) {
  telegram(bm ? { BiometricManager: bm as unknown as TgBiometricManager } : {});
  const net = installFetch(routes);
  const client = new MiniClient({ mode: 'telegram', token: 'tok-1', csrf: 'csrf-1' });
  const ctx: MiniContextValue = { client, api: createMiniApi(client), session, me: { permissions: PERMS, role: 'owner', admin: true }, username: 'owner', inTelegram: true };
  const restore = setTransport(client.transport());
  const view = render(
    <ToastProvider>
      <MiniProvider value={ctx}>
        <StepUpProvider client={client}>
          <Probe opts={opts} />
        </StepUpProvider>
      </MiniProvider>
    </ToastProvider>,
  );
  return { ...net, client, view, restore };
}

const count = (calls: RecordedCall[], method: string, path: string) => calls.filter((c) => c.method === method && c.path === path).length;
const bodies = (calls: RecordedCall[], path = '/api/v1/auth/confirm') => calls.filter((c) => c.path === path).map((c) => c.body);
const stored = () => JSON.stringify({ ...window.localStorage, ...Object.fromEntries(Object.keys(sessionStorage).map((k) => [k, sessionStorage.getItem(k)])) });

describe('Owner confirmation (one confirmation instead of two secrets)', () => {
  let restore: (() => void) | null = null;
  beforeEach(() => {
    sessionStorage.clear();
    installMemoryStorage();
    clearQueryCache();
    markBiometricStale(false);
    rememberDevice(null);
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  });
  afterEach(() => {
    restore?.();
    restore = null;
    vi.unstubAllGlobals();
    delete window.Telegram;
    window.history.replaceState(null, '', '/');
    resetStream();
  });

  it('no vault, no biometrics: ONE field, the NEBULA password; a wrong one is reported (the session stays), the right one confirms and the request is retried once', async () => {
    const user = userEvent.setup();
    let n = 0;
    const h = harness({
      'DELETE /api/v1/agents/a1': () => (++n === 1 ? STEPUP() : ok({ deleted: 'a1' })),
      'POST /api/v1/auth/confirm': (c) => ((c.body as { password: string }).password === 'correct horse' ? confirmed({ vault: null }) : apiError(401, 'wrong_password', 'wrong password')),
    });
    restore = h.restore;
    const gone = vi.fn();
    h.client.onUnauthorized(gone);
    let result: unknown = null;
    const p = h.client.request('/agents/a1', { method: 'DELETE' }).then((r) => (result = r));
    const sheet = await screen.findByTestId('owner-confirm');
    expect(within(sheet).getByRole('heading', { name: 'Confirm it is you' })).toBeInTheDocument();
    const field = await within(sheet).findByLabelText('NEBULA password');
    expect(within(sheet).queryByRole('button', { name: /Face ID/ })).toBeNull(); // not enrolled
    expect(within(sheet).queryByLabelText('Vault passphrase')).toBeNull();
    expect(field).toHaveAttribute('type', 'password');
    expect(field).toHaveAttribute('autocomplete', 'current-password');
    await user.type(field, 'nope');
    await user.click(within(sheet).getByRole('button', { name: 'Confirm' }));
    expect(await within(sheet).findByRole('alert')).toHaveTextContent('Wrong password. Try again.');
    expect(field).toHaveValue(''); // never kept after an attempt
    expect(gone).not.toHaveBeenCalled();
    expect(h.client.isExpired).toBe(false);
    await user.type(field, 'correct horse');
    await user.click(within(sheet).getByRole('button', { name: 'Confirm' }));
    await act(async () => {
      await p;
    });
    expect(result).toEqual({ deleted: 'a1' });
    expect(count(h.calls, 'DELETE', '/api/v1/agents/a1')).toBe(2);
    expect(bodies(h.calls)).toEqual([
      { method: 'password', password: 'nope' },
      { method: 'password', password: 'correct horse' },
    ]);
    expect(count(h.calls, 'POST', '/api/v1/auth/stepup')).toBe(0);
    expect(screen.queryByTestId('owner-confirm')).toBeNull();
    expect(stored()).not.toContain('correct horse');
  });

  it('rate limit: tells how long to wait and blocks the field', async () => {
    const user = userEvent.setup();
    const h = harness({
      'POST /api/v1/agents/a1/wake': () => STEPUP(),
      'POST /api/v1/auth/confirm': () => apiError(429, 'rate_limited', 'too many attempts', { retry_after: 30 }),
    });
    restore = h.restore;
    void h.client.request('/agents/a1/wake', { method: 'POST' }).catch(() => undefined);
    const sheet = await screen.findByTestId('owner-confirm');
    await user.type(await within(sheet).findByLabelText('NEBULA password'), 'x');
    await user.click(within(sheet).getByRole('button', { name: 'Confirm' }));
    expect(await within(sheet).findByRole('alert')).toHaveTextContent(/Too many attempts\. Try again in (30|29) s\./);
    expect(within(sheet).getByLabelText('NEBULA password')).toBeDisabled();
  });

  it('the vault passphrase is the single fallback when the host lists it: one field, one confirm, never the login password afterwards', async () => {
    const user = userEvent.setup();
    let n = 0;
    const h = harness({
      'DELETE /api/v1/agents/a1': () => (++n === 1 ? STEPUP(['password', 'vault_passphrase']) : ok({ deleted: 'a1' })),
      'POST /api/v1/auth/confirm': () => confirmed(),
    });
    restore = h.restore;
    const p = h.client.request('/agents/a1', { method: 'DELETE' });
    const sheet = await screen.findByTestId('owner-confirm');
    const field = await within(sheet).findByLabelText('Vault passphrase');
    expect(field).toHaveAttribute('autocomplete', 'off');
    expect(within(sheet).queryByLabelText('NEBULA password')).toBeNull();
    await user.type(field, PASS);
    await user.click(within(sheet).getByRole('button', { name: 'Confirm' }));
    await expect(p).resolves.toEqual({ deleted: 'a1' });
    expect(bodies(h.calls)).toEqual([{ method: 'vault_passphrase', passphrase: PASS }]);
    expect(screen.queryByTestId('owner-confirm')).toBeNull();
    expect(screen.queryByLabelText('NEBULA password')).toBeNull();
    expect(stored()).not.toContain(PASS);
  });

  it('Face ID: the real prompt starts at once; exactly ONE /auth/confirm with the token; the rotated token is stored; retried once', async () => {
    const bm = biometrics();
    let n = 0;
    const h = harness(
      {
        'POST /api/v1/providers': () => (++n === 1 ? STEPUP(['password', 'biometric']) : ok({ id: 'p1' })),
        'POST /api/v1/auth/stepup/challenge': () => ok({ challenge_id: 'ch1', expires_at: NOW() + 60 }),
        'POST /api/v1/auth/confirm': () => confirmed({ next_token: 'tok-B', vault: null }),
      },
      bm,
    );
    restore = h.restore;
    // a Dashboard page request (lib/http transport of the administration area)
    await expect(request('/providers', { method: 'POST', body: { kind: 'openai' } })).resolves.toEqual({ id: 'p1' });
    expect(bm.authenticate).toHaveBeenCalledTimes(1);
    expect(h.calls.find((c) => c.path === '/api/v1/auth/stepup/challenge')?.body).toEqual({ device_id: 'dev1' });
    expect(bodies(h.calls)).toEqual([{ method: 'telegram_biometric', device_id: 'dev1', challenge_id: 'ch1', token: 'tok-A' }]);
    expect(bm.updateBiometricToken).toHaveBeenCalledWith('nebula1.dev1.tok-B', expect.any(Function));
    expect(count(h.calls, 'POST', '/api/v1/providers')).toBe(2);
    expect(h.calls.every((c) => c.headers.authorization === 'Bearer tok-1')).toBe(true);
    expect(stored()).not.toMatch(/tok-A|tok-B/);
  });

  it('Face ID: when the rotated token cannot be stored the owner is told, and the next confirmation uses the single field', async () => {
    const bm = biometrics({ updateBiometricToken: vi.fn((_t: string, cb?: (ok: boolean) => void) => cb?.(false)) });
    let n = 0;
    const h = harness(
      {
        'POST /api/v1/agents/a1/sleep': () => (++n % 2 === 1 ? STEPUP(['password', 'biometric']) : ok({ id: 'a1' })),
        'POST /api/v1/auth/stepup/challenge': () => ok({ challenge_id: 'ch1', expires_at: NOW() + 60 }),
        'POST /api/v1/auth/confirm': () => confirmed({ fresh_until: NOW() - 1, next_token: 'tok-B', vault: null }),
      },
      bm,
    );
    restore = h.restore;
    await expect(h.client.request('/agents/a1/sleep', { method: 'POST' })).resolves.toEqual({ id: 'a1' });
    expect(await screen.findByText('Face ID needs to be set up again')).toBeInTheDocument();
    void h.client.request('/agents/a1/sleep', { method: 'POST' }).catch(() => undefined);
    const again = await screen.findByTestId('owner-confirm');
    expect(await within(again).findByLabelText('NEBULA password')).toBeInTheDocument();
    expect(within(again).queryByRole('button', { name: /Face ID/ })).toBeNull();
    expect(bm.authenticate).toHaveBeenCalledTimes(1);
  });

  it('Face ID: a device removed on the host (challenge 404) falls back to the single field; the token is never sent', async () => {
    const bm = biometrics();
    const h = harness(
      {
        'DELETE /api/v1/agents/a1': () => STEPUP(['password', 'biometric']),
        'POST /api/v1/auth/stepup/challenge': () => apiError(404, 'not_found', 'no such device'),
      },
      bm,
    );
    restore = h.restore;
    void h.client.request('/agents/a1', { method: 'DELETE' }).catch(() => undefined);
    const sheet = await screen.findByTestId('owner-confirm');
    expect(await within(sheet).findByRole('alert')).toHaveTextContent('Face ID is no longer set up for this device. Use the password.');
    expect(within(sheet).queryByRole('button', { name: /Face ID/ })).toBeNull();
    expect(within(sheet).getByLabelText('NEBULA password')).toBeInTheDocument();
    expect(count(h.calls, 'POST', '/api/v1/auth/confirm')).toBe(0);
  });

  it('vault + Face ID with the vault key on this device: ONE biometric prompt confirms AND unlocks (one confirm, no passphrase)', async () => {
    const user = userEvent.setup();
    const bm = biometrics();
    const h = harness(
      {
        'GET /api/v1/auth/assurance': () => ok(assurance({ devices: [device(true)] })),
        'POST /api/v1/auth/stepup/challenge': () => ok({ challenge_id: 'ch1', expires_at: NOW() + 60 }),
        'POST /api/v1/auth/confirm': () => confirmed({ next_token: 'tok-B', vault: { exists: true, locked: false, entry_count: 2, result: 'unlocked', reauth_until: NOW() + 300, device_key: true } }),
      },
      bm,
      { unlockVault: true },
    );
    restore = h.restore;
    await user.click(screen.getByRole('button', { name: 'run' }));
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('confirmed'));
    expect(bm.authenticate).toHaveBeenCalledTimes(1);
    expect(bodies(h.calls)).toEqual([{ method: 'telegram_biometric', device_id: 'dev1', challenge_id: 'ch1', token: 'tok-A', unlock_vault: true }]);
    expect(bm.updateBiometricToken).toHaveBeenCalledWith('nebula1.dev1.tok-B', expect.any(Function));
    expect(count(h.calls, 'POST', '/api/v1/vault/unlock')).toBe(0);
  });

  it('first time on a device: the vault passphrase ONCE, then the real Face ID prompt — sent together with the token and "Next time, Face ID only"', async () => {
    const user = userEvent.setup();
    const bm = biometrics();
    const h = harness(
      {
        'GET /api/v1/auth/assurance': () => ok(assurance({ devices: [device(false)] })),
        'POST /api/v1/auth/stepup/challenge': () => ok({ challenge_id: 'ch1', expires_at: NOW() + 60 }),
        'POST /api/v1/auth/confirm': () => confirmed({ next_token: 'tok-B', vault: { exists: true, locked: false, entry_count: 2, result: 'unlocked_passphrase+enrolled', reauth_until: NOW() + 300, device_key: true } }),
      },
      bm,
      { unlockVault: true },
    );
    restore = h.restore;
    await user.click(screen.getByRole('button', { name: 'run' }));
    const sheet = await screen.findByTestId('owner-confirm');
    const field = await within(sheet).findByLabelText('Vault passphrase');
    const remember = within(sheet).getByRole('switch', { name: 'Next time, Face ID only' });
    expect(remember).toHaveAttribute('aria-checked', 'true');
    expect(bm.authenticate).not.toHaveBeenCalled(); // never a simulated biometric: the button triggers the real prompt
    expect(within(sheet).getByRole('button', { name: 'Confirm with Face ID' })).toBeDisabled();
    await user.type(field, PASS);
    await user.click(within(sheet).getByRole('button', { name: 'Confirm with Face ID' }));
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('confirmed'));
    expect(bm.authenticate).toHaveBeenCalledTimes(1);
    expect(bodies(h.calls)).toEqual([
      { method: 'telegram_biometric', device_id: 'dev1', challenge_id: 'ch1', token: 'tok-A', unlock_vault: true, passphrase: PASS, enroll_vault_key: true },
    ]);
    expect(bm.updateBiometricToken).toHaveBeenCalledWith('nebula1.dev1.tok-B', expect.any(Function));
    expect(await screen.findByText('Face ID for the vault is on')).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain(PASS);
    expect(stored()).not.toMatch(/tok-A|tok-B|Fake-Vault/);
  });

  it('first time, toggle off: no enrolment; a wrong passphrase stores the rotated token from the error and shows the attempts left', async () => {
    const user = userEvent.setup();
    const bm = biometrics();
    const h = harness(
      {
        'GET /api/v1/auth/assurance': () => ok(assurance({ devices: [device(false)] })),
        'POST /api/v1/auth/stepup/challenge': () => ok({ challenge_id: 'ch1', expires_at: NOW() + 60 }),
        'POST /api/v1/auth/confirm': () => apiError(401, 'wrong_passphrase', 'wrong vault passphrase', { attempts_left: 4, fresh_until: NOW() + 300, next_token: 'tok-C' }),
      },
      bm,
      { unlockVault: true },
    );
    restore = h.restore;
    await user.click(screen.getByRole('button', { name: 'run' }));
    const sheet = await screen.findByTestId('owner-confirm');
    await user.click(await within(sheet).findByRole('switch', { name: 'Next time, Face ID only' }));
    await user.type(within(sheet).getByLabelText('Vault passphrase'), 'wrong-passphrase');
    await user.click(within(sheet).getByRole('button', { name: 'Confirm with Face ID' }));
    expect(await within(sheet).findByRole('alert')).toHaveTextContent('Wrong vault passphrase. 4 attempts left before a temporary lock.');
    expect(bodies(h.calls)).toEqual([
      { method: 'telegram_biometric', device_id: 'dev1', challenge_id: 'ch1', token: 'tok-A', unlock_vault: true, passphrase: 'wrong-passphrase', enroll_vault_key: false },
    ]);
    // the token rotated even though the vault part failed: stored at once
    expect(bm.updateBiometricToken).toHaveBeenCalledWith('nebula1.dev1.tok-C', expect.any(Function));
    expect(within(sheet).getByLabelText('Vault passphrase')).toHaveValue('');
    expect(screen.getByTestId('probe')).toHaveTextContent('idle');
  });

  it('no biometrics on this device: the vault passphrase ONCE (unlock_vault) — never followed by the login password', async () => {
    const user = userEvent.setup();
    const h = harness(
      {
        'GET /api/v1/auth/assurance': () => ok(assurance()),
        'POST /api/v1/auth/confirm': (c) =>
          (c.body as { passphrase: string }).passphrase === PASS ? confirmed() : apiError(401, 'wrong_passphrase', 'wrong vault passphrase', { attempts_left: 1 }),
      },
      null,
      { unlockVault: true },
    );
    restore = h.restore;
    await user.click(screen.getByRole('button', { name: 'run' }));
    const sheet = await screen.findByTestId('owner-confirm');
    const field = await within(sheet).findByLabelText('Vault passphrase');
    expect(within(sheet).queryByLabelText('NEBULA password')).toBeNull();
    expect(within(sheet).queryByRole('button', { name: 'Use NEBULA password' })).toBeNull(); // the login password cannot unlock the vault
    await user.type(field, 'nope');
    await user.click(within(sheet).getByRole('button', { name: 'Confirm' }));
    expect(await within(sheet).findByRole('alert')).toHaveTextContent('Wrong vault passphrase. 1 attempt left before a temporary lock.');
    await user.type(field, PASS);
    await user.click(within(sheet).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('confirmed'));
    expect(bodies(h.calls)).toEqual([
      { method: 'vault_passphrase', passphrase: 'nope', unlock_vault: true },
      { method: 'vault_passphrase', passphrase: PASS, unlock_vault: true },
    ]);
    expect(screen.queryByTestId('owner-confirm')).toBeNull();
    expect(screen.queryByLabelText('NEBULA password')).toBeNull();
    expect(count(h.calls, 'POST', '/api/v1/auth/stepup')).toBe(0);
    expect(count(h.calls, 'POST', '/api/v1/vault/unlock')).toBe(0);
  });

  it('biometrics denied for NEBULA in Telegram: the single field instead, Face ID is never started', async () => {
    const bm = biometrics({ isAccessGranted: false });
    const h = harness({ 'GET /api/v1/auth/assurance': () => ok(assurance({ devices: [device(true)] })) }, bm, { unlockVault: true });
    restore = h.restore;
    await userEvent.setup().click(screen.getByRole('button', { name: 'run' }));
    const sheet = await screen.findByTestId('owner-confirm');
    expect(await within(sheet).findByLabelText('Vault passphrase')).toBeInTheDocument();
    expect(within(sheet).queryByRole('button', { name: /Face ID/ })).toBeNull();
    expect(bm.authenticate).not.toHaveBeenCalled();
  });

  it('already confirmed and the vault unlocked: nothing is asked and nothing is sent', async () => {
    const user = userEvent.setup();
    const h = harness({ 'GET /api/v1/auth/assurance': () => ok(assurance({ fresh: true, locked: false, reauth: true })) }, biometrics(), { reveal: true });
    restore = h.restore;
    await user.click(screen.getByRole('button', { name: 'run' }));
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('confirmed'));
    expect(screen.queryByTestId('owner-confirm')).toBeNull();
    expect(count(h.calls, 'POST', '/api/v1/auth/confirm')).toBe(0);
  });

  it('reauth_required (showing a secret) is answered by the same ONE confirmation (unlock_vault) and the request is retried once', async () => {
    const user = userEvent.setup();
    let n = 0;
    const h = harness({
      'POST /api/v1/vault/entries/e1/reveal': () => (++n === 1 ? apiError(403, 'reauth_required', 'confirm the vault passphrase again') : ok({ value: 'x' })),
      'GET /api/v1/auth/assurance': () => ok(assurance({ locked: false })),
      'POST /api/v1/auth/confirm': () => confirmed({ vault: { exists: true, locked: false, entry_count: 2, result: 'confirmed_passphrase', reauth_until: NOW() + 300, device_key: false } }),
    });
    restore = h.restore;
    const p = h.client.request('/vault/entries/e1/reveal', { method: 'POST', body: { field: 'password' } });
    const sheet = await screen.findByTestId('owner-confirm');
    await user.type(await within(sheet).findByLabelText('Vault passphrase'), PASS);
    await user.click(within(sheet).getByRole('button', { name: 'Confirm' }));
    await expect(p).resolves.toEqual({ value: 'x' });
    expect(bodies(h.calls)).toEqual([{ method: 'vault_passphrase', passphrase: PASS, unlock_vault: true }]);
    expect(count(h.calls, 'POST', '/api/v1/vault/reauth')).toBe(0);
  });

  it('concurrent 403s (Mini App client and Dashboard transport) share ONE prompt; each request is retried once', async () => {
    const user = userEvent.setup();
    const seen: Record<string, number> = {};
    const once = (key: string, data: unknown) => () => ((seen[key] = (seen[key] ?? 0) + 1) === 1 ? STEPUP() : ok(data));
    const h = harness({
      'DELETE /api/v1/schedules/s1': once('s', { deleted: 's1' }),
      'DELETE /api/v1/teams/t1': once('t', { deleted: 't1' }),
      'PATCH /api/v1/settings': once('c', { ok: true }),
      'POST /api/v1/auth/confirm': () => confirmed({ vault: null }),
    });
    restore = h.restore;
    const all = Promise.all([
      h.client.request('/schedules/s1', { method: 'DELETE' }),
      h.client.request('/teams/t1', { method: 'DELETE' }),
      request('/settings', { method: 'PATCH', body: { a: 1 } }),
    ]);
    const sheet = await screen.findByTestId('owner-confirm');
    await waitFor(() => expect(Object.values(seen).reduce((a, b) => a + b, 0)).toBe(3));
    expect(screen.getAllByTestId('owner-confirm')).toHaveLength(1);
    await user.type(await within(sheet).findByLabelText('NEBULA password'), 'pw');
    await user.click(within(sheet).getByRole('button', { name: 'Confirm' }));
    await expect(all).resolves.toEqual([{ deleted: 's1' }, { deleted: 't1' }, { ok: true }]);
    expect(seen).toEqual({ s: 2, t: 2, c: 2 });
    expect(count(h.calls, 'POST', '/api/v1/auth/confirm')).toBe(1);
  });

  it('cancel fails the waiting request with its original error; nothing is retried or sent', async () => {
    const user = userEvent.setup();
    const h = harness({ 'DELETE /api/v1/agents/a1': () => STEPUP() });
    restore = h.restore;
    const p = h.client.request('/agents/a1', { method: 'DELETE' });
    const caught = p.catch((e: unknown) => e);
    const sheet = await screen.findByTestId('owner-confirm');
    await within(sheet).findByLabelText('NEBULA password');
    await user.click(within(sheet).getByRole('button', { name: 'Cancel' }));
    expect(await caught).toMatchObject({ status: 403, code: 'stepup_required' });
    expect(count(h.calls, 'DELETE', '/api/v1/agents/a1')).toBe(1);
    expect(count(h.calls, 'POST', '/api/v1/auth/confirm')).toBe(0);
    expect(screen.queryByTestId('owner-confirm')).toBeNull();
  });

  it('retry once: a request still refused after the confirmation fails without a second prompt', async () => {
    const user = userEvent.setup();
    const h = harness({ 'DELETE /api/v1/agents/a1': () => STEPUP(), 'POST /api/v1/auth/confirm': () => confirmed({ vault: null }) });
    restore = h.restore;
    const caught = h.client.request('/agents/a1', { method: 'DELETE' }).catch((e: unknown) => e);
    const sheet = await screen.findByTestId('owner-confirm');
    await user.type(await within(sheet).findByLabelText('NEBULA password'), 'pw');
    await user.click(within(sheet).getByRole('button', { name: 'Confirm' }));
    expect(await caught).toMatchObject({ code: 'stepup_required' });
    expect(count(h.calls, 'DELETE', '/api/v1/agents/a1')).toBe(2);
    expect(screen.queryByTestId('owner-confirm')).toBeNull();
  });
});

describe('Settings → Security', () => {
  beforeEach(() => {
    sessionStorage.clear();
    installMemoryStorage();
    clearQueryCache();
    markBiometricStale(false);
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete window.Telegram;
    window.history.replaceState(null, '', '/');
    resetStream();
  });

  const ME = { session_id: 's1', telegram_user_id: 42, bot: 'main', permissions: PERMS, expires_in: 3600, role: 'owner', admin: true, assurance: { fresh_until: null } };
  const assurance = (devices: object[] = []) => ({
    interface: 'miniapp',
    role: 'owner',
    fresh_until: null,
    methods: { password: true, biometric: { enrolled: devices.length > 0, devices } },
  });

  it('enrols Face ID: confirmation first (password), then the device token goes only into BiometricManager', async () => {
    const user = userEvent.setup();
    const bm = biometrics({ isBiometricTokenSaved: false, isAccessGranted: false });
    let n = 0;
    const { calls } = mount(
      '#/settings/security',
      baseRoutes({
        'GET /api/v1/miniapp/me': () => ok(ME),
        'GET /api/v1/auth/assurance': () => ok(assurance()),
        'POST /api/v1/auth/devices': () => (++n === 1 ? STEPUP() : ok({ device_id: 'dev9', token: 'tok-9' })),
        'POST /api/v1/auth/confirm': () => ok({ fresh_until: NOW() + 300, vault: null }),
      }),
      telegram({ BiometricManager: bm as unknown as TgBiometricManager }),
    );
    expect(await screen.findByText('Owner')).toBeInTheDocument();
    expect(screen.getByText('Ask for a confirmation')).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Use Face ID for confirmations' }));
    const sheet = await screen.findByTestId('owner-confirm');
    await user.type(await within(sheet).findByLabelText('NEBULA password'), 'pw');
    await user.click(within(sheet).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(bm.updateBiometricToken).toHaveBeenCalledWith('nebula1.dev9.tok-9', expect.any(Function)));
    expect(bm.requestAccess).toHaveBeenCalledTimes(1);
    expect(count(calls, 'POST', '/api/v1/auth/devices')).toBe(2);
    expect(calls.find((c) => c.path === '/api/v1/auth/devices')?.body).toEqual({ name: 'iPhone / iPad · Telegram' });
    expect(await screen.findByText('Face ID is on')).toBeInTheDocument();
    expect(stored()).not.toContain('tok-9');
  });

  it('lists enrolled devices and removes one after a confirmation sheet', async () => {
    const user = userEvent.setup();
    const { calls } = mount(
      '#/settings/security',
      baseRoutes({
        'GET /api/v1/miniapp/me': () => ok(ME),
        'GET /api/v1/auth/assurance': () => ok(assurance([{ id: 'dev1', name: 'iPhone / iPad · Telegram', created_at: NOW() - 86400, last_used_at: null }])),
        'DELETE /api/v1/auth/devices/dev1': () => ok({ deleted: 'dev1' }),
      }),
      telegram({ BiometricManager: biometrics() as unknown as TgBiometricManager }),
    );
    await user.click(await screen.findByRole('button', { name: 'Remove iPhone / iPad · Telegram' }));
    const confirm = await screen.findByRole('dialog', { name: 'Remove iPhone / iPad · Telegram?' });
    await user.click(within(confirm).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(count(calls, 'DELETE', '/api/v1/auth/devices/dev1')).toBe(1));
    expect(screen.getByText('Face ID is on for this device')).toBeInTheDocument();
  });

  it('an operator sees role and confirmation state, but no biometric enrolment (owner-only on the host)', async () => {
    mount(
      '#/settings/security',
      baseRoutes({ 'GET /api/v1/miniapp/me': () => ok({ ...ME, role: 'operator', admin: false }), 'GET /api/v1/auth/assurance': () => ok({ ...assurance(), role: 'operator' }) }),
      telegram({ BiometricManager: biometrics({ isBiometricTokenSaved: false }) as unknown as TgBiometricManager }),
    );
    expect(await screen.findByText('Operator')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /for confirmations/ })).toBeNull();
    expect(screen.getByText('Owner-only actions stay on your Mac')).toBeInTheDocument();
  });

  it('explains when biometrics are not available (no BiometricManager / old Telegram)', async () => {
    mount('#/settings/security', baseRoutes({ 'GET /api/v1/miniapp/me': () => ok(ME), 'GET /api/v1/auth/assurance': () => ok(assurance()) }));
    expect(await screen.findByText('Not available here')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /for confirmations/ })).toBeNull();
  });
});
