// Create and unlock the Password Vault from the owner's Mini App. Creating needs a fresh owner confirmation (the host
// answers 403 `stepup_required`, the confirmation sheet opens and the request is retried); unlocking IS the owner
// confirmation (POST /auth/confirm with unlock_vault). Passphrases live only in form / sheet state and are cleared right
// after each request.
import { useState } from 'react';
import { formatTime } from '../../lib/format';
import { REASON_UNLOCK, useOwnerConfirm } from '../stepup/StepUpProvider';
import { haptic } from '../telegram';
import { Btn } from '../uiKit';
import { vaultApiM } from './api';
import type { ManagedStatus } from './data';
import { FormAlert, FormCard, MIN_PASSPHRASE, SecretInput, StrengthMeter, strengthHint, useSubmit } from './ui';

export function CreateVaultCard({ onCreated }: { onCreated: (s: ManagedStatus) => void }) {
  const [pass, setPass] = useState('');
  const [again, setAgain] = useState('');
  const [tried, setTried] = useState(false);
  const { busy, error, run } = useSubmit();
  const strength = strengthHint(pass);
  const problem = pass.length < MIN_PASSPHRASE ? `Use at least ${MIN_PASSPHRASE} characters.` : !strength.ok ? 'Choose a less predictable passphrase.' : null;
  const mismatch = again !== pass ? 'The passphrases do not match.' : null;
  const submit = async () => {
    setTried(true);
    if (problem || mismatch) return;
    const typed = pass;
    setPass('');
    setAgain('');
    setTried(false);
    const st = await run(() => vaultApiM.create(typed));
    if (st) onCreated(st);
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      aria-label="Create the Password Vault"
      data-testid="vault-create"
    >
      <FormCard>
        <div className="px-1">
          <p className="text-headline font-semibold text-text">Create your Password Vault</p>
          <p className="mt-0.5 text-subhead text-muted">
            One passphrase encrypts every credential on your Mac. NEBULA cannot recover it — if you forget it, the saved credentials are lost. Use a dedicated
            passphrase, not your NEBULA login password.
          </p>
        </div>
        <SecretInput label="Vault passphrase" value={pass} onChange={setPass} autoComplete="new-password" error={tried ? problem : null} disabled={busy} />
        <StrengthMeter value={pass} />
        <SecretInput label="Repeat the passphrase" value={again} onChange={setAgain} autoComplete="new-password" error={tried ? mismatch : null} disabled={busy} />
        <FormAlert error={error} />
        <Btn type="submit" variant="primary" className="w-full" loading={busy}>
          Create vault
        </Btn>
      </FormCard>
    </form>
  );
}

/**
 * Unlocks the vault with ONE owner confirmation (V4.0): Face ID when this device holds the vault key, else the vault
 * passphrase once — which also confirms it's the owner. No NEBULA password first, no second prompt.
 */
export function UnlockVaultCard({ status, onUnlocked, compact = false }: { status: ManagedStatus | null; onUnlocked: () => void; compact?: boolean }) {
  const confirm = useOwnerConfirm();
  const [busy, setBusy] = useState(false);
  const lockedOut = status?.lockout_until && status.lockout_until * 1000 > Date.now() ? status.lockout_until : null;
  const unlock = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (await confirm({ unlockVault: true, reason: REASON_UNLOCK })) {
        haptic('success');
        onUnlocked();
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <div aria-label="Unlock the Password Vault" role="group" data-testid="vault-unlock">
      <FormCard>
        {!compact && (
          <p className="px-1 text-subhead text-muted">
            Unlock with Face ID or your vault passphrase — one confirmation. The vault locks again automatically
            {status?.auto_lock_minutes ? ` after ${status.auto_lock_minutes} minutes without use` : ''}.
          </p>
        )}
        {lockedOut && <p className="px-1 text-footnote text-warn">Too many wrong passphrases — unlocking is possible again at {formatTime(lockedOut)}.</p>}
        <Btn variant="primary" className="w-full" loading={busy} onClick={() => void unlock()}>
          Unlock
        </Btn>
      </FormCard>
    </div>
  );
}
