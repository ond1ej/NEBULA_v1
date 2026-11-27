import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setCsrfToken } from '../api';
import { ToastProvider } from '../components/Toast';
import { EventHub, EventsProvider } from '../hooks/useEvents';
import { vmMemoryMb } from '../lib/vmMemory';
import { installFetch, ok } from '../test/fetchMock';
import { ResourcesPage, series } from './ResourcesPage';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setCsrfToken(null);
});

const limits = { profile: 'BALANCED', max_active: 2, idle_sleep_s: 1200, local_inference: 1, cloud_inference: 2, max_active_effective: 1, constraints: ['host memory pressure: warning'], desktop_cost_mb: 750 };
const snapshot = {
  ts: 1,
  host: { memory_total_bytes: 16e9, memory_available_bytes: 4e9, memory_free_percent: 25, memory_pressure: 'warning', load_avg: [1, 1, 1], cpu_count: 10, disk_total_bytes: 1, disk_free_bytes: 1, vm_resident_bytes: 1, os: 'macOS', arch: 'arm64', app_version: '2', cpu_percent: 12, swap_used_mb: 100, swap_total_mb: 1024, disk_free_gb: 100, memory_used_percent: 75 },
  guest: { status: 'ok', mem_total_mb: 4000, mem_available_mb: 1500 },
  agents: [{ id: 'a1', name: 'Researcher', status: 'ACTIVE', last_active_at: 1, resource_mode: 'ACTIVE', memory_mb: 812, units: null, busy: true }],
  queue: [],
  active_workers: 1,
  inference_inflight: { local: 0, cloud: 1 },
  limits,
};

const monitor = {
  active_agents: 2,
  workers: { vm: 1, host: 1 },
  task_queue: { QUEUED: 3, EXECUTING: 1, WAITING_APPROVAL: 1 },
  bots: { main_polling: true, bots: 3, polling: 2, errors: 1 },
  desktop_streams: 2,
  voice_jobs: { running: 1, done: 7, failed: 2 },
  company_workloads: { c1: { IN_PROGRESS: 2, BLOCKED: 1 } },
  host_exec: { sandbox: true, running_commands: 1, background_processes: 0, roots: 2 },
  failed_last_24h: { tasks: 2, host_commands: 1 },
  remote: { listening: true, public: false },
};

describe('ResourcesPage', () => {
  it('maps history rows to chart series (missing values stay gaps)', () => {
    expect(series([{ ts: 1, host_cpu_pct: 5 } as never, { ts: 2, host_cpu_pct: null } as never], 'host_cpu_pct')).toEqual([
      { t: 1, v: 5 },
      { t: 2, v: null },
    ]);
  });

  it('shows effective limits with their constraint and switches the profile', async () => {
    setCsrfToken('c');
    const user = userEvent.setup();
    const { calls } = installFetch({
      'GET /api/v1/resources': () => ok(snapshot),
      'GET /api/v1/resources/history': () => ok([]),
      'POST /api/v1/resources/profile': (c) => ok({ ...limits, profile: (c.body as { profile: string }).profile }),
      'GET /api/v1/monitor': () => ok(monitor),
      'GET /api/v1/companies': () => ok([]),
    });
    render(
      <ToastProvider>
        <ResourcesPage />
      </ToastProvider>,
    );
    expect(await screen.findByText('host memory pressure: warning')).toBeInTheDocument();
    expect(screen.getByText('(profile allows 2)')).toBeInTheDocument();
    expect(screen.getByText('812 MB')).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'Eco' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ profile: 'ECO' }));
    expect(calls.find((c) => c.path === '/api/v1/resources/history')?.url).toBe('/api/v1/resources/history?range_s=3600');
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Eco' })).toHaveAttribute('aria-checked', 'true'));
  });

  it('shows the V3 operations section from /monitor', async () => {
    installFetch({
      'GET /api/v1/resources': () => ok(snapshot),
      'GET /api/v1/resources/history': () => ok([]),
      'GET /api/v1/monitor': () => ok(monitor),
      'GET /api/v1/companies': () => ok([{ id: 'c1', name: 'Acme Studio' }]),
    });
    render(
      <ToastProvider>
        <ResourcesPage />
      </ToastProvider>,
    );
    expect(await screen.findByRole('heading', { name: 'Operations' })).toBeInTheDocument();
    expect(await screen.findByText('2/3')).toBeInTheDocument();
    expect(screen.getByText('polling · main polling')).toBeInTheDocument();
    expect(screen.getByText('7 done · 2 failed')).toBeInTheDocument();
    expect(screen.getByText('2 tasks · 1 host commands')).toBeInTheDocument();
    expect(screen.getByText('Listening on loopback')).toBeInTheDocument();
    expect(screen.getAllByText('1 running')).toHaveLength(2); // VM and Mac workers
    expect(screen.getByRole('list', { name: 'Unfinished tasks by state' })).toHaveTextContent('WAITING_APPROVAL');
    expect(await screen.findByText('Acme Studio')).toBeInTheDocument();
    expect(screen.getByText('blocked 1')).toBeInTheDocument();
  });

  it('prefers the VM footprint over RSS, shows host task limits and memory, and follows memory pressure events', async () => {
    const snap = {
      ...snapshot,
      host: { ...snapshot.host, vm_resident_bytes: 300 * 1024 * 1024, vm_footprint_bytes: 3 * 1024 * 1024 * 1024 },
      limits: { ...limits, host_tasks_effective: 2, memory: { pressure: 'warn', free_percent: 18.4, swap_growth_mb_2min: 120 } },
    };
    const { calls } = installFetch({
      'GET /api/v1/resources': () => ok(snap),
      'GET /api/v1/resources/history': () => ok([]),
      'GET /api/v1/monitor': () => ok(monitor),
      'GET /api/v1/companies': () => ok([]),
    });
    const hub = new EventHub();
    render(
      <ToastProvider>
        <EventsProvider hub={hub}>
          <ResourcesPage />
        </EventsProvider>
      </ToastProvider>,
    );
    expect(await screen.findByText(/VM memory \(footprint\) 3(\.0)? GB/)).toBeInTheDocument();
    expect(screen.getByText('Mac mini tasks at once')).toBeInTheDocument();
    expect(screen.getByText('pressure warn · 18% free · swap +120 MB in 2 min')).toBeInTheDocument();
    const before = calls.filter((c) => c.path === '/api/v1/resources').length;
    act(() =>
      hub.handle(
        new MessageEvent('resource.pressure.changed', {
          data: JSON.stringify({ id: 'e1', sequence: 1, type: 'resource.pressure.changed', agent_id: null, task_id: null, timestamp: 1_700_000_000, payload: { from: 'normal', to: 'warn', free_percent: 18, swap_used_mb: 900 } }),
        }),
      ),
    );
    expect(screen.getByTestId('pressure-note')).toHaveTextContent('Memory pressure normal → warn');
    expect(screen.getByTestId('pressure-note')).toHaveTextContent('18% memory free · swap 900 MB');
    await waitFor(() => expect(calls.filter((c) => c.path === '/api/v1/resources').length).toBe(before + 1), { timeout: 3000 });
    // history: footprint, falling back to RSS for older rows
    expect(vmMemoryMb({ vm_footprint_mb: 3100, vm_rss_mb: 290 })).toBe(3100);
    expect(vmMemoryMb({ vm_footprint_mb: null, vm_rss_mb: 290 })).toBe(290);
  });
});
