import { useState } from 'react';
import { ConfirmDialog } from '../../components/Modal';
import { IconPlay, IconStop, IconWorkflows } from '../../components/icons';
import { BUSY_STATES, StatusPill } from '../../components/StatusPill';
import { Badge, KeyValue, Switch } from '../../components/ui';
import type { RunSummary, Workflow, WorkflowListItem, WorkflowRun } from '../../features/workflows/types';
import { formatDuration, formatTime, relativeTime, shortId } from '../../lib/format';
import { hasPermission, useMini } from '../context';
import { useActions, useQuery } from '../hooks';
import { mhref, navigate } from '../router';
import { Card, Clamp, Empty, List, QueryView, Row, Screen, Section, TapButton } from '../uiKit';
import { OwnerNote } from '../uiExtra';

const wfEvent = (ev: { type: string }) => ev.type.startsWith('workflow.');
const ACTIVE = new Set(['RUNNING', 'WAITING']);

export function WorkflowsScreen() {
  const ctx = useMini();
  const { api } = ctx;
  const { run, isPending } = useActions();
  const q = useQuery<WorkflowListItem[]>('workflows', (s) => api.workflows.list(s), { refreshOn: wfEvent });
  const runs = useQuery<RunSummary[]>('workflow-runs', (s) => api.workflows.runs(undefined, s), { refreshOn: wfEvent });
  const canRun = hasPermission(ctx, 'workflows');
  const names = new Map((q.data ?? []).map((w) => [w.id, w.name]));
  const active = (runs.data ?? []).filter((r) => ACTIVE.has(r.state));

  return (
    <Screen title="Workflows" subtitle={q.data ? `${q.data.length} workflow${q.data.length === 1 ? '' : 's'} · ${active.length} running` : undefined}>
      {active.length > 0 && (
        <Section title="Running now">
          <List>
            {active.map((r) => (
              <Row
                key={r.id}
                href={mhref(`/workflow-runs/${r.id}`)}
                title={names.get(r.workflow_id) ?? `Workflow ${shortId(r.workflow_id)}`}
                subtitle={`${r.trigger} · started ${relativeTime(r.created_at)}`}
                trailing={<StatusPill state={r.state} pulse />}
              />
            ))}
          </List>
        </Section>
      )}
      <Section title="All workflows">
        <QueryView q={q} isEmpty={(d) => d.length === 0} empty={<Empty title="No workflows" icon={<IconWorkflows />}>Build workflows on the canvas in the Dashboard.</Empty>}>
          {(list) => (
            <ul className="space-y-2.5">
              {list.map((w) => (
                <li key={w.id}>
                  <Card>
                    <a href={mhref(`/workflows/${w.id}`)} className="-m-1 block rounded-lg p-1 focus-ring">
                      <div className="flex items-start gap-2">
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[15px] font-semibold text-text">{w.name}</span>
                          <Clamp lines={2} className="mt-0.5 text-[12.5px] text-muted">
                            {w.description || `${w.definition?.nodes?.length ?? 0} blocks`}
                          </Clamp>
                        </span>
                        {w.last_run && <StatusPill state={w.last_run.state} pulse={BUSY_STATES.has(w.last_run.state)} />}
                      </div>
                      <span className="mt-1.5 flex flex-wrap gap-1.5">
                        {w.trigger_types.map((t) => (
                          <Badge key={t} tone="neutral">
                            {t}
                          </Badge>
                        ))}
                        {w.last_run && <span className="text-[11.5px] text-subtle">last run {relativeTime(w.last_run.created_at)}</span>}
                      </span>
                    </a>
                    {canRun && (
                      <div className="mt-3 flex items-center gap-3 border-t border-border pt-3">
                        <div className="min-h-11 flex-1">
                          <Switch
                            checked={w.enabled}
                            loading={isPending(`en:${w.id}`)}
                            label={w.enabled ? 'Enabled' : 'Disabled'}
                            onChange={async (on) => {
                              const r = await run(`en:${w.id}`, () => api.workflows.setEnabled(w.id, on), { success: `${w.name} ${on ? 'enabled' : 'disabled'}` });
                              if (r) q.setData((xs) => (xs ?? []).map((x) => (x.id === w.id ? { ...x, enabled: r.enabled } : x)));
                            }}
                          />
                        </div>
                        <TapButton
                          variant="primary"
                          icon={<IconPlay />}
                          loading={isPending(`run:${w.id}`)}
                          disabledReason={!w.enabled ? 'Enable the workflow first' : null}
                          onClick={async () => {
                            const r = await run(`run:${w.id}`, () => api.workflows.run(w.id), { success: `${w.name} started` });
                            if (r) navigate(`/workflow-runs/${r.id}`);
                          }}
                        >
                          Run
                        </TapButton>
                      </div>
                    )}
                  </Card>
                </li>
              ))}
            </ul>
          )}
        </QueryView>
      </Section>
    </Screen>
  );
}

export function WorkflowDetailScreen({ workflowId }: { workflowId: string }) {
  const ctx = useMini();
  const { api } = ctx;
  const { run, isPending } = useActions();
  const wf = useQuery<Workflow>(`workflow:${workflowId}`, (s) => api.workflows.get(workflowId, s), { refreshOn: wfEvent });
  const runs = useQuery<RunSummary[]>(`workflow-runs:${workflowId}`, (s) => api.workflows.runs(workflowId, s), { refreshOn: wfEvent });
  const w = wf.data;
  const canRun = hasPermission(ctx, 'workflows');
  return (
    <Screen title={w?.name ?? 'Workflow'} subtitle={w ? `version ${w.version} · ${w.enabled ? 'enabled' : 'disabled'}` : undefined}>
      <QueryView q={wf}>
        {(d) => (
          <>
            {d.description && <p className="mb-3 px-1 text-sm text-muted">{d.description}</p>}
            {canRun && (
              <TapButton
                variant="primary"
                className="mb-4 w-full"
                icon={<IconPlay />}
                loading={isPending('run')}
                disabledReason={!d.enabled ? 'Enable the workflow first' : null}
                onClick={async () => {
                  const r = await run('run', () => api.workflows.run(d.id), { success: `${d.name} started` });
                  if (r) navigate(`/workflow-runs/${r.id}`);
                }}
              >
                Run now
              </TapButton>
            )}
            <Section title={`Blocks (${d.definition.nodes.length})`}>
              <OwnerNote className="mb-2 !px-1" to={`/admin/workflows/${encodeURIComponent(workflowId)}`} link="Edit the canvas in Administration">
                Read-only — edit the canvas in the Dashboard.
              </OwnerNote>
              <ol className="space-y-2">
                {d.definition.nodes.map((n, i) => {
                  const next = d.definition.edges.filter((e) => e.source === n.id).map((e) => d.definition.nodes.find((x) => x.id === e.target)?.label ?? e.target);
                  const params = Object.entries(n.params ?? {}).filter(([, v]) => v !== '' && v !== null && v !== undefined);
                  return (
                    <li key={n.id} className="rounded-card bg-panel p-3">
                      <div className="flex items-center gap-2">
                        <span className="grid size-6 shrink-0 place-items-center rounded-md bg-panel-3 font-mono text-[11px] text-muted">{i + 1}</span>
                        <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-text">{n.label || n.type}</span>
                        <Badge tone="neutral">{n.type}</Badge>
                      </div>
                      {params.length > 0 && (
                        <p className="mt-1.5 text-[12px] text-muted [overflow-wrap:anywhere]">
                          <Clamp lines={3}>{params.map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' · ')}</Clamp>
                        </p>
                      )}
                      {next.length > 0 && <p className="mt-1 text-[11.5px] text-subtle">→ {next.join(', ')}</p>}
                    </li>
                  );
                })}
              </ol>
            </Section>
          </>
        )}
      </QueryView>
      <Section title="Recent runs">
        <QueryView q={runs} isEmpty={(d) => d.length === 0} empty={<Empty title="Never run" />} rows={2}>
          {(list) => (
            <List>
              {list.map((r) => (
                <Row
                  key={r.id}
                  href={mhref(`/workflow-runs/${r.id}`)}
                  title={`Run ${shortId(r.id)}`}
                  subtitle={`${r.trigger} · ${relativeTime(r.created_at)}${r.error ? ` · ${r.error}` : ''}`}
                  trailing={<StatusPill state={r.state} pulse={BUSY_STATES.has(r.state)} />}
                />
              ))}
            </List>
          )}
        </QueryView>
      </Section>
    </Screen>
  );
}

export function WorkflowRunScreen({ runId }: { runId: string }) {
  const ctx = useMini();
  const { api } = ctx;
  const { run, isPending } = useActions();
  const q = useQuery<WorkflowRun>(`workflow-run:${runId}`, (s) => api.workflows.getRun(runId, s), {
    refreshOn: (ev) => wfEvent(ev) && (!ev.payload?.run_id || ev.payload.run_id === runId),
    pollMs: 8_000,
  });
  const [confirm, setConfirm] = useState(false);
  const r = q.data;
  return (
    <Screen title={r?.workflow_name ?? 'Workflow run'} subtitle={r ? `Run ${shortId(r.id)}` : undefined}>
      <QueryView q={q}>
        {(d) => (
          <>
            <Card className="mb-4">
              <div className="mb-2 flex items-center gap-2">
                <StatusPill state={d.state} pulse={BUSY_STATES.has(d.state)} />
                <a href={mhref(`/workflows/${d.workflow_id}`)} className="ml-auto inline-flex min-h-11 items-center text-[12.5px] text-accent-soft focus-ring">
                  Workflow
                </a>
              </div>
              <KeyValue
                items={[
                  ['Trigger', d.trigger],
                  ['Started', formatTime(d.created_at)],
                  ['Duration', formatDuration((d.finished_at ?? Date.now() / 1000) - d.created_at)],
                  ['Version', String(d.workflow_version)],
                ]}
              />
              {d.error && <p className="mt-2 text-[13px] text-danger">{d.error}</p>}
            </Card>
            {hasPermission(ctx, 'workflows') && ACTIVE.has(d.state) && (
              <TapButton variant="danger" className="mb-4 w-full" icon={<IconStop />} onClick={() => setConfirm(true)}>
                Stop run
              </TapButton>
            )}
            <Section title={`Steps (${d.steps.length})`}>
              {d.steps.length === 0 ? (
                <p className="px-1 text-sm text-muted">No steps yet.</p>
              ) : (
                <ol className="space-y-2">
                  {d.steps.map((s) => (
                    <li key={s.id} className="rounded-card bg-panel p-3">
                      <div className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-text">{d.definition.nodes.find((n) => n.id === s.node_id.split('#')[0])?.label ?? s.node_id}</span>
                        <StatusPill state={s.state} pulse={BUSY_STATES.has(s.state)} />
                      </div>
                      <p className="mt-0.5 text-[11.5px] text-subtle">
                        {s.node_type}
                        {s.attempt > 1 ? ` · attempt ${s.attempt}` : ''} · {relativeTime(s.started_at)}
                      </p>
                      {s.error && <p className="mt-1 text-[12.5px] text-danger [overflow-wrap:anywhere]">{s.error}</p>}
                      {s.ref && typeof s.ref.task_id === 'string' && (
                        <a href={mhref(`/tasks/${s.ref.task_id}`)} className="mt-1 inline-flex min-h-11 items-center text-[12.5px] text-accent-soft focus-ring">
                          Open task {shortId(s.ref.task_id)}
                        </a>
                      )}
                    </li>
                  ))}
                </ol>
              )}
            </Section>
          </>
        )}
      </QueryView>
      <ConfirmDialog
        open={confirm}
        title="Stop this workflow run?"
        confirmLabel="Stop run"
        busyText="Stopping…"
        onCancel={() => setConfirm(false)}
        onConfirm={async () => {
          const res = await run('stop', () => api.workflows.stopRun(runId), { success: 'Run stopped' });
          if (res !== undefined) {
            setConfirm(false);
            q.reload();
          }
        }}
      >
        <p>Blocks that already ran are not undone.</p>
      </ConfirmDialog>
      {isPending('stop') && <span className="sr-only">Stopping…</span>}
    </Screen>
  );
}
