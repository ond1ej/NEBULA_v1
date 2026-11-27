// Agent access to the Password Vault (#/agents/<id>/vault for the owner): the access mode, the agent's grants (approval
// policy, revoke, delete), adding a grant for a saved website credential — and the vault history (#/settings/vault/
// history). Permission changes need a fresh owner confirmation; the host asks for it (step-up sheet) and the request
// is retried once.
import { useState } from 'react';
import { parseTags, VAULT_OP_LABEL } from '../../features/vault/lib';
import { formatTime, relativeTime } from '../../lib/format';
import type { AgentDetail } from '../../types';
import { RadioList, SelectInput, TextInput, FieldShell } from '../agentConfig/fields';
import { useBackOverlay } from '../backStack';
import { useMini } from '../context';
import { useActions, useQuery } from '../hooks';
import { IcPlus } from '../icons';
import { Btn, Card, Empty, ErrorState, List, Pill, Row, Screen, Section, Sheet, SkeletonList, StatusDot, type Tone } from '../uiKit';
import { ConfirmSheet, KV, Notice } from '../uiExtra';
import { IconKey } from '../../components/icons';
import { vaultApiM } from './api';
import { MODE_LABEL, POLICY_LABEL, TYPE_LABEL, unavailable, useLocal, vaultEvent, type ManagedGrant } from './data';
import { FormAlert, useSubmit } from './ui';
import type { AgentVault, VaultAuditRow } from '../types';

const OUTCOME_TONE = (o: string): Tone => (/^(allowed|ok|success|approved|filled)$/i.test(o) ? 'success' : /^(denied|refused|blocked|error|failed|expired)$/i.test(o) ? 'danger' : 'warning');
const POLICIES = ['always_ask', 'once_per_task', 'auto'] as const;
const POLICY_HINT: Record<string, string> = {
  always_ask: 'You approve every use.',
  once_per_task: 'You approve the first use in each task.',
  auto: 'No approval — only for sign-in to exactly one website.',
};

function AuditRows({ rows, showAgent = true }: { rows: VaultAuditRow[]; showAgent?: boolean }) {
  if (!rows.length) return <p className="rounded-card bg-panel px-4 py-3.5 text-subhead text-muted">Nothing recorded yet.</p>;
  return (
    <List>
      {rows.map((r) => {
        const who = r.agent_name ?? (r.actor_type === 'owner' ? 'You' : r.actor_type || 'System');
        const what = VAULT_OP_LABEL[r.operation] ?? r.operation.replace(/[._]/g, ' ');
        return (
          <Row
            key={r.id || `${r.ts}-${r.operation}-${r.entry_id}`}
            leading={<StatusDot tone={OUTCOME_TONE(r.outcome)} />}
            title={`${showAgent ? `${who} · ` : ''}${what}${r.entry_name ? ` · ${r.entry_name}` : ''}`}
            subtitle={`${r.outcome}${r.destination_origin ? ` · ${r.destination_origin}` : ''}${r.reason_code ? ` · ${r.reason_code.replace(/_/g, ' ')}` : ''} · ${relativeTime(r.ts)}`}
            chevron={false}
          />
        );
      })}
    </List>
  );
}

// ---------------------------------------------------------------- history
export function VaultHistory() {
  const h = useLocal((s) => vaultApiM.audit(200, undefined, s), [], vaultEvent);
  return (
    <Screen title="Vault history">
      <Section footer="Who used or changed the vault, when, and the outcome. Secrets are never recorded.">
        {h.data ? <AuditRows rows={h.data} /> : h.error ? <ErrorState error={h.error} onRetry={h.reload} /> : <SkeletonList rows={4} avatar={false} />}
      </Section>
    </Screen>
  );
}

// ---------------------------------------------------------------- agent access
function AddGrantSheet({ agentName, mode, onClose, onAdd }: { agentName: string; mode: string; onClose: () => void; onAdd: (entryId: string, policy: string) => Promise<boolean> }) {
  const entries = useLocal((s) => vaultApiM.entries(undefined, s), []);
  const websites = (entries.data ?? []).filter((e) => e.credential_type === 'website');
  const [entryId, setEntryId] = useState('');
  const [policy, setPolicy] = useState<string>('always_ask');
  const [busy, setBusy] = useState(false);
  useBackOverlay(true, onClose);
  const add = async () => {
    const id = entryId || websites[0]?.id;
    if (!id) return;
    setBusy(true);
    const ok = await onAdd(id, policy);
    setBusy(false);
    if (ok) onClose();
  };
  return (
    <Sheet open keyboardAware testId="vault-add-grant" title={`Give ${agentName} a credential`} onClose={onClose} dismissible={!busy}>
      <div className="space-y-4 pt-1 pb-2">
        {entries.data ? (
          websites.length ? (
            <FieldShell id="grant-entry" label="Credential" hint="Agents can use website credentials to sign in, only on the credential’s own website.">
              <SelectInput id="grant-entry" value={entryId || websites[0].id} onChange={(e) => setEntryId(e.target.value)} aria-describedby="grant-entry-hint">
                {websites.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.display_name}
                    {e.origin ? ` — ${e.origin}` : ''}
                  </option>
                ))}
              </SelectInput>
            </FieldShell>
          ) : (
            <Notice tone="info">No website credentials saved yet. Add one in the Password Vault first.</Notice>
          )
        ) : entries.error ? (
          <ErrorState error={entries.error} onRetry={entries.reload} />
        ) : (
          <SkeletonList rows={1} avatar={false} />
        )}
        <RadioList label="When to ask you" value={policy} onChange={setPolicy} options={POLICIES.map((p) => ({ id: p, label: POLICY_LABEL[p], description: POLICY_HINT[p] }))} />
        {mode === 'NONE' && <p className="px-1 text-footnote text-muted">This also switches {agentName} to “Selected credentials”.</p>}
        <div className="flex gap-2">
          <Btn className="flex-1" onClick={onClose} disabled={busy}>
            Cancel
          </Btn>
          <Btn variant="primary" className="flex-1" loading={busy} disabled={!websites.length} onClick={() => void add()}>
            Give access
          </Btn>
        </div>
      </div>
    </Sheet>
  );
}

function GrantCard({ g, busy, onPolicy, onRevoke, onDelete }: { g: ManagedGrant; busy: boolean; onPolicy: (p: string) => void; onRevoke: () => void; onDelete: () => void }) {
  const expired = g.expires_at !== null && g.expires_at * 1000 < Date.now();
  const sel = `pol-${g.id}`;
  return (
    <li className="rounded-card bg-panel p-4" data-testid="vault-grant">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-body font-semibold text-text">{g.entry_name}</span>
        <Pill>{TYPE_LABEL[g.credential_type] ?? g.credential_type}</Pill>
        <Pill tone={!g.enabled ? 'neutral' : expired ? 'warning' : 'success'}>{!g.enabled ? 'revoked' : expired ? 'expired' : 'active'}</Pill>
      </div>
      <KV
        className="mt-1"
        items={[
          ['Sites', g.allowed_origins.length ? <span className="font-mono text-footnote whitespace-pre-line">{g.allowed_origins.join('\n')}</span> : '—'],
          ['Expires', g.expires_at ? formatTime(g.expires_at) : 'never'],
          ['Last used', g.last_used_at ? relativeTime(g.last_used_at) : 'never'],
        ]}
      />
      {g.enabled && (
        <div className="mt-2">
          <label htmlFor={sel} className="mb-1 block px-1 text-footnote font-medium text-muted">
            When to ask you
          </label>
          <SelectInput id={sel} value={g.approval_policy} disabled={busy} onChange={(e) => onPolicy(e.target.value)}>
            {POLICIES.map((p) => (
              <option key={p} value={p}>
                {POLICY_LABEL[p]}
              </option>
            ))}
          </SelectInput>
        </div>
      )}
      <div className="mt-3 flex gap-2">
        {g.enabled && (
          <Btn className="flex-1" variant="danger" onClick={onRevoke}>
            Revoke
          </Btn>
        )}
        <Btn className="flex-1" onClick={onDelete}>
          Delete
        </Btn>
      </div>
    </li>
  );
}

export function AgentAccess({ agentId }: { agentId: string }) {
  const { api } = useMini();
  const { run, isPending } = useActions();
  const agent = useQuery<AgentDetail>(`agent:${agentId}`, (s) => api.agents.get(agentId, s));
  const v = useLocal((s) => vaultApiM.agent(agentId, s), [agentId], (ev) => vaultEvent(ev) && (!ev.agent_id || ev.agent_id === agentId));
  const [adding, setAdding] = useState(false);
  const [confirm, setConfirm] = useState<{ kind: 'revoke' | 'delete'; g: ManagedGrant } | null>(null);
  const [tags, setTags] = useState<string | null>(null);
  const modeSubmit = useSubmit();
  const name = agent.data?.name ?? 'Agent';
  const d = v.data;
  const missing = unavailable(v.error);

  const setMode = async (mode: string, managed: string[] = []) => {
    const r = await modeSubmit.run(() => vaultApiM.setMode(agentId, mode, managed));
    if (r) {
      v.set(() => r);
      setTags(null);
    }
  };
  const addGrant = async (entryId: string, policy: string): Promise<boolean> => {
    const r = await run(
      'grant',
      async () => {
        if (d?.mode === 'NONE') await vaultApiM.setMode(agentId, 'SELECTED');
        return vaultApiM.createGrant(agentId, entryId, policy);
      },
      { success: `${name} can use the credential now`, errorTitle: 'Access not given' },
    );
    v.reload();
    return r !== undefined;
  };
  const updatePolicy = async (g: ManagedGrant, p: string) => {
    const r = await run(`pol-${g.id}`, () => vaultApiM.updateGrant(g.id, p), { success: 'Approval rule changed', errorTitle: 'Rule not changed' });
    if (r) v.set((x) => (x ? { ...x, grants: x.grants.map((y) => (y.id === g.id ? { ...y, ...r } : y)) } : x));
  };
  const doConfirm = async () => {
    if (!confirm) return;
    const { kind, g } = confirm;
    const r = await run(kind, () => (kind === 'revoke' ? vaultApiM.revokeGrant(g.id) : vaultApiM.deleteGrant(g.id)), {
      success: kind === 'revoke' ? `Access to ${g.entry_name} revoked` : `Grant for ${g.entry_name} deleted`,
    });
    if (r !== undefined) {
      setConfirm(null);
      v.reload();
    }
  };

  return (
    <Screen title="Password Vault" subtitle={name}>
      {missing ? (
        <Empty title="Password Vault unavailable" icon={<IconKey />}>
          {missing}
        </Empty>
      ) : !d ? (
        v.error ? (
          <ErrorState error={v.error} onRetry={v.reload} />
        ) : (
          <SkeletonList rows={2} avatar={false} />
        )
      ) : (
        <>
          <Section title="Access mode" footer={d.mode === 'MANAGED' ? `Credentials tagged ${d.managed_tags.map((t) => `#${t}`).join(', ') || '(no tags)'}.` : undefined}>
            <span className="sr-only" data-testid="vault-mode">
              {MODE_LABEL[d.mode] ?? d.mode}
            </span>
            <RadioList
              label="Vault access mode"
              value={tags !== null ? 'MANAGED' : (d.mode as 'NONE' | 'SELECTED' | 'MANAGED')}
              disabled={modeSubmit.busy}
              onChange={(m) => (m === 'MANAGED' ? setTags(d.managed_tags.join(', ')) : void setMode(m))}
              options={[
                { id: 'NONE', label: MODE_LABEL.NONE, description: `${name} cannot use any saved credential.` },
                { id: 'SELECTED', label: MODE_LABEL.SELECTED, description: 'Only the credentials you grant below.' },
                { id: 'MANAGED', label: MODE_LABEL.MANAGED, description: 'Every credential with one of the chosen tags.' },
              ]}
            />
            {tags !== null && (
              <div className="mt-2 space-y-2 rounded-card bg-panel p-4">
                <FieldShell id="managed-tags" label="Tags" hint="Separated by commas, e.g. work, finance.">
                  <TextInput id="managed-tags" value={tags} onChange={(e) => setTags(e.target.value)} autoCapitalize="none" autoComplete="off" aria-describedby="managed-tags-hint" />
                </FieldShell>
                <div className="flex gap-2">
                  <Btn className="flex-1" onClick={() => setTags(null)} disabled={modeSubmit.busy}>
                    Cancel
                  </Btn>
                  <Btn variant="primary" className="flex-1" loading={modeSubmit.busy} disabled={!parseTags(tags).length} onClick={() => void setMode('MANAGED', parseTags(tags))}>
                    Save
                  </Btn>
                </div>
              </div>
            )}
            <div className="mt-2">
              <FormAlert error={modeSubmit.error} />
            </div>
          </Section>
          <Section
            title={`Grants${d.grants.length ? ` · ${d.grants.length}` : ''}`}
            action={
              <button type="button" onClick={() => setAdding(true)} className="inline-flex min-h-9 items-center gap-1 text-subhead font-semibold text-accent-soft focus-ring [&>svg]:size-4">
                <IcPlus aria-hidden /> Add
              </button>
            }
          >
            {d.grants.length ? (
              <ul className="space-y-2.5">
                {(d.grants as ManagedGrant[]).map((g) => (
                  <GrantCard
                    key={g.id}
                    g={g}
                    busy={isPending(`pol-${g.id}`)}
                    onPolicy={(p) => void updatePolicy(g, p)}
                    onRevoke={() => setConfirm({ kind: 'revoke', g })}
                    onDelete={() => setConfirm({ kind: 'delete', g })}
                  />
                ))}
              </ul>
            ) : (
              <Card>
                <p className="text-subhead text-muted">No credential granted to {name} yet.</p>
              </Card>
            )}
          </Section>
          <Section title="Recent use">
            <AuditRows rows={(d as AgentVault).recent} showAgent={false} />
          </Section>
        </>
      )}
      {adding && d && <AddGrantSheet agentName={name} mode={d.mode} onClose={() => setAdding(false)} onAdd={addGrant} />}
      <ConfirmSheet
        open={confirm !== null}
        title={confirm?.kind === 'delete' ? `Delete the grant for ${confirm.g.entry_name}?` : `Revoke access to ${confirm?.g.entry_name ?? 'this credential'}?`}
        confirmLabel={confirm?.kind === 'delete' ? 'Delete' : 'Revoke'}
        tone="danger"
        busy={isPending('revoke') || isPending('delete')}
        onCancel={() => setConfirm(null)}
        onConfirm={() => void doConfirm()}
      >
        {confirm?.kind === 'delete' ? 'The grant is removed. The credential itself stays in the vault.' : `${name} can no longer use this credential.`}
      </ConfirmSheet>
    </Screen>
  );
}
