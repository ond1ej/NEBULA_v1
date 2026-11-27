// The owner's Password Vault in the Mini App (lazily loaded; operators keep the read-only screen). Routes under
// #/settings/vault: the home (status + security, create / unlock / lock, credentials with search, agent access, links),
// new, entries/<id>, entries/<id>/edit, history, settings, signin — and #/agents/<id>/vault (agent access).
// Every sub-screen is its own chunk. Vault data is screen-local (useLocal) and whitelisted (data.ts).
import { useEffect, useMemo, useState } from 'react';
import { formatTime } from '../../lib/format';
import { lazyNamed } from '../../lib/lazy';
import type { Agent } from '../../types';
import { useMini } from '../context';
import { useActions, useQuery } from '../hooks';
import { IcPlus } from '../icons';
import { mhref } from '../router';
import { agentAvatar, Avatar, Btn, cx, Empty, ErrorState, Glyph, IconLink, List, Row, Screen, SearchField, Section, SkeletonList } from '../uiKit';
import { Notice } from '../uiExtra';
import { IconActivity, IconKey, IconLock, IconSettings, IconShield } from '../../components/icons';
import { vaultApiM } from './api';
import { TYPE_LABEL, unavailable, useLocal, vaultEvent, type ManagedStatus } from './data';
import { CreateVaultCard, UnlockVaultCard } from './forms';

const EntryDetail = lazyNamed(() => import('./entries'), 'EntryDetail');
const EntryForm = lazyNamed(() => import('./entries'), 'EntryForm');
const VaultHistory = lazyNamed(() => import('./access'), 'VaultHistory');
const AgentAccess = lazyNamed(() => import('./access'), 'AgentAccess');
const VaultSettings = lazyNamed(() => import('./settings'), 'VaultSettings');
const SignInSettings = lazyNamed(() => import('./signin'), 'SignInSettings');

/** #/settings/vault/… for the owner. `sub`: the path segments after "vault". */
export function VaultManager({ sub }: { sub: string[] }) {
  const [c, d, e] = sub;
  let screen;
  if (c === 'new') screen = <EntryForm />;
  else if (c === 'entries' && d) screen = e === 'edit' ? <EntryForm key={`e:${d}`} entryId={d} /> : <EntryDetail key={d} entryId={d} />;
  else if (c === 'history') screen = <VaultHistory />;
  else if (c === 'settings') screen = <VaultSettings />;
  else if (c === 'signin') screen = <SignInSettings />;
  else screen = <VaultHome />;
  return screen;
}

/** #/agents/<id>/vault for the owner. */
export function AgentVaultManager({ agentId }: { agentId: string }) {
  return <AgentAccess agentId={agentId} />;
}

// ---------------------------------------------------------------- home
function StatusCard({ st, onLock, locking }: { st: ManagedStatus; onLock: () => void; locking: boolean }) {
  const label = !st.exists ? 'Not set up' : st.locked ? 'Locked' : 'Unlocked';
  return (
    <div className="mb-5 flex flex-col items-center text-center" data-testid="vault-status">
      <span className={cx('grid size-16 place-items-center rounded-2xl [&>svg]:size-7', !st.exists ? 'bg-text/8 text-muted' : st.locked ? 'bg-success/15 text-success' : 'bg-warn/15 text-warn')}>
        <IconLock />
      </span>
      <p className="mt-3 text-title font-semibold text-text">{label}</p>
      {st.exists && (
        <p className="mt-0.5 text-subhead text-muted">
          {st.entry_count} credential{st.entry_count === 1 ? '' : 's'}
          {st.auto_lock_minutes ? ` · auto-locks after ${st.auto_lock_minutes} min` : ''}
        </p>
      )}
      {st.exists && !st.locked && st.lock_at && <p className="text-footnote text-subtle">Locks {formatTime(st.lock_at)} if unused</p>}
      {st.exists && !st.locked && (
        <Btn className="mt-4" variant="primary" icon={<IconLock />} loading={locking} onClick={onLock}>
          Lock now
        </Btn>
      )}
    </div>
  );
}

function Credentials({ unlocked }: { unlocked: boolean }) {
  const [term, setTerm] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setQ(term.trim()), 250);
    return () => clearTimeout(t);
  }, [term]);
  const entries = useLocal((s) => vaultApiM.entries(q || undefined, s), [q], (ev) => ev.type === 'vault.status.changed');
  return (
    <Section
      title="Credentials"
      action={
        unlocked ? (
          <a href={mhref('/settings/vault/new')} className="inline-flex min-h-9 items-center gap-1 text-subhead font-semibold text-accent-soft focus-ring [&>svg]:size-4">
            <IcPlus aria-hidden /> Add
          </a>
        ) : undefined
      }
      footer={unlocked ? 'Passwords stay encrypted on your Mac; they are shown only when you reveal one.' : 'Unlock the vault to add, open or edit credentials.'}
    >
      <div className="mb-2">
        <SearchField label="Search credentials" value={term} onChange={setTerm} placeholder="Search credentials" />
      </div>
      {entries.data ? (
        entries.data.length ? (
          <List>
            {entries.data.map((e) => (
              <Row
                key={e.id}
                href={mhref(`/settings/vault/entries/${e.id}`)}
                leading={
                  <Glyph tone="accent">
                    <IconKey />
                  </Glyph>
                }
                title={e.display_name}
                subtitle={[TYPE_LABEL[e.credential_type] ?? e.credential_type, e.origin ?? e.app_name, e.tags.length ? e.tags.map((t) => `#${t}`).join(' ') : null].filter(Boolean).join(' · ')}
                value={e.grant_count ? `${e.grant_count} agent${e.grant_count === 1 ? '' : 's'}` : undefined}
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
  );
}

function AgentAccessList() {
  const { api } = useMini();
  const agents = useQuery<Agent[]>('agents', (s) => api.agents.list(s));
  const grants = useLocal((s) => vaultApiM.grants(s), [], (ev) => ev.type === 'vault.status.changed');
  const active = useMemo(() => {
    const m = new Map<string, number>();
    for (const g of grants.data ?? []) if (g.enabled && g.agent_id) m.set(g.agent_id, (m.get(g.agent_id) ?? 0) + 1);
    return m;
  }, [grants.data]);
  return (
    <Section title="Agent access" footer="Choose which saved credentials each agent may use, and when you are asked first.">
      {agents.data ? (
        agents.data.length ? (
          <List>
            {agents.data.slice(0, 30).map((a) => {
              const n = active.get(a.id) ?? 0;
              return (
                <Row
                  key={a.id}
                  href={mhref(`/agents/${a.id}/vault`)}
                  leading={<Avatar name={a.name} id={a.id} size="sm" avatar={agentAvatar(a)} />}
                  title={a.name}
                  subtitle={grants.data ? (n ? `${n} active grant${n === 1 ? '' : 's'}` : 'No credentials') : 'Loading…'}
                />
              );
            })}
          </List>
        ) : (
          <p className="rounded-card bg-panel px-4 py-3.5 text-subhead text-muted">No agents.</p>
        )
      ) : agents.error ? (
        <ErrorState error={agents.error} onRetry={agents.reload} />
      ) : (
        <SkeletonList rows={2} />
      )}
    </Section>
  );
}

function VaultHome() {
  const { run, isPending } = useActions();
  const status = useLocal((s) => vaultApiM.status(s), [], vaultEvent);
  const st = status.data;
  const missing = unavailable(status.error);
  const lock = async () => {
    if ((await run('lock', () => vaultApiM.lock(), { success: 'Vault locked' })) !== undefined) status.reload();
  };
  const apply = (next: ManagedStatus) => status.set((prev) => (prev ? { ...prev, ...next, broker: prev.broker, broker_enabled: prev.broker_enabled } : next));
  return (
    <Screen
      title="Password Vault"
      actions={st?.exists && !st.locked ? <IconLink label="Add credential" icon={<IcPlus />} href={mhref('/settings/vault/new')} /> : undefined}
    >
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
          <StatusCard st={st} onLock={() => void lock()} locking={isPending('lock')} />
          {!st.exists ? (
            <div className="mb-6">
              <CreateVaultCard onCreated={apply} />
            </div>
          ) : st.locked ? (
            <div className="mb-6">
              <UnlockVaultCard status={st} onUnlocked={status.reload} />
            </div>
          ) : null}
          {st.exists && !st.broker_enabled && (
            <Notice tone="warning" title="Agent credential use is off" className="mb-6">
              Agents cannot use saved credentials until you turn it on in Vault settings.
            </Notice>
          )}
          {st.exists && <Credentials unlocked={!st.locked} />}
          {st.exists && <AgentAccessList />}
          <Section title="Security">
            <List>
              <Row
                href={mhref('/settings/vault/signin')}
                leading={
                  <Glyph tone="info">
                    <IconShield />
                  </Glyph>
                }
                title="Smart sign-in"
                subtitle="Remote PIN, trusted sign-in providers"
              />
              {st.exists && (
                <Row
                  href={mhref('/settings/vault/settings')}
                  leading={
                    <Glyph tone="neutral">
                      <IconSettings />
                    </Glyph>
                  }
                  title="Vault settings"
                  subtitle="Auto-lock, agent use, passphrase, export & import"
                />
              )}
              {st.exists && (
                <Row
                  href={mhref('/settings/vault/history')}
                  leading={
                    <Glyph tone="success">
                      <IconActivity />
                    </Glyph>
                  }
                  title="History"
                  subtitle="Who used or changed what, and when"
                />
              )}
            </List>
          </Section>
        </>
      )}
    </Screen>
  );
}
