// Password Vault settings: auto-lock, passphrase rotation, encrypted export / import, LAN HTTPS management and the
// agent sign-in broker. Passphrases and the parsed export live only in these components' state.
import { useId, useRef, useState, type FormEvent } from 'react';
import { ConfirmDialog } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { IconClock, IconDownload, IconKey, IconLock, IconShield, IconUpload, IconWifi } from '../../components/icons';
import { Badge, Button, Card, ErrorBanner, Field, KeyValue, Mono, Notice, SegmentedControl, Switch } from '../../components/ui';
import { useAction } from '../../hooks/useApi';
import { downloadBlob, formatBytes } from '../../lib/format';
import { vaultApi } from './api';
import { SecretInput, StrengthMeter } from './forms';
import { passphraseStrength } from './lib';
import { AUTO_LOCK_CHOICES, MIN_PASSPHRASE, type VaultCoreStatus, type VaultExportFile, type VaultStatus } from './types';

type WithReauth = <T>(fn: () => Promise<T>) => Promise<T>;

const MECHANISM: Record<string, string> = { isolated_login_session_handoff: 'Isolated login session hand-off' };
const ENVIRONMENT: Record<string, string> = { vm: 'Agents in the Ubuntu VM', host: 'Agents on the Mac' };

/** Agent credential use on/off (`settings.broker_enabled`; older hosts only report `broker.enabled`). */
export function brokerEnabled(s: VaultStatus): boolean {
  return s.settings?.broker_enabled ?? s.broker.enabled;
}

/**
 * Agent sign-in (credential broker): how agents use credentials, whether the broker works right now, and — with
 * `onStatus` (Settings) — the owner's on/off switch.
 */
export function BrokerCard({ status, onStatus }: { status: VaultStatus; onStatus?: (s: VaultCoreStatus) => void }) {
  const toast = useToast();
  const { run, isPending } = useAction();
  const b = status.broker;
  const enabled = brokerEnabled(status);
  const local = status.management_local;
  const tone = !enabled ? 'neutral' : b.available ? 'success' : 'warn';
  const state = !enabled ? 'Off' : b.available ? 'Available' : 'Unavailable';
  const toggle = async (v: boolean) => {
    const r = await run('broker', () => vaultApi.settings({ broker_enabled: v }), { errorTitle: 'Agent sign-in not changed' });
    if (!r || !onStatus) return;
    onStatus(r);
    if (v) toast.success('Agent sign-in turned on', 'Agents can ask to sign in with the credentials you granted.');
    else toast.success('Agent sign-in turned off', 'Agents cannot use any credential; pending sign-in requests were cancelled.');
  };
  return (
    <Card
      title="Agent sign-in (credential broker)"
      icon={<IconShield />}
      actions={
        <Badge tone={tone} dot>
          {state}
        </Badge>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-muted">
          <strong className="text-text">Agents never see passwords;</strong> NEBULA signs in separately and hands over only the session. An agent can only ask to sign in with a
          credential you granted, on the origins you allowed, with the approval you chose.
        </p>
        {onStatus && (
          <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 rounded-xl border border-border bg-panel-2/60 px-3.5 py-3">
            <Switch
              checked={enabled}
              loading={isPending('broker')}
              disabled={!local}
              onChange={(v) => void toggle(v)}
              label="Agent sign-in (credential broker)"
              description="Off: agents cannot use any vault credential and are not offered the vault at all; pending sign-in requests are cancelled. Grants are kept."
            />
            <div className="flex min-w-0 flex-col items-end gap-1 text-right" aria-live="polite">
              <Badge tone={b.available ? 'success' : 'warn'} dot>
                {b.available ? 'Broker available' : 'Broker unavailable'}
              </Badge>
              {b.reason && <span className="max-w-xs text-xs text-muted">{b.reason}</span>}
              {!local && <span className="text-xs text-subtle">Only on this Mac</span>}
            </div>
          </div>
        )}
        <KeyValue
          items={[
            ['Mechanism', MECHANISM[b.mechanism] ?? b.mechanism],
            ['Works for', b.environments.length ? b.environments.map((e) => ENVIRONMENT[e] ?? e).join(', ') : '—'],
            ...(b.reason && !onStatus ? ([['Note', b.reason]] as [string, string][]) : []),
          ]}
        />
      </div>
    </Card>
  );
}

function AutoLockCard({ status, local, onStatus }: { status: VaultStatus; local: boolean; onStatus: (s: VaultCoreStatus) => void }) {
  const { run, isPending } = useAction();
  const value = String(status.auto_lock_minutes);
  return (
    <Card title="Auto-lock" icon={<IconClock />} subtitle="The vault locks itself after this much inactivity. Locking forgets the key until the next unlock.">
      <div className="flex flex-wrap items-center gap-3">
        <SegmentedControl
          label="Auto-lock after"
          value={value}
          disabled={!local || isPending('autolock')}
          options={AUTO_LOCK_CHOICES.map((m) => ({ value: String(m), label: `${m} min` }))}
          onChange={async (v) => {
            if (v === value) return;
            const r = await run('autolock', () => vaultApi.settings({ auto_lock_minutes: Number(v) }), { success: `Auto-lock set to ${v} minutes`, errorTitle: 'Auto-lock not changed' });
            if (r) onStatus(r);
          }}
        />
        {!local && <span className="text-xs text-subtle">Only on this Mac</span>}
      </div>
    </Card>
  );
}

function RotateCard({ local, onStatus }: { local: boolean; onStatus: (s: VaultCoreStatus) => void }) {
  const toast = useToast();
  const ids = { cur: useId(), n1: useId(), n2: useId() };
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const invalid = !local
    ? 'Only on this Mac'
    : !current
      ? 'Enter the current passphrase'
      : next.length < MIN_PASSPHRASE
        ? `The new passphrase needs at least ${MIN_PASSPHRASE} characters`
        : !passphraseStrength(next).ok
          ? 'Choose a less repetitive passphrase'
          : next !== confirm
            ? 'The new passphrases do not match'
            : null;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (invalid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const s = await vaultApi.rotate(current, next);
      setCurrent('');
      setNext('');
      setConfirm('');
      toast.success('Vault passphrase changed', 'Use the new passphrase from now on. Earlier exports keep their own export passphrase.');
      onStatus(s);
    } catch (err) {
      setCurrent('');
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Change the vault passphrase" icon={<IconKey />} subtitle="Re-encrypts the vault key with the new passphrase. Credentials stay as they are.">
      <form onSubmit={submit} className="grid max-w-xl gap-4" aria-label="Change the vault passphrase">
        <Field htmlFor={ids.cur} label="Current passphrase">
          <SecretInput id={ids.cur} toggleLabel="current passphrase" value={current} onChange={(e) => setCurrent(e.target.value)} maxLength={1024} disabled={!local} />
        </Field>
        <Field htmlFor={ids.n1} label="New passphrase" hint={`At least ${MIN_PASSPHRASE} characters; not your NEBULA login password.`}>
          <SecretInput id={ids.n1} toggleLabel="new passphrase" value={next} onChange={(e) => setNext(e.target.value)} maxLength={1024} disabled={!local} />
        </Field>
        {next && <StrengthMeter value={next} />}
        <Field htmlFor={ids.n2} label="Repeat the new passphrase" error={confirm && confirm !== next ? 'The passphrases do not match' : null}>
          <SecretInput id={ids.n2} toggleLabel="repeated new passphrase" value={confirm} onChange={(e) => setConfirm(e.target.value)} maxLength={1024} disabled={!local} />
        </Field>
        <p className="text-xs text-muted">If you lose the new passphrase the vault cannot be decrypted — there is no recovery or backdoor.</p>
        {error ? <ErrorBanner error={error} title="Passphrase not changed" /> : null}
        <div>
          <Button type="submit" variant="primary" loading={busy} disabledReason={busy ? null : invalid}>
            Change passphrase
          </Button>
        </div>
      </form>
    </Card>
  );
}

function exportFileName(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `nebula-vault-export-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.json`;
}

function ExportCard({ manageReason, withReauth }: { manageReason: string | null; withReauth: WithReauth }) {
  const toast = useToast();
  const ids = { p1: useId(), p2: useId() };
  const [pass, setPass] = useState('');
  const [confirm, setConfirm] = useState('');
  const { run, isPending } = useAction();
  const invalid =
    manageReason ??
    (pass.length < MIN_PASSPHRASE
      ? `The export passphrase needs at least ${MIN_PASSPHRASE} characters`
      : pass !== confirm
        ? 'The export passphrases do not match'
        : null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (invalid) return;
    const p = pass;
    const r = await run('export', () => withReauth(() => vaultApi.exportVault(p)), { errorTitle: 'Export failed' });
    setPass('');
    setConfirm('');
    if (!r) return;
    // The encrypted file goes straight to the browser's download; nothing keeps a copy.
    const blob = new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' });
    downloadBlob(blob, exportFileName());
    toast.success('Encrypted export downloaded', `${r.header.entry_count} credential${r.header.entry_count === 1 ? '' : 's'} (${formatBytes(blob.size)}). Keep the export passphrase apart from the file.`);
  };
  return (
    <Card title="Encrypted export" icon={<IconDownload />} subtitle="A backup file encrypted with a separate export passphrase (Argon2id + AES-GCM).">
      <form onSubmit={submit} className="grid max-w-xl gap-4" aria-label="Export the vault">
        <Field htmlFor={ids.p1} label="Export passphrase" hint={`At least ${MIN_PASSPHRASE} characters. Needed to import the file; it cannot be recovered either.`}>
          <SecretInput id={ids.p1} toggleLabel="export passphrase" value={pass} onChange={(e) => setPass(e.target.value)} maxLength={1024} disabled={Boolean(manageReason)} />
        </Field>
        <Field htmlFor={ids.p2} label="Repeat the export passphrase" error={confirm && confirm !== pass ? 'The passphrases do not match' : null}>
          <SecretInput id={ids.p2} toggleLabel="repeated export passphrase" value={confirm} onChange={(e) => setConfirm(e.target.value)} maxLength={1024} disabled={Boolean(manageReason)} />
        </Field>
        <div>
          <Button type="submit" icon={<IconDownload />} loading={isPending('export')} disabledReason={isPending('export') ? null : invalid}>
            Download encrypted export
          </Button>
        </div>
      </form>
    </Card>
  );
}

function isExportFile(v: unknown): v is VaultExportFile {
  const o = v as Partial<VaultExportFile> | null;
  return Boolean(
    o &&
      typeof o === 'object' &&
      o.header &&
      typeof o.header === 'object' &&
      o.header.format === 'nebula-vault-export' &&
      typeof o.nonce === 'string' &&
      typeof o.ciphertext === 'string',
  );
}

function readText(f: File): Promise<string> {
  if (typeof f.text === 'function') return f.text();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result ?? ''));
    r.onerror = () => reject(r.error ?? new Error('Could not read the file'));
    r.readAsText(f);
  });
}

function ImportCard({ manageReason, withReauth, onImported }: { manageReason: string | null; withReauth: WithReauth; onImported: () => void }) {
  const toast = useToast();
  const ids = { file: useId(), pass: useId() };
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<{ name: string; data: VaultExportFile } | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [pass, setPass] = useState('');
  const [confirming, setConfirming] = useState(false);
  const { run } = useAction();

  const reset = () => {
    setFile(null);
    setPass('');
    if (fileRef.current) fileRef.current.value = '';
  };

  const pick = async (f: File | undefined) => {
    setFile(null);
    setFileError(null);
    if (!f) return;
    try {
      const data: unknown = JSON.parse(await readText(f));
      if (!isExportFile(data)) throw new Error('This is not a NEBULA vault export file.');
      setFile({ name: f.name, data });
    } catch (e) {
      setFileError(e instanceof SyntaxError ? 'The file is not valid JSON.' : e instanceof Error ? e.message : String(e));
    }
  };

  const count = file?.data.header.entry_count ?? 0;
  const invalid = manageReason ?? (!file ? 'Choose an export file' : !pass ? 'Enter the export passphrase' : null);
  return (
    <Card title="Import" icon={<IconUpload />} subtitle="Adds the credentials of a NEBULA vault export to this vault. Grants are not imported.">
      <div className="grid max-w-xl gap-4">
        <Field htmlFor={ids.file} label="Export file" error={fileError}>
          <input
            ref={fileRef}
            id={ids.file}
            type="file"
            accept="application/json,.json"
            disabled={Boolean(manageReason)}
            onChange={(e) => void pick(e.target.files?.[0])}
            className="block w-full text-sm text-muted file:mr-3 file:rounded-lg file:border file:border-border-strong file:bg-panel-2 file:px-3 file:py-1.5 file:text-sm file:text-text disabled:opacity-50"
          />
        </Field>
        {file && (
          <p className="text-sm text-muted">
            <Mono className="text-text">{file.name}</Mono> · {count} credential{count === 1 ? '' : 's'}
          </p>
        )}
        <Field htmlFor={ids.pass} label="Export passphrase">
          <SecretInput id={ids.pass} toggleLabel="export passphrase" value={pass} onChange={(e) => setPass(e.target.value)} maxLength={1024} disabled={Boolean(manageReason)} />
        </Field>
        <div>
          <Button icon={<IconUpload />} disabledReason={invalid} onClick={() => setConfirming(true)}>
            Import…
          </Button>
        </div>
      </div>
      <ConfirmDialog
        open={confirming}
        destructive={false}
        title={`Import ${count} credential${count === 1 ? '' : 's'}?`}
        confirmLabel="Import"
        busyText="Importing…"
        onCancel={() => setConfirming(false)}
        onConfirm={async () => {
          if (!file) return;
          const p = pass;
          const r = await run('import', () => withReauth(() => vaultApi.importVault(p, file.data, true)), { errorTitle: 'Import failed' });
          setConfirming(false);
          if (r) {
            toast.success(`Imported ${r.imported} credential${r.imported === 1 ? '' : 's'}`);
            reset();
            onImported();
          } else {
            setPass('');
          }
        }}
      >
        <p>
          They are added next to the existing credentials of this vault — nothing is overwritten or merged, so importing the same file twice creates duplicates. No agent
          gets access to them until you grant it.
        </p>
      </ConfirmDialog>
    </Card>
  );
}

function LanCard({ status, onStatus }: { status: VaultStatus; onStatus: (s: VaultCoreStatus) => void }) {
  const toast = useToast();
  const local = status.management_local;
  const [confirming, setConfirming] = useState(false);
  const { run, isPending } = useAction();
  const allowed = status.settings?.allow_lan_https ?? false;
  const set = async (v: boolean) => {
    const r = await run('lan', () => vaultApi.settings({ allow_lan_https: v }), { errorTitle: 'Setting not changed' });
    if (r) {
      onStatus(r);
      toast.success(v ? 'Vault management allowed over LAN HTTPS' : 'Vault management limited to this Mac');
    }
    return r;
  };
  return (
    <Card title="Remote management" icon={<IconWifi />}>
      <div className="space-y-3">
        <Switch
          checked={allowed}
          loading={isPending('lan')}
          disabled={!local}
          onChange={(v) => (v ? setConfirming(true) : void set(false))}
          label="Allow management over LAN HTTPS"
          description="Off by default: creating, unlocking, revealing and exporting only work on this Mac (http://127.0.0.1)."
        />
        {!local && <p className="text-xs text-subtle">This setting can only be changed in the Dashboard on this Mac.</p>}
        {allowed && (
          <Notice tone="warn">
            Anyone on your network who has the NEBULA login can manage — and reveal — vault credentials over HTTPS. Turn this off when you no longer need it.
          </Notice>
        )}
      </div>
      <ConfirmDialog
        open={confirming}
        title="Allow vault management over LAN HTTPS?"
        confirmLabel="Allow over LAN HTTPS"
        onCancel={() => setConfirming(false)}
        onConfirm={async () => {
          if (await set(true)) setConfirming(false);
        }}
      >
        <p>
          Every device on your network that reaches the Dashboard over HTTPS and is signed in could then unlock the vault, reveal passwords and export it. Keep this off unless
          you manage the vault from another trusted computer.
        </p>
      </ConfirmDialog>
    </Card>
  );
}

function EncryptionCard({ status }: { status: VaultStatus }) {
  const k = status.kdf;
  if (!k) return null;
  return (
    <Card title="Encryption" icon={<IconLock />}>
      <KeyValue
        items={[
          ['Key derivation', `${k.alg ?? '—'}${k.memory_kib ? ` · ${formatBytes(k.memory_kib * 1024, 0)}` : ''}${k.time_cost ? ` · t=${k.time_cost}` : ''}${k.parallelism ? ` · p=${k.parallelism}` : ''}`],
          ['Unlock cost', k.calibrated_ms ? `about ${Math.round(k.calibrated_ms)} ms per attempt` : '—'],
          ['Credentials', 'AES-256-GCM, each bound to its metadata'],
        ]}
      />
    </Card>
  );
}

export function VaultSettingsPanel({
  status,
  onStatus,
  onImported,
  withReauth,
}: {
  status: VaultStatus;
  onStatus: (s: VaultCoreStatus) => void;
  onImported: () => void;
  withReauth: WithReauth;
}) {
  const local = status.management_local;
  const secretReason = !local ? 'Only on this Mac' : status.locked ? 'Unlock the vault first' : null;
  return (
    <div className="space-y-5">
      <AutoLockCard status={status} local={local} onStatus={onStatus} />
      <BrokerCard status={status} onStatus={onStatus} />
      <RotateCard local={local} onStatus={onStatus} />
      <div className="grid gap-5 xl:grid-cols-2">
        <ExportCard manageReason={secretReason} withReauth={withReauth} />
        <ImportCard manageReason={secretReason} withReauth={withReauth} onImported={onImported} />
      </div>
      <LanCard status={status} onStatus={onStatus} />
      <EncryptionCard status={status} />
    </div>
  );
}
