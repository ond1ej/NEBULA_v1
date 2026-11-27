// Credentials of the Password Vault: searchable metadata list, detail drawer with explicit Reveal / Copy, and the
// add / edit form. Typed and revealed secrets exist only in the drawer's component state; the drawer closes (and
// so drops them) when the vault locks.
import { useEffect, useId, useState, type FormEvent } from 'react';
import { ConfirmDialog, Drawer } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { IconEdit, IconKey, IconPlus, IconSearch, IconSparkle, IconTrash } from '../../components/icons';
import {
  Badge,
  Button,
  Checkbox,
  DataTable,
  EmptyState,
  ErrorBanner,
  Field,
  IconButton,
  Input,
  KeyValue,
  LoadingRows,
  Mono,
  Notice,
  Select,
  Textarea,
  type Column,
} from '../../components/ui';
import { useAction, useApi } from '../../hooks/useApi';
import { useDebounced } from '../../hooks/useDebounced';
import { useLiveRefresh } from '../../hooks/useEvents';
import { formatTime, relativeTime } from '../../lib/format';
import { vaultApi } from './api';
import { SECRET_INPUT, SecretInput } from './forms';
import { useVaultLockSignal } from './hooks';
import { generatePassword, originOf, parseTags, TYPE_LABEL } from './lib';
import { CopyButton, SecretField } from './secretField';
import type { CredentialType, EntryBody, EntryPatch, VaultEntry, VaultEntryDetail } from './types';

type WithReauth = <T>(fn: () => Promise<T>) => Promise<T>;
type DrawerTarget = { mode: 'new' } | { mode: 'view' | 'edit'; entry: VaultEntry };

export function TagList({ tags }: { tags: string[] }) {
  if (!tags.length) return <span className="text-subtle">—</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {tags.map((t) => (
        <Badge key={t} tone="accent">
          {t}
        </Badge>
      ))}
    </span>
  );
}

export function CredentialsPanel({
  locked,
  manageReason,
  withReauth,
  onActivity,
}: {
  locked: boolean;
  /** Why the owner cannot manage credentials right now (locked / not local), or null. */
  manageReason: string | null;
  withReauth: WithReauth;
  onActivity: () => void;
}) {
  const toast = useToast();
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 250);
  const list = useApi((signal) => vaultApi.entries(dq, signal), [dq]);
  useLiveRefresh(list.reload, (ev) => ev.type === 'vault.status.changed', 300);
  const [target, setTarget] = useState<DrawerTarget | null>(null);
  const [deleting, setDeleting] = useState<VaultEntry | null>(null);
  const { run } = useAction();

  // Locking drops everything secret: close the drawer (typed / revealed values unmount with it).
  useVaultLockSignal(() => setTarget(null));
  useEffect(() => {
    if (locked || manageReason) setTarget(null);
  }, [locked, manageReason]);

  const rows = list.data ?? [];
  const columns: Column<VaultEntry>[] = [
    {
      key: 'name',
      header: 'Credential',
      mobile: 'title',
      cell: (e) => (
        <div className="min-w-0">
          <p className="truncate font-medium text-text">{e.display_name}</p>
          {e.app_name ? <p className="truncate text-xs text-muted">{e.app_name}</p> : null}
        </div>
      ),
    },
    { key: 'type', header: 'Type', mobile: 'aside', cell: (e) => <Badge>{TYPE_LABEL[e.credential_type]}</Badge> },
    { key: 'origin', header: 'Origin', cell: (e) => (e.origin ? <Mono className="break-all">{e.origin}</Mono> : <span className="text-subtle">—</span>) },
    { key: 'tags', header: 'Tags', cell: (e) => <TagList tags={e.tags} /> },
    { key: 'grants', header: 'Agent grants', align: 'right', cell: (e) => <span className="tabular-nums">{e.grant_count}</span> },
    { key: 'updated', header: 'Updated', cell: (e) => <span title={formatTime(e.updated_at)}>{relativeTime(e.updated_at)}</span> },
  ];
  if (!manageReason) {
    columns.push({
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      mobile: 'aside',
      cell: (e) => (
        <span className="inline-flex gap-1" onClick={(ev) => ev.stopPropagation()}>
          <IconButton size="sm" label={`Edit ${e.display_name}`} icon={<IconEdit />} onClick={() => setTarget({ mode: 'edit', entry: e })} />
          <IconButton size="sm" label={`Delete ${e.display_name}`} icon={<IconTrash />} onClick={() => setDeleting(e)} />
        </span>
      ),
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="relative block w-full max-w-sm">
          <span className="sr-only">Search credentials</span>
          <IconSearch className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-subtle" />
          <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, app, origin or tag" className="pl-9" autoComplete="off" />
        </label>
        <Button variant="primary" icon={<IconPlus />} disabledReason={manageReason} onClick={() => setTarget({ mode: 'new' })}>
          Add credential
        </Button>
      </div>
      {locked && (
        <p className="text-sm text-muted">The vault is locked: only metadata is shown. Unlock it to add, edit or reveal credentials.</p>
      )}
      {list.error && !list.data ? (
        <ErrorBanner error={list.error} onRetry={list.reload} />
      ) : !list.data ? (
        <LoadingRows rows={3} label="Loading credentials…" />
      ) : rows.length === 0 ? (
        <EmptyState compact icon={<IconKey />} title={dq ? 'No matching credentials' : 'No credentials yet'}>
          {dq ? 'Try another search.' : 'Add the sign-in details an agent may use. Passwords are encrypted on this Mac and never shown to agents.'}
        </EmptyState>
      ) : (
        <DataTable
          label="Credentials"
          rows={rows}
          rowKey={(e) => e.id}
          columns={columns}
          minWidth={760}
          onRowClick={manageReason ? undefined : (e) => setTarget({ mode: 'view', entry: e })}
          rowLabel={(e) => `Open ${e.display_name}`}
        />
      )}

      {target && (
        <CredentialDrawer
          target={target}
          withReauth={withReauth}
          onActivity={onActivity}
          onClose={() => setTarget(null)}
          onEdit={(entry) => setTarget({ mode: 'edit', entry })}
          onView={(entry) => setTarget({ mode: 'view', entry })}
          onDelete={(entry) => setDeleting(entry)}
          onSaved={(entry, created) => {
            list.reload();
            onActivity();
            setTarget(created ? null : { mode: 'view', entry });
          }}
        />
      )}

      <ConfirmDialog
        open={deleting !== null}
        title={`Delete “${deleting?.display_name ?? ''}”?`}
        confirmLabel="Delete credential"
        busyText="Deleting…"
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return;
          const r = await run('delete', () => vaultApi.deleteEntry(deleting.id), { errorTitle: 'Credential not deleted' });
          if (r) {
            toast.success('Credential deleted', r.grants_revoked ? `${r.grants_revoked} agent grant${r.grants_revoked === 1 ? '' : 's'} removed.` : undefined);
            setDeleting(null);
            setTarget(null);
            list.reload();
            onActivity();
          }
        }}
      >
        <p>
          The encrypted credential is destroyed{deleting?.grant_count ? (
            <>
              {' '}
              and its <strong>{deleting.grant_count} agent grant{deleting.grant_count === 1 ? '' : 's'}</strong> {deleting.grant_count === 1 ? 'is' : 'are'} deleted
            </>
          ) : null}
          . This cannot be undone.
        </p>
      </ConfirmDialog>
    </div>
  );
}

function CredentialDrawer({
  target,
  withReauth,
  onActivity,
  onClose,
  onEdit,
  onView,
  onDelete,
  onSaved,
}: {
  target: DrawerTarget;
  withReauth: WithReauth;
  onActivity: () => void;
  onClose: () => void;
  onEdit: (e: VaultEntry) => void;
  onView: (e: VaultEntry) => void;
  onDelete: (e: VaultEntry) => void;
  onSaved: (e: VaultEntry, created: boolean) => void;
}) {
  if (target.mode === 'new') {
    return (
      <Drawer open title="Add credential" description="Stored encrypted on this Mac. Agents never see passwords." onClose={onClose} width="lg">
        <EntryForm initial={null} onCancel={onClose} onSaved={(e) => onSaved(e, true)} />
      </Drawer>
    );
  }
  return <ExistingCredential key={`${target.entry.id}-${target.mode}`} target={target} withReauth={withReauth} onActivity={onActivity} onClose={onClose} onEdit={onEdit} onView={onView} onDelete={onDelete} onSaved={onSaved} />;
}

function ExistingCredential({
  target,
  withReauth,
  onActivity,
  onClose,
  onEdit,
  onView,
  onDelete,
  onSaved,
}: {
  target: { mode: 'view' | 'edit'; entry: VaultEntry };
  withReauth: WithReauth;
  onActivity: () => void;
  onClose: () => void;
  onEdit: (e: VaultEntry) => void;
  onView: (e: VaultEntry) => void;
  onDelete: (e: VaultEntry) => void;
  onSaved: (e: VaultEntry, created: boolean) => void;
}) {
  const { entry, mode } = target;
  const detail = useApi((signal) => vaultApi.entry(entry.id, signal), [entry.id]);
  const d = detail.data;
  return (
    <Drawer
      open
      title={mode === 'edit' ? `Edit ${entry.display_name}` : entry.display_name}
      description={mode === 'edit' ? 'Leave the password and notes empty to keep the stored values.' : `${TYPE_LABEL[entry.credential_type]}${entry.origin ? ` · ${entry.origin}` : ''}`}
      onClose={onClose}
      width="lg"
      footer={
        mode === 'view' ? (
          <>
            <Button variant="danger" icon={<IconTrash />} onClick={() => onDelete(entry)}>
              Delete
            </Button>
            <Button icon={<IconEdit />} onClick={() => onEdit(entry)} disabled={!d}>
              Edit
            </Button>
            <Button onClick={onClose}>Close</Button>
          </>
        ) : undefined
      }
    >
      {detail.error && !d ? (
        <ErrorBanner error={detail.error} onRetry={detail.reload} title="Could not open the credential" />
      ) : !d ? (
        <LoadingRows rows={4} label="Loading credential…" />
      ) : mode === 'edit' ? (
        <EntryForm initial={d} onCancel={() => onView(entry)} onSaved={(e) => onSaved({ ...entry, ...e, grant_count: entry.grant_count }, false)} />
      ) : (
        <CredentialDetail detail={d} grantCount={entry.grant_count} withReauth={withReauth} onActivity={onActivity} />
      )}
    </Drawer>
  );
}

function CredentialDetail({ detail, grantCount, withReauth, onActivity }: { detail: VaultEntryDetail; grantCount: number; withReauth: WithReauth; onActivity: () => void }) {
  return (
    <div className="space-y-5">
      <KeyValue
        items={[
          ['Type', <Badge>{TYPE_LABEL[detail.credential_type]}</Badge>],
          ['App', detail.app_name || '—'],
          ['Origin', detail.origin ? <Mono className="break-all text-text">{detail.origin}</Mono> : '—'],
          ['Sign-in page', detail.login_url ? <Mono className="break-all text-text">{detail.login_url}</Mono> : '—'],
          ['Tags', <TagList tags={detail.tags} />],
          [
            'Username',
            detail.username ? (
              <span className="inline-flex flex-wrap items-center gap-1.5">
                <Mono className="break-all text-text">{detail.username}</Mono>
                <CopyButton text={detail.username} label="username" />
              </span>
            ) : (
              <span className="text-subtle">Not stored</span>
            ),
          ],
          ['Password', <SecretField entryId={detail.id} field="password" label="Password" present={detail.has_password} withReauth={withReauth} onActivity={onActivity} canReveal={null} />],
          ['Notes', <SecretField entryId={detail.id} field="notes" label="Notes" present={detail.has_notes} withReauth={withReauth} onActivity={onActivity} canReveal={null} />],
          ['Agent grants', String(grantCount)],
          ['Updated', formatTime(detail.updated_at)],
        ]}
      />
      <p className="text-xs leading-5 text-subtle">
        Revealed values hide again after 30 seconds and whenever the vault locks. Every reveal is recorded in the vault history.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------- add / edit
export function EntryForm({ initial, onCancel, onSaved }: { initial: VaultEntryDetail | null; onCancel: () => void; onSaved: (e: VaultEntry) => void }) {
  const toast = useToast();
  const ids = { type: useId(), name: useId(), app: useId(), origin: useId(), login: useId(), user: useId(), pass: useId(), notes: useId(), tags: useId() };
  const [type, setType] = useState<CredentialType>(initial?.credential_type ?? 'website');
  const [name, setName] = useState(initial?.display_name ?? '');
  const [app, setApp] = useState(initial?.app_name ?? '');
  const [origin, setOrigin] = useState(initial?.origin ?? '');
  const [loginUrl, setLoginUrl] = useState(initial?.login_url ?? '');
  const [username, setUsername] = useState(initial?.username ?? '');
  const [password, setPassword] = useState('');
  const [notes, setNotes] = useState('');
  const [clearNotes, setClearNotes] = useState(false);
  const [tags, setTags] = useState((initial?.tags ?? []).join(', '));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const tagList = parseTags(tags);
  const loginMismatch = Boolean(loginUrl.trim() && origin.trim() && originOf(loginUrl) && originOf(origin) && originOf(loginUrl) !== originOf(origin));

  const patch: EntryPatch = {};
  if (initial) {
    if (type !== initial.credential_type) patch.credential_type = type;
    if (name.trim() !== initial.display_name) patch.display_name = name.trim();
    if (app.trim() !== (initial.app_name ?? '')) patch.app_name = app.trim();
    if (origin.trim() !== (initial.origin ?? '')) patch.origin = origin.trim();
    if (loginUrl.trim() !== initial.login_url) patch.login_url = loginUrl.trim();
    if (username !== initial.username) patch.username = username;
    if (tagList.join(',') !== initial.tags.join(',')) patch.tags = tagList;
    if (password) patch.password = password;
    if (notes) patch.notes = notes;
    else if (clearNotes) patch.notes = '';
  }
  const invalid = !name.trim()
    ? 'A display name is required'
    : type === 'website' && !origin.trim()
      ? 'Website credentials need the site origin'
      : loginMismatch
        ? 'The sign-in page must be on the credential origin'
        : initial && Object.keys(patch).length === 0
          ? 'No changes'
          : null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (invalid || busy) return;
    setBusy(true);
    setError(null);
    try {
      let saved: VaultEntry;
      if (initial) {
        saved = await vaultApi.updateEntry(initial.id, patch);
      } else {
        const body: EntryBody = { display_name: name.trim(), credential_type: type, tags: tagList };
        if (app.trim()) body.app_name = app.trim();
        if (origin.trim()) body.origin = origin.trim();
        if (loginUrl.trim()) body.login_url = loginUrl.trim();
        if (username) body.username = username;
        if (password) body.password = password;
        if (notes) body.notes = notes;
        saved = await vaultApi.createEntry(body);
      }
      setPassword('');
      setNotes('');
      toast.success(initial ? 'Credential saved' : 'Credential added', saved.display_name);
      onSaved(saved);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4" aria-label={initial ? 'Edit credential' : 'Add credential'}>
      <div className="grid gap-4 md:grid-cols-2">
        <Field htmlFor={ids.type} label="Type">
          <Select id={ids.type} value={type} onChange={(e) => setType(e.target.value as CredentialType)}>
            <option value="website">Website (agents can sign in)</option>
            <option value="application">Application</option>
            <option value="api_token">API token</option>
          </Select>
        </Field>
        <Field htmlFor={ids.name} label="Display name" required>
          <Input id={ids.name} value={name} maxLength={200} onChange={(e) => setName(e.target.value)} autoComplete="off" />
        </Field>
        <Field htmlFor={ids.app} label="App name">
          <Input id={ids.app} value={app} maxLength={200} onChange={(e) => setApp(e.target.value)} autoComplete="off" />
        </Field>
        <Field
          htmlFor={ids.origin}
          label="Origin"
          required={type === 'website'}
          hint={type === 'website' ? 'Full origin such as https://github.com — agents may only sign in there.' : 'Optional.'}
        >
          <Input id={ids.origin} value={origin} maxLength={2000} placeholder="https://" inputMode="url" onChange={(e) => setOrigin(e.target.value)} autoComplete="off" />
        </Field>
        <div className="md:col-span-2">
          <Field htmlFor={ids.login} label="Sign-in page URL" hint="Optional; must be on the origin above." error={loginMismatch ? 'The sign-in page must be on the credential origin' : null}>
            <Input id={ids.login} value={loginUrl} maxLength={2000} placeholder="https://…/login" inputMode="url" onChange={(e) => setLoginUrl(e.target.value)} autoComplete="off" />
          </Field>
        </div>
        <Field htmlFor={ids.user} label="Username">
          <Input id={ids.user} value={username} maxLength={512} onChange={(e) => setUsername(e.target.value)} {...SECRET_INPUT} autoComplete="off" />
        </Field>
        <Field
          htmlFor={ids.pass}
          label={type === 'api_token' ? 'Token / password' : 'Password'}
          hint={initial?.has_password ? 'Leave empty to keep the stored password.' : undefined}
          aside={
            <span className="inline-flex gap-1">
              <Button size="xs" variant="ghost" icon={<IconSparkle />} onClick={() => setPassword(generatePassword(20))}>
                Generate
              </Button>
              {password && <CopyButton text={password} label="password" />}
            </span>
          }
        >
          <SecretInput id={ids.pass} toggleLabel="password" value={password} maxLength={4096} placeholder={initial?.has_password ? 'Unchanged' : ''} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <div className="md:col-span-2">
          <Field htmlFor={ids.notes} label="Notes" hint={initial?.has_notes ? 'Stored notes are kept unless you type new ones.' : 'Encrypted like the password (recovery codes, security answers…).'}>
            <Textarea id={ids.notes} rows={3} maxLength={4000} value={notes} onChange={(e) => setNotes(e.target.value)} autoComplete="off" spellCheck={false} />
          </Field>
          {initial?.has_notes && !notes && (
            <div className="mt-2">
              <Checkbox label="Remove the stored notes" checked={clearNotes} onChange={setClearNotes} />
            </div>
          )}
        </div>
        <div className="md:col-span-2">
          <Field htmlFor={ids.tags} label="Tags" hint="Comma separated, e.g. work, finance. Managed agents may use credentials with their collection tags.">
            <Input id={ids.tags} value={tags} onChange={(e) => setTags(e.target.value)} autoComplete="off" />
          </Field>
        </div>
      </div>
      {type !== 'website' && <Notice tone="info">Only website credentials can be used by agents (sign-in). Applications and API tokens are stored for you only.</Notice>}
      {error ? <ErrorBanner error={error} title="Credential not saved" /> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" loading={busy} disabledReason={busy ? null : invalid}>
          {initial ? 'Save changes' : 'Add credential'}
        </Button>
        <Button onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
