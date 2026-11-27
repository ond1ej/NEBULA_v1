// Approval cards shared by Activity and the inline task details in a chat: task approvals, owner approvals and
// Password Vault sign-in approvals ("Approve once" / "Deny"). The owner always sees the exact text being approved.
import { useState } from 'react';
import { relativeTime, shortId } from '../lib/format';
import type { Approval, Json } from '../types';
import { useMini } from './context';
import { useActions } from './hooks';
import { IcCheck, IcX } from './icons';
import { mhref } from './router';
import { isTaskApproval, type CenterApproval, type VaultSignInPreview } from './types';
import { Btn, Pill, Sheet } from './uiKit';

const KIND_LABEL: Record<string, string> = {
  task: 'Agent action',
  workflow: 'Workflow',
  command: 'Command',
  schedule_misfire: 'Missed schedule',
  package_install: 'Package install',
  plugin: 'Plugin',
  company_plan: 'Company plan',
};

/** One approval, whichever endpoint it came from. */
export interface ApprovalView {
  key: string;
  kind: 'task' | 'owner';
  id: string;
  label: string;
  summary: string;
  reason: string | null;
  agentName: string | null;
  tool: string | null;
  environment: string | null;
  taskId: string | null;
  prompt: string | null;
  expiresAt: number | null;
  preview: Json | null;
  vault: VaultSignInPreview | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * The vault sign-in preview, reduced to its documented, non-secret fields. Anything else the object carries is
 * dropped here and never rendered.
 */
export function vaultPreview(p: unknown, tool?: string | null): VaultSignInPreview | null {
  if (!p || typeof p !== 'object') return null;
  const o = p as Record<string, unknown>;
  if (o.kind !== 'vault_sign_in' && tool !== 'vault_sign_in') return null;
  return {
    kind: 'vault_sign_in',
    agent_name: str(o.agent_name) ?? 'Agent',
    credential_name: str(o.credential_name) ?? 'a saved credential',
    origin: str(o.origin) ?? 'unknown site',
    operation: str(o.operation) ?? 'sign_in',
    task_id: str(o.task_id) ?? '',
    expires_at: num(o.expires_at),
  };
}

export function fromCenter(a: CenterApproval): ApprovalView {
  if (isTaskApproval(a)) {
    const vault = vaultPreview(a.action_preview, a.tool);
    return {
      key: `task:${a.id}`,
      kind: 'task',
      id: a.id,
      label: vault ? 'Password Vault' : KIND_LABEL.task,
      summary: a.action_summary,
      reason: a.reason,
      agentName: a.agent_name,
      tool: a.tool,
      environment: a.environment,
      taskId: a.task_id,
      prompt: a.prompt,
      expiresAt: a.expires_at,
      preview: null,
      vault,
    };
  }
  return {
    key: `owner:${a.id}`,
    kind: 'owner',
    id: a.id,
    label: KIND_LABEL[a.kind] ?? a.kind.replace(/_/g, ' '),
    summary: a.summary,
    reason: null,
    agentName: null,
    tool: null,
    environment: null,
    taskId: null,
    prompt: null,
    expiresAt: a.expires_at,
    preview: a.preview,
    vault: null,
  };
}

export function fromTaskApproval(a: Approval, agentName: string | null = null): ApprovalView {
  const vault = vaultPreview(a.action_preview, a.tool);
  return {
    key: `task:${a.id}`,
    kind: 'task',
    id: a.id,
    label: vault ? 'Password Vault' : KIND_LABEL.task,
    summary: a.action_summary,
    reason: a.reason,
    agentName,
    tool: a.tool,
    environment: null,
    taskId: a.task_id,
    prompt: null,
    expiresAt: a.expires_at,
    preview: null,
    vault,
  };
}

const OPERATION: Record<string, string> = { sign_in: 'Sign in', fill: 'Fill the sign-in form', use_token: 'Use the API token' };

function VaultDetails({ v }: { v: VaultSignInPreview }) {
  return (
    <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-subhead" data-testid="vault-approval">
      <dt className="text-muted">Agent</dt>
      <dd className="text-text">{v.agent_name}</dd>
      <dt className="text-muted">Credential</dt>
      <dd className="text-text">{v.credential_name}</dd>
      <dt className="text-muted">Destination</dt>
      <dd className="font-mono text-footnote break-all text-text">{v.origin}</dd>
      <dt className="text-muted">Action</dt>
      <dd className="text-text">{OPERATION[v.operation] ?? v.operation.replace(/_/g, ' ')}</dd>
      {v.task_id && (
        <>
          <dt className="text-muted">Task</dt>
          <dd>
            <a className="text-accent-soft underline underline-offset-2" href={mhref(`/tasks/${v.task_id}`)}>
              {shortId(v.task_id)}
            </a>
          </dd>
        </>
      )}
      {v.expires_at && (
        <>
          <dt className="text-muted">Expires</dt>
          <dd className="text-text">{relativeTime(v.expires_at)}</dd>
        </>
      )}
    </dl>
  );
}

/** Pending approval with inline Approve / Deny (each opens a confirmation that quotes the exact action). */
export function ApprovalCard({ a, canApprove, onDone }: { a: ApprovalView; canApprove: boolean; onDone?: () => void }) {
  const [decide, setDecide] = useState<'approved' | 'denied' | null>(null);
  return (
    <div className="rounded-card bg-panel p-4">
      <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
        <Pill tone="warning">{a.label}</Pill>
        {a.agentName && !a.vault && <span className="text-subhead font-medium text-text">{a.agentName}</span>}
        {a.tool && !a.vault && <Pill>{a.tool}</Pill>}
        {a.expiresAt && <span className="ml-auto text-caption text-subtle">expires {relativeTime(a.expiresAt)}</span>}
      </div>
      <p className="text-body whitespace-pre-wrap text-text [overflow-wrap:anywhere]" data-testid="approval-summary">
        {a.summary}
      </p>
      {a.vault && <VaultDetails v={a.vault} />}
      {a.reason && <p className="mt-1 text-footnote text-muted">Why: {a.reason}</p>}
      {a.taskId && !a.vault && (
        <p className="mt-1 text-footnote text-subtle">
          Task{' '}
          <a className="text-accent-soft underline underline-offset-2" href={mhref(`/tasks/${a.taskId}`)}>
            {shortId(a.taskId)}
          </a>
          {a.prompt ? ` · ${a.prompt.slice(0, 80)}` : ''}
        </p>
      )}
      {a.preview && Object.keys(a.preview).length > 0 && (
        <details className="mt-2">
          <summary className="inline-flex min-h-11 items-center text-footnote font-medium text-accent-soft">Show details</summary>
          <pre className="max-h-48 overflow-auto rounded-xl bg-panel-2 p-2 font-mono text-[11px] whitespace-pre-wrap text-muted [overflow-wrap:anywhere]">{JSON.stringify(a.preview, null, 2)}</pre>
        </details>
      )}
      {canApprove ? (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <Btn variant="danger" icon={<IcX />} onClick={() => setDecide('denied')}>
            Deny
          </Btn>
          <Btn variant="primary" icon={<IcCheck />} onClick={() => setDecide('approved')}>
            {a.vault ? 'Approve once' : 'Approve'}
          </Btn>
        </div>
      ) : (
        <p className="mt-2 text-footnote text-subtle" data-testid="owner-only-approval">
          Only the NEBULA owner can approve or deny this, in the main bot’s Mini App or in the Dashboard.
        </p>
      )}
      {decide && <DecideSheet a={a} decision={decide} onClose={() => setDecide(null)} onDone={onDone} />}
    </div>
  );
}

export function DecideSheet({ a, decision, onClose, onDone }: { a: ApprovalView; decision: 'approved' | 'denied'; onClose: () => void; onDone?: () => void }) {
  const { api } = useMini();
  const { run, isPending } = useActions();
  const approve = decision === 'approved';
  const submit = async () => {
    const r = await run('decide', () => (a.kind === 'task' ? api.approvals.resolveTask(a.id, decision) : api.approvals.resolveOwner(a.id, decision)), {
      success: approve ? (a.vault ? 'Approved once' : 'Approved') : 'Denied',
    });
    if (r !== undefined) {
      onClose();
      onDone?.();
    }
  };
  const busy = isPending('decide');
  const confirmLabel = approve ? (a.vault ? 'Approve once' : 'Approve') : 'Deny';
  return (
    <Sheet
      open
      title={approve ? (a.vault ? 'Allow this sign-in once?' : 'Approve this action?') : 'Deny this action?'}
      onClose={onClose}
      dismissible={!busy}
      footer={
        <>
          <Btn className="flex-1" onClick={onClose} disabled={busy}>
            Cancel
          </Btn>
          <Btn className="flex-1" variant={approve ? 'primary' : 'danger'} loading={busy} onClick={submit}>
            {confirmLabel}
          </Btn>
        </>
      }
    >
      <p className="mb-2 text-footnote text-muted">{approve ? 'You are allowing exactly this:' : 'You are refusing exactly this:'}</p>
      <blockquote className="rounded-xl bg-panel-2 p-3 text-body whitespace-pre-wrap text-text [overflow-wrap:anywhere]" data-testid="decide-summary">
        {a.summary}
      </blockquote>
      {a.vault && <VaultDetails v={a.vault} />}
      {(a.agentName || a.tool) && !a.vault && (
        <p className="mt-2 text-footnote text-subtle">
          {[a.agentName, a.tool, a.environment === 'host' ? 'Mac mini' : a.environment === 'vm' ? 'Ubuntu VM' : null].filter(Boolean).join(' · ')}
        </p>
      )}
    </Sheet>
  );
}
