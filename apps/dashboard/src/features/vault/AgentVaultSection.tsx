// Agent → Security → Password Vault: the agent's vault access mode (NONE by default), its credential grants and its
// recent credential use. Changing the mode to SELECTED / MANAGED and creating grants need an unlocked vault and a
// local session; NONE and Revoke always work.
import { useEffect, useId, useState } from 'react';
import { Card, Badge, Button, ButtonLink, EmptyState, ErrorBanner, Field, Input, LoadingRows, Notice } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { IconActivity, IconPlus, IconShield, IconVault } from '../../components/icons';
import { useAction, useApi } from '../../hooks/useApi';
import { useLiveRefresh } from '../../hooks/useEvents';
import { href } from '../../hooks/useHashRoute';
import type { Agent } from '../../types';
import { vaultApi } from './api';
import { UnlockForm } from './forms';
import { AuditTable, GrantDialog, GrantTable } from './grants';
import { useVaultStatus } from './hooks';
import { MODE_LABEL, parseTags } from './lib';
import type { AgentVaultMode, VaultGrant } from './types';

const MODES: AgentVaultMode[] = ['NONE', 'SELECTED', 'MANAGED'];

const MODE_DESC: Record<AgentVaultMode, string> = {
  NONE: 'The agent cannot ask for any credential. Switching to this disables its grants.',
  SELECTED: 'The agent may ask to sign in only with the credentials you grant below.',
  MANAGED: 'The agent may use every website credential tagged with one of its collection tags.',
};

export function AgentVaultSection({ agent }: { agent: Pick<Agent, 'id' | 'name'> }) {
  const toast = useToast();
  const ids = { mode: useId(), tags: useId() };
  const status = useVaultStatus();
  const view = useApi((signal) => vaultApi.agent(agent.id, signal), [agent.id]);
  const entries = useApi((signal) => vaultApi.entries(undefined, signal), []);
  useLiveRefresh(view.reload, (ev) => ev.type === 'vault.status.changed' || (ev.type === 'vault.access' && ev.agent_id === agent.id), 400);
  useLiveRefresh(entries.reload, (ev) => ev.type === 'vault.status.changed', 400);
  const { run, isPending } = useAction();
  const [draft, setDraft] = useState<AgentVaultMode>('NONE');
  const [tags, setTags] = useState('');
  const [dialog, setDialog] = useState<{ grant: VaultGrant | null } | null>(null);

  const v = view.data;
  const s = status.data;
  // Follow the saved mode until the owner starts changing it.
  useEffect(() => {
    if (!v) return;
    setDraft(v.mode);
    setTags(v.managed_tags.join(', '));
  }, [v?.mode, v?.managed_tags.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  if ((view.error && !v) || (status.error && !s)) {
    return <ErrorBanner error={view.error ?? status.error} onRetry={() => (view.reload(), status.reload())} />;
  }
  if (!v || !s) {
    return (
      <Card>
        <LoadingRows rows={3} label="Loading Password Vault access…" />
      </Card>
    );
  }

  const local = s.management_local;
  const unlockedReason = !local ? 'Only in the Dashboard on this Mac' : !s.exists ? 'Set up the Password Vault first' : s.locked ? 'Unlock the vault first' : null;
  const tagList = parseTags(tags);
  const dirty = draft !== v.mode || (draft === 'MANAGED' && tagList.join(',') !== v.managed_tags.join(','));
  const saveReason = !dirty
    ? 'No changes'
    : !local
      ? 'Only in the Dashboard on this Mac'
      : draft !== 'NONE' && unlockedReason
        ? unlockedReason
        : draft === 'MANAGED' && tagList.length === 0
          ? 'Enter at least one collection tag'
          : null;
  const addReason = v.mode === 'NONE' ? 'Choose “Selected credentials” and save first' : unlockedReason;

  const saveMode = async () => {
    const r = await run('mode', () => vaultApi.setAgentMode(agent.id, draft, draft === 'MANAGED' ? tagList : []), { errorTitle: 'Vault access not changed' });
    if (r) {
      view.setData(() => r);
      toast.success(`${agent.name}: ${MODE_LABEL[r.mode]}`);
      status.reload();
    }
  };

  return (
    <div className="space-y-5">
      <Card
        title="Password Vault"
        icon={<IconVault />}
        subtitle="Lets this agent sign in to websites with credentials from your vault. The agent never sees a password: NEBULA signs in separately and hands over only the session."
        actions={
          <ButtonLink size="sm" href={href('/vault')}>
            Open vault
          </ButtonLink>
        }
      >
        <div className="space-y-4">
          {!s.exists ? (
            <Notice tone="info" title="No Password Vault yet" action={<ButtonLink size="sm" variant="primary" href={href('/vault')}>Set up the vault</ButtonLink>}>
              Set up the Password Vault before giving this agent access to credentials.
            </Notice>
          ) : s.locked && local ? (
            <Notice tone="warn" title="The vault is locked">
              <p className="mb-3">Unlock it to change this agent’s access or to grant credentials. Revoking works while locked.</p>
              <UnlockForm
                compact
                lockoutUntil={s.lockout_until}
                onFailed={status.reload}
                onUnlocked={(core) => {
                  status.merge(core);
                  status.reload();
                  toast.success('Vault unlocked');
                }}
              />
            </Notice>
          ) : !local ? (
            <Notice tone="warn" title="Only on this Mac">
              Changing vault access and granting credentials works only in the Dashboard opened on the NEBULA Mac. You can still revoke grants from here.
            </Notice>
          ) : null}

          <fieldset>
            <legend id={ids.mode} className="mb-2 text-[13px] font-medium text-text">
              Vault access
            </legend>
            <div className="grid gap-2 lg:grid-cols-3">
              {MODES.map((m) => {
                const on = draft === m;
                return (
                  <label
                    key={m}
                    className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors ${on ? 'border-accent/60 bg-accent/[0.06]' : 'border-border hover:border-border-strong'}`}
                  >
                    <input type="radio" name={`vault-mode-${agent.id}`} value={m} checked={on} onChange={() => setDraft(m)} className="mt-1 size-4 shrink-0 accent-accent" />
                    <span className="min-w-0">
                      <span className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-text">
                        {MODE_LABEL[m]}
                        {m === 'NONE' && <Badge>Default</Badge>}
                        {m === 'SELECTED' && <Badge tone="accent">Recommended</Badge>}
                        {m === 'MANAGED' && <Badge tone="warn">Broader</Badge>}
                      </span>
                      <span className="mt-0.5 block text-xs leading-5 text-muted">{MODE_DESC[m]}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>

          {draft === 'MANAGED' && (
            <div className="space-y-3">
              <Notice tone="warn" title="Managed access is broader">
                Every website credential with one of these tags — including ones you add later — becomes usable by {agent.name} without a separate grant. Prefer “Selected
                credentials” unless the agent manages a whole collection for you.
              </Notice>
              <Field htmlFor={ids.tags} label="Collection tags" hint="Comma separated, e.g. shopping, newsletters.">
                <Input id={ids.tags} value={tags} onChange={(e) => setTags(e.target.value)} autoComplete="off" />
              </Field>
            </div>
          )}
          {draft === 'NONE' && v.mode !== 'NONE' && <Notice tone="info">Saving disables all of {agent.name}’s grants. You can enable them again later.</Notice>}

          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" loading={isPending('mode')} disabledReason={isPending('mode') ? null : saveReason} onClick={() => void saveMode()}>
              Save vault access
            </Button>
            {dirty && (
              <Button
                onClick={() => {
                  setDraft(v.mode);
                  setTags(v.managed_tags.join(', '));
                }}
              >
                Discard
              </Button>
            )}
            <span className="text-xs text-muted">
              Current: <strong className="text-text">{MODE_LABEL[v.mode]}</strong>
              {v.mode === 'MANAGED' && v.managed_tags.length ? ` (${v.managed_tags.join(', ')})` : ''}
            </span>
          </div>
        </div>
      </Card>

      <Card
        title="Credential grants"
        icon={<IconShield />}
        subtitle="Which credential the agent may use, on which origins, and whether you approve each sign-in."
        actions={
          <Button size="sm" variant="primary" icon={<IconPlus />} disabledReason={addReason} onClick={() => setDialog({ grant: null })}>
            Add grant
          </Button>
        }
      >
        {v.grants.length === 0 ? (
          <EmptyState compact icon={<IconShield />} title="No credential granted">
            {v.mode === 'NONE' ? `${agent.name} has no vault access.` : 'Add a grant to let this agent ask to sign in with a credential.'}
          </EmptyState>
        ) : (
          <GrantTable
            grants={v.grants}
            label={`Grants of ${agent.name}`}
            manageReason={{ edit: unlockedReason, remove: local ? null : 'Only in the Dashboard on this Mac' }}
            onEdit={(g) => setDialog({ grant: g })}
            onChanged={view.reload}
          />
        )}
      </Card>

      <Card title="Recent credential use" icon={<IconActivity />}>
        {v.recent.length === 0 ? <p className="text-sm text-muted">No vault activity for this agent yet.</p> : <AuditTable rows={v.recent} showAgent={false} label={`Recent vault activity of ${agent.name}`} />}
      </Card>

      {dialog && (
        <GrantDialog
          agentId={agent.id}
          agentName={agent.name}
          entries={entries.data ?? []}
          grant={dialog.grant}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            view.reload();
            entries.reload();
          }}
        />
      )}
    </div>
  );
}
