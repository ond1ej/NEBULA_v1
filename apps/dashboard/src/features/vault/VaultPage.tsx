// Password Vault (#/vault): owner-only credential store. Not set up -> create; locked -> unlock (attempts / lockout);
// unlocked -> auto-lock countdown, credentials, agent grants, history and settings. Management works only from this Mac
// (`management_local`); metadata, Lock and Revoke work everywhere.
//
// Secret hygiene: passphrases, typed passwords and revealed values live only in component state. The panels below are
// keyed by the lock state, so locking (button, auto-lock, or a `vault.status.changed` event) remounts them and drops
// every such value. Nothing is written to storage, URLs, toasts or the console.
import { useEffect, useRef, useState } from 'react';
import { IconActivity, IconKey, IconLock, IconSettings, IconShield, IconVault } from '../../components/icons';
import { Badge, Button, Card, ErrorBanner, LoadingRows, PageHeader, TabBar, TabPanel, type TabItem } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { useAction } from '../../hooks/useApi';
import { vaultApi } from './api';
import { useSecondsLeft } from './clock';
import { CredentialsPanel } from './credentials';
import { CreateVaultForm, LocalOnlyNotice, UnlockForm } from './forms';
import { GrantsOverview, HistoryPanel } from './grants';
import { useReauth, useVaultStatus } from './hooks';
import { formatCountdown } from './lib';
import { BrokerCard, VaultSettingsPanel } from './settings';
import { SignInRequestsCard } from '../smartauth/SignIns';
import { SmartAuthSettingsCard } from '../smartauth/SmartAuthSettingsCard';
import { SmartAuthTrustCard } from '../smartauth/SmartAuthTrustCard';
import type { VaultCoreStatus, VaultStatus } from './types';

type VaultTab = 'credentials' | 'access' | 'signins' | 'history' | 'settings';

const TABS: TabItem<VaultTab>[] = [
  { id: 'credentials', label: 'Credentials', icon: <IconKey /> },
  { id: 'access', label: 'Agent access', icon: <IconShield /> },
  { id: 'signins', label: 'Sign-in requests', icon: <IconLock /> },
  { id: 'history', label: 'History', icon: <IconActivity /> },
  { id: 'settings', label: 'Settings', icon: <IconSettings /> },
];

function AutoLockCountdown({ lockAt, onExpired }: { lockAt: number; onExpired: () => void }) {
  const left = useSecondsLeft(lockAt);
  const fired = useRef<number | null>(null);
  const onExpiredRef = useRef(onExpired);
  onExpiredRef.current = onExpired;
  useEffect(() => {
    if (left <= 0 && fired.current !== lockAt) {
      fired.current = lockAt;
      onExpiredRef.current(); // the host locks lazily: asking for the status applies the auto-lock
    }
  }, [left, lockAt]);
  return (
    <span className="text-xs text-muted" role="timer" aria-label={`Auto-lock in ${formatCountdown(left)}`}>
      Auto-lock in <span className="font-mono text-text tabular-nums">{formatCountdown(left)}</span>
    </span>
  );
}

export function vaultStateBadge(s: VaultStatus) {
  if (!s.exists) return <Badge tone="neutral">Not set up</Badge>;
  return s.locked ? (
    <Badge tone="warn" dot>
      Locked
    </Badge>
  ) : (
    <Badge tone="success" dot>
      Unlocked
    </Badge>
  );
}

export function VaultPage({ query }: { query?: URLSearchParams }) {
  const toast = useToast();
  const status = useVaultStatus();
  const { reload, merge } = status;
  const s = status.data;
  const { withReauth, reauthDialog } = useReauth();
  const initial = query?.get('tab');
  const [tab, setTab] = useState<VaultTab>(TABS.some((t) => t.id === initial) ? (initial as VaultTab) : 'credentials');
  // Follow `?tab=` links (e.g. from the Command Center feed) while the page is already open.
  useEffect(() => {
    if (initial && TABS.some((t) => t.id === initial)) setTab(initial as VaultTab);
  }, [initial]);
  const { run, isPending } = useAction();

  const applied = (core: Partial<VaultCoreStatus>) => {
    merge(core);
    reload();
  };

  const lockNow = async () => {
    const r = await run('lock', () => vaultApi.lock(), { success: 'Vault locked', errorTitle: 'Vault not locked' });
    if (r) applied({ locked: true, lock_at: null, unlocked_at: null });
  };

  if (!s) {
    return (
      <>
        <PageHeader title="Password Vault" icon={<VaultMark />} />
        {status.error ? <ErrorBanner error={status.error} onRetry={reload} /> : <LoadingRows rows={4} label="Loading the Password Vault…" />}
      </>
    );
  }

  const local = s.management_local;
  const manageReason = !local ? 'Only on this Mac' : s.locked ? 'Unlock the vault first' : null;

  return (
    <>
      <PageHeader
        title="Password Vault"
        icon={<VaultMark />}
        description="Credentials encrypted on this Mac. Agents can only sign in with what you grant them — they never see a password."
        meta={
          <>
            {vaultStateBadge(s)}
            {s.exists && (
              <span className="text-xs text-muted">
                {s.entry_count} credential{s.entry_count === 1 ? '' : 's'}
              </span>
            )}
            {s.exists && !s.locked && s.lock_at ? <AutoLockCountdown lockAt={s.lock_at} onExpired={reload} /> : null}
          </>
        }
        actions={
          s.exists && !s.locked ? (
            <Button icon={<IconLock />} loading={isPending('lock')} onClick={() => void lockNow()}>
              Lock now
            </Button>
          ) : undefined
        }
      />
      {status.error ? (
        <div className="mb-4">
          <ErrorBanner error={status.error} onRetry={reload} title="Refresh failed" />
        </div>
      ) : null}

      <div className="space-y-5">
        {!local && <LocalOnlyNotice />}

        {!s.exists ? (
          <>
            {local && (
              <Card title="Set up the Password Vault" icon={<IconVault />} subtitle="Choose a dedicated passphrase. It encrypts every credential on this Mac.">
                <CreateVaultForm
                  onCreated={(core) => {
                    toast.success('Password Vault created', 'It is unlocked now.');
                    applied(core);
                  }}
                />
              </Card>
            )}
            <BrokerCard status={s} />
            {/* Smart sign-in works without a vault (typed details are used once); saving needs the vault. */}
            <SmartAuthSettingsCard />
            <SignInRequestsCard />
          </>
        ) : (
          <>
            {s.locked && local && (
              <Card title="Unlock the vault" icon={<IconLock />} subtitle={`Unlocks for this NEBULA host until you lock it or after ${s.auto_lock_minutes} minutes of inactivity.`}>
                <UnlockForm
                  lockoutUntil={s.lockout_until}
                  onFailed={reload}
                  onUnlocked={(core) => {
                    toast.success('Vault unlocked');
                    applied(core);
                  }}
                />
              </Card>
            )}
            <div>
              <TabBar label="Password Vault sections" tabs={TABS} active={tab} onChange={setTab} idPrefix="vault" />
              {/* Keyed by the lock state: locking remounts the panels and drops typed / revealed secrets. */}
              <div key={s.locked ? 'locked' : 'unlocked'}>
                <TabPanel id={tab} idPrefix="vault">
                  {tab === 'credentials' && <CredentialsPanel locked={s.locked} manageReason={manageReason} withReauth={withReauth} onActivity={reload} />}
                  {tab === 'access' && <GrantsOverview manageReason={!local ? 'Only on this Mac' : null} />}
                  {tab === 'signins' && <SignInRequestsCard />}
                  {tab === 'history' && <HistoryPanel />}
                  {tab === 'settings' && (
                    <div className="space-y-5">
                      <VaultSettingsPanel status={s} onStatus={applied} onImported={reload} withReauth={withReauth} />
                      <SmartAuthSettingsCard />
                      <SmartAuthTrustCard />
                    </div>
                  )}
                </TabPanel>
              </div>
            </div>
          </>
        )}
      </div>
      {reauthDialog}
    </>
  );
}

function VaultMark() {
  return (
    <span aria-hidden className="grid size-11 place-items-center rounded-xl border border-border-strong bg-panel-2 text-accent-soft [&>svg]:size-5">
      <IconVault />
    </span>
  );
}
