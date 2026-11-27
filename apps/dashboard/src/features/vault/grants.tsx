// Agent grants (who may use which credential, where, with which approval) and the redacted vault history.
import { useId, useState, type ReactNode } from 'react';
import { api } from '../../api';
import { ConfirmDialog, Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { IconActivity, IconPlus, IconShield, IconTrash, IconX } from '../../components/icons';
import { Badge, Button, DataTable, EmptyState, ErrorBanner, Field, Input, LoadingRows, Mono, Notice, Select, Switch, TextLink, type Column, type Tone } from '../../components/ui';
import { useAction, useApi } from '../../hooks/useApi';
import { useLiveRefresh } from '../../hooks/useEvents';
import { href } from '../../hooks/useHashRoute';
import { formatTime, relativeTime, shortId } from '../../lib/format';
import { vaultApi } from './api';
import { ACTION_LABEL, VAULT_OP_LABEL, epochToLocalInput, localInputToEpoch, originOf, POLICY_HINT, POLICY_LABEL } from './lib';
import type { ApprovalPolicy, GrantBody, GrantPatch, VaultAuditRow, VaultEntry, VaultGrant } from './types';

const isVaultEvent = (ev: { type: string }) => ev.type === 'vault.status.changed' || ev.type === 'vault.access';

export function grantState(g: VaultGrant, now = Date.now() / 1000): { label: string; tone: Tone } {
  if (!g.enabled) return { label: 'Revoked', tone: 'neutral' };
  if (g.expires_at && g.expires_at <= now) return { label: 'Expired', tone: 'warn' };
  return { label: 'Active', tone: 'success' };
}

// ---------------------------------------------------------------- grant table (overview + agent tab)
export function GrantTable({
  grants,
  agentName,
  manageReason,
  onEdit,
  onChanged,
  label = 'Agent grants',
}: {
  grants: VaultGrant[];
  /** Show an Agent column (overview of all agents). */
  agentName?: (id: string) => string;
  /** Why the owner cannot edit / delete here (not local / locked), or null. Revoke always works. */
  manageReason: { edit: string | null; remove: string | null };
  onEdit?: (g: VaultGrant) => void;
  onChanged: () => void;
  label?: string;
}) {
  const toast = useToast();
  const { run, isPending } = useAction();
  const [deleting, setDeleting] = useState<VaultGrant | null>(null);

  const revoke = async (g: VaultGrant) => {
    const r = await run(`revoke-${g.id}`, () => vaultApi.revokeGrant(g.id), { errorTitle: 'Grant not revoked' });
    if (r) {
      toast.success('Grant revoked', `${g.entry_name ?? 'The credential'} can no longer be used by this agent.`);
      onChanged();
    }
  };

  const columns: Column<VaultGrant>[] = [];
  if (agentName) {
    columns.push({ key: 'agent', header: 'Agent', mobile: 'subtitle', cell: (g) => <TextLink href={href(`/agents/${g.agent_id}/security`)}>{agentName(g.agent_id)}</TextLink> });
  }
  columns.push(
    { key: 'entry', header: 'Credential', mobile: 'title', cell: (g) => <span className="font-medium text-text">{g.entry_name ?? 'Deleted credential'}</span> },
    {
      key: 'origins',
      header: 'Origins',
      cell: (g) => (
        <span className="flex flex-col gap-0.5">
          {g.allowed_origins.map((o) => (
            <Mono key={o} className="break-all text-text">
              {o}
            </Mono>
          ))}
        </span>
      ),
    },
    { key: 'action', header: 'Action', cell: (g) => g.allowed_actions.map((a) => ACTION_LABEL[a] ?? a).join(', ') },
    { key: 'policy', header: 'Approval', cell: (g) => <Badge tone={g.approval_policy === 'auto' ? 'warn' : 'neutral'}>{POLICY_LABEL[g.approval_policy] ?? g.approval_policy}</Badge> },
    { key: 'expiry', header: 'Expires', cell: (g) => (g.expires_at ? <span title={formatTime(g.expires_at)}>{relativeTime(g.expires_at)}</span> : <span className="text-subtle">Never</span>) },
    { key: 'used', header: 'Last used', cell: (g) => (g.last_used_at ? <span title={formatTime(g.last_used_at)}>{relativeTime(g.last_used_at)}</span> : <span className="text-subtle">Never</span>) },
    {
      key: 'state',
      header: 'Status',
      mobile: 'aside',
      cell: (g) => {
        const s = grantState(g);
        return (
          <Badge tone={s.tone} dot>
            {s.label}
          </Badge>
        );
      },
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (g) => (
        <span className="inline-flex flex-wrap justify-end gap-1.5">
          {onEdit && (
            <Button size="xs" disabledReason={manageReason.edit} onClick={() => onEdit(g)} aria-label={`Edit grant for ${g.entry_name ?? 'credential'}`}>
              Edit
            </Button>
          )}
          {g.enabled && (
            <Button size="xs" variant="outline" loading={isPending(`revoke-${g.id}`)} onClick={() => void revoke(g)} aria-label={`Revoke grant for ${g.entry_name ?? 'credential'}`}>
              Revoke
            </Button>
          )}
          <Button size="xs" variant="danger" icon={<IconTrash />} disabledReason={manageReason.remove} onClick={() => setDeleting(g)} aria-label={`Delete grant for ${g.entry_name ?? 'credential'}`}>
            Delete
          </Button>
        </span>
      ),
    },
  );

  return (
    <>
      <DataTable label={label} rows={grants} rowKey={(g) => g.id} columns={columns} minWidth={agentName ? 980 : 880} dense />
      <ConfirmDialog
        open={deleting !== null}
        title="Delete this grant?"
        confirmLabel="Delete grant"
        busyText="Deleting…"
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return;
          const r = await run('delete-grant', () => vaultApi.deleteGrant(deleting.id), { errorTitle: 'Grant not deleted' });
          if (r) {
            toast.success('Grant deleted');
            setDeleting(null);
            onChanged();
          }
        }}
      >
        <p>
          {agentName ? <strong>{agentName(deleting?.agent_id ?? '')}</strong> : 'This agent'} loses access to <strong>{deleting?.entry_name ?? 'the credential'}</strong>. Use Revoke
          instead to keep the grant in the list.
        </p>
      </ConfirmDialog>
    </>
  );
}

/** Every grant of every agent (Password Vault → Agent access). */
export function GrantsOverview({ manageReason }: { manageReason: string | null }) {
  const grants = useApi((signal) => vaultApi.grants(signal), []);
  const agents = useApi(() => api.agents.list(), []);
  useLiveRefresh(grants.reload, isVaultEvent, 400);
  const names = new Map((agents.data ?? []).map((a) => [a.id, a.name]));
  const agentName = (id: string) => names.get(id) ?? shortId(id);
  if (grants.error && !grants.data) return <ErrorBanner error={grants.error} onRetry={grants.reload} />;
  if (!grants.data) return <LoadingRows rows={3} label="Loading grants…" />;
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        Agents have no vault access unless you grant it in <strong className="text-text">Agent → Security</strong>. Revoking works even while the vault is locked.
      </p>
      {grants.data.length === 0 ? (
        <EmptyState compact icon={<IconShield />} title="No agent has access to a credential">
          Open an agent’s Security tab to allow it to sign in with a credential.
        </EmptyState>
      ) : (
        <GrantTable grants={grants.data} agentName={agentName} manageReason={{ edit: manageReason, remove: manageReason }} onChanged={grants.reload} label="All agent grants" />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- add / edit grant
export function GrantDialog({
  agentId,
  agentName,
  entries,
  grant,
  onClose,
  onSaved,
}: {
  agentId: string;
  agentName: string;
  /** Credentials to pick from (add mode). */
  entries: VaultEntry[];
  /** Edit mode when set. */
  grant: VaultGrant | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const ids = { entry: useId(), origin: useId(), policy: useId(), expiry: useId() };
  const websites = entries.filter((e) => e.credential_type === 'website' && e.origin);
  const [entryId, setEntryId] = useState(grant?.entry_id ?? websites[0]?.id ?? '');
  const entry = grant ? null : (websites.find((e) => e.id === entryId) ?? null);
  // The credential's own origin is always part of a grant (the host enforces it) and cannot be removed here.
  const own = grant ? (entries.find((e) => e.id === grant.entry_id)?.origin ?? null) : (entry?.origin ?? null);
  const [extra, setExtra] = useState<string[]>(() => (grant ? grant.allowed_origins.filter((o) => o !== own) : []));
  const [newOrigin, setNewOrigin] = useState('');
  const [policy, setPolicy] = useState<ApprovalPolicy>(grant?.approval_policy ?? 'always_ask');
  const [expiry, setExpiry] = useState(epochToLocalInput(grant?.expires_at));
  const [enabled, setEnabled] = useState(grant?.enabled ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  // Further origins only when the owner adds them explicitly.
  const origins = own ? [own, ...extra.filter((o) => o !== own)] : extra;
  const singleOrigin = origins.length === 1;
  const effectivePolicy: ApprovalPolicy = policy === 'auto' && !singleOrigin ? 'always_ask' : policy;
  const expiresAt = localInputToEpoch(expiry);
  const expiryChanged = grant ? expiry !== epochToLocalInput(grant.expires_at) : Boolean(expiry);
  const expiryInvalid = expiryChanged && expiry && (!expiresAt || expiresAt <= Date.now() / 1000) ? 'The expiry must be in the future' : null;
  const candidate = newOrigin.trim() ? originOf(newOrigin) : '';

  const addOrigin = () => {
    if (!candidate || origins.includes(candidate)) return;
    setExtra((xs) => [...xs, candidate]);
    setNewOrigin('');
    if (policy === 'auto') setPolicy('always_ask');
  };
  const removeOrigin = (o: string) => setExtra((xs) => xs.filter((x) => x !== o));

  // Edit mode: only what the owner changed.
  const patch: GrantPatch = {};
  if (grant) {
    if ([...origins].sort().join(' ') !== [...grant.allowed_origins].sort().join(' ')) patch.allowed_origins = origins;
    if (effectivePolicy !== grant.approval_policy) patch.approval_policy = effectivePolicy;
    if (expiryChanged) {
      if (expiresAt) patch.expires_at = expiresAt;
      else patch.clear_expiry = true;
    }
    if (enabled !== grant.enabled) patch.enabled = enabled;
  }

  const invalid =
    !grant && !entry
      ? 'Choose a website credential'
      : origins.length === 0
        ? 'At least one origin is required'
        : (expiryInvalid ?? (grant && Object.keys(patch).length === 0 ? 'No changes' : null));

  const save = async () => {
    if (invalid || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (grant) {
        await vaultApi.updateGrant(grant.id, patch);
        toast.success('Grant updated');
      } else {
        const body: GrantBody = { entry_id: entryId, allowed_origins: origins, allowed_actions: ['sign_in'], approval_policy: effectivePolicy };
        if (expiresAt) body.expires_at = expiresAt;
        await vaultApi.createGrant(agentId, body);
        toast.success('Grant created', `${agentName} may now ask to sign in with ${entry?.display_name ?? 'the credential'}.`);
      }
      onSaved();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const policyOptions: ApprovalPolicy[] = singleOrigin ? ['always_ask', 'once_per_task', 'auto'] : ['always_ask', 'once_per_task'];

  return (
    <Modal
      open
      size="md"
      title={grant ? `Edit grant · ${grant.entry_name ?? 'credential'}` : `Grant a credential to ${agentName}`}
      description="The agent never sees the password: NEBULA signs in separately and hands over only the session."
      onClose={onClose}
      dismissible={!busy}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabledReason={busy ? null : invalid} onClick={() => void save()}>
            {grant ? 'Save grant' : 'Create grant'}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        {!grant &&
          (websites.length === 0 ? (
            <Notice tone="info">No website credential with an origin yet. Add one in the Password Vault first — only website credentials can be used by agents.</Notice>
          ) : (
            <Field htmlFor={ids.entry} label="Credential" required>
              <Select
                id={ids.entry}
                value={entryId}
                onChange={(e) => {
                  setEntryId(e.target.value);
                  setExtra([]);
                }}
              >
                {websites.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.display_name} — {e.origin}
                  </option>
                ))}
              </Select>
            </Field>
          ))}
        <div className="space-y-2">
          <p className="text-[13px] font-medium text-text">Allowed origins</p>
          <ul className="space-y-1.5" aria-label="Allowed origins">
            {origins.map((o) => {
              const fixed = o === own || origins.length === 1;
              return (
                <li key={o} className="flex items-center justify-between gap-2 rounded-lg border border-border bg-panel-2 px-2.5 py-1.5">
                  <Mono className="break-all text-text">{o}</Mono>
                  {fixed ? (
                    <span className="text-2xs text-subtle">{o === own ? 'credential origin' : 'required'}</span>
                  ) : (
                    <Button size="xs" variant="ghost" icon={<IconX />} aria-label={`Remove origin ${o}`} onClick={() => removeOrigin(o)}>
                      Remove
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
          <Field htmlFor={ids.origin} label="Add another origin (optional)" hint="Only if the site signs in on a second domain. The credential’s own origin always stays included.">
            <div className="flex gap-2">
              <Input
                id={ids.origin}
                value={newOrigin}
                placeholder="https://"
                inputMode="url"
                autoComplete="off"
                onChange={(e) => setNewOrigin(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addOrigin();
                  }
                }}
              />
              <Button icon={<IconPlus />} disabledReason={!newOrigin.trim() ? null : !candidate ? 'Enter a full URL such as https://example.com' : origins.includes(candidate) ? 'Already allowed' : null} disabled={!newOrigin.trim()} onClick={addOrigin}>
                Add
              </Button>
            </div>
          </Field>
        </div>
        <Field htmlFor={ids.policy} label="Approval" hint={POLICY_HINT[effectivePolicy]}>
          <Select id={ids.policy} value={effectivePolicy} onChange={(e) => setPolicy(e.target.value as ApprovalPolicy)}>
            {policyOptions.map((p) => (
              <option key={p} value={p}>
                {POLICY_LABEL[p]}
                {p === 'always_ask' ? ' (default)' : ''}
              </option>
            ))}
          </Select>
        </Field>
        {!singleOrigin && <p className="-mt-2 text-xs text-subtle">Automatic is only offered for a single origin.</p>}
        {effectivePolicy === 'auto' && (
          <Notice tone="warn">The agent can sign in without asking you. Prefer “Always ask” unless the agent runs unattended on a site you fully trust.</Notice>
        )}
        <Field htmlFor={ids.expiry} label="Expires (optional)" error={expiryInvalid}>
          <Input id={ids.expiry} type="datetime-local" value={expiry} onChange={(e) => setExpiry(e.target.value)} />
        </Field>
        {grant && <Switch checked={enabled} onChange={setEnabled} label="Grant enabled" description="A disabled grant cannot be used until you enable it again." />}
        {error ? <ErrorBanner error={error} title={grant ? 'Grant not saved' : 'Grant not created'} /> : null}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- history

const OUTCOME_TONE: Record<string, Tone> = { ok: 'success', denied: 'danger', error: 'warn' };

export function AuditTable({ rows, showAgent = true, label = 'Vault history' }: { rows: VaultAuditRow[]; showAgent?: boolean; label?: string }) {
  const columns: Column<VaultAuditRow>[] = [
    { key: 'ts', header: 'Time', mobile: 'subtitle', cell: (r) => <span title={formatTime(r.ts)}>{relativeTime(r.ts)}</span> },
    { key: 'op', header: 'Event', mobile: 'title', cell: (r) => <span className="text-text">{VAULT_OP_LABEL[r.operation] ?? r.operation}</span> },
  ];
  if (showAgent) {
    columns.push({
      key: 'actor',
      header: 'By',
      cell: (r) =>
        r.actor_type === 'agent' ? (
          r.agent_id ? (
            <TextLink href={href(`/agents/${r.agent_id}/security`)}>{r.agent_name ?? shortId(r.agent_id)}</TextLink>
          ) : (
            'Agent'
          )
        ) : r.actor_type === 'system' ? (
          'System'
        ) : (
          'Owner'
        ),
    });
  }
  columns.push(
    { key: 'entry', header: 'Credential', cell: (r) => r.entry_name ?? (r.entry_id ? <Mono>{shortId(r.entry_id)}</Mono> : <span className="text-subtle">—</span>) },
    { key: 'origin', header: 'Destination', cell: (r) => (r.destination_origin ? <Mono className="break-all">{r.destination_origin}</Mono> : <span className="text-subtle">—</span>) },
    {
      key: 'outcome',
      header: 'Outcome',
      mobile: 'aside',
      cell: (r) => (
        <Badge tone={OUTCOME_TONE[r.outcome] ?? 'neutral'} title={r.reason_code ?? undefined}>
          {r.outcome}
        </Badge>
      ),
    },
    { key: 'reason', header: 'Detail', cell: (r) => (r.reason_code ? <Mono>{r.reason_code}</Mono> : <span className="text-subtle">—</span>) },
  );
  return <DataTable label={label} rows={rows} rowKey={(r) => r.id} columns={columns} minWidth={showAgent ? 860 : 720} dense />;
}

export function HistoryPanel({ intro }: { intro?: ReactNode }) {
  const audit = useApi((signal) => vaultApi.audit(200, undefined, signal), []);
  useLiveRefresh(audit.reload, isVaultEvent, 500);
  if (audit.error && !audit.data) return <ErrorBanner error={audit.error} onRetry={audit.reload} />;
  if (!audit.data) return <LoadingRows rows={4} label="Loading vault history…" />;
  return (
    <div className="space-y-3">
      {intro ?? <p className="text-sm text-muted">Every unlock, reveal, change and agent sign-in. Rows never contain a secret.</p>}
      {audit.data.length === 0 ? (
        <EmptyState compact icon={<IconActivity />} title="No vault activity yet" />
      ) : (
        <AuditTable rows={audit.data} />
      )}
    </div>
  );
}
