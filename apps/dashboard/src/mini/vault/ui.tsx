// Shared pieces of the owner's Password Vault screens in the Mini App: secret inputs with a show toggle, a passphrase
// strength hint, inline error alerts, the vault re-confirmation before showing / exporting secrets (the unified owner
// confirmation, V4.0) and a clipboard copy that clears itself.
//
// Secrets typed here (passphrases, passwords) live only in the state of the form that owns them and are cleared after
// every request; nothing is logged or written to storage.
import { useCallback, useId, useState, type InputHTMLAttributes, type ReactNode } from 'react';
import { passphraseStrength } from '../../features/vault/lib';
import { MIN_PASSPHRASE } from '../../features/vault/types';
import { ApiError } from '../../lib/http';
import { FieldShell, TextInput, describedBy } from '../agentConfig/fields';
import { useOwnerConfirm } from '../stepup/StepUpProvider';
import { haptic } from '../telegram';
import { cx, IconBtn } from '../uiKit';
import { Notice } from '../uiExtra';
import { IconEye } from '../../components/icons';
import { vaultErrorText } from './data';

export { MIN_PASSPHRASE };

// ---------------------------------------------------------------- inputs
/** A password / passphrase field with a show toggle. Never autofilled by the browser unless `autoComplete` says so. */
export function SecretInput({
  id,
  label,
  value,
  onChange,
  hint,
  error,
  warning,
  autoComplete = 'off',
  disabled,
  autoFocus,
  ...rest
}: {
  id?: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: ReactNode;
  error?: string | null;
  warning?: ReactNode;
  autoComplete?: string;
  disabled?: boolean;
  autoFocus?: boolean;
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'>) {
  const auto = useId();
  const fid = id ?? auto;
  const [show, setShow] = useState(false);
  return (
    <FieldShell id={fid} label={label} hint={hint} error={error} warning={warning}>
      <div className="flex min-w-0 gap-1.5">
        <TextInput
          id={fid}
          type={show ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          disabled={disabled}
          autoFocus={autoFocus}
          data-autofocus={autoFocus || undefined}
          invalid={Boolean(error)}
          aria-describedby={describedBy(fid, error, warning, hint)}
          maxLength={1024}
          className="font-mono"
          {...rest}
        />
        <IconBtn label={`${show ? 'Hide' : 'Show'} ${label.toLowerCase()}`} icon={<IconEye />} onClick={() => setShow((v) => !v)} aria-pressed={show} />
      </div>
    </FieldShell>
  );
}

/** Live hint for a new passphrase (the host enforces the rules). */
export function strengthHint(p: string): { text: string; ok: boolean; tone: 'danger' | 'warning' | 'success' | 'muted' } {
  if (!p) return { text: `At least ${MIN_PASSPHRASE} characters — a few unrelated words work well.`, ok: false, tone: 'muted' };
  const s = passphraseStrength(p);
  return { text: `Strength: ${s.label}`, ok: s.ok, tone: s.tone === 'danger' ? 'danger' : s.tone === 'warn' ? 'warning' : 'success' };
}

export function StrengthMeter({ value }: { value: string }) {
  const s = passphraseStrength(value);
  const h = strengthHint(value);
  return (
    <div className="px-1" data-testid="strength">
      <div className="h-1.5 overflow-hidden rounded-full bg-text/8" aria-hidden>
        <div
          className={cx('h-full rounded-full transition-[width]', h.tone === 'danger' ? 'bg-danger' : h.tone === 'warning' ? 'bg-warn' : 'bg-success')}
          style={{ width: `${value ? Math.max(6, s.score) : 0}%` }}
        />
      </div>
      <p role="status" className={cx('mt-1 text-footnote', h.tone === 'danger' ? 'text-danger' : h.tone === 'warning' ? 'text-warn' : h.tone === 'success' ? 'text-success' : 'text-subtle')}>
        {h.text}
      </p>
    </div>
  );
}

/** Inline failure of a form (role="alert"). */
export function FormAlert({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div role="alert" data-testid="vault-error">
      <Notice tone="danger">{error}</Notice>
    </div>
  );
}

/** Runs one owner action with a busy flag and an inline error; resolves undefined on failure. */
export function useSubmit() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try {
      const r = await fn();
      haptic('success');
      return r;
    } catch (e) {
      haptic('error');
      setError(vaultErrorText(e));
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, setError, run };
}

// ---------------------------------------------------------------- vault re-confirmation (reveal / export / import)
type Reauth = <T>(fn: () => Promise<T>) => Promise<T>;

/**
 * Runs `fn` (showing / exporting / importing secrets) after ONE owner confirmation when the session needs it: the
 * unified confirmation (Face ID, or the vault passphrase) makes the session fresh and re-confirms the vault in one
 * step — never the owner step-up followed by the vault passphrase. Cancelled: fails with `reauth_required`.
 */
export function useReauth(): Reauth {
  const confirm = useOwnerConfirm();
  return useCallback<Reauth>(
    async (fn) => {
      if (!(await confirm({ reveal: true }))) throw new ApiError(403, 'reauth_required', 'not confirmed');
      return fn();
    },
    [confirm],
  );
}

// ---------------------------------------------------------------- clipboard
export const CLEAR_CLIPBOARD_S = 30;

async function digest(text: string): Promise<string | null> {
  try {
    const d = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

/**
 * Copies a secret and clears the clipboard after 30 s if it still holds it (best effort). Only a SHA-256 digest of
 * the value is kept for that comparison. When the clipboard cannot be read back, it is cleared only if this page
 * stayed in the foreground and nothing else was copied here meanwhile.
 */
export async function copySecret(value: string, seconds = CLEAR_CLIPBOARD_S): Promise<void> {
  const cb = navigator.clipboard;
  if (!cb?.writeText) throw new Error('Copying is not available here.');
  await cb.writeText(value);
  const hash = await digest(value);
  let untouched = document.visibilityState !== 'hidden';
  const dirty = () => {
    untouched = false;
  };
  const onVis = () => {
    if (document.visibilityState === 'hidden') untouched = false;
  };
  document.addEventListener('copy', dirty);
  document.addEventListener('cut', dirty);
  document.addEventListener('visibilitychange', onVis);
  setTimeout(() => {
    document.removeEventListener('copy', dirty);
    document.removeEventListener('cut', dirty);
    document.removeEventListener('visibilitychange', onVis);
    void (async () => {
      try {
        let same = false;
        let known = false;
        if (typeof cb.readText === 'function' && hash) {
          try {
            same = (await digest(await cb.readText())) === hash;
            known = true;
          } catch {
            known = false;
          }
        }
        if (known ? same : untouched) await cb.writeText('');
      } catch {
        // best effort
      }
    })();
  }, seconds * 1000);
}

// ---------------------------------------------------------------- password generator
export interface GenOptions {
  length: number;
  lower: boolean;
  upper: boolean;
  digits: boolean;
  symbols: boolean;
}

const SETS = { lower: 'abcdefghijkmnopqrstuvwxyz', upper: 'ABCDEFGHJKLMNPQRSTUVWXYZ', digits: '23456789', symbols: '!#$%&*+-=?@^_~' } as const;

function randomIndex(n: number): number {
  const limit = 256 - (256 % n);
  const b = new Uint8Array(1);
  for (;;) {
    globalThis.crypto.getRandomValues(b);
    if (b[0] < limit) return b[0] % n;
  }
}

/** Random password from the Web Crypto CSPRNG with at least one character of every chosen set. */
export function generatePassword(o: GenOptions): string {
  const sets = (Object.keys(SETS) as (keyof typeof SETS)[]).filter((k) => o[k]).map((k) => SETS[k]);
  const pool = sets.length ? sets.join('') : SETS.lower + SETS.upper + SETS.digits;
  const use = sets.length ? sets : [SETS.lower, SETS.upper, SETS.digits];
  const n = Math.max(8, Math.min(128, Math.floor(o.length) || 20));
  for (;;) {
    let out = '';
    for (let i = 0; i < n; i += 1) out += pool[randomIndex(pool.length)];
    if (n < use.length || use.every((set) => [...out].some((c) => set.includes(c)))) return out;
  }
}

// ---------------------------------------------------------------- small layout helpers
export function FormCard({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={cx('space-y-3 rounded-card bg-panel p-4', className)}>{children}</div>;
}
