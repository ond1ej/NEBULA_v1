import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setCsrfToken } from '../api';
import { ToastProvider } from '../components/Toast';
import { installFetch, ok } from '../test/fetchMock';
import { bodyFromForm, defaultForm, monthGrid, ScheduleEditor, specFromForm } from './SchedulesPage';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setCsrfToken(null);
});

describe('schedule form → API spec', () => {
  it('builds the spec of every kind', () => {
    const f = defaultForm();
    expect(specFromForm({ ...f, kind: 'daily', time: '07:45' })).toEqual({ time: '07:45' });
    expect(specFromForm({ ...f, kind: 'weekly', time: '08:30', weekdays: [5, 1] })).toEqual({ time: '08:30', weekdays: [1, 5] });
    expect(specFromForm({ ...f, kind: 'weekly', weekdays: [] })).toBeNull();
    expect(specFromForm({ ...f, kind: 'monthly', time: '06:00', day: '31' })).toEqual({ time: '06:00', day: 31 });
    expect(specFromForm({ ...f, kind: 'monthly', day: '32' })).toBeNull();
    expect(specFromForm({ ...f, kind: 'interval', everyN: '90', everyUnit: 'minutes' })).toEqual({ every_s: 5400 });
    expect(specFromForm({ ...f, kind: 'interval', everyN: '2', everyUnit: 'hours' }, { start_at: 100 })).toEqual({ every_s: 7200, start_at: 100 });
    expect(specFromForm({ ...f, kind: 'cron', cron: ' 0 7 * * 1 ' })).toEqual({ cron: '0 7 * * 1' });
    expect(specFromForm({ ...f, kind: 'once', onceDate: '2026-12-24', onceTime: '18:00', timezone: 'Europe/Prague' })).toEqual({ at: Date.UTC(2026, 11, 24, 17) / 1000 });
  });

  it('converts minutes to the seconds the host expects', () => {
    const b = bodyFromForm({ ...defaultForm(), name: ' N ', target_id: 'a1', prompt: ' p ', retry_delay_min: '5', max_runtime_min: '30' }, { time: '09:00' });
    expect(b).toMatchObject({ name: 'N', prompt: 'p', retry_delay_s: 300, max_runtime_s: 1800, timezone: 'Europe/Prague', notify: { telegram: false } });
  });

  it('builds Monday-first month grids', () => {
    const g = monthGrid(2026, 10); // November 2026 starts on a Sunday
    expect(g[0].getDay()).toBe(1);
    expect(g.length % 7).toBe(0);
    expect(g.some((d) => d.getMonth() === 10 && d.getDate() === 30)).toBe(true);
  });
});

describe('ScheduleEditor', () => {
  it('previews the next runs through the host and creates the schedule', async () => {
    setCsrfToken('c');
    const user = userEvent.setup();
    const { calls } = installFetch({
      'GET /api/v1/agents': () => ok([{ id: 'a1', name: 'Researcher', state: 'READY' }]),
      'GET /api/v1/teams': () => ok([]),
      'GET /api/v1/workflows': () => ok([]),
      'POST /api/v1/schedules/preview': () => ok({ next: [2000000000, 2000086400] }),
      'POST /api/v1/schedules': (c) => ok({ id: 's1', ...(c.body as object) }, 201),
    });
    const onSaved = vi.fn();
    render(
      <ToastProvider>
        <ScheduleEditor schedule={null} onClose={() => {}} onSaved={onSaved} />
      </ToastProvider>,
    );
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/^Name/), 'Morning brief');
    await waitFor(() => expect(within(dialog).getByRole('option', { name: 'Researcher' })).toBeInTheDocument());
    await user.selectOptions(within(dialog).getByLabelText(/^Agent/), 'a1');
    await user.type(within(dialog).getByLabelText(/^Prompt/), 'Summarise the news');
    await user.click(within(dialog).getByRole('radio', { name: 'Weekly' }));
    await waitFor(() => expect(calls.some((c) => c.path === '/api/v1/schedules/preview' && (c.body as { kind: string }).kind === 'weekly')).toBe(true), { timeout: 2000 });
    const preview = calls.filter((c) => c.path === '/api/v1/schedules/preview').at(-1);
    expect(preview?.body).toMatchObject({ kind: 'weekly', timezone: 'Europe/Prague', spec: { time: '09:00', weekdays: [1, 2, 3, 4, 5] } });
    await user.click(within(dialog).getByRole('button', { name: 'Create schedule' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const created = calls.find((c) => c.method === 'POST' && c.path === '/api/v1/schedules');
    expect(created?.body).toMatchObject({ name: 'Morning brief', target_type: 'agent', target_id: 'a1', kind: 'weekly', misfire_policy: 'run_once', overlap_policy: 'skip' });
    expect(created?.headers['x-csrf-token']).toBe('c');
  });
});
