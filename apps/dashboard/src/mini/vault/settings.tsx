// Vault settings in the owner's Mini App (#/settings/vault/settings): auto-lock, agent credential use, change the
// passphrase, export (an encrypted file: Web Share with a file, else a download, else copy as text) and import.
// Passphrases live only in their form's state and are cleared after every request; the export object (encrypted with
// the export passphrase) stays in this screen's state until it closes.
import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { AUTO_LOCK_CHOICES, type VaultExportFile } from '../../features/vault/types';
import { useToast } from '../../components/Toast';
import { RadioList, ToggleRow } from '../agentConfig/fields';
import { useActions } from '../hooks';
import { useStepUp } from '../stepup/StepUpProvider';
import { Btn, ErrorState, List, Screen, Section, SkeletonList } from '../uiKit';
import { ConfirmSheet, Notice } from '../uiExtra';
import { IconDownload, IconShare, IconUpload } from '../../components/icons';
import { vaultApiM } from './api';
import { useLocal, vaultEvent, type ManagedStatus } from './data';
import { FormAlert, FormCard, MIN_PASSPHRASE, SecretInput, StrengthMeter, strengthHint, useReauth, useSubmit } from './ui';

const EXPORT_NAME = 'nebula-vault-export.json';

function ChangePassphrase({ onChanged }: { onChanged: (s: ManagedStatus) => void }) {
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [tried, setTried] = useState(false);
  const { busy, error, run } = useSubmit();
  const toast = useToast();
  const { freshUntil, confirmWith } = useStepUp();
  const weak = next.length < MIN_PASSPHRASE ? `Use at least ${MIN_PASSPHRASE} characters.` : !strengthHint(next).ok ? 'Choose a less predictable passphrase.' : null;
  const mismatch = again !== next ? 'The passphrases do not match.' : null;
  const submit = async () => {
    setTried(true);
    if (!cur || weak || mismatch) return;
    const [a, b] = [cur, next];
    setCur('');
    setNext('');
    setAgain('');
    setTried(false);
    const r = await run(async () => {
      // the current passphrase IS the owner confirmation (V4.0): never a second prompt after typing it here
      if (!(freshUntil !== null && freshUntil * 1000 > Date.now() + 5000)) await confirmWith({ method: 'vault_passphrase', passphrase: a });
      return vaultApiM.rotate(a, b);
    });
    if (r) {
      toast.success('Vault passphrase changed');
      onChanged(r);
    }
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      aria-label="Change the vault passphrase"
    >
      <FormCard>
        <SecretInput label="Current passphrase" value={cur} onChange={setCur} error={tried && !cur ? 'Enter the current passphrase.' : null} disabled={busy} />
        <SecretInput label="New passphrase" value={next} onChange={setNext} autoComplete="new-password" error={tried ? weak : null} disabled={busy} />
        <StrengthMeter value={next} />
        <SecretInput label="Repeat the new passphrase" value={again} onChange={setAgain} autoComplete="new-password" error={tried ? mismatch : null} disabled={busy} />
        <FormAlert error={error} />
        <Btn type="submit" variant="primary" className="w-full" loading={busy}>
          Change passphrase
        </Btn>
      </FormCard>
    </form>
  );
}

/** Hands the encrypted export to the owner: share sheet with a file, else a download, else copy the JSON text. */
async function deliver(file: VaultExportFile, how: 'share' | 'download' | 'copy'): Promise<void> {
  const text = JSON.stringify(file, null, 2);
  if (how === 'copy') {
    await navigator.clipboard.writeText(text);
    return;
  }
  const blob = new Blob([text], { type: 'application/json' });
  if (how === 'share') {
    const f = new File([blob], EXPORT_NAME, { type: 'application/json' });
    await navigator.share({ files: [f], title: 'NEBULA vault export' });
    return;
  }
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = EXPORT_NAME;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}

function canShareFile(): boolean {
  try {
    if (typeof navigator.share !== 'function' || typeof navigator.canShare !== 'function' || typeof File === 'undefined') return false;
    return navigator.canShare({ files: [new File(['{}'], EXPORT_NAME, { type: 'application/json' })] });
  } catch {
    return false;
  }
}

function ExportCard() {
  const withReauth = useReauth();
  const toast = useToast();
  const [pass, setPass] = useState('');
  const [again, setAgain] = useState('');
  const [tried, setTried] = useState(false);
  const [file, setFile] = useState<VaultExportFile | null>(null);
  const { busy, error, setError, run } = useSubmit();
  useEffect(() => () => setFile(null), []);
  const weak = pass.length < MIN_PASSPHRASE ? `Use at least ${MIN_PASSPHRASE} characters.` : null;
  const mismatch = again !== pass ? 'The passphrases do not match.' : null;
  const submit = async () => {
    setTried(true);
    if (weak || mismatch) return;
    const typed = pass;
    setPass('');
    setAgain('');
    setTried(false);
    const r = await run(() => withReauth(() => vaultApiM.exportVault(typed)));
    if (r) setFile(r);
  };
  const share = canShareFile();
  const give = async (how: 'share' | 'download' | 'copy') => {
    if (!file) return;
    try {
      await deliver(file, how);
      toast.success(how === 'copy' ? 'Export copied as text' : how === 'share' ? 'Export shared' : 'Export downloaded');
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return; // share sheet closed
      setError(e instanceof Error ? e.message : 'The export could not be handed over.');
    }
  };
  return (
    <FormCard>
      <p className="px-1 text-subhead text-muted">
        The export is encrypted with an export passphrase you choose now. You need it to import the file again. Keep the file and the passphrase apart.
      </p>
      {file ? (
        <div className="space-y-2" data-testid="vault-export-ready">
          <Notice tone="success" title="Export ready">
            {file.header?.entry_count ?? 0} credential{file.header?.entry_count === 1 ? '' : 's'}, encrypted.
          </Notice>
          {share && (
            <Btn variant="primary" className="w-full" icon={<IconShare />} onClick={() => void give('share')}>
              Share file
            </Btn>
          )}
          <Btn variant={share ? 'secondary' : 'primary'} className="w-full" icon={<IconDownload />} onClick={() => void give('download')}>
            Download file
          </Btn>
          <Btn className="w-full" onClick={() => void give('copy')}>
            Copy as text
          </Btn>
          <Btn variant="ghost" className="w-full" onClick={() => setFile(null)}>
            Done
          </Btn>
        </div>
      ) : (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          aria-label="Export the vault"
        >
          <SecretInput label="Export passphrase" value={pass} onChange={setPass} autoComplete="new-password" error={tried ? weak : null} disabled={busy} />
          <SecretInput label="Repeat the export passphrase" value={again} onChange={setAgain} autoComplete="new-password" error={tried ? mismatch : null} disabled={busy} />
          <Btn type="submit" variant="primary" className="w-full" icon={<IconDownload />} loading={busy}>
            Export vault
          </Btn>
        </form>
      )}
      <FormAlert error={error} />
    </FormCard>
  );
}

/** The file's text (FileReader where Blob.text() is missing, e.g. older WebViews). */
function readFile(f: File): Promise<string> {
  if (typeof f.text === 'function') return f.text();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result ?? ''));
    r.onerror = () => reject(r.error ?? new Error('read failed'));
    r.readAsText(f);
  });
}

function ImportCard({ onImported }: { onImported: () => void }) {
  const withReauth = useReauth();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [parsed, setParsed] = useState<{ name: string; data: unknown; count: number | null } | null>(null);
  const [pass, setPass] = useState('');
  const [confirm, setConfirm] = useState(false);
  const { busy, error, setError, run } = useSubmit();
  const pick = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    setError(null);
    if (!f) return;
    if (f.size > 20 * 1024 * 1024) return setError('This file is too large for a vault export.');
    try {
      const data = JSON.parse(await readFile(f)) as { header?: { entry_count?: unknown; format?: unknown } };
      if (!data || typeof data !== 'object' || !data.header) throw new Error('not an export');
      setParsed({ name: f.name, data, count: typeof data.header.entry_count === 'number' ? data.header.entry_count : null });
    } catch {
      setParsed(null);
      setError('This file is not a NEBULA vault export (JSON).');
    }
  };
  const doImport = async () => {
    if (!parsed || !pass) return;
    const typed = pass;
    setPass('');
    setConfirm(false);
    const r = await run(() => withReauth(() => vaultApiM.importVault(typed, parsed.data)));
    if (r) {
      toast.success(`${r.imported ?? 0} credential${r.imported === 1 ? '' : 's'} imported`);
      setParsed(null);
      onImported();
    }
  };
  return (
    <FormCard>
      <p className="px-1 text-subhead text-muted">Adds the credentials of a NEBULA vault export to this vault. Existing credentials are kept.</p>
      <input ref={input} type="file" accept="application/json,.json" className="sr-only" aria-label="Choose an export file" onChange={(e) => void pick(e)} data-testid="vault-import-file" />
      {parsed ? (
        <div className="space-y-3">
          <p className="px-1 text-subhead text-text">
            {parsed.name}
            {parsed.count !== null ? ` · ${parsed.count} credential${parsed.count === 1 ? '' : 's'}` : ''}
          </p>
          <SecretInput label="Export passphrase" value={pass} onChange={setPass} disabled={busy} />
          <div className="flex gap-2">
            <Btn className="flex-1" onClick={() => setParsed(null)} disabled={busy}>
              Cancel
            </Btn>
            <Btn variant="primary" className="flex-1" loading={busy} disabled={!pass} onClick={() => setConfirm(true)}>
              Import
            </Btn>
          </div>
        </div>
      ) : (
        <Btn className="w-full" icon={<IconUpload />} onClick={() => input.current?.click()}>
          Choose export file
        </Btn>
      )}
      <FormAlert error={error} />
      <ConfirmSheet open={confirm} title="Import these credentials?" confirmLabel="Import" busy={busy} onCancel={() => setConfirm(false)} onConfirm={() => void doImport()}>
        {parsed?.count ?? 'The'} credential{parsed?.count === 1 ? '' : 's'} from {parsed?.name ?? 'the file'} are added to your vault.
      </ConfirmSheet>
    </FormCard>
  );
}

export function VaultSettings() {
  const { run, isPending } = useActions();
  const status = useLocal((s) => vaultApiM.status(s), [], vaultEvent);
  const st = status.data;
  const apply = async (body: { auto_lock_minutes?: number; broker_enabled?: boolean }, success: string, key: string) => {
    const r = await run(key, () => vaultApiM.settings(body), { success, errorTitle: 'Setting not changed' });
    if (r) status.set(() => r);
  };
  return (
    <Screen title="Vault settings">
      {!st ? (
        status.error ? (
          <ErrorState error={status.error} onRetry={status.reload} />
        ) : (
          <SkeletonList rows={3} avatar={false} />
        )
      ) : !st.exists ? (
        <Notice tone="info" title="No vault yet">
          Create the Password Vault first.
        </Notice>
      ) : (
        <>
          <Section title="Auto-lock" footer="The vault locks itself after this time without use. Locking forgets the key on your Mac.">
            <RadioList
              label="Auto-lock"
              value={String(st.auto_lock_minutes ?? 15)}
              disabled={isPending('autolock')}
              onChange={(v) => void apply({ auto_lock_minutes: Number(v) }, `Auto-lock after ${v} minutes`, 'autolock')}
              options={AUTO_LOCK_CHOICES.map((m) => ({ id: String(m), label: `${m} minutes` }))}
              testId="vault-autolock"
            />
          </Section>
          <Section title="Agents">
            <List>
              <ToggleRow
                label="Agent credential use"
                description="Agents may ask to sign in with saved credentials (always within their grants). Off stops every pending request."
                checked={st.broker_enabled}
                disabled={isPending('broker')}
                onChange={(v) => void apply({ broker_enabled: v }, v ? 'Agent credential use turned on' : 'Agent credential use turned off', 'broker')}
              />
            </List>
          </Section>
          <Section title="Passphrase" footer="Changing it re-encrypts the vault key. Nothing else changes.">
            <ChangePassphrase onChanged={(r) => status.set((p) => (p ? { ...p, ...r, broker: p.broker, broker_enabled: p.broker_enabled } : r))} />
          </Section>
          <Section title="Export">
            {st.locked ? <Notice tone="info">Unlock the vault to export it.</Notice> : <ExportCard />}
          </Section>
          <Section title="Import">
            {st.locked ? <Notice tone="info">Unlock the vault to import an export.</Notice> : <ImportCard onImported={status.reload} />}
          </Section>
        </>
      )}
    </Screen>
  );
}
