// "Confirm it is you" — the ONE owner confirmation of the Mini App (its own chunk, V4.0). It asks for exactly one
// thing and sends exactly one POST /auth/confirm:
//
//  * Face ID / Touch ID (Telegram BiometricManager, this device enrolled, access granted): the REAL biometric prompt
//    starts at once; with `unlockVault` the same prompt also unlocks the vault when this device holds the vault key.
//    The first time on a device (no vault key yet) the sheet asks for the vault passphrase ONCE, then the biometric
//    prompt; the passphrase and the device token go together and, with "Next time, Face ID only", the vault key is wrapped
//    for this device so next time Face ID alone is enough.
//  * no biometrics here: one field — the vault passphrase (it confirms the owner and unlocks the vault) or, without a
//    vault, the NEBULA login password. Never two secrets in a row.
//
// The device token rotates on every use: the next one is stored in BiometricManager at once (also when the answer is an
// error that carries it). Typed secrets live only in this component's state and the one request body; they are cleared
// before every request and never logged or stored.
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { useToast } from '../../components/Toast';
import { t, tp } from '../../i18n';
import { errorMessage, isApiError } from '../../lib/http';
import { FieldShell, MiniSwitch, TextInput, describedBy } from '../agentConfig/fields';
import { useBackOverlay } from '../backStack';
import { useMini } from '../context';
import { haptic, type TgBiometricManager } from '../telegram';
import type { Assurance, BiometricDevice } from '../types';
import { Btn, Sheet, Spinner } from '../uiKit';
import { Notice } from '../uiExtra';
import { stepUpApi, type ConfirmBody, type ConfirmResult } from './api';
import {
  biometricManager,
  biometricName,
  biometricStale,
  encodeDeviceToken,
  initBiometrics,
  markBiometricStale,
  rememberDevice,
  rememberedDevice,
  storeBiometricToken,
  unlockDeviceToken,
} from './biometric';
import type { ConfirmPrompt } from './StepUpProvider';

const setupAgain = () => t('confirm.setupAgain');

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

const attemptsLeft = (n: number): string => tp('confirm.attempts', n);

/** The message for a failed confirmation (never echoes what was typed). */
export function confirmErrorText(e: unknown, bio = 'Face ID'): string {
  if (!isApiError(e)) return errorMessage(e);
  const d = e.details ?? {};
  switch (e.code) {
    case 'wrong_passphrase': {
      const left = num(d.attempts_left);
      return `${t('confirm.err.wrongPassphrase')}${left !== null ? ` ${t('confirm.err.untilLock', { left: attemptsLeft(left) })}` : ''}`;
    }
    case 'wrong_password':
      return t('confirm.err.wrongPassword');
    case 'rate_limited': {
      const s = num(d.retry_after);
      return t('confirm.err.rateLimited', { wait: s !== null && s > 0 ? t('confirm.wait.seconds', { s: Math.ceil(s) }) : t('confirm.wait.moment') });
    }
    case 'bad_token':
      return t('confirm.err.badToken', { bio, setup: setupAgain() });
    case 'challenge_expired':
      return t('confirm.err.challengeExpired');
    case 'owner_only':
      return t('confirm.err.ownerOnly');
    case 'no_vault':
      return t('confirm.err.noVault');
    case 'network_error':
      return t('common.networkError');
    default:
      return e.message || t('confirm.err.default');
  }
}

/** Does THIS Telegram's enrolled device already hold the vault key? (Its id is known after a biometric unlock.) */
export function deviceHasVaultKey(devices: BiometricDevice[], known: string | null = rememberedDevice()): boolean {
  const mine = known ? devices.find((d) => d.id === known) : undefined;
  if (mine) return mine.vault_key === true;
  if (devices.length === 1) return devices[0].vault_key === true;
  return devices.length > 0 && devices.every((d) => d.vault_key === true);
}

type Mode = 'loading' | 'bio' | 'secret' | 'vault-after-bio';
type SecretKind = 'passphrase' | 'password';

export function ConfirmSheet({ prompt, onDone, onFresh }: { prompt: ConfirmPrompt; onDone: (r: ConfirmResult | null) => void; onFresh: (until: number | null) => void }) {
  const { client, username } = useMini();
  const toast = useToast();
  const api = useMemo(() => stepUpApi(client), [client]);
  const fieldId = useId();
  const rememberId = useId();
  const [assurance, setAssurance] = useState<Assurance | null>(prompt.assurance);
  const [bm, setBm] = useState<TgBiometricManager | null>(null);
  const [mode, setMode] = useState<Mode>('loading');
  const [kind, setKind] = useState<SecretKind>('password');
  const [secret, setSecret] = useState('');
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState<'bio' | 'secret' | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [lockedUntil, setLockedUntil] = useState(0);
  const [, setTick] = useState(0);
  const finished = useRef(false);
  const autoStarted = useRef(false);
  const alive = useRef(true);

  const cancel = () => {
    if (finished.current) return;
    finished.current = true;
    setSecret('');
    onDone(null);
  };
  useBackOverlay(true, cancel);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Once per sheet: this Telegram's biometrics and (for the vault) what this session needs.
  useEffect(() => {
    const m = biometricStale() ? null : biometricManager();
    const needAssurance = prompt.assurance === null && (prompt.unlockVault || prompt.methods === null);
    void Promise.all([
      m ? initBiometrics(m) : Promise.resolve(null),
      needAssurance ? api.assurance().catch(() => null) : Promise.resolve(prompt.assurance),
    ]).then(([b, a]) => {
      if (!alive.current) return;
      setAssurance(a);
      const methods = prompt.methods ?? [];
      const hostBio = a ? a.methods.biometric.enrolled : methods.includes('biometric');
      const usable = Boolean(b && b.isBiometricAvailable && b.isBiometricTokenSaved && b.isAccessGranted && hostBio);
      const passphraseOk = prompt.unlockVault || (a ? a.methods.vault_passphrase === true : methods.includes('vault_passphrase'));
      setKind(passphraseOk ? 'passphrase' : 'password');
      setBm(usable ? b : null);
      setMode(usable ? 'bio' : 'secret');
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- once per sheet: the prompt it was opened for

  const now = Date.now();
  const locked = lockedUntil > now;
  useEffect(() => {
    if (!locked) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [locked]);

  const label = biometricName(bm?.biometricType);
  const methods = prompt.methods ?? [];
  const passphraseOk = prompt.unlockVault || (assurance ? assurance.methods.vault_passphrase === true : methods.includes('vault_passphrase'));
  /** Biometrics alone cannot unlock the vault here yet: the passphrase goes along once (first time on this device). */
  const firstTime = prompt.unlockVault && !deviceHasVaultKey(assurance?.methods.biometric.devices ?? []);
  const reasonText = prompt.reason;

  const succeed = (r: ConfirmResult) => {
    if (finished.current) return;
    finished.current = true;
    haptic('success');
    if (r.vault?.result?.includes('enrolled')) toast.success(t('confirm.vaultOn', { bio: label }), t('confirm.vaultOn.body', { bio: label }));
    onDone(r);
  };

  const fail = (e: unknown) => {
    haptic('error');
    setProblem(confirmErrorText(e, label));
    if (isApiError(e) && e.code === 'rate_limited') {
      const s = num(e.details.retry_after);
      setLockedUntil(Date.now() + (s !== null && s > 0 ? s : 30) * 1000);
    }
  };

  /** Biometrics stop working on this device: the single field takes over. */
  const dropBiometrics = (message: string) => {
    markBiometricStale();
    setBm(null);
    setMode('secret');
    setProblem(message);
  };

  /** The token rotated: store the next one right away (the old one is no longer accepted). */
  const storeNext = async (m: TgBiometricManager, deviceId: string, next: unknown) => {
    if (typeof next !== 'string' || !next) return;
    const ok = await storeBiometricToken(m, encodeDeviceToken(deviceId, next));
    if (!ok) {
      markBiometricStale();
      toast.warn(t('confirm.rekey', { bio: label }), t('confirm.rekey.body', { setup: setupAgain() }));
    }
  };

  const withBiometrics = async () => {
    const m = bm;
    if (!m || busy || locked || finished.current) return;
    if (firstTime && !secret) {
      setProblem(t('confirm.enterPassphrase'));
      return;
    }
    setProblem(null);
    setBusy('bio');
    let deviceId: string | null = null;
    let body: ConfirmBody | null = null;
    try {
      const u = await unlockDeviceToken(m, reasonText);
      if (!alive.current) return;
      if (u.status === 'cancelled') {
        setProblem(t('confirm.bioCancelled', { bio: label }));
        return;
      }
      if (u.status === 'invalid') {
        dropBiometrics(t('confirm.bioInvalid', { bio: label, setup: setupAgain() }));
        return;
      }
      deviceId = u.deviceId;
      rememberDevice(deviceId);
      const typed = firstTime ? secret : '';
      setSecret('');
      const ch = await api.challenge(deviceId);
      body = {
        method: 'telegram_biometric',
        device_id: deviceId,
        challenge_id: ch.challenge_id,
        token: u.token,
        ...(prompt.unlockVault ? { unlock_vault: true } : {}),
        ...(typed ? { passphrase: typed, enroll_vault_key: remember } : {}),
      };
      const r = await api.confirm(body);
      await storeNext(m, deviceId, r.next_token);
      if (prompt.unlockVault && r.vault_unlock_needed) {
        // confirmed, but this device's vault key is missing / no longer valid: the passphrase unlocks it (once)
        onFresh(r.fresh_until ?? null);
        setMode('vault-after-bio');
        setProblem(
          r.vault?.result === 'device_key_invalid'
            ? t('confirm.vaultKeyInvalid', { bio: label })
            : t('confirm.unlockAfterBio'),
        );
        return;
      }
      succeed(r);
    } catch (e) {
      if (isApiError(e) && deviceId) {
        await storeNext(m, deviceId, e.details.next_token);
        const until = num(e.details.fresh_until);
        if (until !== null) onFresh(until);
      }
      if (!alive.current) return;
      if (isApiError(e) && e.status === 404) dropBiometrics(t('confirm.bioGone', { bio: label, setup: setupAgain() }));
      else if (isApiError(e) && e.code === 'bad_token') dropBiometrics(confirmErrorText(e, label));
      else fail(e);
    } finally {
      if (body) {
        body.token = undefined;
        body.passphrase = undefined;
      }
      if (alive.current) setBusy(null);
    }
  };

  // Face ID right away when it is all that is needed
  useEffect(() => {
    if (mode !== 'bio' || firstTime || autoStarted.current) return;
    autoStarted.current = true;
    void withBiometrics();
  }, [mode, firstTime]); // eslint-disable-line react-hooks/exhaustive-deps -- once, when the sheet knows Face ID is ready

  const usePassphrase = mode === 'vault-after-bio' || (mode === 'bio' && firstTime) || kind === 'passphrase';
  const showsField = mode === 'secret' || mode === 'vault-after-bio' || (mode === 'bio' && firstTime);

  // the single field gets the focus as soon as it is shown
  useEffect(() => {
    if (!showsField) return;
    const t = setTimeout(() => document.getElementById(fieldId)?.focus({ preventScroll: true }), 0);
    return () => clearTimeout(t);
  }, [showsField, mode, kind, fieldId]);

  const withSecret = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!secret || busy || locked || finished.current) return;
    setProblem(null);
    setBusy('secret');
    const typed = secret;
    setSecret('');
    const body: ConfirmBody = usePassphrase
      ? { method: 'vault_passphrase', passphrase: typed, ...(prompt.unlockVault ? { unlock_vault: true } : {}) }
      : { method: 'password', password: typed };
    try {
      succeed(await api.confirm(body));
    } catch (err) {
      if (alive.current) fail(err);
    } finally {
      body.passphrase = undefined;
      body.password = undefined;
      if (alive.current) setBusy(null);
    }
  };

  const wait = locked ? Math.ceil((lockedUntil - now) / 1000) : 0;
  const disabled = busy !== null || locked;
  const fieldLabel = usePassphrase ? t('confirm.field.passphrase') : t('confirm.field.password');
  const hint = usePassphrase
    ? prompt.unlockVault
      ? t('confirm.hint.unlock')
      : t('confirm.hint.passphrase')
    : t('confirm.hint.password');
  const description =
    mode === 'bio' && !firstTime
      ? t('confirm.desc.bio', { reason: reasonText, bio: label })
      : mode === 'bio'
        ? t('confirm.desc.bioFirst', { reason: reasonText, bio: label })
        : t('confirm.desc.secret', { reason: reasonText, what: usePassphrase ? t('confirm.what.passphrase') : t('confirm.what.password') });

  const field = (
    <FieldShell id={fieldId} label={fieldLabel} hint={hint}>
      <TextInput
        id={fieldId}
        type="password"
        name={usePassphrase ? 'vault-passphrase' : 'password'}
        autoComplete={usePassphrase ? 'off' : 'current-password'}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        value={secret}
        onChange={(e) => setSecret(e.target.value)}
        disabled={disabled}
        maxLength={1024}
        aria-describedby={describedBy(fieldId, null, null, 'hint')}
        data-autofocus=""
      />
    </FieldShell>
  );

  return (
    <Sheet open keyboardAware testId="owner-confirm" title={t('confirm.title')} description={mode === 'loading' ? reasonText : description} onClose={cancel} dismissible={busy === null}>
      <div className="space-y-4 pt-1 pb-2" data-mode={mode}>
        {problem && (
          <div role="alert">
            <Notice tone="danger">{locked ? t('confirm.err.rateLimited', { wait: t('confirm.wait.seconds', { s: wait }) }) : problem}</Notice>
          </div>
        )}

        {mode === 'loading' && (
          <div className="grid place-items-center py-6">
            <Spinner label={t('confirm.preparing')} />
          </div>
        )}

        {mode === 'bio' && bm && firstTime && (
          <form
            className="space-y-3"
            autoComplete="off"
            onSubmit={(e) => {
              e.preventDefault();
              void withBiometrics();
            }}
          >
            {field}
            <div className="flex items-center gap-3 rounded-card bg-text/5 px-4 py-3">
              <span className="min-w-0 flex-1">
                <span id={`${rememberId}-l`} className="block text-body text-text">
                  {t('confirm.remember', { bio: label })}
                </span>
                <span id={`${rememberId}-d`} className="mt-0.5 block text-footnote text-muted">
                  {t('confirm.remember.body', { bio: label })}
                </span>
              </span>
              <MiniSwitch checked={remember} onChange={setRemember} disabled={disabled} labelledBy={`${rememberId}-l`} describedBy={`${rememberId}-d`} />
            </div>
            <Btn type="submit" variant="primary" className="w-full" loading={busy === 'bio'} disabled={disabled || !secret}>
              {t('confirm.with', { bio: label })}
            </Btn>
            <div className="flex gap-2">
              <Btn variant="secondary" className="flex-1" onClick={cancel} disabled={busy !== null}>
                {t('common.cancel')}
              </Btn>
              <Btn variant="ghost" className="flex-1" loading={busy === 'secret'} disabled={disabled || !secret} onClick={() => void withSecret()}>
                {t('confirm.passphraseOnly')}
              </Btn>
            </div>
          </form>
        )}

        {mode === 'bio' && bm && !firstTime && (
          <div className="space-y-3">
            <p className="px-1 text-subhead text-muted">
              {prompt.unlockVault ? t('confirm.bio.unlock', { bio: label }) : t('confirm.bio.plain', { bio: label })}
            </p>
            <Btn variant="primary" className="w-full" loading={busy === 'bio'} disabled={disabled} onClick={() => void withBiometrics()}>
              {t('confirm.with', { bio: label })}
            </Btn>
            <div className="flex gap-2">
              <Btn variant="secondary" className="flex-1" onClick={cancel} disabled={busy !== null}>
                {t('common.cancel')}
              </Btn>
              <Btn
                variant="ghost"
                className="flex-1"
                disabled={busy !== null}
                onClick={() => {
                  setProblem(null);
                  setMode('secret');
                }}
              >
                {passphraseOk ? t('confirm.usePassphrase') : t('confirm.usePassword')}
              </Btn>
            </div>
          </div>
        )}

        {(mode === 'secret' || mode === 'vault-after-bio') && (
          <form onSubmit={(e) => void withSecret(e)} className="space-y-3" autoComplete={usePassphrase ? 'off' : 'on'}>
            {/* lets password managers offer the NEBULA login */}
            {!usePassphrase && username && <input type="text" name="username" autoComplete="username" value={username} readOnly hidden aria-hidden tabIndex={-1} />}
            {field}
            <div className="flex gap-2">
              <Btn type="button" variant="secondary" className="flex-1" onClick={cancel} disabled={busy !== null}>
                {t('common.cancel')}
              </Btn>
              <Btn type="submit" variant="primary" className="flex-1" loading={busy === 'secret'} disabled={disabled || !secret}>
                {t('confirm.submit')}
              </Btn>
            </div>
            {mode === 'secret' && !prompt.unlockVault && passphraseOk && (
              <button
                type="button"
                className="block w-full py-1 text-center text-subhead text-accent-soft focus-ring"
                disabled={busy !== null}
                onClick={() => {
                  setSecret('');
                  setProblem(null);
                  setKind((k) => (k === 'passphrase' ? 'password' : 'passphrase'));
                }}
              >
                {kind === 'passphrase' ? t('confirm.usePassword') : t('confirm.usePassphrase')}
              </button>
            )}
            {mode === 'secret' && bm && (
              <button
                type="button"
                className="block w-full py-1 text-center text-subhead text-accent-soft focus-ring"
                disabled={busy !== null}
                onClick={() => {
                  setSecret('');
                  setProblem(null);
                  setMode('bio');
                }}
              >
                {t('confirm.backTo', { bio: label })}
              </button>
            )}
          </form>
        )}
      </div>
    </Sheet>
  );
}
