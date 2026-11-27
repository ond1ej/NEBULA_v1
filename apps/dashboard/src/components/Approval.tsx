// Approvals center: task tool approvals (/approvals) + owner approvals for automation (/owner-approvals).
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { api } from '../api';
import { useAction, useApi, useNow } from '../hooks/useApi';
import { useNebulaEvents } from '../hooks/useEvents';
import { href } from '../hooks/useHashRoute';
import { formatDuration, relativeTime, shortId } from '../lib/format';
import type { Approval, OwnerApproval } from '../types';
import { IconCalendar, IconCheckCircle, IconShield, IconTerminal, IconWorkflows, IconPackage } from './icons';
import { Drawer, Modal } from './Modal';
import { StatusPill } from './StatusPill';
import { Badge, Button, EmptyState, ErrorBanner, LoadingRows, Mono } from './ui';

function Countdown({ expiresAt, decided }: { expiresAt: number; decided: boolean }) {
  const now = useNow(1000) / 1000;
  if (decided) return null;
  const remaining = expiresAt - now;
  return (
    <span className={`text-xs tabular-nums ${remaining < 60 ? 'text-warn' : 'text-muted'}`}>
      {remaining <= 0 ? 'Expired' : `Expires in ${formatDuration(remaining)}`}
    </span>
  );
}

function Preview({ data, label }: { data: Record<string, unknown> | null; label: string }) {
  if (!data || Object.keys(data).length === 0) return null;
  return (
    <details className="mt-2.5 group">
      <summary className="inline-flex rounded text-xs text-muted hover:text-text focus-ring">{label}</summary>
      <pre className="mt-1.5 max-h-48 overflow-auto rounded-lg border border-border bg-input p-2.5 font-mono text-2xs leading-relaxed text-muted">
        {JSON.stringify(data, null, 2)}
      </pre>
    </details>
  );
}

export function ApprovalCard({
  approval,
  agentName,
  onResolved,
  compact = false,
}: {
  approval: Approval;
  agentName?: string;
  onResolved?: (a: Approval) => void;
  compact?: boolean;
}) {
  const { run, isPending } = useAction();
  const now = useNow(5000) / 1000;
  const expired = !approval.decision && approval.expires_at - now <= 0;

  const decide = async (decision: 'approved' | 'denied') => {
    const r = await run(decision, () => api.approvals.resolve(approval.id, decision), {
      success: (res) =>
        res.decision === 'expired' ? 'Approval had already expired' : decision === 'approved' ? 'Action approved' : 'Action denied',
      errorTitle: 'Could not record the decision',
    });
    if (r) onResolved?.(r);
  };

  return (
    <div className="rounded-xl border border-warn/25 bg-warn/[0.045] p-4" data-testid="approval-card">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <IconShield className="size-4 shrink-0 text-warn" />
          <StatusPill state={approval.decision ?? (expired ? 'expired' : 'pending')} label={approval.decision ?? (expired ? 'expired' : 'Approval required')} />
          <Mono className="text-text">{approval.tool}</Mono>
        </div>
        <Countdown expiresAt={approval.expires_at} decided={Boolean(approval.decision)} />
      </div>
      <p className="mt-2.5 text-sm leading-relaxed whitespace-pre-wrap text-text">{approval.action_summary}</p>
      {approval.reason && (
        <p className="mt-1.5 text-sm text-muted">
          <span className="text-subtle">Why approval is needed: </span>
          {approval.reason}
        </p>
      )}
      {!compact && <Preview data={approval.action_preview} label="Action preview (sanitized arguments)" />}
      <p className="mt-2.5 text-xs text-subtle">
        {agentName ? `Agent ${agentName}` : `Agent ${shortId(approval.agent_id)}`} · task{' '}
        <a className="rounded underline decoration-subtle/50 underline-offset-2 hover:text-text focus-ring" href={href(`/agents/${approval.agent_id}/tasks?task=${approval.task_id}`)}>
          {shortId(approval.task_id)}
        </a>
      </p>
      {!approval.decision && (
        <div className="mt-3.5 flex flex-wrap gap-2">
          <Button
            variant="primary"
            size="sm"
            onClick={() => decide('approved')}
            loading={isPending('approved')}
            disabled={isPending('denied')}
            disabledReason={expired ? 'This request has expired' : null}
          >
            Approve
          </Button>
          <Button
            variant="danger"
            size="sm"
            onClick={() => decide('denied')}
            loading={isPending('denied')}
            disabled={isPending('approved')}
            disabledReason={expired ? 'This request has expired' : null}
          >
            Deny
          </Button>
        </div>
      )}
    </div>
  );
}

const OWNER_KIND: Record<string, { label: string; icon: ReactNode }> = {
  workflow: { label: 'Workflow approval', icon: <IconWorkflows className="size-4 text-warn" /> },
  command: { label: 'Command approval', icon: <IconTerminal className="size-4 text-warn" /> },
  schedule_misfire: { label: 'Missed schedule', icon: <IconCalendar className="size-4 text-warn" /> },
  package_install: { label: 'Package install', icon: <IconPackage className="size-4 text-warn" /> },
  plugin: { label: 'Plugin', icon: <IconPackage className="size-4 text-warn" /> },
};

function ownerLink(a: OwnerApproval): { href: string; label: string } | null {
  const ref = a.ref ?? {};
  if (a.kind === 'schedule_misfire' && typeof ref.schedule_id === 'string') return { href: href(`/schedules/${ref.schedule_id}`), label: 'Open schedule' };
  if (a.kind === 'workflow' || a.kind === 'command') return { href: href('/workflows'), label: 'Open workflows' };
  if (typeof ref.task_id === 'string' && typeof ref.agent_id === 'string') return { href: href(`/agents/${ref.agent_id}/tasks?task=${ref.task_id}`), label: 'Open task' };
  return null;
}

export function OwnerApprovalCard({ approval, onResolved, compact = false }: { approval: OwnerApproval; onResolved?: (a: OwnerApproval) => void; compact?: boolean }) {
  const { run, isPending } = useAction();
  const now = useNow(5000) / 1000;
  const expired = !approval.decision && approval.expires_at - now <= 0;
  const kind = OWNER_KIND[approval.kind] ?? { label: approval.kind.replace(/_/g, ' '), icon: <IconShield className="size-4 text-warn" /> };
  const link = ownerLink(approval);
  const decide = async (decision: 'approved' | 'denied') => {
    const r = await run(`o-${decision}`, () => api.ownerApprovals.resolve(approval.id, decision), {
      success: (res) => (res.decision === 'expired' ? 'The request had already expired' : decision === 'approved' ? 'Approved' : 'Denied'),
      errorTitle: 'Could not record the decision',
    });
    if (r) onResolved?.(r);
  };
  const approveLabel = approval.kind === 'schedule_misfire' ? 'Run it now' : 'Approve';
  const denyLabel = approval.kind === 'schedule_misfire' ? 'Skip' : 'Deny';
  return (
    <div className="rounded-xl border border-warn/25 bg-warn/[0.045] p-4" data-testid="owner-approval-card">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {kind.icon}
          <Badge tone="warn">{kind.label}</Badge>
          {approval.decision && <StatusPill state={approval.decision} />}
        </div>
        <Countdown expiresAt={approval.expires_at} decided={Boolean(approval.decision)} />
      </div>
      <p className="mt-2.5 text-sm leading-relaxed whitespace-pre-wrap text-text">{approval.summary}</p>
      {!compact && <Preview data={approval.preview} label="Details" />}
      <p className="mt-2.5 flex flex-wrap items-center gap-x-2 text-xs text-subtle">
        <span>Requested {relativeTime(approval.created_at)}</span>
        {link && (
          <>
            <span aria-hidden>·</span>
            <a className="rounded underline decoration-subtle/50 underline-offset-2 hover:text-text focus-ring" href={link.href}>
              {link.label}
            </a>
          </>
        )}
      </p>
      {!approval.decision && (
        <div className="mt-3.5 flex flex-wrap gap-2">
          <Button
            variant="primary"
            size="sm"
            onClick={() => decide('approved')}
            loading={isPending('o-approved')}
            disabled={isPending('o-denied')}
            disabledReason={expired ? 'This request has expired' : null}
          >
            {approveLabel}
          </Button>
          <Button
            variant="danger"
            size="sm"
            onClick={() => decide('denied')}
            loading={isPending('o-denied')}
            disabled={isPending('o-approved')}
            disabledReason={expired ? 'This request has expired' : null}
          >
            {denyLabel}
          </Button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- shared state
interface ApprovalsCtx {
  tasks: Approval[];
  owner: OwnerApproval[];
  count: number;
  loaded: boolean;
  error: unknown;
  reload: () => void;
  openPanel: () => void;
}

const Ctx = createContext<ApprovalsCtx>({ tasks: [], owner: [], count: 0, loaded: false, error: null, reload: () => {}, openPanel: () => {} });

export function useApprovals(): ApprovalsCtx {
  return useContext(Ctx);
}

/**
 * Loads pending approvals (polled + refreshed by SSE), pops up a dialog for requests that arrive while the
 * dashboard is open, and offers a panel with everything that is waiting.
 */
export function ApprovalsProvider({ children }: { children: ReactNode }) {
  // Requests and resolutions (including expiry) arrive as events; the poll is a safety net (5 min while live).
  const tasksQ = useApi(() => api.approvals.list(true), [], { pollMs: 60_000, livePollMs: 300_000 });
  const ownerQ = useApi(() => api.ownerApprovals.list(), [], { pollMs: 60_000, livePollMs: 300_000 });
  const [panel, setPanel] = useState(false);
  const [popup, setPopup] = useState<Set<string>>(new Set());
  const [deferred, setDeferred] = useState<Set<string>>(new Set());
  const reloadTasks = tasksQ.reload;
  const reloadOwner = ownerQ.reload;

  const markPopup = useCallback((ids: string[]) => setPopup((s) => new Set([...s, ...ids])), []);

  useNebulaEvents((ev) => {
    if (ev.type === 'task.approval.requested') {
      api.approvals.list(true).then(
        (list) => {
          tasksQ.setData(() => list);
          markPopup(list.filter((a) => !a.decision).map((a) => a.id));
        },
        () => reloadTasks(),
      );
    } else if (ev.type === 'task.approval.resolved') {
      const id = String(ev.payload.approval_id ?? '');
      tasksQ.setData((xs) => (xs ? xs.filter((a) => a.id !== id) : xs));
      reloadTasks();
    } else if (ev.type === 'owner.approval.requested') {
      const id = String(ev.payload.approval_id ?? '');
      api.ownerApprovals.list().then(
        (list) => {
          ownerQ.setData(() => list);
          markPopup(id ? [id] : list.map((a) => a.id));
        },
        () => reloadOwner(),
      );
    } else if (ev.type === 'owner.approval.resolved') {
      const id = String(ev.payload.approval_id ?? '');
      ownerQ.setData((xs) => (xs ? xs.filter((a) => a.id !== id) : xs));
    }
  });

  const tasks = useMemo(() => (tasksQ.data ?? []).filter((a) => !a.decision).sort((a, b) => a.created_at - b.created_at), [tasksQ.data]);
  const owner = useMemo(() => (ownerQ.data ?? []).filter((a) => !a.decision).sort((a, b) => a.created_at - b.created_at), [ownerQ.data]);
  const value = useMemo<ApprovalsCtx>(
    () => ({
      tasks,
      owner,
      count: tasks.length + owner.length,
      loaded: tasksQ.data !== null || ownerQ.data !== null,
      error: tasksQ.error ?? ownerQ.error,
      reload: () => {
        reloadTasks();
        reloadOwner();
      },
      openPanel: () => setPanel(true),
    }),
    [tasks, owner, tasksQ.data, ownerQ.data, tasksQ.error, ownerQ.error, reloadTasks, reloadOwner],
  );

  type Item = { kind: 'task'; a: Approval } | { kind: 'owner'; a: OwnerApproval };
  const queue: Item[] = [
    ...tasks.map((a) => ({ kind: 'task' as const, a })),
    ...owner.map((a) => ({ kind: 'owner' as const, a })),
  ].sort((x, y) => x.a.created_at - y.a.created_at);
  const current = panel ? null : (queue.find((i) => popup.has(i.a.id) && !deferred.has(i.a.id)) ?? null);
  const defer = () => {
    if (!current) return;
    setDeferred((s) => new Set(s).add(current.a.id));
  };
  const removeTask = (a: Approval) => tasksQ.setData((xs) => (xs ? xs.filter((x) => x.id !== a.id) : xs));
  const removeOwner = (a: OwnerApproval) => ownerQ.setData((xs) => (xs ? xs.filter((x) => x.id !== a.id) : xs));

  return (
    <Ctx.Provider value={value}>
      {children}
      <Modal
        open={current !== null}
        title={current?.kind === 'owner' ? 'NEBULA needs your decision' : 'An agent is asking for approval'}
        onClose={defer}
        footer={
          <Button variant="ghost" onClick={defer}>
            Decide later
          </Button>
        }
      >
        {current?.kind === 'task' && <ApprovalCard approval={current.a} onResolved={removeTask} />}
        {current?.kind === 'owner' && <OwnerApprovalCard approval={current.a} onResolved={removeOwner} />}
        <p className="mt-3 text-xs leading-relaxed text-muted">
          {current?.kind === 'owner'
            ? 'The automation waits until you decide. Unanswered requests are denied automatically when they expire.'
            : 'The task waits in WAITING_APPROVAL until you decide. Unanswered requests are denied automatically when they expire.'}
          {queue.length > 1 && ` ${queue.length - 1} more waiting in the approvals panel.`}
        </p>
      </Modal>
      <Drawer
        open={panel}
        onClose={() => setPanel(false)}
        title="Approvals"
        description="Everything that waits for your decision: agent actions and automation (workflows, commands, missed schedules)."
      >
        <ApprovalsList onTask={removeTask} onOwner={removeOwner} value={value} tasksError={tasksQ.error} ownerError={ownerQ.error} />
      </Drawer>
    </Ctx.Provider>
  );
}

function ApprovalsList({
  value,
  onTask,
  onOwner,
  tasksError,
  ownerError,
}: {
  value: ApprovalsCtx;
  onTask: (a: Approval) => void;
  onOwner: (a: OwnerApproval) => void;
  tasksError: unknown;
  ownerError: unknown;
}) {
  const agents = useApi(() => api.agents.list(), []);
  const agentName = (id: string) => agents.data?.find((a) => a.id === id)?.name;
  if (!value.loaded && !tasksError && !ownerError) return <LoadingRows label="Loading approvals…" />;
  return (
    <div className="space-y-6">
      <section>
        <h3 className="mb-2.5 text-xs font-semibold tracking-wide text-subtle uppercase">Agent actions ({value.tasks.length})</h3>
        {tasksError ? <ErrorBanner error={tasksError} onRetry={value.reload} /> : null}
        {value.tasks.length === 0 ? (
          <p className="text-sm text-muted">No agent is waiting for approval.</p>
        ) : (
          <div className="space-y-3">
            {value.tasks.map((a) => (
              <ApprovalCard key={a.id} approval={a} agentName={agentName(a.agent_id)} onResolved={onTask} />
            ))}
          </div>
        )}
      </section>
      <section>
        <h3 className="mb-2.5 text-xs font-semibold tracking-wide text-subtle uppercase">Automation ({value.owner.length})</h3>
        {ownerError ? <ErrorBanner error={ownerError} onRetry={value.reload} /> : null}
        {value.owner.length === 0 ? (
          <p className="text-sm text-muted">No workflow, command or missed schedule is waiting.</p>
        ) : (
          <div className="space-y-3">
            {value.owner.map((a) => (
              <OwnerApprovalCard key={a.id} approval={a} onResolved={onOwner} />
            ))}
          </div>
        )}
      </section>
      {value.count === 0 && !tasksError && !ownerError && (
        <EmptyState icon={<IconCheckCircle />} title="You're all caught up" compact>
          Agents ask here before sensitive actions; automations ask before risky steps.
        </EmptyState>
      )}
    </div>
  );
}

/** Kept for compatibility: the approvals dialog now lives in <ApprovalsProvider>. */
export function ApprovalCenter() {
  return null;
}
