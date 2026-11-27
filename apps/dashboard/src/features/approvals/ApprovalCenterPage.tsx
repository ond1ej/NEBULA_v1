// Approval Center (#/approvals): every pending decision in one place — sign-in requests of agents (Smart
// Authentication), agent tool approvals (with the exact proposed operation, environment and risk) and owner approvals
// (company plans, package installs, workflows, commands, …).
import { useMemo, useState, type ReactNode } from 'react';
import { IconApprovals, IconCalendar, IconCompanies, IconPackage, IconShield, IconTerminal, IconWorkflows } from '../../components/icons';
import { ConfirmDialog } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { Avatar, Badge, Button, Card, EmptyState, ErrorBanner, LoadingCards, LoadingRows, Mono, PageHeader, SegmentedControl, TextLink } from '../../components/ui';
import { useApi, useNow } from '../../hooks/useApi';
import { useLiveRefresh } from '../../hooks/useEvents';
import { isAuthEvent } from '../smartauth/core/lib';
import { SignInCard } from '../smartauth/SignIns';
import { href } from '../../hooks/useHashRoute';
import { formatDuration, formatTime, relativeTime, shortId } from '../../lib/format';
import {
  approvalsApi,
  describeDecider,
  isDestructive,
  isTaskItem,
  riskCategories,
  type ApprovalCenterData,
  type CenterItem,
  type Decision,
  type OwnerApprovalItem,
  type RecentDecision,
  type TaskApprovalItem,
} from './api';

type Group = 'all' | 'sign_in' | 'task' | 'company_plan' | 'install' | 'automation';

function groupOf(a: CenterItem): Exclude<Group, 'all' | 'sign_in'> {
  if (isTaskItem(a)) return 'task';
  if (a.kind === 'company_plan') return 'company_plan';
  if (a.kind === 'package_install' || a.kind === 'plugin') return 'install';
  return 'automation';
}

const GROUP_TITLE: Record<Exclude<Group, 'all' | 'sign_in'>, { title: string; description: string }> = {
  task: { title: 'Agent actions', description: 'A running task is paused until you decide on this exact operation.' },
  company_plan: { title: 'Company plans', description: 'A CEO agent proposed work items; nothing is executed before you approve.' },
  install: { title: 'Installs', description: 'Packages or plugins that would be installed.' },
  automation: { title: 'Automation', description: 'Workflows, commands and missed schedules.' },
};

const OWNER_KIND: Record<string, { label: string; icon: ReactNode }> = {
  company_plan: { label: 'Company plan', icon: <IconCompanies /> },
  package_install: { label: 'Package install', icon: <IconPackage /> },
  plugin: { label: 'Plugin', icon: <IconPackage /> },
  workflow: { label: 'Workflow', icon: <IconWorkflows /> },
  command: { label: 'Command', icon: <IconTerminal /> },
  schedule_misfire: { label: 'Missed schedule', icon: <IconCalendar /> },
};

const CATEGORY_LABEL: Record<string, string> = {
  privileged: 'privileged',
  mass_delete: 'mass delete',
  host_delete: 'deletes on the Mac',
  external_share: 'sends data out',
  payment: 'payment',
  credential_entry: 'credential entry',
  outbound_message: 'outbound message',
  system_change: 'system change',
  system_install: 'installs software',
  sensitive_file: 'sensitive file',
  explicit_request: 'agent asked',
};

export function EnvBadge({ env }: { env: string | null | undefined }) {
  return env === 'host' ? (
    <Badge tone="warn" title="Runs natively on this Mac">
      Mac
    </Badge>
  ) : (
    <Badge tone="info" title="Runs in the Ubuntu VM">
      VM
    </Badge>
  );
}

function Countdown({ expiresAt }: { expiresAt: number }) {
  const now = useNow(1000) / 1000;
  const left = expiresAt - now;
  return (
    <span role="timer" className={`text-xs tabular-nums ${left <= 0 ? 'text-danger' : left < 60 ? 'text-warn' : 'text-muted'}`}>
      {left <= 0 ? 'Expired' : `Expires in ${formatDuration(left)}`}
    </span>
  );
}

function JsonPreview({ data, label, open = false }: { data: unknown; label: string; open?: boolean }) {
  if (data == null || (typeof data === 'object' && Object.keys(data as object).length === 0)) return null;
  return (
    <details className="group mt-3" open={open}>
      <summary className="inline-flex cursor-pointer rounded text-xs font-medium text-muted hover:text-text focus-ring">{label}</summary>
      <pre className="mt-1.5 max-h-64 overflow-auto rounded-lg border border-border bg-input p-2.5 font-mono text-2xs leading-relaxed whitespace-pre-wrap break-all text-muted">
        {JSON.stringify(data, null, 2)}
      </pre>
    </details>
  );
}

function DecisionButtons({
  item,
  approveLabel = 'Approve',
  rejectLabel = 'Reject',
  onDecide,
  busy,
}: {
  item: CenterItem;
  approveLabel?: string;
  rejectLabel?: string;
  onDecide: (d: Decision) => void;
  busy: Decision | null;
}) {
  const now = useNow(5000) / 1000;
  const expired = item.expires_at - now <= 0;
  return (
    <div className="mt-4 flex flex-wrap gap-2">
      <Button variant="primary" size="sm" onClick={() => onDecide('approved')} loading={busy === 'approved'} disabled={busy === 'denied'} disabledReason={expired ? 'This request has expired' : null}>
        {approveLabel}
      </Button>
      <Button variant="danger" size="sm" onClick={() => onDecide('denied')} loading={busy === 'denied'} disabled={busy === 'approved'} disabledReason={expired ? 'This request has expired' : null}>
        {rejectLabel}
      </Button>
    </div>
  );
}

function TaskApprovalCard({ a, onDecide, busy }: { a: TaskApprovalItem; onDecide: (d: Decision) => void; busy: Decision | null }) {
  const cats = riskCategories(a.reason);
  const destructive = isDestructive(a);
  return (
    <article className={`rounded-xl border p-4 ${destructive ? 'border-danger/30 bg-danger/[0.04]' : 'border-warn/25 bg-warn/[0.04]'}`} aria-label={`Approval for ${a.agent_name ?? 'agent'}: ${a.tool}`} data-testid="center-task-approval">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <Avatar name={a.agent_name ?? 'Agent'} id={a.agent_id} size="sm" />
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-1.5 text-sm">
              <a href={href(`/agents/${a.agent_id}`)} className="rounded font-medium text-text hover:underline focus-ring">
                {a.agent_name ?? shortId(a.agent_id)}
              </a>
              <EnvBadge env={a.environment} />
              <Mono className="text-text">{a.tool}</Mono>
              {destructive && <Badge tone="danger">Destructive</Badge>}
            </p>
            <p className="text-2xs text-subtle">
              Requested {relativeTime(a.created_at)} by {a.requested_by}
            </p>
          </div>
        </div>
        <Countdown expiresAt={a.expires_at} />
      </header>

      {a.prompt && (
        <div className="mt-3">
          <p className="text-2xs font-semibold tracking-wider text-subtle uppercase">Task</p>
          <p className="mt-0.5 line-clamp-3 text-sm break-words text-muted">{a.prompt}</p>
        </div>
      )}
      <div className="mt-3">
        <p className="text-2xs font-semibold tracking-wider text-subtle uppercase">Proposed operation</p>
        <p className="mt-1 rounded-lg border border-border bg-input px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words text-text">{a.action_summary}</p>
      </div>
      {a.reason && (
        <div className="mt-3">
          <p className="text-2xs font-semibold tracking-wider text-subtle uppercase">Why approval is needed</p>
          <p className="mt-0.5 text-sm text-warn">{a.reason}</p>
          {cats.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {cats.map((c) => (
                <Badge key={c} tone={['mass_delete', 'host_delete', 'system_change', 'system_install', 'privileged', 'payment', 'credential_entry'].includes(c) ? 'danger' : 'warn'}>
                  {CATEGORY_LABEL[c] ?? c}
                </Badge>
              ))}
            </div>
          )}
        </div>
      )}
      <JsonPreview data={a.action_preview} label="Exact arguments (preview JSON)" open />
      <p className="mt-3 text-xs text-subtle">
        Task{' '}
        <TextLink href={href(`/agents/${a.agent_id}/tasks?task=${a.task_id}`)}>
          <Mono className="text-[11px] text-accent-soft">{shortId(a.task_id)}</Mono>
        </TextLink>
      </p>
      <DecisionButtons item={a} onDecide={onDecide} busy={busy} />
    </article>
  );
}

function ownerLink(a: OwnerApprovalItem): { href: string; label: string } | null {
  const ref = (a.ref ?? {}) as Record<string, unknown>;
  if (a.kind === 'company_plan' && typeof ref.company_id === 'string') return { href: href(`/companies/${ref.company_id}`), label: 'Open company' };
  if (a.kind === 'schedule_misfire' && typeof ref.schedule_id === 'string') return { href: href(`/schedules/${ref.schedule_id}`), label: 'Open schedule' };
  if (a.kind === 'workflow' || a.kind === 'command') return { href: href('/workflows'), label: 'Open workflows' };
  if (typeof ref.task_id === 'string' && typeof ref.agent_id === 'string') return { href: href(`/agents/${ref.agent_id}/tasks?task=${ref.task_id}`), label: 'Open task' };
  return null;
}

function OwnerApprovalCard({ a, onDecide, busy }: { a: OwnerApprovalItem; onDecide: (d: Decision) => void; busy: Decision | null }) {
  const kind = OWNER_KIND[a.kind] ?? { label: a.kind.replace(/_/g, ' '), icon: <IconShield /> };
  const link = ownerLink(a);
  const destructive = isDestructive(a);
  return (
    <article className={`rounded-xl border p-4 ${destructive ? 'border-danger/30 bg-danger/[0.04]' : 'border-warn/25 bg-warn/[0.04]'}`} aria-label={`${kind.label}: ${a.summary.slice(0, 80)}`} data-testid="center-owner-approval">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <p className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm">
          <span className="text-warn [&>svg]:size-4">{kind.icon}</span>
          <Badge tone="warn">{kind.label}</Badge>
          {destructive && <Badge tone="danger">Changes the system</Badge>}
        </p>
        <Countdown expiresAt={a.expires_at} />
      </header>
      <p className="mt-3 text-sm leading-relaxed whitespace-pre-wrap break-words text-text">{a.summary}</p>
      <JsonPreview data={a.preview} label={a.kind === 'company_plan' ? 'Proposed plan' : 'Details'} open={a.kind === 'company_plan' || a.kind === 'package_install'} />
      <p className="mt-3 flex flex-wrap items-center gap-x-2 text-xs text-subtle">
        <span>Requested {relativeTime(a.created_at)}</span>
        {link && (
          <>
            <span aria-hidden>·</span>
            <TextLink href={link.href}>{link.label}</TextLink>
          </>
        )}
      </p>
      <DecisionButtons
        item={a}
        onDecide={onDecide}
        busy={busy}
        approveLabel={a.kind === 'schedule_misfire' ? 'Run it now' : a.kind === 'company_plan' ? 'Approve plan' : 'Approve'}
        rejectLabel={a.kind === 'schedule_misfire' ? 'Skip' : 'Reject'}
      />
    </article>
  );
}

const DECISION_TONE = { approved: 'success', denied: 'danger', expired: 'neutral' } as const;

function RecentList({ rows }: { rows: RecentDecision[] }) {
  if (rows.length === 0) return <p className="px-4 py-5 text-sm text-muted sm:px-5">No decisions yet.</p>;
  return (
    <ul aria-label="Recent decisions">
      {rows.map((r) => {
        const d = describeDecider(r.resolved_by);
        return (
          <li key={r.id} className="border-b border-border/60 px-4 py-3 last:border-0 sm:px-5">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge tone={DECISION_TONE[r.decision as keyof typeof DECISION_TONE] ?? 'neutral'} dot>
                {r.decision}
              </Badge>
              <Mono className="text-text">{r.tool}</Mono>
            </div>
            <p className="mt-1 line-clamp-2 text-xs break-words text-muted">{r.action_summary}</p>
            <p className="mt-1 text-2xs text-subtle">
              by <span className="text-muted">{d.channel}</span>
              {d.who && <span className="text-muted"> · {d.who}</span>}
              {r.resolved_at ? (
                <>
                  {' '}
                  ·{' '}
                  <time dateTime={new Date(r.resolved_at * 1000).toISOString()} title={formatTime(r.resolved_at)}>
                    {relativeTime(r.resolved_at)}
                  </time>
                </>
              ) : null}
            </p>
            {r.resolved_by && <p className="sr-only">Decided by {r.resolved_by}</p>}
          </li>
        );
      })}
    </ul>
  );
}

export function ApprovalCenterPage(_props: Record<string, never>) {
  const toast = useToast();
  const center = useApi<ApprovalCenterData>((s) => approvalsApi.center(s), [], { pollMs: 30_000 });
  const [filter, setFilter] = useState<Group>('all');
  const [busy, setBusy] = useState<Record<string, Decision>>({});
  const [confirm, setConfirm] = useState<CenterItem | null>(null);
  useLiveRefresh(center.reload, (e) => e.type.startsWith('task.approval.') || e.type.startsWith('owner.approval.') || e.type === 'company.run.started' || isAuthEvent(e), 300);

  const pending = useMemo(() => [...(center.data?.pending ?? [])].sort((a, b) => a.expires_at - b.expires_at), [center.data]);
  const signIns = center.data?.sign_ins ?? [];
  const counts = useMemo(() => {
    const c: Record<Group, number> = { all: pending.length + signIns.length, sign_in: signIns.length, task: 0, company_plan: 0, install: 0, automation: 0 };
    for (const a of pending) c[groupOf(a)] += 1;
    return c;
  }, [pending, signIns.length]);
  const groups = (['task', 'company_plan', 'install', 'automation'] as const).filter((g) => (filter === 'all' || filter === g) && counts[g] > 0);
  const showSignIns = (filter === 'all' || filter === 'sign_in') && signIns.length > 0;

  const decide = async (a: CenterItem, decision: Decision) => {
    setBusy((b) => ({ ...b, [a.id]: decision }));
    try {
      const r = isTaskItem(a) ? await approvalsApi.decideTask(a.id, decision) : await approvalsApi.decideOwner(a.id, decision);
      if (r.decision === 'expired') toast.warn('The request had already expired', 'Nothing was executed.');
      else toast.success(decision === 'approved' ? 'Approved' : 'Rejected', isTaskItem(a) ? `${a.agent_name ?? 'The agent'} continues with your decision.` : undefined);
      center.setData((p) => (p ? { ...p, pending: p.pending.filter((x) => x.id !== a.id) } : p));
      center.reload();
      return true;
    } catch (e) {
      toast.error(e, 'Could not record the decision');
      return false;
    } finally {
      setBusy((b) => {
        const n = { ...b };
        delete n[a.id];
        return n;
      });
    }
  };

  const onDecide = (a: CenterItem) => (d: Decision) => {
    if (d === 'approved' && isDestructive(a)) setConfirm(a);
    else void decide(a, d);
  };

  const options: { value: Group; label: string }[] = [
    { value: 'all', label: `All (${counts.all})` },
    { value: 'sign_in', label: `Sign-ins (${counts.sign_in})` },
    { value: 'task', label: `Agent actions (${counts.task})` },
    { value: 'company_plan', label: `Company plans (${counts.company_plan})` },
    { value: 'install', label: `Installs (${counts.install})` },
    { value: 'automation', label: `Automation (${counts.automation})` },
  ];

  return (
    <>
      <PageHeader
        title="Approval Center"
        icon={<IconApprovals className="size-6 text-accent-soft" />}
        description="Everything that waits for your decision. The same requests appear in Telegram and the Mini App; whoever decides first wins and the others update."
        meta={center.data ? <Badge tone={counts.all ? 'warn' : 'success'}>{counts.all ? `${counts.all} pending` : 'Nothing pending'}</Badge> : undefined}
      />
      {center.error && !center.data ? (
        <ErrorBanner error={center.error} onRetry={center.reload} title="Could not load approvals" />
      ) : (
        <div className="grid gap-5 xl:grid-cols-3">
          <div className="min-w-0 space-y-5 xl:col-span-2">
            <SegmentedControl<Group> label="Filter approvals" size="sm" value={filter} onChange={setFilter} options={options} />
            {!center.data ? (
              <LoadingCards count={2} className="grid gap-4" label="Loading approvals…" />
            ) : groups.length === 0 && !showSignIns ? (
              <EmptyState icon={<IconApprovals />} title={filter === 'all' ? 'Nothing waits for you' : 'Nothing pending in this group'}>
                When an agent wants to do something sensitive, a company plan is proposed or a package should be installed, it appears here (and in Telegram) with the exact operation.
              </EmptyState>
            ) : (
              <>
              {showSignIns && (
                <section aria-labelledby="ap-group-sign_in" className="space-y-3">
                  <div>
                    <h2 id="ap-group-sign_in" className="text-sm font-semibold text-text">
                      Sign-in requests <span className="font-normal text-subtle">({signIns.length})</span>
                    </h2>
                    <p className="mt-0.5 text-xs text-muted">An agent’s task waits until you sign in to a website. What you type goes only to the isolated sign-in browser.</p>
                  </div>
                  {signIns.map((s) => (
                    <SignInCard key={s.id} s={s} onChanged={() => center.reload()} />
                  ))}
                </section>
              )}
              {groups.map((g) => (
                <section key={g} aria-labelledby={`ap-group-${g}`} className="space-y-3">
                  <div>
                    <h2 id={`ap-group-${g}`} className="text-sm font-semibold text-text">
                      {GROUP_TITLE[g].title} <span className="font-normal text-subtle">({counts[g]})</span>
                    </h2>
                    <p className="mt-0.5 text-xs text-muted">{GROUP_TITLE[g].description}</p>
                  </div>
                  {pending
                    .filter((a) => groupOf(a) === g)
                    .map((a) =>
                      isTaskItem(a) ? (
                        <TaskApprovalCard key={a.id} a={a} onDecide={onDecide(a)} busy={busy[a.id] ?? null} />
                      ) : (
                        <OwnerApprovalCard key={a.id} a={a} onDecide={onDecide(a)} busy={busy[a.id] ?? null} />
                      ),
                    )}
                </section>
              ))}
              </>
            )}
          </div>
          <div className="min-w-0">
            <Card title="Recent decisions" subtitle="Agent tool approvals, newest first" padded={false}>
              {!center.data ? (
                <div className="p-5">
                  <LoadingRows rows={4} />
                </div>
              ) : (
                <RecentList rows={center.data.recent} />
              )}
            </Card>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirm !== null}
        title="Approve a destructive operation?"
        confirmLabel="Approve"
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          if (!confirm) return;
          if (await decide(confirm, 'approved')) setConfirm(null);
        }}
      >
        {confirm && (
          <>
            <p>
              {isTaskItem(confirm) ? (
                <>
                  <strong>{confirm.agent_name ?? 'The agent'}</strong> will run <strong>{confirm.tool}</strong> {confirm.environment === 'host' ? 'natively on this Mac' : 'in the Ubuntu VM'}:
                </>
              ) : (
                <>
                  This <strong>{(OWNER_KIND[confirm.kind]?.label ?? confirm.kind).toLowerCase()}</strong> will be executed:
                </>
              )}
            </p>
            <p className="rounded-lg border border-border bg-input px-3 py-2 font-mono text-xs whitespace-pre-wrap break-words text-text">{isTaskItem(confirm) ? confirm.action_summary : confirm.summary}</p>
            {isTaskItem(confirm) && confirm.reason && <p className="text-warn">{confirm.reason}</p>}
            <p>Deleted data or system changes may not be reversible.</p>
          </>
        )}
      </ConfirmDialog>
    </>
  );
}
