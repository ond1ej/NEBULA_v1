// Password Vault in the Mini App for sessions that are not the NEBULA owner (operators, agent bots) — metadata only.
// This view never receives, renders, stores or requests a password, passphrase or key. Allowed here: status, credential
// names and non-secret metadata, agent access, recent access, and the protective actions "Lock now" and "Revoke".
// The owner gets full management instead (src/mini/vault/, lazily loaded).
//
// Every response is reduced to an explicit whitelist of fields before rendering (clean*, vault/data.ts); data lives
// only in this screen's component state (not in the shared query cache, not in any storage) and is gone when it closes.
import { useEffect, useState } from 'react';
import { formatTime, relativeTime } from '../../lib/format';
import type { Agent, AgentDetail } from '../../types';
import { useMini, hasPermission } from '../context';
import { useActions, useQuery } from '../hooks';
import { mhref } from '../router';
import type { AgentVault, VaultAuditRow, VaultGrant } from '../types';
import { cleanAgentVault, cleanAudit, cleanEntry, cleanStatus, MODE_LABEL, POLICY_LABEL, TYPE_LABEL, unavailable, useLocal, vaultEvent } from '../vault/data';
import { agentAvatar, Avatar, Btn, Card, cx, Empty, ErrorState, List, Pill, Row, Screen, SearchField, Section, SkeletonList, StatusDot, type Tone } from '../uiKit';
import { ConfirmSheet, KV, Notice } from '../uiExtra';
import { IconKey, IconLock } from '../../components/icons';

export { cleanAgentVault, cleanAudit, cleanEntry, cleanGrant, cleanStatus } from '../vault/data';

const OUTCOME_TONE = (o: string): Tone => (/^(allowed|ok|success|approved|filled)$/i.test(o) ? 'success' : /^(denied|refused|blocked|error|failed|expired)$/i.test(o) ? 'danger' : 'warning');

function LocalOnlyNotice() {
  return (
    <Notice tone="info" title="Vault management is reserved for the NEBULA owner" className="mb-6">
      Creating or unlocking the vault and adding or editing credentials and agent grants are done by the owner (in the owner’s Mini App or the NEBULA
      Dashboard). Here you can check the status, lock the vault and revoke access.
    </Notice>
  );
}

function AuditList({ rows, showAgent = true }: { rows: VaultAuditRow[]; showAgent?: boolean }) {
  if (!rows.length) return <p className="rounded-card bg-panel px-4 py-3.5 text-subhead text-muted">No access recorded yet.</p>;
  return (
    <List>
      {rows.map((r) => (
        <Row
          key={r.id || `${r.ts}-${r.entry_id}`}
          leading={<StatusDot tone={OUTCOME_TONE(r.outcome)} />}
          title={`${showAgent ? `${r.agent_name ?? r.actor_type ?? 'Someone'} · ` : ''}${r.operation.replace(/_/g, ' ')}${r.entry_name ? ` · ${r.entry_name}` : ''}`}
          subtitle={`${r.outcome}${r.destination_origin ? ` · ${r.destination_origin}` : ''}${r.reason_code ? ` · ${r.reason_code.replace(/_/g, ' ')}` : ''} · ${relativeTime(r.ts)}`}
          chevron={false}
        />
      ))}
    </List>
  );
}

// ---------------------------------------------------------------- Settings → Password Vault
export function VaultScreen() {
  const ctx = useMini();
  const { api } = ctx;
  const { run, isPending } = useActions();
  const status = useLocal(async (s) => cleanStatus(await api.vault.status(s)), [], vaultEvent);
  const [term, setTerm] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setQ(term.trim()), 250);
    return () => clearTimeout(t);
  }, [term]);
  const entries = useLocal(async (s) => ((await api.vault.entries(q || undefined, s)) as unknown[]).map(cleanEntry), [q], (ev) => ev.type === 'vault.status.changed');
  const audit = useLocal(async (s) => ((await api.vault.audit(undefined, s)) as unknown[]).map(cleanAudit), [], vaultEvent);
  const agents = useQuery<Agent[]>('agents', (s) => api.agents.list(s));
  const ids = (agents.data ?? []).slice(0, 12).map((a) => a.id);
  const access = useLocal(
    async (s) => {
      const out: Record<string, AgentVault | null> = {};
      await Promise.all(
        ids.map(async (id) => {
          try {
            out[id] = cleanAgentVault(await api.vault.agent(id, s));
          } catch (e) {
            if (e instanceof DOMException && e.name === 'AbortError') throw e;
            out[id] = null;
          }
        }),
      );
      return out;
    },
    [ids.join(',')],
    (ev) => ev.type === 'vault.status.changed',
  );

  const st = status.data;
  const missing = unavailable(status.error);
  const lock = async () => {
    if ((await run('lock', () => api.vault.lock(), { success: 'Vault locked' })) !== undefined) status.reload();
  };

  return (
    <Screen title="Password Vault">
      {missing ? (
        <Empty title="Password Vault unavailable" icon={<IconKey />}>
          {missing}
        </Empty>
      ) : !st ? (
        status.error ? (
          <ErrorState error={status.error} onRetry={status.reload} />
        ) : (
          <SkeletonList rows={2} avatar={false} />
        )
      ) : (
        <>
          <div className="mb-5 flex flex-col items-center text-center" data-testid="vault-status">
            <span className={cx('grid size-16 place-items-center rounded-2xl [&>svg]:size-7', !st.exists ? 'bg-text/8 text-muted' : st.locked ? 'bg-success/15 text-success' : 'bg-warn/15 text-warn')}>
              <IconLock />
            </span>
            <p className="mt-3 text-title font-semibold text-text">{!st.exists ? 'Not set up' : st.locked ? 'Locked' : 'Unlocked'}</p>
            <p className="mt-0.5 text-subhead text-muted">
              {st.entry_count} credential{st.entry_count === 1 ? '' : 's'}
              {st.auto_lock_minutes ? ` · auto-locks after ${st.auto_lock_minutes} min` : ''}
            </p>
            {st.exists && !st.locked && st.lock_at && <p className="text-footnote text-subtle">Locks {formatTime(st.lock_at)}</p>}
            {st.exists && !st.locked && (
              <Btn className="mt-4" variant="primary" icon={<IconLock />} loading={isPending('lock')} onClick={() => void lock()}>
                Lock now
              </Btn>
            )}
          </div>
          <LocalOnlyNotice />
          <Section title="Sign-in broker">
            <Card>
              <KV
                items={[
                  ['Broker', st.broker.enabled ? (st.broker.available ? 'Available' : 'Unavailable') : 'Off'],
                  ...(st.broker.reason ? ([['Note', st.broker.reason]] as [string, string][]) : []),
                ]}
              />
            </Card>
          </Section>

          <Section title="Credentials" footer="Names and non-secret details only. Passwords and keys never leave your Mac.">
            <div className="mb-2">
              <SearchField label="Search credentials" value={term} onChange={setTerm} placeholder="Search credentials" />
            </div>
            {entries.data ? (
              entries.data.length ? (
                <List>
                  {entries.data.map((e) => (
                    <Row
                      key={e.id}
                      title={e.display_name}
                      subtitle={[TYPE_LABEL[e.credential_type] ?? e.credential_type, e.app_name, e.origin, e.tags.length ? e.tags.map((t) => `#${t}`).join(' ') : null].filter(Boolean).join(' · ')}
                      value={e.grant_count ? `${e.grant_count} agent${e.grant_count === 1 ? '' : 's'}` : 'no access'}
                      chevron={false}
                    />
                  ))}
                </List>
              ) : (
                <p className="rounded-card bg-panel px-4 py-3.5 text-subhead text-muted">{q ? 'No credential matches.' : 'No credentials saved yet.'}</p>
              )
            ) : entries.error ? (
              <ErrorState error={entries.error} onRetry={entries.reload} />
            ) : (
              <SkeletonList rows={2} avatar={false} />
            )}
          </Section>

          <Section title="Agent access">
            {agents.data ? (
              agents.data.length ? (
                <List>
                  {agents.data.slice(0, 12).map((a) => {
                    const v = access.data?.[a.id];
                    return (
                      <Row
                        key={a.id}
                        href={mhref(`/agents/${a.id}/vault`)}
                        leading={<Avatar name={a.name} id={a.id} size="sm" avatar={agentAvatar(a)} />}
                        title={a.name}
                        subtitle={v ? `${MODE_LABEL[v.mode] ?? v.mode}${v.grants.length ? ` · ${v.grants.filter((g) => g.enabled).length} active grant${v.grants.filter((g) => g.enabled).length === 1 ? '' : 's'}` : ''}` : access.data ? 'Unknown' : 'Loading…'}
                      />
                    );
                  })}
                </List>
              ) : (
                <p className="rounded-card bg-panel px-4 py-3.5 text-subhead text-muted">No agents.</p>
              )
            ) : (
              <SkeletonList rows={2} />
            )}
          </Section>

          <Section title="Recent access">
            {audit.data ? <AuditList rows={audit.data} /> : audit.error ? <ErrorState error={audit.error} onRetry={audit.reload} /> : <SkeletonList rows={2} avatar={false} />}
          </Section>
        </>
      )}
      {!hasPermission(ctx, 'commands') && st?.exists && !st.locked ? <p className="px-4 text-footnote text-subtle">If “Lock now” is refused, lock the vault in the Dashboard.</p> : null}
    </Screen>
  );
}

// ---------------------------------------------------------------- Agent → Security → Password Vault
export function AgentVaultScreen({ agentId }: { agentId: string }) {
  const { api } = useMini();
  const { run, isPending } = useActions();
  const agent = useQuery<AgentDetail>(`agent:${agentId}`, (s) => api.agents.get(agentId, s));
  const v = useLocal(async (s) => cleanAgentVault(await api.vault.agent(agentId, s)), [agentId], (ev) => vaultEvent(ev) && (!ev.agent_id || ev.agent_id === agentId));
  const [revoke, setRevoke] = useState<VaultGrant | null>(null);
  const name = agent.data?.name ?? 'Agent';
  const missing = unavailable(v.error);
  const doRevoke = async () => {
    if (!revoke) return;
    const r = await run('revoke', () => api.vault.revoke(revoke.id), { success: `Access to ${revoke.entry_name} revoked` });
    if (r !== undefined) {
      setRevoke(null);
      v.reload();
    }
  };
  const d = v.data;
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
          <Section title="Access mode">
            <Card>
              <p className="text-headline font-semibold text-text" data-testid="vault-mode">
                {MODE_LABEL[d.mode] ?? d.mode}
              </p>
              <p className="mt-0.5 text-subhead text-muted">
                {d.mode === 'NONE'
                  ? `${name} cannot use any saved credential.`
                  : d.mode === 'MANAGED'
                    ? `Credentials tagged ${d.managed_tags.map((t) => `#${t}`).join(', ') || '(no tags)'}.`
                    : `Only the credentials granted below.`}
              </p>
            </Card>
          </Section>
          <Section title={`Grants${d.grants.length ? ` · ${d.grants.length}` : ''}`}>
            {d.grants.length ? (
              <ul className="space-y-2.5">
                {d.grants.map((g) => {
                  const expired = g.expires_at !== null && g.expires_at * 1000 < Date.now();
                  return (
                    <li key={g.id} className="rounded-card bg-panel p-4" data-testid="vault-grant">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="min-w-0 flex-1 truncate text-body font-semibold text-text">{g.entry_name}</span>
                        <Pill>{TYPE_LABEL[g.credential_type] ?? g.credential_type}</Pill>
                        <Pill tone={!g.enabled ? 'neutral' : expired ? 'warning' : 'success'}>{!g.enabled ? 'revoked' : expired ? 'expired' : 'active'}</Pill>
                      </div>
                      <KV
                        className="mt-1"
                        items={[
                          ['Sites', g.allowed_origins.length ? <span className="font-mono text-footnote whitespace-pre-line">{g.allowed_origins.join('\n')}</span> : '—'],
                          ['Actions', g.allowed_actions.length ? g.allowed_actions.map((x) => x.replace(/_/g, ' ')).join(', ') : '—'],
                          ['Approval', POLICY_LABEL[g.approval_policy] ?? g.approval_policy],
                          ['Expires', g.expires_at ? formatTime(g.expires_at) : 'never'],
                          ['Last used', g.last_used_at ? relativeTime(g.last_used_at) : 'never'],
                        ]}
                      />
                      {g.enabled && (
                        <Btn className="mt-2 w-full" variant="danger" onClick={() => setRevoke(g)}>
                          Revoke
                        </Btn>
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="rounded-card bg-panel px-4 py-3.5 text-subhead text-muted">No grants.</p>
            )}
          </Section>
          <Section title="Recent use">
            <AuditList rows={d.recent} showAgent={false} />
          </Section>
          <LocalOnlyNotice />
        </>
      )}
      <ConfirmSheet open={revoke !== null} title={`Revoke access to ${revoke?.entry_name ?? 'this credential'}?`} confirmLabel="Revoke" tone="danger" busy={isPending('revoke')} onCancel={() => setRevoke(null)} onConfirm={() => void doRevoke()}>
        {name} can no longer use this credential. Only the NEBULA owner can grant it again.
      </ConfirmSheet>
    </Screen>
  );
}
