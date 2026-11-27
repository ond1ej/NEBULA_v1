// Passphrase forms of the Password Vault: create, unlock, re-confirm. Typed passphrases live only in these
// components' state, are sent once in a POST body and are cleared right after the request (success or failure).
import { forwardRef, useId, useState, type FormEvent, type InputHTMLAttributes, type ReactNode } from 'react';
import { Modal } from '../../components/Modal';
import { IconEye, IconLock } from '../../components/icons';
import { Button, Checkbox, Field, Input, Meter, Notice } from '../../components/ui';
import { isApiError, type ApiError } from '../../lib/http';
import { vaultApi } from './api';
import { useSecondsLeft } from './clock';
import { formatCountdown, passphraseStrength } from './lib';
import { MIN_PASSPHRASE, type VaultCoreStatus } from './types';

/** Attributes every secret input carries: no autofill of saved passwords, no spellcheck / autocorrect uploads. */
export const SECRET_INPUT = {
  autoComplete: 'new-password',
  spellCheck: false,
  autoCapitalize: 'off',
  autoCorrect: 'off',
  'data-1p-ignore': true,
  'data-lpignore': 'true',
} as const;

/** Password input with a Show / Hide toggle for the value the owner is typing. */
export const SecretInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { toggleLabel?: string }>(function SecretInput(
  { toggleLabel = 'passphrase', className = '', ...rest },
  ref,
) {
  const [show, setShow] = useState(false);
  return (
    <div className="flex min-w-0 gap-1.5">
      <Input ref={ref} {...SECRET_INPUT} {...rest} type={show ? 'text' : 'password'} className={`font-mono ${className}`} />
      <Button size="md" variant="ghost" className="!px-2.5" aria-pressed={show} aria-label={`${show ? 'Hide' : 'Show'} ${toggleLabel}`} title={show ? 'Hide' : 'Show'} onClick={() => setShow((v) => !v)} icon={<IconEye />} />
    </div>
  );
});

export function StrengthMeter({ value }: { value: string }) {
  const s = passphraseStrength(value);
  return (
    <div className="space-y-1">
      <Meter value={s.score} label="Passphrase strength" size="sm" tone={s.tone === 'danger' ? 'danger' : s.tone === 'warn' ? 'warn' : s.tone === 'success' ? 'success' : 'accent'} />
      <p className="text-xs text-muted">
        Strength: <span className="text-text">{s.label}</span>
      </p>
    </div>
  );
}

export function NoRecoveryWarning() {
  return (
    <Notice tone="warn" title="There is no recovery">
      If you lose this passphrase the vault cannot be decrypted — there is no recovery or backdoor. Not even NEBULA can open it. Store the passphrase somewhere safe (for
      example a written note in a safe place).
    </Notice>
  );
}

export function LocalOnlyNotice() {
  return (
    <Notice tone="warn" title="Vault management is only available on this Mac">
      Creating, unlocking, editing, revealing, exporting and granting credentials works only in the Dashboard opened locally on the NEBULA Mac (
      <span className="font-mono">http://127.0.0.1</span>), unless you allowed management over LAN HTTPS there. From here you can view metadata, lock the vault and revoke
      grants.
    </Notice>
  );
}

function ErrorLine({ error, children }: { error: unknown; children?: ReactNode }) {
  if (!error) return null;
  const msg = isApiError(error) || error instanceof Error ? error.message : String(error);
  return (
    <div role="alert" className="rounded-lg border border-danger/30 bg-danger/[0.07] px-3 py-2 text-sm text-text">
      <p className="break-words">{msg}</p>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------- create
export function CreateVaultForm({ onCreated }: { onCreated: (s: VaultCoreStatus) => void }) {
  const ids = { p1: useId(), p2: useId() };
  const [pass, setPass] = useState('');
  const [confirm, setConfirm] = useState('');
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const strength = passphraseStrength(pass);
  const invalid =
    pass.length < MIN_PASSPHRASE
      ? `The passphrase needs at least ${MIN_PASSPHRASE} characters`
      : !strength.ok
        ? 'Choose a less repetitive passphrase'
        : pass !== confirm
          ? 'The passphrases do not match'
          : !ack
            ? 'Confirm that you stored the passphrase safely'
            : null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (invalid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const s = await vaultApi.create(pass);
      setPass('');
      setConfirm('');
      onCreated(s);
    } catch (err) {
      // e.g. passphrase_reused (it was the login password): never keep a rejected passphrase around
      setPass('');
      setConfirm('');
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="grid max-w-xl gap-4" aria-label="Create the Password Vault">
      <NoRecoveryWarning />
      <Field htmlFor={ids.p1} label="Vault passphrase" required hint={`At least ${MIN_PASSPHRASE} characters. Use several random words or a long sentence — not your NEBULA login password.`}>
        <SecretInput id={ids.p1} value={pass} onChange={(e) => setPass(e.target.value)} maxLength={1024} />
      </Field>
      {pass && <StrengthMeter value={pass} />}
      <Field htmlFor={ids.p2} label="Repeat the passphrase" required error={confirm && confirm !== pass ? 'The passphrases do not match' : null}>
        <SecretInput id={ids.p2} toggleLabel="repeated passphrase" value={confirm} onChange={(e) => setConfirm(e.target.value)} maxLength={1024} />
      </Field>
      <Checkbox
        label="I stored this passphrase safely and understand it cannot be recovered"
        checked={ack}
        onChange={setAck}
      />
      <ErrorLine error={error} />
      <div>
        <Button type="submit" variant="primary" icon={<IconLock />} loading={busy} disabledReason={busy ? null : invalid}>
          Create vault
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- unlock
function unlockHint(e: ApiError): string | null {
  if (e.code === 'wrong_passphrase' && typeof e.details.attempts_left === 'number') {
    const n = e.details.attempts_left;
    return n > 0 ? `${n} attempt${n === 1 ? '' : 's'} left before a temporary lockout.` : 'Further attempts are now temporarily blocked.';
  }
  return null;
}

export function UnlockForm({
  lockoutUntil,
  onUnlocked,
  onFailed,
  compact = false,
}: {
  lockoutUntil: number | null;
  onUnlocked: (s: VaultCoreStatus) => void;
  /** e.g. refresh the status (lockout_until) after a wrong passphrase. */
  onFailed?: () => void;
  compact?: boolean;
}) {
  const id = useId();
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const until = Math.max(lockoutUntil ?? 0, retryAt ?? 0) || null;
  const wait = useSecondsLeft(until);
  const blocked = wait > 0;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!pass || busy || blocked) return;
    setBusy(true);
    setError(null);
    try {
      const s = await vaultApi.unlock(pass);
      setPass('');
      setRetryAt(null);
      onUnlocked(s);
    } catch (err) {
      setPass('');
      if (isApiError(err) && err.code === 'rate_limited' && typeof err.details.retry_after === 'number') {
        setRetryAt(Date.now() / 1000 + err.details.retry_after);
      }
      setError(err);
      onFailed?.();
    } finally {
      setBusy(false);
    }
  };

  const apiErr = isApiError(error) ? error : null;
  return (
    <form onSubmit={submit} className={`grid gap-3 ${compact ? '' : 'max-w-md'}`} aria-label="Unlock the Password Vault">
      <Field htmlFor={id} label="Vault passphrase">
        <SecretInput id={id} value={pass} onChange={(e) => setPass(e.target.value)} maxLength={1024} disabled={blocked} />
      </Field>
      {error && !(apiErr?.code === 'rate_limited' && !blocked) ? (
        <ErrorLine error={error}>{apiErr && unlockHint(apiErr) && <p className="mt-0.5 text-xs text-muted">{unlockHint(apiErr)}</p>}</ErrorLine>
      ) : null}
      {blocked && (
        <p role="status" className="text-sm text-warn">
          Too many wrong passphrases. Try again in <span className="font-mono tabular-nums">{formatCountdown(wait)}</span>.
        </p>
      )}
      <div>
        <Button type="submit" variant="primary" icon={<IconLock />} loading={busy} disabledReason={busy ? null : blocked ? 'Temporarily locked after wrong passphrases' : !pass ? 'Enter the vault passphrase' : null}>
          Unlock vault
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- re-confirm
export function ReauthDialog({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: (passphrase: string) => Promise<void> }) {
  const id = useId();
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!pass || busy) return;
    setBusy(true);
    setError(null);
    const p = pass;
    setPass('');
    try {
      await onConfirm(p);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      size="sm"
      title="Confirm the vault passphrase"
      description="Revealing, exporting or importing secrets needs a passphrase confirmation every 5 minutes."
      onClose={onCancel}
      dismissible={!busy}
      footer={
        <>
          <Button onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabledReason={busy ? null : !pass ? 'Enter the vault passphrase' : null} onClick={() => void submit()}>
            Confirm
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className="grid gap-3">
        <Field htmlFor={id} label="Vault passphrase">
          <SecretInput id={id} value={pass} onChange={(e) => setPass(e.target.value)} maxLength={1024} data-autofocus />
        </Field>
        <ErrorLine error={error} />
      </form>
    </Modal>
  );
}
