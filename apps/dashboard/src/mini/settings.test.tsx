import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ok } from '../test/fetchMock';
import { clearQueryCache } from './hooks';
import { filterSettings } from './screens/SettingsScreen';
import { baseRoutes, installMemoryStorage, mount, resetStream } from './test/kit';
import { setThemeMode } from './theme';

vi.mock('@novnc/novnc', () => ({ default: class {} }));

describe('Settings', () => {
  beforeEach(() => {
    sessionStorage.clear();
    installMemoryStorage();
    clearQueryCache();
    setThemeMode('system', null);
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete window.Telegram;
    window.history.replaceState(null, '', '/');
    delete document.documentElement.dataset.theme;
    resetStream();
  });

  it('search matches titles, sections and keywords', () => {
    expect(filterSettings('vault').map((i) => i.id)).toEqual(['vault']);
    expect(filterSettings('passwords').map((i) => i.id)).toEqual(['vault']);
    expect(filterSettings('dark').map((i) => i.id)).toEqual(['appearance']);
    expect(filterSettings('connections telegram').map((i) => i.id)).toEqual(['telegram', 'bots']);
    expect(filterSettings('telegram').map((i) => i.id)).toEqual(['account', 'tg-account', 'telegram', 'bots']);
    expect(filterSettings('zzz-nothing')).toEqual([]);
    expect(filterSettings('').length).toBeGreaterThan(20);
  });

  it('groups every capability; local-only items are disabled with an explanation; search filters the list', async () => {
    const user = userEvent.setup();
    mount('#/settings', baseRoutes());
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    for (const section of ['Account', 'Agents & Automation', 'Data', 'Connections', 'System']) {
      expect(screen.getByRole('heading', { name: section })).toBeInTheDocument();
    }
    for (const [name, href] of [
      ['AI companies', '#/companies'],
      ['Agents', '#/agents'],
      ['Teams', '#/teams'],
      ['Workflows', '#/workflows'],
      ['Schedules', '#/schedules'],
      ['Files', '#/files'],
      ['Password Vault', '#/settings/vault'],
      ['Notifications', '#/notifications'],
      ['System status', '#/settings/system'],
      ['Live Desktops', '#/settings/desktops'],
      ['Appearance', '#/settings/appearance'],
    ]) {
      expect(within(screen.getByRole('main')).getByRole('link', { name: new RegExp(`^${name}`) })).toHaveAttribute('href', href);
    }
    expect(screen.getByLabelText('Backups: Only in the local Dashboard')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByLabelText('Bot network: Manage in the local Dashboard')).toHaveAttribute('aria-disabled', 'true');

    await user.type(screen.getByLabelText('Search settings'), 'vault');
    expect(screen.getByRole('link', { name: /^Password Vault/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^AI companies/ })).toBeNull();
    await user.clear(screen.getByLabelText('Search settings'));
    await user.type(screen.getByLabelText('Search settings'), 'zzz');
    expect(screen.getByRole('status')).toHaveTextContent('No settings match “zzz”.');
  });

  it('Appearance switches between System, Dark and Light', async () => {
    const user = userEvent.setup();
    const { wa } = mount('#/settings/appearance', baseRoutes());
    const group = await screen.findByRole('radiogroup', { name: 'Theme' });
    expect(within(group).getByRole('radio', { name: /System/ })).toHaveAttribute('aria-checked', 'true');
    await user.click(within(group).getByRole('radio', { name: /Light/ }));
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(window.localStorage.getItem('nebula.mini.theme')).toBe('light');
    expect(within(group).getByRole('radio', { name: /Light/ })).toHaveAttribute('aria-checked', 'true');
    expect(wa?.setHeaderColor).toHaveBeenLastCalledWith('#F7F8FA');
    await user.click(within(group).getByRole('radio', { name: /System/ }));
    expect(document.documentElement.dataset.theme).toBe('dark'); // Telegram double is dark
  });

  it('logs out of the Mini App after confirmation', async () => {
    const user = userEvent.setup();
    const { calls } = mount('#/settings/account', baseRoutes({ 'POST /api/mini/logout': () => ok({ ok: true }) }));
    await user.click(await screen.findByRole('button', { name: 'Log out of the Mini App' }));
    const dialog = await screen.findByRole('dialog', { name: 'Log out of the Mini App?' });
    await user.click(within(dialog).getByRole('button', { name: 'Log out' }));
    expect(await screen.findByText('This Mini App session was ended')).toBeInTheDocument();
    await waitFor(() => expect(calls.find((c) => c.path === '/api/mini/logout')?.headers.authorization).toBe('Bearer tok-1'));
  });

  it('System status shows health and resources (read-only)', async () => {
    mount(
      '#/settings/system',
      baseRoutes({
        'GET /api/v1/resources': () =>
          ok({
            ts: 1,
            host: { memory_used_percent: 61, memory_free_percent: 39, memory_available_bytes: 6e9, memory_pressure: 'normal', cpu_percent: 12, load_avg: [1.2], disk_total_bytes: 1e12, disk_free_bytes: 4e11 },
            guest: { status: 'ok', mem_total_mb: 4096, mem_available_mb: 2048 },
            agents: [],
            queue: [],
            active_workers: 1,
            inference_inflight: { local: 0, cloud: 0 },
            limits: { profile: 'BALANCED', max_active_effective: 2 },
          }),
      }),
    );
    expect(await screen.findByText('Healthy')).toBeInTheDocument();
    expect(await screen.findByRole('meter', { name: 'Mac mini memory' })).toHaveAttribute('aria-valuenow', '61');
    expect(screen.getByRole('meter', { name: 'Ubuntu VM memory' })).toHaveAttribute('aria-valuenow', '50');
  });
});
