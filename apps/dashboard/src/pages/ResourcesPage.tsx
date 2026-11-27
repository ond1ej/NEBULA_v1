// Resource Monitor: live snapshot, history charts, profile switch with effective limits, per-agent memory, queue, alerts.
import { useMemo, useState, type ReactNode } from 'react';
import { api, request } from '../api';
import { TimeSeriesChart, type Point } from '../components/Charts';
import { IconAlert, IconChip, IconCpu, IconDisk, IconMonitor, IconQueue, IconRefresh, IconResources } from '../components/icons';
import { StatusPill, toneFor } from '../components/StatusPill';
import {
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  ErrorBanner,
  KeyValue,
  LoadingRows,
  Meter,
  Notice,
  PageHeader,
  SegmentedControl,
  Skeleton,
  Stat,
  usageTone,
  type Column,
} from '../components/ui';
import { useAction, useApi } from '../hooks/useApi';
import { useLiveRefresh, useNebulaEvents } from '../hooks/useEvents';
import { href } from '../hooks/useHashRoute';
import { formatBytes, formatDuration, formatTime, relativeTime } from '../lib/format';
import { VM_MEMORY_LABEL, vmMemoryBytes, vmMemoryMb } from '../lib/vmMemory';
import type { QueuedTask, ResourceAgent, ResourceProfile, ResourceSample } from '../types';

export const PROFILES: { id: ResourceProfile; title: string; text: string }[] = [
  { id: 'ECO', title: 'Eco', text: '1 active desktop, idle agents sleep after 5 min, 1 local + 1 cloud model call at a time.' },
  { id: 'BALANCED', title: 'Balanced', text: 'Active-desktop limit from Settings (default 2), idle sleep after 20 min, 1 local + 2 cloud model calls.' },
  { id: 'PERFORMANCE', title: 'Performance', text: 'Up to 4 desktops if the VM has the memory, idle sleep after 60 min, 1 local + 3 cloud model calls.' },
];

const RANGES = [
  { value: '3600', label: '1 h' },
  { value: '21600', label: '6 h' },
  { value: '86400', label: '24 h' },
  { value: '259200', label: '3 d' },
];

export function series(rows: ResourceSample[], key: keyof ResourceSample | ((r: ResourceSample) => number | null)): Point[] {
  if (typeof key === 'function') return rows.map((r) => ({ t: r.ts, v: key(r) }));
  return rows.map((r) => ({ t: r.ts, v: typeof r[key] === 'number' ? (r[key] as number) : null }));
}

// Stable formatters: the memoised charts only re-render when their data changes, not on every page update.
const fmtPct = (v: number) => `${Math.round(v)}%`;
const fmtInt = (v: number) => String(Math.round(v));
const NO_ROWS: ResourceSample[] = [];

interface PressureNote {
  from: string | null;
  to: string;
  freePercent: number | null;
  swapUsedMb: number | null;
  at: number;
}

interface AlertItem {
  id: string;
  ts: number;
  kind: string;
  level: string;
  message: string;
}

function ChartCard({ title, children, hint }: { title: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <Card title={title} subtitle={hint}>
      {children}
    </Card>
  );
}

export function ResourcesPage() {
  const snap = useApi(() => api.resources.snapshot(), [], { pollMs: 20_000 });
  const [range, setRange] = useState('3600');
  const hist = useApi(() => api.resources.history(Number(range)), [range], { pollMs: 60_000 });
  const { run, isPending } = useAction();
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [pressure, setPressure] = useState<PressureNote | null>(null);
  useLiveRefresh(
    snap.reload,
    (e) => e.type === 'resource.alert' || e.type === 'resource.pressure.changed' || e.type.startsWith('agent.') || e.type === 'task.queued' || e.type === 'task.started',
    1500,
  );
  useNebulaEvents((e) => {
    if (e.type === 'resource.pressure.changed') {
      const p = e.payload;
      setPressure({
        from: typeof p.from === 'string' ? p.from : null,
        to: typeof p.to === 'string' ? p.to : 'changed',
        freePercent: typeof p.free_percent === 'number' ? p.free_percent : null,
        swapUsedMb: typeof p.swap_used_mb === 'number' ? p.swap_used_mb : null,
        at: e.timestamp,
      });
      return;
    }
    if (e.type !== 'resource.alert') return;
    setAlerts((xs) => [{ id: e.id, ts: e.timestamp, kind: String(e.payload.kind ?? ''), level: String(e.payload.level ?? 'warning'), message: String(e.payload.message ?? '') }, ...xs].slice(0, 30));
  });

  const s = snap.data;
  const h = s?.host;
  const g = s?.guest;
  const lim = s?.limits;
  const rows = hist.data ?? NO_ROWS;
  const charts = useMemo(
    () => ({
      mem: series(rows, 'host_mem_used_pct'),
      cpu: series(rows, 'host_cpu_pct'),
      swap: series(rows, 'host_swap_used_mb'),
      guest: series(rows, 'guest_mem_avail_mb'),
      vm: series(rows, vmMemoryMb),
      agents: series(rows, 'active_agents'),
      queue: series(rows, 'queued_tasks'),
    }),
    [rows],
  );
  const vmMem = vmMemoryBytes(h);

  const setProfile = async (p: ResourceProfile) => {
    const r = await run('profile', () => api.resources.setProfile(p), { success: `Profile set to ${p}`, errorTitle: 'Profile not changed' });
    if (r) snap.setData((x) => (x ? { ...x, limits: r } : x));
  };

  const guestUsedPct = g?.mem_total_mb && g.mem_available_mb != null ? 100 - (g.mem_available_mb / g.mem_total_mb) * 100 : null;
  const swapPct = h?.swap_total_mb ? ((h.swap_used_mb ?? 0) / h.swap_total_mb) * 100 : null;

  const agentCols: Column<ResourceAgent>[] = [
    {
      key: 'name',
      header: 'Agent',
      mobile: 'title',
      cell: (a) => (
        <a href={href(`/agents/${a.id}`)} className="rounded font-medium text-text hover:underline focus-ring">
          {a.name}
        </a>
      ),
    },
    { key: 'status', header: 'State', mobile: 'aside', cell: (a) => <StatusPill state={a.status} /> },
    { key: 'mode', header: 'Mode', cell: (a) => <span className="text-muted">{a.resource_mode.toLowerCase()}</span> },
    {
      key: 'mem',
      header: 'Memory in VM',
      align: 'right',
      cell: (a) => <span className="tabular-nums">{a.memory_mb != null ? `${a.memory_mb} MB` : <span className="text-subtle">—</span>}</span>,
    },
    { key: 'busy', header: 'Worker', cell: (a) => (a.busy ? <Badge tone="accent" dot>running</Badge> : <span className="text-subtle">idle</span>) },
    { key: 'last', header: 'Last active', cell: (a) => <span className="text-xs text-muted">{a.last_active_at ? relativeTime(a.last_active_at) : '—'}</span> },
  ];
  const queueCols: Column<QueuedTask>[] = [
    {
      key: 'prompt',
      header: 'Task',
      mobile: 'title',
      className: 'max-w-[380px]',
      cell: (q) => (
        <a className="line-clamp-2 rounded text-text hover:underline focus-ring" href={href(`/agents/${q.agent_id}/tasks?task=${q.id}`)}>
          {q.prompt}
        </a>
      ),
    },
    { key: 'agent', header: 'Agent', mobile: 'subtitle', cell: (q) => q.agent_name },
    { key: 'prio', header: 'Priority', align: 'right', cell: (q) => <span className="tabular-nums">{q.priority}</span> },
    { key: 'src', header: 'Source', cell: (q) => q.source_channel },
    { key: 'wait', header: 'Waiting for', mobile: 'aside', cell: (q) => (q.waiting_for_resources ? <Badge tone="warn">resources</Badge> : <Badge>a worker</Badge>) },
    { key: 'age', header: 'Queued', cell: (q) => <span className="text-xs text-muted">{relativeTime(q.created_at)}</span> },
  ];

  return (
    <>
      <PageHeader
        title="Resource Monitor"
        description="This Mac mini runs the VM, the agents and local models together. NEBULA measures memory pressure and adapts how much work runs at once."
        actions={
          <Button icon={<IconRefresh />} onClick={() => { snap.reload(); hist.reload(); }} loading={snap.loading && !!s}>
            Refresh
          </Button>
        }
      />
      {pressure && (
        <div className="mb-5" data-testid="pressure-note">
          <Notice tone={/critical/i.test(pressure.to) ? 'danger' : /warn/i.test(pressure.to) ? 'warn' : 'info'} title={`Memory pressure ${pressure.from ? `${pressure.from} → ` : ''}${pressure.to}`}>
            {[
              pressure.freePercent != null ? `${Math.round(pressure.freePercent)}% memory free` : null,
              pressure.swapUsedMb != null ? `swap ${Math.round(pressure.swapUsedMb)} MB` : null,
              `at ${formatTime(pressure.at)}`,
            ]
              .filter(Boolean)
              .join(' · ')}
            . NEBULA adapts how much work runs at once; the limits below are refreshed.
          </Notice>
        </div>
      )}
      {snap.error && !s ? (
        <div className="mb-5">
          <ErrorBanner error={snap.error} onRetry={snap.reload} title="Resource snapshot unavailable" />
        </div>
      ) : null}

      {/* profile */}
      <Card title="Resource profile" icon={<IconResources />} subtitle="Profiles set the base limits; NEBULA lowers them further when the measured memory requires it.">
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="space-y-3">
            <SegmentedControl<ResourceProfile>
              label="Resource profile"
              value={(lim?.profile as ResourceProfile) ?? 'BALANCED'}
              onChange={(p) => void setProfile(p)}
              disabled={!lim || isPending('profile')}
              options={PROFILES.map((p) => ({ value: p.id, label: p.title }))}
            />
            <ul className="space-y-2">
              {PROFILES.map((p) => (
                <li key={p.id} className={`rounded-lg border px-3 py-2 text-xs ${lim?.profile === p.id ? 'border-accent/35 bg-accent/[0.06] text-text' : 'border-border text-muted'}`}>
                  <span className="font-medium">{p.title}:</span> {p.text}
                </li>
              ))}
            </ul>
          </div>
          <div>
            {!lim ? (
              <LoadingRows rows={4} />
            ) : (
              <div className="space-y-3">
                <KeyValue
                  items={[
                    [
                      'Active desktops',
                      <span key="a" className="tabular-nums">
                        {lim.max_active_effective}
                        {lim.max_active_effective !== lim.max_active && <span className="text-subtle"> (profile allows {lim.max_active})</span>}
                      </span>,
                    ],
                    ['Idle agents sleep after', formatDuration(lim.idle_sleep_s)],
                    ['Local model calls at once', String(lim.local_inference)],
                    ['Cloud model calls at once', String(lim.cloud_inference)],
                    ...(lim.host_tasks_effective != null ? ([['Mac mini tasks at once', String(lim.host_tasks_effective)]] as [string, string][]) : []),
                    ...(lim.memory
                      ? ([
                          [
                            'Memory (measured)',
                            [
                              `pressure ${lim.memory.pressure}`,
                              lim.memory.free_percent != null ? `${Math.round(lim.memory.free_percent)}% free` : null,
                              lim.memory.swap_growth_mb_2min != null ? `swap ${lim.memory.swap_growth_mb_2min >= 0 ? '+' : ''}${Math.round(lim.memory.swap_growth_mb_2min)} MB in 2 min` : null,
                            ]
                              .filter(Boolean)
                              .join(' · '),
                          ],
                        ] as [string, string][])
                      : []),
                    ['Desktop cost (measured)', `≈ ${lim.desktop_cost_mb} MB per active agent`],
                    ['In flight now', `${s?.inference_inflight.local ?? 0} local · ${s?.inference_inflight.cloud ?? 0} cloud`],
                  ]}
                />
                {lim.constraints.length > 0 ? (
                  <Notice tone="warn" title="Limits lowered right now">
                    <ul className="list-inside list-disc">
                      {lim.constraints.map((c) => (
                        <li key={c}>{c}</li>
                      ))}
                    </ul>
                  </Notice>
                ) : (
                  <p className="text-xs text-muted">No constraint applies: the effective limits equal the profile’s.</p>
                )}
                <p className="text-xs text-subtle">Local inference is always one at a time (two local models would push a 16 GB Mac into swap). The VM size is never changed automatically.</p>
              </div>
            )}
          </div>
        </div>
      </Card>

      {/* snapshot */}
      <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {!s ? (
          Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-[104px] rounded-xl" />)
        ) : (
          <>
            <Stat
              label="Mac memory"
              icon={<IconChip />}
              tone={toneFor(h?.memory_pressure)}
              value={h?.memory_used_percent != null ? `${Math.round(h.memory_used_percent)}%` : '—'}
              hint={`Pressure ${h?.memory_pressure ?? '—'} · ${formatBytes(h?.memory_available_bytes)} free`}
            />
            <Stat label="Mac CPU" icon={<IconCpu />} value={h?.cpu_percent != null ? `${Math.round(h.cpu_percent)}%` : '—'} hint={`Load ${h?.load_avg?.map((x) => x.toFixed(1)).join(' / ') ?? '—'}`} />
            <Stat label="Swap" icon={<IconDisk />} tone={(h?.swap_used_mb ?? 0) > 3072 ? 'warn' : undefined} value={h?.swap_used_mb != null ? `${Math.round(h.swap_used_mb)} MB` : '—'} hint={h?.swap_total_mb ? `of ${Math.round(h.swap_total_mb)} MB` : 'not reported'} />
            <Stat
              label="VM memory free"
              icon={<IconMonitor />}
              tone={g?.status !== 'ok' ? 'danger' : (g?.mem_available_mb ?? 9999) < 400 ? 'warn' : undefined}
              value={g?.status === 'ok' ? `${g.mem_available_mb ?? '—'} MB` : g?.status ?? '—'}
              hint={g?.status === 'ok' ? `of ${g.mem_total_mb} MB · ${VM_MEMORY_LABEL} ${formatBytes(vmMem)}` : g?.detail ?? 'Guest unavailable'}
            />
            <Stat label="Workers" icon={<IconResources />} value={`${s.active_workers}/${lim?.max_active_effective ?? '—'}`} hint="running / allowed" />
            <Stat label="Queue" icon={<IconQueue />} tone={s.queue.some((q) => q.waiting_for_resources) ? 'warn' : undefined} value={s.queue.length} hint={`${s.queue.filter((q) => q.waiting_for_resources).length} waiting for resources`} />
          </>
        )}
      </div>
      {s && (
        <div className="mt-3 grid gap-3 md:grid-cols-3">
          <UsageBar label="Mac memory used" value={h?.memory_used_percent ?? null} />
          <UsageBar label="VM memory used" value={guestUsedPct} />
          <UsageBar label="Swap used" value={swapPct} warn={30} danger={60} />
        </div>
      )}
      {s && <p className="mt-2 text-2xs text-subtle">Snapshot taken {formatTime(s.ts)} · disk free {h?.disk_free_gb != null ? `${h.disk_free_gb} GB` : '—'} · samples every 20 s.</p>}

      {/* history */}
      <div className="mt-8 mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-text">History</h2>
        <SegmentedControl label="History range" value={range} onChange={setRange} options={RANGES} size="sm" />
      </div>
      {hist.error && !hist.data ? <ErrorBanner error={hist.error} onRetry={hist.reload} title="History unavailable" /> : null}
      {!hist.data && hist.loading ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-[250px] rounded-xl" />
          ))}
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <ChartCard title="Mac memory used (%)">
            <TimeSeriesChart data={charts.mem} label="Mac memory used" yMin={0} yMax={100} format={fmtPct} />
          </ChartCard>
          <ChartCard title="Mac CPU (%)" hint="Sum of process CPU normalised to all cores">
            <TimeSeriesChart data={charts.cpu} label="Mac CPU" yMin={0} yMax={100} format={fmtPct} />
          </ChartCard>
          <ChartCard title="Swap used (MB)">
            <TimeSeriesChart data={charts.swap} label="Swap used" yMin={0} format={fmtInt} />
          </ChartCard>
          <ChartCard title="VM memory available (MB)">
            <TimeSeriesChart data={charts.guest} label="VM memory available" yMin={0} format={fmtInt} />
          </ChartCard>
          <ChartCard title={`${VM_MEMORY_LABEL} on the Mac (MB)`} hint="Older samples show the VM process RSS">
            <TimeSeriesChart data={charts.vm} label={VM_MEMORY_LABEL} yMin={0} format={fmtInt} />
          </ChartCard>
          <ChartCard title="Active agents">
            <TimeSeriesChart data={charts.agents} label="Active agents" yMin={0} format={fmtInt} />
          </ChartCard>
          <ChartCard title="Queued tasks">
            <TimeSeriesChart data={charts.queue} label="Queued tasks" yMin={0} format={fmtInt} />
          </ChartCard>
        </div>
      )}

      {/* agents & queue */}
      <div className="mt-8 grid gap-5 xl:grid-cols-2">
        <section className="min-w-0">
          <h2 className="mb-3 text-sm font-semibold text-text">Memory per agent</h2>
          {!s ? (
            <Skeleton className="h-40 rounded-xl" />
          ) : s.agents.length === 0 ? (
            <EmptyState compact title="No agents" />
          ) : (
            <DataTable label="Memory per agent" columns={agentCols} rows={[...s.agents].sort((a, b) => (b.memory_mb ?? -1) - (a.memory_mb ?? -1))} rowKey={(a) => a.id} minWidth={600} dense />
          )}
          {s && g?.status !== 'ok' && <p className="mt-2 text-xs text-muted">Per-agent memory needs the VM; it shows “—” while the guest is unavailable.</p>}
        </section>
        <section className="min-w-0">
          <h2 className="mb-3 text-sm font-semibold text-text">Task queue</h2>
          {!s ? (
            <Skeleton className="h-40 rounded-xl" />
          ) : s.queue.length === 0 ? (
            <EmptyState compact title="Queue is empty">Interactive tasks run before scheduled ones when they have to wait.</EmptyState>
          ) : (
            <DataTable label="Task queue" columns={queueCols} rows={s.queue} rowKey={(q) => q.id} minWidth={640} dense />
          )}
        </section>
      </div>

      <V3MonitorSection />

      {/* alerts */}
      <section className="mt-8">
        <h2 className="mb-3 text-sm font-semibold text-text">Alerts</h2>
        {alerts.length === 0 ? (
          <p className="text-sm text-muted">No resource alert since this page was opened. Alerts (memory pressure, swap above 3 GB, low disk, VM not responding) also appear as notifications everywhere in the dashboard.</p>
        ) : (
          <ul className="space-y-2">
            {alerts.map((a) => (
              <li key={a.id} className={`flex items-start gap-3 rounded-xl border px-4 py-3 ${a.level === 'critical' ? 'border-danger/30 bg-danger/[0.06]' : 'border-warn/30 bg-warn/[0.05]'}`}>
                <IconAlert className={`mt-0.5 size-4 shrink-0 ${a.level === 'critical' ? 'text-danger' : 'text-warn'}`} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-text">{a.message}</p>
                  <p className="text-2xs text-subtle">
                    {a.level} · {a.kind.replace(/_/g, ' ')} · {formatTime(a.ts)}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function UsageBar({ label, value, warn = 75, danger = 90 }: { label: string; value: number | null; warn?: number; danger?: number }) {
  return (
    <div className="rounded-xl border border-border bg-panel px-4 py-3">
      <div className="mb-2 flex items-baseline justify-between text-xs">
        <span className="text-muted">{label}</span>
        <span className="text-text tabular-nums">{value != null ? `${Math.round(value)}%` : '—'}</span>
      </div>
      <Meter value={value ?? 0} label={label} tone={usageTone(value, warn, danger)} size="sm" />
    </div>
  );
}

// ---------------------------------------------------------------- V3 monitoring (GET /monitor)
export interface MonitorData {
  active_agents: number;
  workers: { vm: number; host: number };
  task_queue: Record<string, number>;
  bots: { main_polling: boolean; bots: number; polling: number; errors: number };
  desktop_streams: number;
  voice_jobs: { running: number; done: number; failed: number };
  company_workloads: Record<string, Record<string, number>>;
  host_exec: { sandbox: boolean; running_commands: number; background_processes: number; roots: number } | null;
  failed_last_24h: { tasks: number; host_commands: number };
  remote: { listening: boolean; public: boolean };
}

const QUEUE_ORDER = ['RECEIVED', 'QUEUED', 'PLANNING', 'EXECUTING', 'VERIFYING', 'WAITING_APPROVAL', 'WAITING_PROVIDER', 'WAITING_CONTROL', 'PAUSING', 'PAUSED'];

function MiniBar({ label, value, max, tone = 'accent' }: { label: string; value: number; max: number; tone?: 'accent' | 'warn' | 'info' }) {
  return (
    <li className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)_2.5rem] items-center gap-3 text-xs">
      <span className="truncate text-muted" title={label}>
        {label}
      </span>
      <Meter value={max ? (value / max) * 100 : 0} label={`${label}: ${value}`} tone={tone} size="sm" />
      <span className="text-right text-text tabular-nums">{value}</span>
    </li>
  );
}

export function V3MonitorSection() {
  const mon = useApi(() => request<MonitorData>('/monitor'), [], { pollMs: 15_000 });
  const companies = useApi(() => request<{ id: string; name: string }[]>('/companies').catch(() => [] as { id: string; name: string }[]), []);
  useLiveRefresh(
    mon.reload,
    (e) => e.type === 'bot.state.changed' || e.type === 'remote.state.changed' || e.type.startsWith('company.run.') || ['task.queued', 'task.started', 'task.completed', 'task.failed', 'task.cancelled', 'live.viewer.joined', 'live.viewer.left'].includes(e.type),
    1500,
  );
  const m = mon.data;
  const names = new Map((companies.data ?? []).map((c) => [c.id, c.name] as const));
  const queue = m ? Object.entries(m.task_queue).sort(([a], [b]) => (QUEUE_ORDER.indexOf(a) + 1 || 99) - (QUEUE_ORDER.indexOf(b) + 1 || 99)) : [];
  const queueMax = Math.max(1, ...queue.map(([, n]) => n));
  const workloads = m ? Object.entries(m.company_workloads) : [];

  return (
    <section className="mt-8" aria-labelledby="v3-monitor-h">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 id="v3-monitor-h" className="text-sm font-semibold text-text">
            Operations
          </h2>
          <p className="mt-0.5 text-xs text-muted">Bots, desktop streams, voice, companies, workers and the remote gateway.</p>
        </div>
        {m && (
          <Button size="sm" variant="ghost" icon={<IconRefresh />} onClick={mon.reload} loading={mon.loading}>
            Refresh
          </Button>
        )}
      </div>
      {mon.error && !m ? (
        <ErrorBanner error={mon.error} onRetry={mon.reload} title="Operations data unavailable" />
      ) : !m ? (
        <LoadingRows rows={4} label="Loading operations…" />
      ) : (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <Stat
              label="Telegram bots"
              value={`${m.bots.polling}/${m.bots.bots}`}
              hint={`polling · main ${m.bots.main_polling ? 'polling' : 'idle'}`}
              tone={m.bots.errors ? 'danger' : m.bots.main_polling ? 'success' : 'warn'}
              href={href('/bots')}
            />
            <Stat label="Bot errors" value={m.bots.errors} hint="ERROR or REVOKED agent bots" tone={m.bots.errors ? 'danger' : undefined} href={href('/bots')} />
            <Stat label="Desktop streams" value={m.desktop_streams} hint="Live Desktop viewers" icon={<IconMonitor />} />
            <Stat label="Voice jobs" value={m.voice_jobs.running} hint={`${m.voice_jobs.done} done · ${m.voice_jobs.failed} failed`} tone={m.voice_jobs.failed ? 'warn' : undefined} href={href('/voice')} />
            <Stat
              label="Failed (24 h)"
              value={m.failed_last_24h.tasks + m.failed_last_24h.host_commands}
              hint={`${m.failed_last_24h.tasks} tasks · ${m.failed_last_24h.host_commands} host commands`}
              tone={m.failed_last_24h.tasks + m.failed_last_24h.host_commands ? 'danger' : undefined}
              icon={<IconAlert />}
            />
            <Stat
              label="Remote gateway"
              value={<span className="text-lg">{m.remote.listening ? (m.remote.public ? 'Public' : 'Local') : 'Off'}</span>}
              hint={m.remote.listening ? (m.remote.public ? 'Reachable via HTTPS tunnel' : 'Listening on loopback') : 'Mini App gateway disabled'}
              tone={m.remote.public ? 'warn' : m.remote.listening ? 'success' : undefined}
              href={href('/remote')}
            />
          </div>

          <div className="grid gap-5 lg:grid-cols-3">
            <Card title="Workers" subtitle="Where tasks execute right now" icon={<IconChip />}>
              <KeyValue
                items={[
                  ['Ubuntu VM', <span key="vm" className="tabular-nums">{m.workers.vm} running</span>],
                  ['Mac (host)', <span key="h" className="tabular-nums">{m.workers.host} running</span>],
                  ['Active agents', <span key="a" className="tabular-nums">{m.active_agents}</span>],
                  ...(m.host_exec
                    ? ([
                        ['Host commands', <span key="c" className="tabular-nums">{m.host_exec.running_commands} running · {m.host_exec.background_processes} background</span>],
                        ['Authorised folders', <span key="r" className="tabular-nums">{m.host_exec.roots}</span>],
                        ['Sandbox', m.host_exec.sandbox ? <Badge key="s" tone="success">available</Badge> : <Badge key="s" tone="warn">unavailable</Badge>],
                      ] as [ReactNode, ReactNode][])
                    : []),
                ]}
              />
            </Card>
            <Card title="Task queue by state" subtitle="Unfinished tasks" icon={<IconQueue />}>
              {queue.length === 0 ? (
                <p className="text-sm text-muted">No unfinished task.</p>
              ) : (
                <ul className="space-y-2" aria-label="Unfinished tasks by state">
                  {queue.map(([state, n]) => (
                    <MiniBar key={state} label={state} value={n} max={queueMax} tone={state.startsWith('WAITING') || state === 'PAUSED' ? 'warn' : state === 'QUEUED' || state === 'RECEIVED' ? 'info' : 'accent'} />
                  ))}
                </ul>
              )}
            </Card>
            <Card title="Company workloads" subtitle="Open work items per company" icon={<IconResources />}>
              {workloads.length === 0 ? (
                <p className="text-sm text-muted">No company has open work items.</p>
              ) : (
                <ul className="space-y-3">
                  {workloads.map(([cid, states]) => {
                    const total = Object.values(states).reduce((a, b) => a + b, 0);
                    return (
                      <li key={cid} className="min-w-0">
                        <p className="flex items-baseline justify-between gap-2 text-sm">
                          <a href={href(`/companies/${cid}`)} className="truncate rounded text-text hover:underline focus-ring">
                            {names.get(cid) ?? cid.slice(0, 8)}
                          </a>
                          <span className="shrink-0 text-xs text-muted tabular-nums">{total} open</span>
                        </p>
                        <div className="mt-1 flex flex-wrap gap-1.5">
                          {Object.entries(states).map(([st, n]) => (
                            <Badge key={st} tone={st === 'FAILED' || st === 'BLOCKED' ? 'danger' : st.startsWith('WAIT') || st === 'AWAITING_APPROVAL' ? 'warn' : 'neutral'}>
                              {st.toLowerCase().replace(/_/g, ' ')} {n}
                            </Badge>
                          ))}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>
          </div>
        </div>
      )}
    </section>
  );
}
