// Building blocks of <SmartAuthRequest>: icons, buttons, notes and the role-based inputs. Skinned per app (skin.ts);
// labels come from the field ROLE only, never from the page.
import { useEffect, useId, useState, type ButtonHTMLAttributes, type ClipboardEvent, type KeyboardEvent, type ReactNode } from 'react';
import { FIELD_LABEL, fieldInputProps, isCodeRole, isIdentifierRole, normalizeCode } from './lib';
import { TONE_BOX, TONE_TITLE, type Skin } from './skin';
import type { AuthField } from './types';

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

// ---------------------------------------------------------------- icons
export function Spin({ className = 'size-4' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={cx('animate-spin', className)} fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2.5" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

export function LockIcon({ className = 'size-4' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className} {...stroke}>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

export function ShieldCheckIcon({ className = 'size-4' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className} {...stroke}>
      <path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6l-7-3Z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

export function InfoIcon({ className = 'size-4' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className} {...stroke}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </svg>
  );
}

export function EyeIcon({ off = false }: { off?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className="size-5" {...stroke} strokeWidth={1.8}>
      <path d="M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="2.8" />
      {off && <path d="M4 4l16 16" />}
    </svg>
  );
}

// ---------------------------------------------------------------- buttons + notes
export function Btn({
  skin,
  kind = 'secondary',
  busy = false,
  disabledReason,
  className = '',
  children,
  ...rest
}: {
  skin: Skin;
  kind?: 'primary' | 'secondary' | 'danger' | 'ghost';
  busy?: boolean;
  disabledReason?: string | null;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  const descId = useId();
  const off = Boolean(rest.disabled || busy || disabledReason);
  return (
    <button
      type="button"
      {...rest}
      disabled={off}
      aria-busy={busy || undefined}
      aria-describedby={disabledReason ? descId : rest['aria-describedby']}
      title={disabledReason ?? rest.title}
      className={cx(skin.btn, skin[kind], className)}
    >
      {busy && <Spin />}
      {children}
      {disabledReason && (
        <span id={descId} className="sr-only">
          {` (unavailable: ${disabledReason})`}
        </span>
      )}
    </button>
  );
}

export type BoxTone = keyof typeof TONE_BOX;

export function Box({ tone, title, children, role = 'note', className = '', testId }: { tone: BoxTone; title?: ReactNode; children?: ReactNode; role?: string; className?: string; testId?: string }) {
  return (
    <div role={role} data-testid={testId} className={cx('rounded-xl px-3.5 py-3', TONE_BOX[tone], className)}>
      {title && <p className={cx('font-semibold', TONE_TITLE[tone])}>{title}</p>}
      {children && <div className={cx('text-muted', title ? 'mt-0.5' : '')}>{children}</div>}
    </div>
  );
}

export function CancelButton({ skin, onCancel, busy, label = 'Cancel sign-in' }: { skin: Skin; onCancel: () => void; busy: boolean; label?: string }) {
  const [ask, setAsk] = useState(false);
  if (!ask)
    return (
      <Btn skin={skin} kind="ghost" onClick={() => setAsk(true)} disabled={busy}>
        {label}
      </Btn>
    );
  return (
    <div className={cx(skin.panel, 'space-y-2')} role="group" aria-label="Cancel this sign-in?">
      <p className={skin.text}>Cancel this sign-in? The agent’s task continues without it.</p>
      <div className="flex flex-wrap gap-2">
        <Btn skin={skin} kind="danger" busy={busy} onClick={onCancel}>
          Yes, cancel sign-in
        </Btn>
        <Btn skin={skin} kind="secondary" onClick={() => setAsk(false)} disabled={busy}>
          Keep it
        </Btn>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- inputs
/** The return key of the phone keyboard: "next" field, or "go" / "done" on the last one. */
export type EnterKey = 'next' | 'go' | 'done';

export function SecretToggleInput({
  id,
  skin,
  value,
  onChange,
  disabled,
  describedBy,
  invalid,
  autoComplete,
  name,
  label,
  onKeyDown,
  autoFocus,
  enterKeyHint,
}: {
  id: string;
  skin: Skin;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
  describedBy?: string;
  invalid?: boolean;
  autoComplete: string;
  name?: string;
  label: string;
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
  autoFocus?: boolean;
  enterKeyHint?: EnterKey;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="flex min-w-0 gap-1.5">
      <input
        id={id}
        name={name}
        type={show ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        disabled={disabled}
        autoComplete={autoComplete}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        autoFocus={autoFocus}
        data-autofocus={autoFocus || undefined}
        enterKeyHint={enterKeyHint}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        maxLength={4096}
        className={skin.input}
      />
      <button
        type="button"
        aria-pressed={show}
        aria-label={`${show ? 'Hide' : 'Show'} ${label.toLowerCase()}`}
        title={show ? 'Hide' : 'Show'}
        onClick={() => setShow((v) => !v)}
        className={cx(skin.btn, skin.secondary, '!px-3')}
      >
        <EyeIcon off={show} />
      </button>
    </div>
  );
}

/**
 * One field of the current page, by role: fixed label, keyboard (type / inputmode), password-manager token, return key,
 * code normalisation on paste.
 */
export function FieldInput({
  field,
  skin,
  value,
  onChange,
  disabled,
  error,
  hint,
  autoFocus,
  enterKeyHint,
}: {
  field: AuthField;
  skin: Skin;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
  error?: string | null;
  hint?: ReactNode;
  autoFocus?: boolean;
  /** Default: "done" for codes, "next" otherwise. */
  enterKeyHint?: EnterKey;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errId = `${id}-error`;
  const label = FIELD_LABEL[field.role];
  const props = fieldInputProps(field);
  const code = isCodeRole(field.role);
  const describedBy = [hint ? hintId : null, error ? errId : null].filter(Boolean).join(' ') || undefined;
  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    if (!code) return;
    e.preventDefault();
    onChange(normalizeCode(e.clipboardData.getData('text'), field));
  };
  return (
    <div className="min-w-0">
      <label htmlFor={id} className={skin.label}>
        {label}
      </label>
      {field.role === 'password' ? (
        <SecretToggleInput
          id={id}
          name="password"
          skin={skin}
          value={value}
          onChange={onChange}
          disabled={disabled}
          describedBy={describedBy}
          invalid={Boolean(error)}
          autoComplete={props.autoComplete}
          label={label}
          autoFocus={autoFocus}
          enterKeyHint={enterKeyHint ?? 'next'}
        />
      ) : (
        <input
          id={id}
          name={isIdentifierRole(field.role) ? 'username' : field.role === 'otp' ? 'one-time-code' : undefined}
          type={props.type}
          inputMode={props.inputMode}
          autoComplete={props.autoComplete}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          maxLength={props.maxLength ?? (field.role === 'phone' ? 32 : field.role === 'email' ? 320 : 512)}
          value={value}
          onChange={(e) => onChange(code ? normalizeCode(e.target.value, field) : e.target.value)}
          onPaste={onPaste}
          disabled={disabled}
          autoFocus={autoFocus}
          data-autofocus={autoFocus || undefined}
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          enterKeyHint={enterKeyHint ?? (code ? 'done' : 'next')}
          className={cx(skin.input, code && field.role === 'otp' && skin.code)}
        />
      )}
      {hint && (
        <p id={hintId} className={cx(skin.small, 'mt-1.5')}>
          {hint}
        </p>
      )}
      {error && (
        <p id={errId} role="alert" className={cx(skin.small, 'mt-1.5 !text-danger')}>
          {error}
        </p>
      )}
    </div>
  );
}

export function PinField({ skin, value, onChange, disabled, error }: { skin: Skin; value: string; onChange: (v: string) => void; disabled: boolean; error?: string | null }) {
  const id = useId();
  const [show, setShow] = useState(false);
  return (
    <div className={cx(skin.panel, 'space-y-1.5')} data-testid="auth-pin">
      <label htmlFor={id} className={skin.label}>
        Remote sign-in PIN
      </label>
      <div className="flex min-w-0 gap-1.5">
        <input
          id={id}
          type={show ? 'text' : 'password'}
          inputMode="numeric"
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          maxLength={64}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          aria-describedby={`${id}-hint${error ? ` ${id}-error` : ''}`}
          aria-invalid={error ? true : undefined}
          data-1p-ignore
          data-lpignore="true"
          className={skin.input}
        />
        <button
          type="button"
          aria-pressed={show}
          aria-label={`${show ? 'Hide' : 'Show'} PIN`}
          onClick={() => setShow((v) => !v)}
          className={cx(skin.btn, skin.secondary, '!px-3')}
        >
          <EyeIcon off={show} />
        </button>
      </div>
      <p id={`${id}-hint`} className={skin.small}>
        The PIN you set in Password Vault → Smart sign-in. It protects entering passwords from outside the Mac.
      </p>
      {error && (
        <p id={`${id}-error`} role="alert" className={cx(skin.small, '!text-danger')}>
          {error}
        </p>
      )}
    </div>
  );
}

export function CheckRow({
  skin,
  checked,
  onChange,
  disabled,
  children,
  hint,
  error,
  testId,
}: {
  skin: Skin;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  children: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  testId?: string;
}) {
  const id = useId();
  const desc = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(' ') || undefined;
  return (
    <div>
      <div className="flex items-start gap-3">
        <input
          id={id}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          aria-invalid={error ? true : undefined}
          aria-describedby={desc}
          data-testid={testId}
          className={cx(skin.check, 'mt-0.5 cursor-pointer')}
        />
        <label htmlFor={id} className={cx(skin.text, '!text-text', disabled ? 'opacity-60' : 'cursor-pointer')}>
          {children}
        </label>
      </div>
      {hint && (
        <p id={`${id}-hint`} className={cx(skin.small, 'mt-1 pl-8')}>
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} role="alert" className={cx(skin.small, 'mt-1 pl-8 !text-danger')}>
          {error}
        </p>
      )}
    </div>
  );
}

export function NameField({ skin, value, onChange, disabled, site }: { skin: Skin; value: string; onChange: (v: string) => void; disabled: boolean; site: string }) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className={skin.label}>
        Name in the vault <span className="font-normal opacity-75">(optional)</span>
      </label>
      <input
        id={id}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        maxLength={200}
        disabled={disabled}
        placeholder={site}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        className={skin.input}
      />
    </div>
  );
}
