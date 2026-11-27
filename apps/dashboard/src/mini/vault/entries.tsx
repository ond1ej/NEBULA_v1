// One credential in the owner's Mini App: details (metadata + user name, never the password unless revealed), reveal /
// copy the password (ONE owner confirmation first when the session needs it — Face ID or the vault passphrase), edit, delete — and the add / edit
// form with a password generator. A revealed or typed password lives only in this screen's state: it is wiped when
// hidden, after 30 s, after saving and when the screen closes.
import { useEffect, useId, useRef, useState } from 'react';
import { parseTags } from '../../features/vault/lib';
import { formatTime, relativeTime } from '../../lib/format';
import { isApiError } from '../../lib/http';
import { useToast } from '../../components/Toast';
import { FieldShell, SelectInput, TextArea, TextInput, describedBy } from '../agentConfig/fields';
import { useActions } from '../hooks';
import { IcCopy } from '../icons';
import { mhref, navigate } from '../router';
import { Btn, Card, cx, ErrorState, List, Row, Screen, Section, SkeletonList } from '../uiKit';
import { ConfirmSheet, KV, Notice } from '../uiExtra';
import { IconEdit, IconEye, IconRefresh, IconTrash } from '../../components/icons';
import { vaultApiM, type EntryInput } from './api';
import { normalizeOrigin, TYPE_LABEL, useLocal, vaultErrorText, type EntryDetail as Detail } from './data';
import { UnlockVaultCard } from './forms';
import { CLEAR_CLIPBOARD_S, copySecret, FormAlert, FormCard, generatePassword, SecretInput, useReauth, useSubmit, type GenOptions } from './ui';

export const REVEAL_SECONDS = 30;
const isLocked = (e: unknown) => isApiError(e) && (e.code === 'vault_locked' || e.status === 423);

// ---------------------------------------------------------------- the stored password
function PasswordRow({ entryId, present }: { entryId: string; present: boolean }) {
  const withReauth = useReauth();
  const toast = useToast();
  const [value, setValue] = useState<string | null>(null);
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState<'reveal' | 'copy' | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  // wiped after 30 s (and with the component when the screen closes)
  useEffect(() => {
    if (value === null) return;
    const t = setTimeout(() => {
      setValue(null);
      setShow(false);
    }, REVEAL_SECONDS * 1000);
    return () => clearTimeout(t);
  }, [value]);

  const fetchValue = async (what: 'reveal' | 'copy'): Promise<string | null> => {
    setBusy(what);
    try {
      return await withReauth(() => vaultApiM.reveal(entryId, 'password'));
    } catch (e) {
      if (alive.current) toast.error(vaultErrorText(e), 'Could not reveal the password');
      return null;
    } finally {
      if (alive.current) setBusy(null);
    }
  };
  const reveal = async () => {
    const v = await fetchValue('reveal');
    if (v === null || !alive.current) return;
    setValue(v);
    setShow(false);
  };
  const copy = async () => {
    const v = value ?? (await fetchValue('copy'));
    if (v === null || !alive.current) return;
    try {
      await copySecret(v);
      toast.info('Password copied', `It is cleared from the clipboard after ${CLEAR_CLIPBOARD_S} s if it is still there.`);
    } catch (e) {
      toast.error(e, 'Copy failed');
    }
  };
  const hide = () => {
    setValue(null);
    setShow(false);
  };

  if (!present) return <p className="px-4 py-3 text-subhead text-muted">No password stored.</p>;
  return (
    <div className="px-4 py-3" data-testid="vault-password">
      <p className="text-footnote text-muted">Password</p>
      <p className={cx('mt-0.5 font-mono text-body break-all text-text', value === null && 'tracking-widest text-muted')} data-testid={value !== null && show ? 'revealed-password' : undefined}>
        {value === null ? '••••••••••••' : show ? value : '•'.repeat(Math.min(24, Math.max(8, value.length)))}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        {value === null ? (
          <Btn size="sm" variant="tinted" icon={<IconEye />} loading={busy === 'reveal'} disabled={busy !== null} onClick={() => void reveal()}>
            Reveal
          </Btn>
        ) : (
          <>
            <Btn size="sm" variant="tinted" icon={<IconEye />} aria-pressed={show} onClick={() => setShow((s) => !s)}>
              {show ? 'Mask' : 'Show'}
            </Btn>
            <Btn size="sm" onClick={hide}>
              Hide
            </Btn>
          </>
        )}
        <Btn size="sm" icon={<IcCopy />} loading={busy === 'copy'} disabled={busy !== null} onClick={() => void copy()} aria-label="Copy password">
          Copy
        </Btn>
      </div>
      {value !== null && (
        <p role="status" className="mt-1.5 text-footnote text-subtle">
          Hidden again after {REVEAL_SECONDS} s. Every reveal is recorded in the vault history.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- details
export function EntryDetail({ entryId }: { entryId: string }) {
  const toast = useToast();
  const { run, isPending } = useActions();
  const d = useLocal((s) => vaultApiM.entry(entryId, s), [entryId], (ev) => ev.type === 'vault.status.changed');
  const [del, setDel] = useState(false);
  const e = d.data;
  const remove = async () => {
    const r = await run('delete', () => vaultApiM.deleteEntry(entryId), { success: `${e?.display_name ?? 'Credential'} deleted` });
    if (r !== undefined) {
      setDel(false);
      navigate('/settings/vault', { replace: true });
    }
  };
  const copyUser = async (u: string) => {
    try {
      await navigator.clipboard.writeText(u);
      toast.info('User name copied');
    } catch (err) {
      toast.error(err, 'Copy failed');
    }
  };
  return (
    <Screen
      title={e?.display_name ?? 'Credential'}
      subtitle={e ? (TYPE_LABEL[e.credential_type] ?? e.credential_type) : undefined}
      actions={e ? <a href={mhref(`/settings/vault/entries/${entryId}/edit`)} className="px-2 text-body font-semibold text-accent-soft focus-ring">Edit</a> : undefined}
    >
      {e ? (
        <EntryBody e={e} onCopyUser={(u) => void copyUser(u)} onDelete={() => setDel(true)} />
      ) : d.error ? (
        isLocked(d.error) ? (
          <LockedHint onUnlocked={d.reload} />
        ) : (
          <ErrorState error={d.error} onRetry={d.reload} />
        )
      ) : (
        <SkeletonList rows={3} avatar={false} />
      )}
      <ConfirmSheet open={del} title={`Delete ${e?.display_name ?? 'this credential'}?`} confirmLabel="Delete" tone="danger" busy={isPending('delete')} onCancel={() => setDel(false)} onConfirm={() => void remove()}>
        The credential and every agent grant for it are removed from the vault. This cannot be undone.
      </ConfirmSheet>
    </Screen>
  );
}

function LockedHint({ onUnlocked }: { onUnlocked: () => void }) {
  return (
    <div className="space-y-3">
      <Notice tone="info" title="The vault is locked">
        Unlock it to see this credential.
      </Notice>
      <UnlockVaultCard status={null} onUnlocked={onUnlocked} compact />
    </div>
  );
}

function EntryBody({ e, onCopyUser, onDelete }: { e: Detail; onCopyUser: (u: string) => void; onDelete: () => void }) {
  return (
    <>
      <Section title="Sign-in">
        <div className="overflow-hidden rounded-card bg-panel">
          {e.origin && (
            <div className="border-b border-border px-4 py-3">
              <p className="text-footnote text-muted">Website</p>
              <p className="mt-0.5 font-mono text-body break-all text-text">{e.origin}</p>
            </div>
          )}
          <div className="flex items-center gap-2 border-b border-border px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="text-footnote text-muted">User name</p>
              <p className="mt-0.5 text-body break-all text-text" data-testid="vault-username">
                {e.username || '—'}
              </p>
            </div>
            {e.username && (
              <Btn size="sm" icon={<IcCopy />} aria-label="Copy user name" onClick={() => onCopyUser(e.username)}>
                Copy
              </Btn>
            )}
          </div>
          <PasswordRow entryId={e.id} present={e.has_password} />
        </div>
      </Section>
      <Section title="Details">
        <Card>
          <KV
            items={[
              ['Type', TYPE_LABEL[e.credential_type] ?? e.credential_type],
              ...(e.app_name ? ([['App', e.app_name]] as [string, string][]) : []),
              ['Tags', e.tags.length ? e.tags.map((t) => `#${t}`).join(' ') : '—'],
              ['Notes', e.has_notes ? 'Stored (encrypted)' : '—'],
              ['Created', e.created_at ? formatTime(e.created_at) : '—'],
              ['Changed', e.updated_at ? relativeTime(e.updated_at) : '—'],
            ]}
          />
        </Card>
      </Section>
      <Section>
        <List>
          <Row href={mhref(`/settings/vault/entries/${e.id}/edit`)} leading={<IconEdit className="size-5 text-accent-soft" />} title="Edit credential" />
          <Row onClick={onDelete} leading={<IconTrash className="size-5 text-danger" />} title="Delete credential" destructive chevron={false} />
        </List>
      </Section>
    </>
  );
}

// ---------------------------------------------------------------- add / edit
type CredType = EntryInput['credential_type'];

function Generator({ onUse }: { onUse: (pw: string) => void }) {
  const ids = useId();
  const [o, setO] = useState<GenOptions>({ length: 20, lower: true, upper: true, digits: true, symbols: true });
  const toggle = (k: 'lower' | 'upper' | 'digits' | 'symbols', label: string) => (
    <label className="flex min-h-11 items-center gap-2 text-subhead text-text">
      <input type="checkbox" className="size-5 accent-accent" checked={o[k]} onChange={(e) => setO((x) => ({ ...x, [k]: e.target.checked }))} />
      {label}
    </label>
  );
  return (
    <div className="space-y-2 rounded-xl bg-text/5 p-3" data-testid="vault-generator" role="group" aria-label="Password generator">
      <div className="flex items-center gap-3">
        <label htmlFor={`${ids}-len`} className="text-subhead text-text">
          Length
        </label>
        <input
          id={`${ids}-len`}
          type="range"
          min={8}
          max={64}
          value={o.length}
          onChange={(e) => setO((x) => ({ ...x, length: Number(e.target.value) }))}
          className="min-w-0 flex-1 accent-accent"
        />
        <span className="w-8 text-right font-mono text-subhead text-text tabular-nums" aria-hidden>
          {o.length}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-x-3">
        {toggle('lower', 'a–z')}
        {toggle('upper', 'A–Z')}
        {toggle('digits', '0–9')}
        {toggle('symbols', 'Symbols')}
      </div>
      <Btn size="sm" variant="tinted" icon={<IconRefresh />} className="w-full" onClick={() => onUse(generatePassword(o))}>
        Generate password
      </Btn>
    </div>
  );
}

export function EntryForm({ entryId }: { entryId?: string }) {
  const editing = Boolean(entryId);
  const existing = useLocal((s) => (entryId ? vaultApiM.entry(entryId, s) : Promise.resolve(null)), [entryId ?? '']);
  const f = useId();
  const [name, setName] = useState('');
  const [type, setType] = useState<CredType>('website');
  const [site, setSite] = useState('');
  const [app, setApp] = useState('');
  const [user, setUser] = useState('');
  const [pw, setPw] = useState('');
  const [notes, setNotes] = useState('');
  const [tags, setTags] = useState('');
  const [gen, setGen] = useState(false);
  const [tried, setTried] = useState(false);
  const { busy, error, run } = useSubmit();
  const loaded = useRef(false);
  const base = existing.data;
  useEffect(() => {
    if (!base || loaded.current) return;
    loaded.current = true;
    setName(base.display_name);
    setType((['website', 'application', 'api_token'].includes(base.credential_type) ? base.credential_type : 'website') as CredType);
    setSite(base.origin ?? '');
    setApp(base.app_name ?? '');
    setUser(base.username);
    setTags(base.tags.join(', '));
  }, [base]);
  // the typed password and notes never outlive the form
  useEffect(
    () => () => {
      setPw('');
      setNotes('');
    },
    [],
  );

  const origin = normalizeOrigin(site);
  const errors = {
    name: !name.trim() ? 'Enter a name for this credential.' : null,
    site: type === 'website' && !origin ? 'Enter the website, for example github.com.' : site.trim() && !origin ? 'This is not a website address.' : null,
  };
  const invalid = Boolean(errors.name || errors.site);

  const submit = async () => {
    setTried(true);
    if (invalid) return;
    const body: EntryInput = {
      display_name: name.trim(),
      credential_type: type,
      ...(origin ? { origin } : {}),
      ...(type === 'application' && app.trim() ? { app_name: app.trim() } : {}),
      username: user,
      tags: parseTags(tags),
      ...(pw ? { password: pw } : {}),
      ...(notes ? { notes } : {}),
    };
    const r = await run(() => (entryId ? vaultApiM.updateEntry(entryId, body) : vaultApiM.createEntry(body)));
    body.password = undefined;
    body.notes = undefined;
    if (r === undefined) return;
    setPw('');
    setNotes('');
    navigate(`/settings/vault/entries/${r.id || entryId}`, { replace: true });
  };

  if (editing && !base)
    return (
      <Screen title="Edit credential">
        {existing.error ? (
          isLocked(existing.error) ? (
            <LockedHint onUnlocked={existing.reload} />
          ) : (
            <ErrorState error={existing.error} onRetry={existing.reload} />
          )
        ) : (
          <SkeletonList rows={3} avatar={false} />
        )}
      </Screen>
    );

  return (
    <Screen title={editing ? 'Edit credential' : 'New credential'}>
      <form
        className="space-y-4 pb-6"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        noValidate
        aria-label={editing ? 'Edit credential' : 'New credential'}
        data-testid="vault-entry-form"
      >
        <FormCard>
          <FieldShell id={`${f}-name`} label="Service name" required error={tried ? errors.name : null}>
            <TextInput
              id={`${f}-name`}
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={200}
              placeholder="GitHub (work)"
              autoComplete="off"
              invalid={tried && Boolean(errors.name)}
              aria-describedby={describedBy(`${f}-name`, tried ? errors.name : null)}
            />
          </FieldShell>
          <FieldShell id={`${f}-type`} label="Type">
            <SelectInput id={`${f}-type`} value={type} onChange={(e) => setType(e.target.value as CredType)}>
              <option value="website">Website</option>
              <option value="application">App</option>
              <option value="api_token">API token</option>
            </SelectInput>
          </FieldShell>
          <FieldShell
            id={`${f}-site`}
            label="Website"
            required={type === 'website'}
            error={tried ? errors.site : null}
            hint={origin && origin !== site.trim() ? `Saved as ${origin}` : 'Only this exact address can use the credential. Agents may use https:// sites only.'}
          >
            <TextInput
              id={`${f}-site`}
              type="url"
              inputMode="url"
              value={site}
              onChange={(e) => setSite(e.target.value)}
              placeholder="github.com"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              invalid={tried && Boolean(errors.site)}
              aria-describedby={describedBy(`${f}-site`, tried ? errors.site : null, null, 'hint')}
            />
          </FieldShell>
          {type === 'application' && (
            <FieldShell id={`${f}-app`} label="App name">
              <TextInput id={`${f}-app`} value={app} onChange={(e) => setApp(e.target.value)} maxLength={200} autoComplete="off" />
            </FieldShell>
          )}
        </FormCard>
        <FormCard>
          <FieldShell id={`${f}-user`} label="Username, email or phone">
            <TextInput id={`${f}-user`} value={user} onChange={(e) => setUser(e.target.value)} maxLength={512} autoComplete="off" autoCapitalize="none" spellCheck={false} />
          </FieldShell>
          <SecretInput
            label={type === 'api_token' ? 'Token' : 'Password'}
            value={pw}
            onChange={setPw}
            autoComplete="new-password"
            hint={editing ? 'Leave empty to keep the stored one.' : undefined}
          />
          {type !== 'api_token' &&
            (gen ? (
              <Generator
                onUse={(p) => {
                  setPw(p);
                }}
              />
            ) : (
              <Btn size="sm" variant="tinted" icon={<IconRefresh />} onClick={() => setGen(true)}>
                Password generator
              </Btn>
            ))}
          <FieldShell id={`${f}-notes`} label="Notes" hint={editing ? 'Encrypted. Leave empty to keep the stored notes.' : 'Encrypted like the password.'}>
            <TextArea id={`${f}-notes`} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={4000} aria-describedby={`${f}-notes-hint`} />
          </FieldShell>
          <FieldShell id={`${f}-tags`} label="Tags" hint="Separated by commas, e.g. work, finance. Agents with managed access use tags.">
            <TextInput id={`${f}-tags`} value={tags} onChange={(e) => setTags(e.target.value)} maxLength={300} autoComplete="off" autoCapitalize="none" aria-describedby={`${f}-tags-hint`} />
          </FieldShell>
        </FormCard>
        <FormAlert error={error} />
        <Btn type="submit" variant="primary" size="lg" className="w-full" loading={busy}>
          {editing ? 'Save changes' : 'Save credential'}
        </Btn>
        {editing && (
          <a href={mhref(`/settings/vault/entries/${entryId}`)} className="block py-2 text-center text-body text-accent-soft focus-ring">
            Cancel
          </a>
        )}
      </form>
    </Screen>
  );
}
