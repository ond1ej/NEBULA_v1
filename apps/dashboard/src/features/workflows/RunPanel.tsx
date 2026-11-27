// Run history and the detail of one run (per-step state, attempt, output, error, approvals).
import { useEffect, useMemo, useState } from 'react';
import { StatusPill } from '../../components/StatusPill';
import { useToast } from '../../components/Toast';
import { Button, EmptyState, ErrorBanner, Mono, Spinner } from '../../components/ui';
import { href } from '../../hooks/useHashRoute';
import { formatDuration, formatTime, relativeTime, shortId } from '../../lib/format';
import { workflowsApi } from './api';
import { ACTIVE_RUN_STATES, baseNodeId } from './graph';
import { IconBack, IconStop } from './icons';
import type { OwnerApproval, RunSummary, WfDefinition, WorkflowRun, WorkflowStep } from './types';

export function RunsList({
  runs,
  loading,
  error,
  onReload,
  onOpen,
  activeRunId,
}: {
  runs: RunSummary[] | null;
  loading: boolean;
  error: unknown;
  onReload: () => void;
  onOpen: (id: string) => void;
  activeRunId: string | null;
}) {
  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted">{runs ? `${runs.length} recent run(s)` : ' '}</p>
        <Button size="sm" variant="ghost" onClick={onReload} loading={loading && !!runs} className="max-sm:min-h-11">
          Refresh
        </Button>
      </div>
      {error ? <ErrorBanner error={error} onRetry={onReload} title="Could not load runs" /> : null}
      {!runs && loading ? (
        <Spinner label="Loading runs…" />
      ) : runs && runs.length === 0 ? (
        <EmptyState title="No runs yet">Use “Run” to start this workflow manually; triggers start it automatically while it is enabled.</EmptyState>
      ) : (
        <ul className="flex flex-col gap-1">
          {(runs ?? []).map((r) => (
            <li key={r.id}>
              <button
                type="button"
                onClick={() => onOpen(r.id)}
                aria-current={r.id === activeRunId || undefined}
                className={`flex min-h-11 w-full flex-col gap-1 rounded-md border px-3 py-2 text-left focus-visible:outline-2 focus-visible:outline-accent ${
                  r.id === activeRunId ? 'border-accent/60 bg-accent/10' : 'border-border hover:bg-panel-2'
                }`}
              >
                <span className="flex items-center justify-between gap-2">
                  <StatusPill state={r.state} pulse={ACTIVE_RUN_STATES.has(r.state)} />
                  <span className="text-[11px] text-subtle" title={formatTime(r.created_at)}>
                    {relativeTime(r.created_at)}
                  </span>
                </span>
                <span className="flex flex-wrap items-center gap-x-2 text-[11px] text-muted">
                  <Mono className="text-[11px]">{shortId(r.id)}</Mono>
                  <span>{r.trigger.replace(/_/g, ' ')}</span>
                  <span>v{r.workflow_version}</span>
                  {r.finished_at && <span>{formatDuration(r.finished_at - r.created_at)}</span>}
                </span>
                {r.error && <span className="line-clamp-2 text-[11px] text-danger">{r.error}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function outputText(output: unknown): string | null {
  if (output === null || output === undefined) return null;
  if (typeof output === 'object' && !Array.isArray(output)) {
    const rest = { ...(output as Record<string, unknown>) };
    delete rest._handle;
    if (Object.keys(rest).length === 0) return null;
    const s = JSON.stringify(rest, null, 2);
    return s.length > 20000 ? `${s.slice(0, 20000)}\n… (truncated)` : s;
  }
  return JSON.stringify(output, null, 2);
}

export function RunDetail({
  run,
  loading,
  error,
  onReload,
  def,
  currentVersion,
  selectedNode,
  onSelectNode,
  onBack,
}: {
  run: WorkflowRun | null;
  loading: boolean;
  error: unknown;
  onReload: () => void;
  def: WfDefinition | null;
  currentVersion: number | null;
  selectedNode: string | null;
  onSelectNode: (id: string | null) => void;
  onBack: () => void;
}) {
  const toast = useToast();
  const [stopping, setStopping] = useState(false);
  const [approvals, setApprovals] = useState<OwnerApproval[] | null>(null);
  const [deciding, setDeciding] = useState<string | null>(null);
  const waitingApprovalIds = useMemo(
    () =>
      (run?.steps ?? [])
        .filter((s) => s.state === 'WAITING' && typeof s.ref?.approval_id === 'string')
        .map((s) => String(s.ref?.approval_id))
        .join(','),
    [run],
  );

  useEffect(() => {
    if (!waitingApprovalIds) {
      setApprovals(null);
      return;
    }
    const c = new AbortController();
    workflowsApi
      .ownerApprovals(c.signal)
      .then(setApprovals)
      .catch((e: unknown) => {
        if (!c.signal.aborted) toast.error(e, 'Could not load pending approvals');
      });
    return () => c.abort();
  }, [waitingApprovalIds, toast]);

  if (error && !run) return <div className="p-3"><ErrorBanner error={error} onRetry={onReload} title="Could not load the run" /></div>;
  if (!run) return <div className="p-3"><Spinner label="Loading run…" /></div>;

  const active = ACTIVE_RUN_STATES.has(run.state);
  const labelOf = (nodeId: string) => def?.nodes.find((n) => n.id === baseNodeId(nodeId))?.label || baseNodeId(nodeId);
  const steps = [...run.steps].sort((a, b) => a.started_at - b.started_at || a.attempt - b.attempt);
  const shown = selectedNode ? steps.filter((s) => baseNodeId(s.node_id) === selectedNode) : steps;
  const payload = run.trigger_payload && Object.keys(run.trigger_payload).length ? JSON.stringify(run.trigger_payload, null, 2) : null;

  const stop = async () => {
    setStopping(true);
    try {
      await workflowsApi.stopRun(run.id);
      toast.success('Run stopped');
      onReload();
    } catch (e) {
      toast.error(e, 'Could not stop the run');
    } finally {
      setStopping(false);
    }
  };

  const decide = async (approvalId: string, decision: 'approved' | 'denied') => {
    setDeciding(approvalId);
    try {
      await workflowsApi.resolveApproval(approvalId, decision);
      toast.success(decision === 'approved' ? 'Approved' : 'Denied');
      onReload();
    } catch (e) {
      toast.error(e, 'Could not record the decision');
    } finally {
      setDeciding(null);
    }
  };

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex items-center justify-between gap-2">
        <Button size="sm" variant="ghost" onClick={onBack} className="max-sm:min-h-11">
          <IconBack /> All runs
        </Button>
        {loading && !active && <Spinner className="size-3.5" />}
      </div>
      <div className="rounded-lg border border-border bg-panel-2/60 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill state={run.state} pulse={active} />
          <Mono>{shortId(run.id)}</Mono>
          <span className="text-xs text-muted">v{run.workflow_version}</span>
          {currentVersion !== null && run.workflow_version !== currentVersion && (
            <span className="text-[11px] text-warn">older than the current version (v{currentVersion})</span>
          )}
        </div>
        <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="text-muted">Trigger</dt>
          <dd className="text-text">{run.trigger.replace(/_/g, ' ')}</dd>
          <dt className="text-muted">Started</dt>
          <dd className="text-text">{formatTime(run.created_at)}</dd>
          <dt className="text-muted">{run.finished_at ? 'Finished' : 'Running for'}</dt>
          <dd className="text-text">
            {run.finished_at ? `${formatTime(run.finished_at)} (${formatDuration(run.finished_at - run.created_at)})` : formatDuration(Date.now() / 1000 - run.created_at)}
          </dd>
        </dl>
        {run.error && <p className="mt-2 text-xs break-words text-danger">{run.error}</p>}
        {payload && (
          <details className="mt-2">
            <summary className="cursor-pointer text-xs text-muted hover:text-text">Trigger payload</summary>
            <pre className="mt-1 max-h-40 overflow-auto rounded bg-bg p-2 font-mono text-[11px] text-muted">{payload}</pre>
          </details>
        )}
        {active && (
          <div className="mt-3">
            <Button variant="danger" size="sm" onClick={stop} loading={stopping} className="max-sm:min-h-11">
              <IconStop /> Stop run
            </Button>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-text">Steps{selectedNode ? ` · ${labelOf(selectedNode)}` : ''}</h3>
        {selectedNode && (
          <Button size="sm" variant="ghost" onClick={() => onSelectNode(null)} className="max-sm:min-h-11">
            Show all
          </Button>
        )}
      </div>
      {shown.length === 0 ? (
        <p className="text-xs text-muted">{selectedNode ? 'This block has not run in this run.' : 'No steps recorded yet.'}</p>
      ) : (
        <ol className="flex flex-col gap-1.5">
          {shown.map((s) => (
            <StepRow
              key={s.id}
              step={s}
              label={labelOf(s.node_id)}
              approval={approvals ? (approvals.find((a) => a.id === s.ref?.approval_id) ?? null) : undefined}
              deciding={deciding}
              onDecide={decide}
              onSelect={() => onSelectNode(baseNodeId(s.node_id))}
            />
          ))}
        </ol>
      )}
    </div>
  );
}

function StepRow({
  step,
  label,
  approval,
  deciding,
  onDecide,
  onSelect,
}: {
  step: WorkflowStep;
  label: string;
  /** undefined while the pending approvals are loading */
  approval: OwnerApproval | null | undefined;
  deciding: string | null;
  onDecide: (id: string, d: 'approved' | 'denied') => void;
  onSelect: () => void;
}) {
  const out = outputText(step.output);
  const iter = step.node_id.includes('#') ? step.node_id.slice(step.node_id.indexOf('#') + 1) : null;
  const handle = step.output && typeof step.output === 'object' ? (step.output as { _handle?: unknown })._handle : undefined;
  const taskId = typeof step.ref?.task_id === 'string' ? step.ref.task_id : null;
  const teamRun = typeof step.ref?.team_run_id === 'string' ? step.ref.team_run_id : null;
  const approvalId = typeof step.ref?.approval_id === 'string' ? step.ref.approval_id : null;
  const dur = step.finished_at ? step.finished_at - step.started_at : null;
  return (
    <li className="rounded-md border border-border bg-panel-2/40 px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <button type="button" onClick={onSelect} className="min-w-0 truncate text-left text-sm font-medium text-text hover:underline">
          {label}
        </button>
        <StatusPill state={step.state} pulse={step.state === 'RUNNING'} />
      </div>
      <p className="mt-0.5 flex flex-wrap gap-x-2 text-[11px] text-muted">
        <Mono className="text-[11px]">{step.node_id}</Mono>
        {iter !== null && <span>iteration {Number(iter) + 1}</span>}
        {step.attempt > 1 && <span>attempt {step.attempt}</span>}
        {dur !== null && <span>{formatDuration(dur)}</span>}
        {typeof handle === 'string' && handle !== 'out' && <span>→ {handle}</span>}
      </p>
      {step.error && <p className="mt-1 text-xs break-words text-danger">{step.error}</p>}
      {(taskId || teamRun) && (
        <p className="mt-1 text-xs text-muted">
          {taskId && (
            <a className="text-accent-soft hover:underline" href={href(`/tasks?task=${encodeURIComponent(taskId)}`)}>
              Open task {shortId(taskId)}
            </a>
          )}
          {teamRun && <span>Team run {shortId(teamRun)}</span>}
        </p>
      )}
      {step.state === 'WAITING' && approvalId && (
        <div className="mt-2 rounded-md border border-warn/40 bg-warn/10 p-2">
          <p className="text-xs font-medium text-text">Waiting for your approval</p>
          {approval === undefined ? (
            <p className="mt-0.5 text-xs text-muted">Loading the request…</p>
          ) : approval ? (
            <p className="mt-0.5 text-xs break-words whitespace-pre-wrap text-muted">{approval.summary}</p>
          ) : (
            <p className="mt-0.5 text-xs text-muted">The approval request could not be found (it may have expired).</p>
          )}
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" variant="primary" loading={deciding === approvalId} disabled={!!deciding} onClick={() => onDecide(approvalId, 'approved')} className="max-sm:min-h-11">
              Approve
            </Button>
            <Button size="sm" variant="danger" disabled={!!deciding} onClick={() => onDecide(approvalId, 'denied')} className="max-sm:min-h-11">
              Deny
            </Button>
          </div>
        </div>
      )}
      {out && (
        <details className="mt-1">
          <summary className="cursor-pointer text-xs text-muted hover:text-text">Output</summary>
          <pre className="mt-1 max-h-60 overflow-auto rounded bg-bg p-2 font-mono text-[11px] whitespace-pre-wrap text-muted">{out}</pre>
        </details>
      )}
    </li>
  );
}
