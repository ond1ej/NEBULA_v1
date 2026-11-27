import { useEffect, useId, useRef, useState } from 'react';
import { api } from '../api';
import { ConfirmDialog } from '../components/Modal';
import { StatusPill } from '../components/StatusPill';
import { useToast } from '../components/Toast';
import { IconCpu, IconMonitor, IconRefresh, IconSettings, IconShield, IconSystem } from '../components/icons';
import { Button, Card, DataTable, ErrorBanner, KeyValue, LoadingRows, Meter, Mono, Notice, PageHeader, Select, Spinner, usageTone } from '../components/ui';
import { useAction, useApi, useNow } from '../hooks/useApi';
import { useHealth } from '../hooks/useHealth';
import { useLiveRefresh, useNebulaEvents } from '../hooks/useEvents';
import { downloadBlob, formatBytes, formatDuration, formatTime, percent, shortId } from '../lib/format';
import { VM_MEMORY_LABEL, vmMemoryBytes } from '../lib/vmMemory';
import type { InstallJob, PreflightReport } from '../types';

const LOGS = [
  { id: 'host', label: 'Host service' },
  { id: 'vm-helper', label: 'VM helper' },
  { id: 'guest-provision', label: 'Guest provisioning' },
];

function jobFailed(j: InstallJob): boolean {
  return j.state === 'FAILED' || j.steps.some((s) => s.status === 'failed');
}

function RepairJob({ jobId, onDone }: { jobId: string; onDone: () => void }) {
  const toast = useToast();
  const [job, setJob] = useState<InstallJob | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [watching, setWatching] = useState(true);
  const started = useRef(Date.now());
  const now = useNow(1000);
  const finishedRef = useRef(false);

  useEffect(() => {
    if (!watching) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const j = await api.system.job(jobId);
        if (cancelled) return;
        setJob(j);
        setError(null);
        const terminal = j.state !== 'RUNNING' || jobFailed(j);
        if (terminal) {
          if (!finishedRef.current) {
            finishedRef.current = true;
            if (jobFailed(j)) toast.error(new Error(j.error ?? j.steps.find((s) => s.status === 'failed')?.detail ?? 'repair failed'), 'Repair failed');
            else toast.success('Repair finished', 'Guest provisioning re-applied and health-check passed.');
            onDone();
          }
          return;
        }
      } catch (e) {
        if (cancelled) return;
        setError(e);
      }
      timer = setTimeout(poll, 1500);
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [jobId, watching, toast, onDone]);

  // faster updates from the event bus
  useNebulaEvents((ev) => {
    if (ev.type === 'install.progress' && ev.payload.job_id === jobId && watching) {
      api.system.job(jobId).then(setJob, (e: unknown) => setError(e));
    }
  });

  const failed = job ? jobFailed(job) : false;
  const done = job ? job.state === 'SUCCEEDED' : false;
  return (
    <div className="mt-4 rounded-xl border border-border bg-input/60 p-4" aria-live="polite">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-sm text-text">
          Repair job <Mono>{shortId(jobId)}</Mono>
          {job ? <StatusPill state={failed ? 'FAILED' : job.state} pulse={!failed && !done} /> : <Spinner />}
        </p>
        <span className="text-xs text-muted">elapsed {formatDuration((now - started.current) / 1000)}</span>
      </div>
      {error ? <div className="mt-2"><ErrorBanner error={error} title="Could not read job status" /></div> : null}
      {job && (
        <ol className="mt-3 space-y-1.5">
          {job.steps.map((s, i) => (
            <li key={`${s.state}-${i}`} className="flex flex-wrap items-start gap-2 text-sm">
              <StatusPill state={s.status} tone={s.status === 'running' ? 'info' : undefined} pulse={s.status === 'running'} />
              <Mono className="text-text">{s.state}</Mono>
              <span className="min-w-0 flex-1 break-words text-muted">{s.detail}</span>
              <span className="text-xs text-subtle">{formatTime(s.updated_at)}</span>
            </li>
          ))}
          {job.steps.length === 0 && <li className="text-sm text-muted">Waiting for the first step…</li>}
        </ol>
      )}
      {job?.error && <p className="mt-2 text-sm text-danger">{job.error}</p>}
      {failed && job?.state === 'RUNNING' && (
        <p className="mt-2 text-xs text-warn">A step failed but the job record was not finalised by the host; see the Guest provisioning log.</p>
      )}
      {!failed && !done && (
        <Button className="mt-3" size="sm" variant="ghost" onClick={() => setWatching(false)} disabled={!watching}>
          {watching ? 'Stop watching' : 'Not watching (job keeps running)'}
        </Button>
      )}
    </div>
  );
}

function LogsViewer() {
  const id = useId();
  const linesId = useId();
  const [name, setName] = useState('host');
  const [lines, setLines] = useState(300);
  const logs = useApi(() => api.system.logs(name, lines), [name, lines]);
  const pre = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (pre.current) pre.current.scrollTop = pre.current.scrollHeight;
  }, [logs.data]);
  return (
    <Card
      title="Logs"
      subtitle="Secrets are redacted by the host before they are returned."
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={id} className="sr-only">Log file</label>
          <Select id={id} value={name} onChange={(e) => setName(e.target.value)} className="!h-8 w-44 text-xs">
            {LOGS.map((l) => (
              <option key={l.id} value={l.id}>{l.label}</option>
            ))}
          </Select>
          <label htmlFor={linesId} className="sr-only">Lines</label>
          <Select id={linesId} value={lines} onChange={(e) => setLines(Number(e.target.value))} className="!h-8 w-28 text-xs">
            {[100, 300, 1000, 2000].map((n) => (
              <option key={n} value={n}>{n} lines</option>
            ))}
          </Select>
          <Button size="sm" onClick={logs.reload} loading={logs.loading}>Refresh</Button>
        </div>
      }
    >
      {logs.error ? <ErrorBanner error={logs.error} onRetry={logs.reload} /> : null}
      <pre ref={pre} className="max-h-[420px] min-h-[160px] overflow-auto rounded-lg border border-border bg-input p-3 font-mono text-2xs leading-relaxed text-muted" tabIndex={0} aria-label={`${name} log`}>
        {logs.data ? (logs.data.lines.length ? logs.data.lines.join('\n') : 'This log file is empty or does not exist yet.') : 'Loading…'}
      </pre>
    </Card>
  );
}

export function SystemPage() {
  const toast = useToast();
  const { health } = useHealth();
  const sys = useApi(() => api.system.info(), [], { pollMs: 10_000 });
  const sessions = useApi(() => api.live.sessions(), []);
  const auditLog = useApi(() => api.audit(200), []);
  const { run, isPending } = useAction();
  const [confirm, setConfirm] = useState<null | 'stop' | 'restart' | 'repair'>(null);
  const [repairJob, setRepairJob] = useState<string | null>(null);
  const [preflight, setPreflight] = useState<PreflightReport | null>(null);
  const [backup, setBackup] = useState<{ path: string; size_bytes: number; note: string } | null>(null);

  useLiveRefresh(sys.reload, (e) => e.type === 'vm.state.changed' || e.type.startsWith('live.'), 500);
  useLiveRefresh(sessions.reload, (e) => e.type.startsWith('live.'), 500);

  const s = sys.data;
  const host = s?.host;
  const memUsed = host ? host.memory_total_bytes - host.memory_available_bytes : 0;
  const vmState = s?.vm.state ?? health?.vm.state ?? null;
  const vmRunning = vmState === 'running';

  const guestExtra = s
    ? Object.entries(s.guest).filter(([k]) => !['status', 'latency_ms', 'detail'].includes(k))
    : [];

  return (
    <>
      <PageHeader title="System" description="Host and guest health, versions, the shared VM, maintenance, logs and the audit trail." />
      {sys.error && !s ? <div className="mb-4"><ErrorBanner error={sys.error} onRetry={sys.reload} /></div> : null}

      <div className="grid gap-5 lg:grid-cols-2">
        <Card
          icon={<IconMonitor />}
          title={<span className="flex items-center gap-2">Virtual machine <StatusPill state={vmState ?? 'unknown'} /></span>}
          actions={
            <>
              <Button
                size="sm"
                variant="primary"
                loading={isPending('start')}
                disabledReason={
                  vmRunning ? 'VM is already running' : vmState === 'not_created' ? 'The VM has not been created yet — run the installer (nebula install)' : null
                }
                onClick={async () => {
                  const r = await run('start', () => api.system.vmStart(), { success: (st) => `VM ${String(st.state ?? 'started')}` });
                  if (r) sys.reload();
                }}
              >
                Start VM
              </Button>
              <Button size="sm" variant="danger" onClick={() => setConfirm('stop')} disabledReason={!vmRunning ? 'VM is not running' : null}>
                Stop VM
              </Button>
            </>
          }
        >
          {s ? (
            <KeyValue
              items={[
                ['State', vmState ?? '—'],
                ...(s.vm.message ? ([['Detail', String(s.vm.message)]] as [string, string][]) : []),
                ...Object.entries(s.vm)
                  .filter(([k]) => !['state', 'message', 'error'].includes(k))
                  .slice(0, 8)
                  .map(([k, v]) => [k.replace(/_/g, ' '), typeof v === 'object' ? JSON.stringify(v) : String(v)] as [string, string]),
                [VM_MEMORY_LABEL, formatBytes(vmMemoryBytes(host))],
                ['Guest', <span key="g" className="inline-flex items-center gap-2"><StatusPill state={s.guest.status} />{s.guest.latency_ms != null ? `${Math.round(s.guest.latency_ms)} ms` : ''}</span>],
                ...(s.guest.detail ? ([['Guest detail', s.guest.detail]] as [string, string][]) : []),
                ...guestExtra.map(([k, v]) => [`guest ${k.replace(/_/g, ' ')}`, typeof v === 'object' ? JSON.stringify(v) : String(v)] as [string, string]),
              ]}
            />
          ) : (
            <LoadingRows rows={5} />
          )}
        </Card>

        <Card title="Host" icon={<IconCpu />} subtitle={host ? `${host.os} · ${host.arch}` : undefined}>
          {host ? (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="text-muted">Memory {formatBytes(memUsed)} / {formatBytes(host.memory_total_bytes)}</span>
                <StatusPill state={host.memory_pressure} label={`Memory pressure: ${host.memory_pressure}`} />
              </div>
              <Meter value={percent(memUsed, host.memory_total_bytes)} label="Host memory in use" tone={usageTone(percent(memUsed, host.memory_total_bytes))} />
              <KeyValue
                items={[
                  ['Load average', host.load_avg.map((x) => x.toFixed(2)).join(' / ')],
                  ['CPU cores', String(host.cpu_count ?? '—')],
                  ['Disk free', `${formatBytes(host.disk_free_bytes)} of ${formatBytes(host.disk_total_bytes)}`],
                  ['Artifacts', formatBytes(s?.storage.artifacts_bytes)],
                  ['Data directory', <Mono key="d">{s?.storage.data_dir}</Mono>],
                  ['Workers', `${s?.limits.running_workers ?? 0} running · active desktop limit ${s?.limits.active_gui_agents ?? '—'}`],
                ]}
              />
            </div>
          ) : (
            <Spinner label="Loading…" />
          )}
        </Card>

        <Card title="Versions & services" icon={<IconSystem />}>
          <KeyValue
            items={[
              ['NEBULA host', host?.app_version ?? health?.version ?? '—'],
              ['Installation', s?.installation ? <StatusPill key="i" state={s.installation.state} tone={s.installation.state === 'READY' ? 'success' : 'warn'} /> : 'Not recorded'],
              ['VM image', s?.installation?.vm_image_version ?? '—'],
              ['Guest service', s?.installation?.guest_version ?? '—'],
              ['API', health?.api ?? '—'],
              ['Database', health?.db ?? '—'],
              ['Telegram polling', health ? (health.telegram.polling ? 'running' : 'stopped') : '—'],
            ]}
          />
          {s?.installation?.state_detail && <p className="mt-2 text-xs text-warn">{s.installation.state_detail}</p>}
        </Card>

        <Card title="Maintenance" icon={<IconSettings />}>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => setConfirm('repair')} loading={isPending('repair')} disabledReason={repairJob ? 'A repair is being watched below' : null}>
              Repair
            </Button>
            <Button onClick={() => setConfirm('restart')}>Restart services</Button>
            <Button
              loading={isPending('backup')}
              onClick={async () => {
                const r = await run('backup', () => api.system.backup(), { success: (b) => `Database backed up (${formatBytes(b.size_bytes)})` });
                if (r) setBackup(r);
              }}
            >
              Backup DB
            </Button>
            <Button
              loading={isPending('diag')}
              onClick={async () => {
                const r = await run('diag', () => api.system.diagnostics(), { success: 'Diagnostics bundle downloaded' });
                if (r) downloadBlob(r.blob, r.filename ?? `nebula-diagnostics-${Date.now()}.tar.gz`);
              }}
            >
              Export diagnostics
            </Button>
            <Button
              loading={isPending('preflight')}
              onClick={async () => {
                const r = await run('preflight', () => api.system.preflight(), { success: (p) => `Preflight: ${p.status}` });
                if (r) setPreflight(r);
              }}
            >
              Run preflight
            </Button>
          </div>
          {backup && (
            <p className="mt-3 text-sm text-muted">
              Backup saved to <Mono>{backup.path}</Mono> ({formatBytes(backup.size_bytes)}). {backup.note}.
            </p>
          )}
          <p className="mt-3 text-xs text-subtle">The diagnostics bundle is redacted: no secrets, no database dump, no workspace files.</p>
          {repairJob && <RepairJob jobId={repairJob} onDone={sys.reload} />}
        </Card>
      </div>

      {preflight && (
        <div className="mt-5">
          <Card title={<span className="flex items-center gap-2">Preflight report <StatusPill state={preflight.status} /></span>}>
            <DataTable
              label="Preflight checks"
              rows={preflight.checks}
              rowKey={(c) => c.id}
              dense
              columns={[
                { key: 'id', header: 'Check', mobile: 'title', cell: (c) => <Mono className="text-text">{c.id}</Mono> },
                { key: 'status', header: 'Result', mobile: 'aside', cell: (c) => <StatusPill state={c.status} /> },
                { key: 'detail', header: 'Detail', cell: (c) => <span className="text-text">{c.detail}</span> },
                { key: 'req', header: 'Required / note', cell: (c) => <span className="text-xs text-muted">{[c.required, c.note].filter(Boolean).join(' · ') || '—'}</span> },
              ]}
            />
          </Card>
        </div>
      )}

      <div className="mt-5">
        <Card title={`Live streams (${s?.live.active_streams.length ?? 0} active)`} subtitle="A stream exists only while a dashboard viewer is connected.">
          {sessions.error ? <ErrorBanner error={sessions.error} onRetry={sessions.reload} /> : null}
          {!sessions.data ? (
            <LoadingRows rows={2} />
          ) : sessions.data.sessions.length === 0 ? (
            <p className="text-sm text-muted">No live sessions recorded.</p>
          ) : (
            <DataTable
              label="Live sessions"
              rows={sessions.data.sessions.slice(0, 20)}
              rowKey={(x) => x.id}
              dense
              columns={[
                { key: 'id', header: 'Session', mobile: 'title', cell: (x) => <Mono>{shortId(x.id)}</Mono> },
                { key: 'agent', header: 'Agent', cell: (x) => <Mono>{shortId(x.agent_id)}</Mono> },
                { key: 'state', header: 'State', mobile: 'aside', cell: (x) => <StatusPill state={x.state} /> },
                { key: 'ctl', header: 'Control', cell: (x) => <span className="text-muted">{x.control_lease ? 'lease held' : '—'}</span> },
                {
                  key: 'bytes',
                  header: 'Bytes sent',
                  cell: (x) => {
                    const active = sessions.data?.active_streams.find((a) => a.session_id === x.id);
                    return <span className="text-muted tabular-nums">{formatBytes(active ? active.bytes_out : x.bytes_to_viewer)}</span>;
                  },
                },
                { key: 'started', header: 'Started', cell: (x) => <span className="text-xs text-muted">{formatTime(x.created_at)}</span> },
              ]}
            />
          )}
        </Card>
      </div>

      <div className="mt-5">
        <LogsViewer />
      </div>

      <div className="mt-5">
        <Card title="Audit log" icon={<IconShield />} subtitle="Most recent 200 entries" actions={<Button size="sm" icon={<IconRefresh />} onClick={auditLog.reload} loading={auditLog.loading}>Refresh</Button>}>
          {auditLog.error ? <ErrorBanner error={auditLog.error} onRetry={auditLog.reload} /> : null}
          {!auditLog.data ? (
            <LoadingRows rows={5} />
          ) : (
            <div className="max-h-[560px] overflow-auto">
              <DataTable
                label="Audit log"
                rows={auditLog.data}
                rowKey={(a) => String(a.id)}
                dense
                stickyHeader
                minWidth={760}
                columns={[
                  { key: 'ts', header: 'Time', mobile: 'subtitle', className: 'whitespace-nowrap text-xs text-muted', cell: (a) => formatTime(a.ts) },
                  { key: 'actor', header: 'Actor', cell: (a) => <Mono>{a.actor}</Mono> },
                  { key: 'action', header: 'Action', mobile: 'title', cell: (a) => <span className="text-text">{a.action}</span> },
                  { key: 'target', header: 'Target', className: 'max-w-[200px] truncate', cell: (a) => <Mono>{a.target ?? '—'}</Mono> },
                  {
                    key: 'meta',
                    header: 'Details',
                    className: 'max-w-[320px]',
                    cell: (a) =>
                      a.metadata && Object.keys(a.metadata).length > 0 ? (
                        <code className="font-mono text-2xs break-all text-subtle">{JSON.stringify(a.metadata)}</code>
                      ) : (
                        <span className="text-subtle">—</span>
                      ),
                  },
                ]}
              />
            </div>
          )}
        </Card>
      </div>

      <ConfirmDialog
        open={confirm === 'stop'}
        title="Stop the VM?"
        confirmLabel="Stop VM"
        busyText="Stopping…"
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          const r = await run('stop', () => api.system.vmStop(), { success: (st) => `VM ${String(st.state ?? 'stopped')}` });
          if (r) {
            setConfirm(null);
            sys.reload();
          }
        }}
      >
        <p>All running tasks are smart-paused first, then the Ubuntu VM shuts down. Every agent desktop stops until you start the VM again.</p>
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm === 'restart'}
        title="Restart NEBULA services?"
        confirmLabel="Restart"
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          const r = await run('restart', () => api.system.restartServices(), {
            success: 'Host service is restarting — this page reconnects automatically',
          });
          if (r) setConfirm(null);
        }}
      >
        <div className="space-y-2">
          <p>The host service exits and launchd starts it again. The database and agents persist; open live streams are closed.</p>
          <Notice tone="info">Only works when NEBULA runs under launchd (not in a development shell).</Notice>
        </div>
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm === 'repair'}
        title="Run repair?"
        confirmLabel="Start repair"
        destructive={false}
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          const r = await run('repair', () => api.system.repair());
          if (r) {
            setConfirm(null);
            const id = r.job_id ?? r.data.job_id;
            setRepairJob(id);
            toast.info('Repair started', `Job ${shortId(id)}`);
          }
        }}
      >
        <p>Starts the VM if needed, re-applies the idempotent guest provisioning and runs the health-check. Agent data is not removed. This can take several minutes.</p>
      </ConfirmDialog>
    </>
  );
}
