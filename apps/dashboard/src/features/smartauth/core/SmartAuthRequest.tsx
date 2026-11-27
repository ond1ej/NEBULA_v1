// <SmartAuthRequest>: the owner's secure answer to the CURRENT step of an agent's sign-in, rendered from the session's
// open request (email / username / phone, password, both, verification code, authenticator approval with its number,
// passkey / security key / CAPTCHA, an unrecognised step, a choice of sign-in method, a destination review, a paused
// loop, the site rejecting the details) plus the session's final states and, on the detail, its diagnostics. One core
// for the Telegram Mini App (bottom sheet) and the local Dashboard (modal).
//
// The form renders exactly the fields the request lists (`request.fields`) — never a field the page did not ask for.
//
// Multi-step sign-ins: the form is keyed by the request — when the page moves on (e-mail, then password) the old form
// and everything typed into it are gone and only what the page asks for NOW is shown. A newer request that replaces an
// open form shows a short "The page changed" notice; an older response never replaces a newer step (pickNewer). The
// save choice (use once / save to the vault / a saved account) is pre-selected from the session and kept across steps.
//
// Secret hygiene: typed values, the remote PIN and the vault passphrase live only in this component's state. Every
// answer fetches a fresh single-use token first (POST token, then POST submit); after a successful submit, a cancel or
// an unmount the values are gone. Nothing is written to storage, URLs, the console or drafts, and errors show the API
// message, never a value. Labels are fixed by role / kind: page-provided labels, titles or button texts never show.
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import {
  ALT_INSTEAD_LABEL,
  ALT_LABEL,
  CHANNEL_HINT,
  KEY_TEXT,
  LOGIN_ERROR_TEXT,
  LOOP_TEXT,
  MANUAL_KIND,
  OWNER_WAIT_STATES,
  RELOAD_ERRORS,
  STEP_ERROR_TEXT,
  altKinds,
  codeLength,
  countdown,
  failureText,
  fieldProblem,
  fieldsHeading,
  flagReason,
  formError,
  hostOf,
  isIdentifierRole,
  isKeyKind,
  isTerminal,
  needsOwner,
  normalizeState,
  noteTexts,
  pickNewer,
  pinNeeded,
  requestTitle,
  saveNoteText,
  shownOrigin,
  stepLabel,
  taskRef,
  vaultUnlockError,
  type FormError,
} from './lib';
import { AuthDiagnostics } from './Diagnostics';
import { Box, Btn, CancelButton, CheckRow, cx, FieldInput, InfoIcon, LockIcon, NameField, PinField, SecretToggleInput, ShieldCheckIcon, Spin, useNow } from './parts';
import { SKINS, TONE_BOX, TONE_TITLE, type Skin, type SkinVariant } from './skin';
import type { AltKind, AuthRequest, AuthSession, AuthTrust, SmartAuthClient, SubmitAction, SubmitBody } from './types';

export interface SmartAuthRequestProps {
  session: AuthSession;
  client: SmartAuthClient;
  variant: SkinVariant;
  /** The agent's Live Desktop (manual steps). */
  liveDesktopHref?: string | null;
  /** The session returned by submit / cancel: the state moves on before the next event arrives. */
  onSession?: (s: AuthSession) => void;
  /** Reload the session (token expired, request replaced, vault unlocked, manual step not finished, …). */
  onReload?: () => void;
  /** Close the hosting sheet / modal (final states). */
  onClose?: () => void;
  /** The hosting sheet / modal already shows the title. */
  hideTitle?: boolean;
}

/** How typed credentials are used: once, saved to the vault after the sign-in, or a saved account instead. */
type Method = 'once' | 'vault' | 'saved';

// ---------------------------------------------------------------- header
function Header({ session, skin, hideTitle }: { session: AuthSession; skin: Skin; hideTitle?: boolean }) {
  const now = useNow(1000);
  const { origin, verified } = shownOrigin(session);
  const req = session.request;
  const active = !isTerminal(session);
  const expiresAt = req?.expires_at ?? session.expires_at;
  const left = Math.max(0, Math.floor(expiresAt - now / 1000));
  const step = stepLabel(req?.step ?? session.step);
  return (
    <header className="space-y-2.5">
      {!hideTitle && <h3 className={skin.title}>{requestTitle(session)}</h3>}
      <div className={cx(skin.panel, 'flex items-start gap-2.5')} data-testid="auth-origin">
        <span className={cx('mt-0.5 shrink-0', verified ? 'text-success' : 'text-warn')}>
          <LockIcon />
        </span>
        <div className="min-w-0">
          <p className={cx(skin.mono, 'font-semibold text-text')}>{origin}</p>
          <p className={skin.small}>{verified ? 'Verified page address in the isolated browser' : 'Requested address — not verified yet'}</p>
        </div>
      </div>
      <dl className={cx(skin.small, 'flex flex-wrap gap-x-3 gap-y-1')}>
        <div className="flex gap-1">
          <dt>Agent</dt>
          <dd className="font-medium text-text">{session.agent_name}</dd>
        </div>
        {step && (
          <div className="flex gap-1">
            <dt>Step</dt>
            <dd className="text-text">{step}</dd>
          </div>
        )}
        <div className="flex gap-1">
          <dt>Task</dt>
          <dd className="font-mono text-text">{taskRef(session.task_id)}</dd>
        </div>
        {active && (
          <div className="flex gap-1">
            <dt>Expires in</dt>
            <dd role="timer" className={cx('font-mono tabular-nums', left < 60 ? 'text-warn' : 'text-text')}>
              {countdown(left)}
            </dd>
          </div>
        )}
      </dl>
    </header>
  );
}

// ---------------------------------------------------------------- final + progress
function Reasons({ trust }: { trust: AuthTrust | null | undefined }) {
  if (!trust?.reasons.length) return null;
  return (
    <ul className="mt-1 list-disc space-y-0.5 pl-5">
      {trust.reasons.map((r) => (
        <li key={r.code}>{r.text}</li>
      ))}
    </ul>
  );
}

function FinalState({ session, skin, onClose }: { session: AuthSession; skin: Skin; onClose?: () => void }) {
  let box: ReactNode;
  switch (session.state) {
    case 'AUTHENTICATED':
      box = (
        <Box tone="success" role="status" title="Signed in — the agent continues">
          {session.saved_to_vault ? 'The credential was saved to your NEBULA Vault.' : (saveNoteText(session.error_code) ?? 'Nothing you typed was stored.')}
        </Box>
      );
      break;
    case 'CANCELLED':
      box = (
        <Box tone="neutral" role="status" title="Sign-in cancelled">
          The agent was told that the sign-in was cancelled.
        </Box>
      );
      break;
    case 'EXPIRED':
      box = (
        <Box tone="neutral" role="status" title="Sign-in request expired">
          {failureText(session.error_code ?? 'request_expired')}
        </Box>
      );
      break;
    default:
      box = (
        <Box tone="danger" role="status" title="Sign-in failed">
          {failureText(session.error_code)}
          {session.trust?.level === 'RED' && <Reasons trust={session.trust} />}
        </Box>
      );
  }
  return (
    <div className="space-y-3" data-testid="auth-final">
      {box}
      {onClose && (
        <div className={skin.actions}>
          <Btn skin={skin} kind="secondary" onClick={onClose}>
            Close
          </Btn>
        </div>
      )}
    </div>
  );
}

function Progress({ session, skin }: { session: AuthSession; skin: Skin }) {
  const text =
    session.state === 'INITIALIZING'
      ? 'Opening the sign-in page in an isolated browser…'
      : session.state === 'VERIFYING'
        ? 'Checking what the website asks for next…'
        : OWNER_WAIT_STATES.has(session.state)
          ? 'Loading the current step…'
          : 'Signing in…';
  return (
    <div className={cx(skin.panel, 'flex items-start gap-3')} role="status" data-testid="auth-progress">
      <span className="mt-0.5 text-accent-soft">
        <Spin className="size-5" />
      </span>
      <div className="min-w-0">
        <p className={skin.strong}>{text}</p>
        <p className={skin.small}>This updates by itself. If the website asks for more (for example a password or a verification code), it appears here.</p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- trust
/**
 * GREEN: one calm "verified" line, no warning. YELLOW: the exact host name, large, with NEBULA's reasons (the owner then
 * confirms "I checked …"). RED never reaches here (BlockedView). No verdict (older host): the detection flags.
 */
function TrustBlock({ trust, origin, req, skin }: { trust: AuthTrust | null; origin: string; req: AuthRequest; skin: Skin }) {
  if (!trust) {
    if (!req.review_required || req.confidence === 'HIGH') return null;
    const low = req.confidence === 'LOW';
    return (
      <div data-testid="auth-review" data-severity={low ? 'high' : 'medium'}>
        <Box tone={low ? 'danger' : 'warning'} title={low ? 'Careful — this sign-in page looks suspicious' : 'Check this sign-in page before you continue'}>
          {req.flags.length > 0 ? (
            <ul className="mt-1 list-disc space-y-0.5 pl-5">
              {req.flags.map((f) => (
                <li key={f}>{flagReason(f)}</li>
              ))}
            </ul>
          ) : (
            <p>NEBULA is not fully sure this is the right sign-in page.</p>
          )}
        </Box>
      </div>
    );
  }
  if (trust.level === 'GREEN')
    return (
      <p data-testid="auth-trust" data-level="GREEN" className={cx(skin.small, 'flex items-center gap-1.5 !text-success')}>
        <ShieldCheckIcon />
        {`Verified sign-in${trust.provider ? ` · ${trust.provider}` : ''}`}
      </p>
    );
  if (trust.level !== 'YELLOW') return null;
  return (
    <div data-testid="auth-trust" data-level="YELLOW" role="note" className={cx('rounded-xl px-3.5 py-3', TONE_BOX.warning)}>
      <p className={cx('font-semibold', TONE_TITLE.warning)}>Check this address before you continue</p>
      <p className={cx(skin.title, 'mt-1 font-mono break-all')} data-testid="auth-trust-host">
        {hostOf(origin)}
      </p>
      <div className="text-muted">
        <Reasons trust={trust} />
      </div>
    </div>
  );
}

/** RED: nothing can be submitted — the reasons and Cancel only. */
function BlockedView({ trust, origin, cancel }: { trust: AuthTrust; origin: string; cancel: ReactNode }) {
  return (
    <div className="space-y-4" data-testid="auth-blocked">
      <Box tone="danger" role="alert" title="NEBULA blocked this sign-in page">
        <p className="font-mono break-all text-text">{hostOf(origin)}</p>
        <Reasons trust={trust} />
        <p className="mt-1">Nothing you type can be sent to this page. Cancel the sign-in; the agent’s task continues without it.</p>
      </Box>
      {cancel}
    </div>
  );
}

// ---------------------------------------------------------------- vault (save options)
/** Why saving / saved accounts are not possible right now — never silently disabled — and an inline unlock. */
function VaultGate({ req, skin, client, onUnlocked }: { req: AuthRequest; skin: Skin; client: SmartAuthClient; onUnlocked?: () => void }) {
  const id = useId();
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const v = req.vault;
  const unified = Boolean(client.confirmOwner);
  const canUnlock = Boolean(v.can_unlock && (client.unlockVault || unified));
  /** V4.0 owner on the phone: the ONE owner confirmation unlocks the vault (no passphrase field here). */
  const confirmUnlock = async () => {
    if (busy || !client.confirmOwner) return;
    setBusy(true);
    setError(null);
    try {
      if (await client.confirmOwner({ unlockVault: true })) {
        if (alive.current) onUnlocked?.();
      } else if (alive.current) setError('Not unlocked: the confirmation was cancelled.');
    } catch (e) {
      if (alive.current) setError(vaultUnlockError(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const unlock = async () => {
    if (!pass || busy || !client.unlockVault) return;
    const typed = pass;
    setPass('');
    setBusy(true);
    setError(null);
    try {
      await client.unlockVault(typed);
      if (alive.current) onUnlocked?.();
    } catch (e) {
      if (alive.current) setError(vaultUnlockError(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    // inside the sign-in <form>: Enter unlocks the vault, it never submits the sign-in
    if (e.key === 'Enter') {
      e.preventDefault();
      void unlock();
    }
  };
  return (
    <div className={cx(skin.panel, 'space-y-2')} data-testid="auth-vault-gate" aria-live="polite">
      <p className={skin.strong}>{v.state === 'not_created' ? 'No Password Vault yet' : 'Password Vault locked'}</p>
      <p className={skin.small} data-testid="auth-vault-reason">
        {v.reason || (v.state === 'not_created' ? 'Set up the Password Vault first.' : 'The Password Vault is locked. Unlock it to save credentials or use a saved account.')}
      </p>
      {canUnlock && unified && (
        <div className="space-y-1.5">
          {error && (
            <p role="alert" className={cx(skin.small, '!text-danger')}>
              {error}
            </p>
          )}
          <Btn skin={skin} kind="secondary" busy={busy} onClick={() => void confirmUnlock()}>
            Unlock vault
          </Btn>
        </div>
      )}
      {canUnlock && !unified && (
        <div className="space-y-1.5">
          <label htmlFor={id} className={skin.label}>
            Vault passphrase
          </label>
          <SecretToggleInput
            id={id}
            skin={skin}
            value={pass}
            onChange={setPass}
            onKeyDown={onKey}
            disabled={busy}
            autoComplete="off"
            label="Vault passphrase"
            invalid={Boolean(error)}
            describedBy={error ? `${id}-error` : undefined}
          />
          {error && (
            <p id={`${id}-error`} role="alert" className={cx(skin.small, '!text-danger')}>
              {error}
            </p>
          )}
          <Btn skin={skin} kind="secondary" busy={busy} disabled={!pass} onClick={() => void unlock()}>
            Unlock vault
          </Btn>
        </div>
      )}
    </div>
  );
}

function initialMethod(req: AuthRequest, pref: Method | null): Method {
  if (req.save_intent === 'vault') return 'vault';
  if (pref === 'saved' && (req.accounts ?? []).length) return 'saved';
  if (pref === 'vault') return 'vault';
  return 'once';
}

function AltButtons({ kinds, skin, instead, busy, disabled, onChoose }: { kinds: AltKind[]; skin: Skin; instead: boolean; busy: AltKind | null; disabled: boolean; onChoose: (k: AltKind) => void }) {
  if (!kinds.length) return null;
  return (
    <div className="flex flex-col gap-2" role="group" aria-label="Other ways to sign in" data-testid="auth-alternatives">
      {kinds.map((k) => (
        <Btn key={k} skin={skin} kind="secondary" busy={busy === k} disabled={disabled} onClick={() => onChoose(k)}>
          {instead ? ALT_INSTEAD_LABEL[k] : ALT_LABEL[k]}
        </Btn>
      ))}
    </div>
  );
}

/** What NEBULA did by itself on the page (fixed texts per code; unknown codes are ignored). */
function Notes({ req, skin }: { req: AuthRequest; skin: Skin }) {
  const notes = noteTexts(req);
  if (!notes.length) return null;
  return (
    <ul className="space-y-1" aria-label="What NEBULA did on the page" data-testid="auth-notes">
      {notes.map((n) => (
        <li key={n.code} data-note={n.code} className={cx(skin.small, 'flex items-start gap-1.5')}>
          <span className="mt-px shrink-0 text-info">
            <InfoIcon className="size-3.5" />
          </span>
          <span>{n.text}</span>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------- the form for the current request
function RequestForm({
  session,
  req,
  client,
  skin,
  liveDesktopHref,
  onSession,
  onReload,
  onAnswer,
  savePref,
}: {
  session: AuthSession;
  req: AuthRequest;
  client: SmartAuthClient;
  skin: Skin;
  liveDesktopHref?: string | null;
  onSession?: (s: AuthSession) => void;
  onReload?: () => void;
  /** This request was answered here (null: the answer failed) — its successor is no "page changed". */
  onAnswer: (requestId: string | null) => void;
  /** The owner's save choice in this dialog, kept across steps. */
  savePref: { current: Method | null };
}) {
  const now = useNow(5000);
  const accounts = req.accounts ?? [];
  const [values, setValues] = useState<Record<string, string>>({});
  const [pin, setPin] = useState('');
  const [method, setMethodState] = useState<Method>(() => initialMethod(req, savePref.current));
  const [entryId, setEntryId] = useState<string | null>(() => accounts[0]?.entry_id ?? null);
  const [name, setName] = useState('');
  const [allowFuture, setAllowFuture] = useState(false);
  const [reviewOk, setReviewOk] = useState(false);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState<SubmitAction | 'cancel' | null>(null);
  const [chosen, setChosen] = useState<AltKind | null>(null);
  const [error, setError] = useState<FormError | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const busyRef = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const setMethod = (m: Method) => {
    savePref.current = m;
    setMethodState(m);
    setError(null);
  };
  useEffect(() => {
    if (entryId && !accounts.some((a) => a.entry_id === entryId)) setEntryId(accounts[0]?.entry_id ?? null);
    else if (!entryId && accounts.length) setEntryId(accounts[0].entry_id);
  }, [accounts, entryId]);
  useEffect(() => {
    if (method === 'saved' && !accounts.length) setMethodState('once');
  }, [method, accounts.length]);

  const clearSecrets = useCallback(() => {
    setValues({});
    setPin('');
  }, []);

  const trust = req.trust ?? (req.type === 'confirm_destination' ? null : (session.trust ?? null));
  const pageOrigin = req.page_origin || shownOrigin(session).origin;
  const reviewOrigin = req.type === 'confirm_destination' && req.destination ? req.destination.origin : pageOrigin;
  const remoteOff = !req.local && !req.remote_submission;
  const pinLocked = Boolean(req.pin_locked_until && req.pin_locked_until * 1000 > now);
  const account = method === 'saved' ? (accounts.find((a) => a.entry_id === entryId) ?? null) : null;
  const vaultReady = req.vault.can_save;
  const needsVault = req.type === 'credentials' && (method === 'vault' || method === 'saved');

  /** The submit action of the form as it is set up now (null: no submit of values). */
  const action: SubmitAction | null =
    req.type === 'credentials'
      ? method === 'saved'
        ? 'saved'
        : 'credentials'
      : req.type === 'otp' || req.type === 'recovery_code'
        ? 'code'
        : req.type === 'confirm_destination'
          ? 'allow_destination'
          : null;
  const futureOffered =
    req.allow_future_available !== false && vaultReady && (method === 'vault' || (method === 'saved' && Boolean(account && !account.has_grant)));
  const wantsFuture = futureOffered && allowFuture;
  const needsFresh = wantsFuture && req.allow_future_needs_stepup === true;
  const pinWanted = action ? pinNeeded(req, action, { hasGrant: account?.has_grant, allowFuture: wantsFuture, save: method === 'vault' ? 'vault' : 'once' }) : false;
  // V4.0: the owner on the phone confirms it's them ONCE instead of typing the remote PIN (operators keep the PIN)
  const unified = Boolean(client.confirmOwner);
  const needPin = pinWanted && !unified;
  const confirmInstead = pinWanted && unified;
  /** "Save to vault" / a saved account while the vault is locked: the same confirmation unlocks it. */
  const unlockOnSubmit = unified && needsVault && !vaultReady && req.vault.state === 'locked' && req.vault.can_unlock === true;
  const blockReason = !action
    ? null
    : remoteOff
      ? 'Remote sign-in is turned off on the Mac'
      : needPin && !req.pin_configured
        ? 'No remote sign-in PIN is set'
        : needPin && pinLocked
          ? 'The remote sign-in PIN is locked for now'
          : needsVault && !vaultReady && !unlockOnSubmit
            ? req.vault.state === 'not_created'
              ? 'There is no Password Vault yet'
              : 'The Password Vault is locked'
            : null;

  const fields = req.fields;
  const fieldErrors: Record<string, string | null> = {};
  if (action === 'credentials' || action === 'code') for (const f of fields) fieldErrors[f.id] = fieldProblem(f, values[f.id] ?? '');
  const reviewMissing = req.review_required && !reviewOk && (action === 'credentials' || action === 'saved' || action === 'code' || action === 'allow_destination');
  const pinMissing = needPin && !pin;

  const send = async (act: SubmitAction | 'cancel', extra: Partial<SubmitBody> = {}, opts: { fresh?: boolean; unlockVault?: boolean } = {}) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(act);
    setError(null);
    setNote(null);
    let body: SubmitBody | null = null;
    try {
      if (act === 'cancel') {
        clearSecrets();
        const next = await client.cancel(session.id);
        if (alive.current) onSession?.(next);
        return;
      }
      if (client.confirmOwner && (opts.fresh || opts.unlockVault)) {
        // ONE owner confirmation BEFORE the single-use token is spent: it replaces the remote PIN, allows "in future"
        // and, for the vault choices, unlocks a locked vault in the same step
        const ok = await client.confirmOwner({ unlockVault: Boolean(opts.unlockVault) });
        if (!alive.current) return;
        if (!ok) {
          setError({ code: 'stepup_required', message: 'Not confirmed. Confirm it’s you to send this, or cancel the sign-in.' });
          return;
        }
      } else if (opts.fresh && client.ensureFresh) {
        // a vault-permission change from the phone: confirm it's the owner BEFORE the single-use token is spent
        const ok = await client.ensureFresh();
        if (!alive.current) return;
        if (!ok) {
          setError({ code: 'stepup_required', message: 'Not confirmed. Confirm it’s you to let the agent use this credential in future, or turn that option off.' });
          return;
        }
      }
      const t = await client.token(session.id);
      if (t.request_id !== req.id) {
        // The request was replaced meanwhile (e.g. the page moved on): never send these values to another request.
        if (alive.current) setError({ code: 'request_changed', message: 'This request changed meanwhile. It was reloaded — check it and try again.' });
        onReload?.();
        return;
      }
      onAnswer(req.id);
      body = { request_id: t.request_id, token: t.token, action: act, ...extra };
      const next = await client.submit(session.id, body);
      if (!alive.current) return;
      clearSecrets();
      setTried(false);
      if (act === 'check') setNote('NEBULA is checking again. This updates as soon as the website reports the approval.');
      if (act === 'handoff' || act === 'inspect') setNote('The page is opening in the agent’s browser — Live Desktop is ready in a moment.');
      onSession?.(next);
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return;
      const fe = formError(e);
      onAnswer(null);
      if (!alive.current) return;
      if (fe.code === 'pin_invalid' || fe.code === 'pin_locked') setPin('');
      setError(fe);
      if (RELOAD_ERRORS.has(fe.code) || fe.code === 'vault_locked' || fe.code === 'blocked_suspicious') onReload?.();
    } finally {
      if (body) {
        body.values = undefined;
        body.pin = undefined;
        body.token = '';
      }
      body = null;
      busyRef.current = false;
      if (alive.current) {
        setBusy(null);
        setChosen(null);
      }
    }
  };

  const choose = (k: AltKind) => {
    setChosen(k);
    void send('choose', { alternative: k });
  };

  const submitValues = () => {
    if (!action || blockReason) return;
    setTried(true);
    const invalid = (action !== 'saved' && Object.values(fieldErrors).some(Boolean)) || reviewMissing || pinMissing || (action === 'saved' && !account);
    if (invalid) return;
    const common: Partial<SubmitBody> = {
      ...(req.review_required ? { review_confirmed: true } : {}),
      ...(needPin ? { pin } : {}),
    };
    if (action === 'credentials') {
      const vals: Record<string, string> = {};
      for (const f of fields) vals[f.id] = values[f.id] ?? '';
      const trimmed = name.trim();
      const save = method === 'vault' ? 'vault' : 'once';
      void send(
        'credentials',
        { values: vals, save, ...(save === 'vault' ? { ...(futureOffered ? { allow_future: wantsFuture } : {}), ...(trimmed ? { name: trimmed } : {}) } : {}), ...common },
        { fresh: needsFresh || confirmInstead, unlockVault: unlockOnSubmit },
      );
    } else if (action === 'saved' && account) {
      void send('saved', { entry_id: account.entry_id, ...(futureOffered ? { allow_future: wantsFuture } : {}), ...common }, { fresh: needsFresh || confirmInstead, unlockVault: unlockOnSubmit });
    } else if (action === 'code') {
      const f = fields[0];
      void send('code', { values: f ? { [f.id]: values[f.id] ?? '' } : {}, ...common }, { fresh: confirmInstead });
    } else if (action === 'allow_destination') {
      void send('allow_destination', common, { fresh: confirmInstead });
    }
  };

  const disabled = busy !== null;
  const setValue = (id: string, v: string) => setValues((xs) => ({ ...xs, [id]: v }));
  const attempts = session.attempts;
  const alts = altKinds(req);

  // ------------------------------------------------------------ shared blocks
  const stepError = req.error ? STEP_ERROR_TEXT[req.error] : null;
  const codeReq = req.type === 'otp' || req.type === 'recovery_code';
  const attemptText = codeReq
    ? attempts.max_codes && req.error === 'code_rejected'
      ? `Attempt ${Math.min(attempts.codes + 1, attempts.max_codes)} of ${attempts.max_codes}.`
      : null
    : attempts.max_credentials && attempts.credentials > 0
      ? `Attempt ${Math.min(attempts.credentials + 1, attempts.max_credentials)} of ${attempts.max_credentials}.`
      : null;
  // LOGIN_ERROR: the site said the details were wrong; the same fields (request.fields) are asked again below
  const rejected = normalizeState(session.state) === 'LOGIN_ERROR' ? (
    <Box tone="danger" role="alert" title="Wrong sign-in details" testId="auth-login-error">
      {codeReq ? LOGIN_ERROR_TEXT.code : LOGIN_ERROR_TEXT.credentials}
      {attemptText ? ` ${attemptText}` : ''}
    </Box>
  ) : stepError ? (
    <Box tone={stepError.tone} role="alert" title={stepError.text} testId="auth-step-error">
      {req.error === 'credentials_rejected' && attempts.max_credentials
        ? `Attempt ${Math.min(attempts.credentials + 1, attempts.max_credentials)} of ${attempts.max_credentials}.`
        : req.error === 'code_rejected' && attempts.max_codes
          ? `Attempt ${Math.min(attempts.codes + 1, attempts.max_codes)} of ${attempts.max_codes}.`
          : null}
    </Box>
  ) : null;

  const trustBlock = <TrustBlock trust={trust} origin={reviewOrigin} req={req} skin={skin} />;
  const notes = <Notes req={req} skin={skin} />;

  const reviewCheck = req.review_required ? (
    <CheckRow skin={skin} checked={reviewOk} onChange={setReviewOk} disabled={disabled} testId="auth-review-check" error={tried && reviewMissing ? 'Confirm that you checked the site first' : null}>
      I checked that <span className="font-mono font-semibold break-all">{reviewOrigin}</span> is the right site
    </CheckRow>
  ) : null;

  const pinBlock = confirmInstead ? (
    <Box tone="info" title="No PIN needed" testId="auth-confirm-instead">
      When you send this, NEBULA asks you to confirm it’s you once — Face ID or your vault passphrase
      {unlockOnSubmit ? ', which also unlocks the vault' : ''}. The remote sign-in PIN is not needed.
    </Box>
  ) : needPin ? (
    !req.pin_configured ? (
      <Box tone="warning" title="Remote sign-in PIN needed">
        To enter passwords from outside your Mac, set a remote sign-in PIN first (Password Vault → Smart sign-in), or confirm it’s you with Face ID or your NEBULA
        password. You can also cancel this sign-in. One-time verification codes work without a PIN.
      </Box>
    ) : pinLocked ? (
      <Box tone="danger" title="Remote sign-in PIN locked">
        Too many wrong PINs. Try again in {countdown(Math.max(0, (req.pin_locked_until ?? 0) - now / 1000))}, or answer on your Mac.
      </Box>
    ) : (
      <PinField skin={skin} value={pin} onChange={setPin} disabled={disabled} error={tried && pinMissing ? 'Enter your remote sign-in PIN' : null} />
    )
  ) : null;

  const remoteOffBox =
    remoteOff && action ? (
      <Box tone="warning" title="Remote sign-in is turned off">
        Entering sign-in details from outside the Mac is turned off. Answer in the NEBULA Dashboard on your Mac, or allow it in Password Vault → Smart sign-in.
      </Box>
    ) : null;

  const errorBox = error ? (
    <div role="alert" data-testid="auth-error" data-code={error.code} className={cx('rounded-xl px-3.5 py-3', TONE_BOX.danger)}>
      <p className="text-text">{error.message}</p>
    </div>
  ) : null;

  const noteBox = note ? (
    <p role="status" className={skin.small}>
      {note}
    </p>
  ) : null;

  const cancel = <CancelButton skin={skin} busy={busy === 'cancel'} onCancel={() => void send('cancel')} />;

  const liveLink = liveDesktopHref ? (
    <a href={liveDesktopHref} className={cx(skin.btn, skin.secondary)}>
      Open Live Desktop
    </a>
  ) : null;

  const liveWarning = (
    <Box tone="warning" title="Live Desktop is not private">
      Anything you type in Live Desktop is visible to the agent’s computer — use it only for this step.
    </Box>
  );

  // RED: blocked — no submit controls at all
  if (trust?.level === 'RED') return <BlockedView trust={trust} origin={reviewOrigin} cancel={cancel} />;

  const form = (label: string, body: ReactNode, testId?: string, autoComplete?: 'on' | 'off') => (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        submitValues();
      }}
      noValidate
      aria-label={label}
      autoComplete={autoComplete}
      data-testid={testId}
    >
      {body}
    </form>
  );

  // ------------------------------------------------------------ per request type
  if (req.type === 'credentials') {
    const hasPassword = fields.some((f) => f.role === 'password');
    const idField = fields.find((f) => isIdentifierRole(f.role));
    const partial = !(idField && hasPassword);
    const idWord = idField && idField.role !== 'email' ? (idField.role === 'phone' ? 'phone number' : 'username') : 'email';
    const options: { id: Method; title: string; text: ReactNode; off?: boolean }[] = [
      { id: 'once', title: 'Use once', text: 'NEBULA forgets what you typed after this sign-in.' },
      {
        id: 'vault',
        title: 'Save to NEBULA Vault',
        text: vaultReady ? 'Encrypted on your Mac, after the website accepts it.' : (req.vault.reason ?? 'The Password Vault is not available right now.'),
        off: !vaultReady && !(req.vault.can_unlock && (client.unlockVault || client.confirmOwner)),
      },
      ...(accounts.length
        ? [
            {
              id: 'saved' as const,
              title: 'Use an existing saved account',
              text: `${accounts.length} saved account${accounts.length === 1 ? '' : 's'} for ${session.site}${vaultReady ? '' : ' (vault locked)'}`,
            },
          ]
        : []),
    ];
    return form(
      `Sign in to ${session.site}`,
      <>
        {rejected}
        {notes}
        {trustBlock}
        <p className={skin.strong} data-testid="auth-step-heading">
          {method === 'saved' ? 'Choose a saved account' : fieldsHeading(fields)}
        </p>
        {method !== 'saved' && (
          <div className="space-y-3" data-testid="auth-typed">
            {fields.map((f, i) => (
              <FieldInput
                key={f.id}
                field={f}
                skin={skin}
                value={values[f.id] ?? ''}
                onChange={(v) => setValue(f.id, v)}
                disabled={disabled}
                error={tried ? fieldErrors[f.id] : null}
                autoFocus={i === 0}
                enterKeyHint={i < fields.length - 1 ? 'next' : 'go'}
              />
            ))}
          </div>
        )}
        <fieldset className="space-y-1.5" data-testid="auth-save-options">
          <legend className={cx(skin.label, '!mb-1')}>How NEBULA uses these details</legend>
          {options.map((o) => (
            <label key={o.id} className={cx(skin.option, o.off && 'cursor-not-allowed opacity-60')}>
              <input
                type="radio"
                name={`save-${req.id}`}
                className={skin.check}
                checked={method === o.id}
                onChange={() => setMethod(o.id)}
                disabled={disabled || o.off}
                aria-describedby={`save-${o.id}-${req.id}`}
              />
              <span className="min-w-0 flex-1">
                <span className="block font-medium text-text">{o.title}</span>
                <span id={`save-${o.id}-${req.id}`} className={skin.small}>
                  {o.text}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
        {method === 'vault' && partial && (
          <p className={skin.small} data-testid="auth-save-together">
            The {idWord} and password will be saved together after a successful sign-in.
          </p>
        )}
        {needsVault && !vaultReady && <VaultGate req={req} skin={skin} client={client} onUnlocked={onReload} />}
        {method === 'saved' && (
          <fieldset className="space-y-1.5" data-testid="auth-saved">
            <legend className={cx(skin.label, '!mb-1')}>Saved accounts</legend>
            {accounts.map((a) => (
              <label key={a.entry_id} className={cx(skin.option, !vaultReady && 'opacity-60')}>
                <input type="radio" name={`acct-${req.id}`} className={skin.check} checked={entryId === a.entry_id} onChange={() => setEntryId(a.entry_id)} disabled={disabled || !vaultReady} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-text">{a.name}</span>
                  {a.username && <span className={cx(skin.small, 'block truncate')}>{a.username}</span>}
                </span>
                {a.has_grant && <span className="shrink-0 rounded-full bg-success/15 px-2 py-0.5 text-xs font-medium text-success">Allowed for this agent</span>}
              </label>
            ))}
          </fieldset>
        )}
        {method === 'vault' && vaultReady && <NameField skin={skin} value={name} onChange={setName} disabled={disabled} site={session.site} />}
        {futureOffered && (
          <CheckRow
            skin={skin}
            checked={allowFuture}
            onChange={setAllowFuture}
            disabled={disabled}
            hint={req.allow_future_needs_stepup ? 'You confirm it’s you first (Face ID or your NEBULA password).' : null}
          >
            Allow this agent to request this credential in the future
          </CheckRow>
        )}
        {reviewCheck}
        {remoteOffBox}
        {pinBlock}
        {errorBox}
        <div className={skin.actions}>
          <Btn skin={skin} kind="primary" type="submit" busy={busy === 'credentials' || busy === 'saved'} disabledReason={blockReason} disabled={disabled || (method === 'saved' && !account)}>
            {method === 'saved' ? 'Use saved account' : hasPassword ? 'Sign in' : 'Continue'}
          </Btn>
        </div>
        <AltButtons kinds={alts} skin={skin} instead busy={chosen} disabled={disabled} onChoose={choose} />
        {cancel}
      </>,
      undefined,
      'on',
    );
  }

  if (req.type === 'otp' || req.type === 'recovery_code') {
    const f = fields[0];
    const len = f ? codeLength(f) : null;
    const channel = req.otp?.channel ?? 'unknown';
    const hint =
      req.type === 'otp' ? (
        <>
          {CHANNEL_HINT[channel] ?? CHANNEL_HINT.unknown}
          {len ? ` (${len} ${f?.charset === 'numeric' ? 'digits' : 'characters'})` : ''}.
          {req.code_ttl_s ? ` Use a fresh code — NEBULA enters it within ${req.code_ttl_s >= 120 ? `${Math.round(req.code_ttl_s / 60)} minutes` : `${req.code_ttl_s} seconds`} of your submit.` : ''}
        </>
      ) : (
        <>Enter one of the recovery codes you saved for {session.site}. Each code works only once.</>
      );
    return form(
      req.type === 'otp' ? 'Verification step' : 'Recovery step',
      <>
        {rejected}
        {notes}
        {trustBlock}
        {f && <FieldInput field={f} skin={skin} value={values[f.id] ?? ''} onChange={(v) => setValue(f.id, v)} disabled={disabled} error={tried ? fieldErrors[f.id] : null} hint={hint} autoFocus enterKeyHint="done" />}
        {reviewCheck}
        {remoteOffBox}
        {pinBlock}
        {errorBox}
        <div className={skin.actions}>
          <Btn skin={skin} kind="primary" type="submit" busy={busy === 'code'} disabledReason={blockReason} disabled={disabled}>
            Submit code
          </Btn>
        </div>
        {req.type === 'otp' && <AltButtons kinds={alts} skin={skin} instead busy={chosen} disabled={disabled} onChoose={choose} />}
        {cancel}
      </>,
    );
  }

  if (req.type === 'confirm_destination') {
    const d = req.destination;
    return form(
      'Review sign-in destination',
      <>
        <div className={cx(skin.panel, 'space-y-1')}>
          <p className={skin.text}>
            The sign-in continues on <span className="font-mono font-semibold break-all text-text">{d?.origin ?? 'another site'}</span> (requested:{' '}
            <span className="font-mono break-all">{d?.requested_origin ?? session.requested_origin}</span>).
          </p>
          <p className={cx(skin.small, d?.same_site ? '' : '!text-warn')}>{d?.same_site ? 'It belongs to the same site.' : 'This is a different site.'}</p>
          {d?.secrets_pending && <p className={cx(skin.small, '!text-warn')}>The sign-in form wants to send what you typed to this site. Allow it only if you expect that.</p>}
        </div>
        {notes}
        {trustBlock}
        {reviewCheck}
        {remoteOffBox}
        {pinBlock}
        {errorBox}
        <div className={skin.actions}>
          <Btn skin={skin} kind="primary" type="submit" busy={busy === 'allow_destination'} disabledReason={blockReason} disabled={disabled}>
            Allow
          </Btn>
          <Btn skin={skin} kind="danger" busy={busy === 'cancel'} disabled={disabled} onClick={() => void send('cancel')}>
            Cancel sign-in
          </Btn>
        </div>
      </>,
      'auth-destination',
    );
  }

  if (req.type === 'device_approval') {
    const num = typeof req.approval_number === 'string' && /^\d{2,3}$/.test(req.approval_number) ? req.approval_number : null;
    return (
      <div className="space-y-4" data-testid="auth-device">
        {rejected}
        {notes}
        {trustBlock}
        {num && (
          <div className={cx(skin.panel, 'py-4 text-center')} data-testid="auth-approval-number">
            <p className="sr-only">{`Enter ${num} in your authenticator app`}</p>
            <div aria-hidden>
              <p className={skin.text}>Enter</p>
              <p className="my-1 font-mono text-5xl leading-none font-bold tracking-[0.12em] text-text tabular-nums">{num}</p>
              <p className={skin.text}>in your authenticator app</p>
            </div>
          </div>
        )}
        <div className={cx(skin.panel, 'flex items-start gap-3')} role="status">
          <span className="mt-0.5 text-accent-soft">
            <Spin className="size-5" />
          </span>
          <div className="min-w-0">
            <p className={skin.strong}>{num ? 'Waiting for your approval' : 'Approve the sign-in on your device'}</p>
            <p className={skin.small}>
              {num
                ? `${session.site} sent a sign-in request to your authenticator app. Check that it is your sign-in, enter the number shown here and approve it.`
                : `${session.site} sent an approval request (for example a push notification). Open that app, check that it is your sign-in, and approve it.`}{' '}
              NEBULA continues as soon as the website confirms it.
            </p>
          </div>
        </div>
        {noteBox}
        {errorBox}
        <div className={skin.actions}>
          <Btn skin={skin} kind="primary" busy={busy === 'check'} disabled={disabled} onClick={() => void send('check')}>
            Check now
          </Btn>
          <Btn skin={skin} kind="danger" busy={busy === 'cancel'} disabled={disabled} onClick={() => void send('cancel')}>
            Cancel sign-in
          </Btn>
        </div>
        <AltButtons kinds={alts} skin={skin} instead busy={chosen} disabled={disabled} onChoose={choose} />
      </div>
    );
  }

  if (req.type === 'method_choice') {
    return (
      <div className="space-y-4" data-testid="auth-method-choice">
        {rejected}
        {notes}
        {trustBlock}
        <p className={skin.text}>{session.site} offers more than one way to sign in. Choose one — NEBULA continues on the page.</p>
        <AltButtons kinds={alts} skin={skin} instead={false} busy={chosen} disabled={disabled} onChoose={choose} />
        <Btn skin={skin} kind="ghost" busy={busy === 'handoff'} disabled={disabled} onClick={() => void send('handoff')}>
          Finish in Live Desktop instead
        </Btn>
        {noteBox}
        {errorBox}
        {cancel}
      </div>
    );
  }

  if (req.type === 'loop') {
    const info = LOOP_TEXT[req.loop?.reason ?? ''] ?? LOOP_TEXT.no_progress;
    const page = stepLabel(req.loop?.page_step);
    return (
      <div className="space-y-4" data-testid="auth-loop" data-reason={req.loop?.reason ?? ''}>
        <Box tone="warning" role="alert" title={info.title}>
          {info.text}
          {page ? ` Current page: ${page}.` : ''}
        </Box>
        {notes}
        <p className={skin.small}>“Retry” opens the sign-in page again and asks you for the current step. “Inspect” opens the page in Live Desktop so you can look at it and finish it yourself.</p>
        {noteBox}
        {errorBox}
        <div className={skin.actions}>
          <Btn skin={skin} kind="primary" busy={busy === 'retry'} disabled={disabled} onClick={() => void send('retry')}>
            Retry
          </Btn>
          <Btn skin={skin} kind="secondary" busy={busy === 'inspect'} disabled={disabled} onClick={() => void send('inspect')}>
            Inspect in Live Desktop
          </Btn>
        </div>
        {cancel}
      </div>
    );
  }

  if (req.type === 'manual') {
    const k = req.manual?.kind ?? '';
    const kind = MANUAL_KIND[k] ?? { title: 'Manual step', text: 'The website needs a step that only a person can do.' };
    const key = isKeyKind(k) && req.manual?.can_complete_here !== true;
    const promptOpen = req.manual?.webauthn_pending ? (
      <p className={skin.small} data-testid="auth-webauthn-pending">
        The site’s {k === 'security_key' ? 'security key' : 'passkey'} prompt is still open.
      </p>
    ) : null;
    if (k === 'unknown') {
      // still a sign-in page, but nothing NEBULA recognises: never treated as success. The page is still in NEBULA's
      // isolated browser; "Retry" re-reads this request (the host re-checks the page by itself and replaces the
      // request once it recognises the step), "Open in Live Desktop" hands the page to the agent's browser.
      return (
        <div className="space-y-4" data-testid="auth-manual" data-kind="unknown">
          {notes}
          {trustBlock}
          <Box tone="warning" role="alert" title={kind.title} testId="auth-unknown">
            {kind.text}
          </Box>
          {noteBox}
          {errorBox}
          <div className={skin.actions}>
            <Btn
              skin={skin}
              kind="primary"
              disabled={disabled}
              onClick={() => {
                setError(null);
                setNote('NEBULA checks the page again. This updates as soon as it recognises the step.');
                onReload?.();
              }}
            >
              Retry
            </Btn>
            <Btn skin={skin} kind="secondary" busy={busy === 'handoff'} disabled={disabled} onClick={() => void send('handoff')}>
              Open in Live Desktop
            </Btn>
          </div>
          <AltButtons kinds={alts} skin={skin} instead busy={chosen} disabled={disabled} onChoose={choose} />
          {cancel}
        </div>
      );
    }
    // a passkey / security key / CAPTCHA with other ways offered: the page is still in NEBULA's isolated browser until
    // handed off
    const beforeHandoff = alts.length > 0 && (isKeyKind(k) || k === 'captcha');
    if (beforeHandoff)
      return (
        <div className="space-y-4" data-testid="auth-manual" data-handoff="pending" data-kind={k}>
          {notes}
          {trustBlock}
          {key ? (
            <Box tone="info" title={kind.title} testId="auth-key">
              {KEY_TEXT}
            </Box>
          ) : (
            <div className={cx(skin.panel, 'space-y-1')}>
              <p className={skin.strong}>{kind.title}</p>
              <p className={skin.text}>{kind.text} Finish it yourself in Live Desktop, or sign in another way.</p>
            </div>
          )}
          {promptOpen}
          {key && <AltButtons kinds={alts} skin={skin} instead busy={chosen} disabled={disabled} onChoose={choose} />}
          {noteBox}
          {errorBox}
          <div className={skin.actions}>
            <Btn skin={skin} kind={key ? 'secondary' : 'primary'} busy={busy === 'handoff'} disabled={disabled} onClick={() => void send('handoff')}>
              Finish in Live Desktop
            </Btn>
          </div>
          {!key && <AltButtons kinds={alts} skin={skin} instead busy={chosen} disabled={disabled} onChoose={choose} />}
          {cancel}
        </div>
      );
    return (
      <div className="space-y-4" data-testid="auth-manual" data-kind={k}>
        {notes}
        <div className={cx(skin.panel, 'space-y-1')}>
          <p className={skin.strong}>{kind.title}</p>
          <p className={skin.text}>
            {key ? `${kind.text} NEBULA’s secure browser has no passkey or security key.` : kind.text}{' '}
            {k === 'unconfirmed'
              ? 'If you are signed in there, tap “I’m done”.'
              : key
                ? 'The page is open in the agent’s browser — choose another way to sign in there, then tap “I’m done”.'
                : 'The page is open in the agent’s browser — finish this one step there, then tap “I’m done”.'}
          </p>
        </div>
        {promptOpen}
        {liveWarning}
        {errorBox}
        <div className={skin.actions}>
          <Btn skin={skin} kind="primary" busy={busy === 'manual_done'} disabled={disabled} onClick={() => void send('manual_done')}>
            I’m done
          </Btn>
          {liveLink}
        </div>
        <AltButtons kinds={alts} skin={skin} instead busy={chosen} disabled={disabled} onChoose={choose} />
        {cancel}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <Box tone="neutral" title="This step cannot be answered here">
        Open the NEBULA Dashboard on your Mac to continue.
      </Box>
      {cancel}
    </div>
  );
}

// ---------------------------------------------------------------- entry
export function SmartAuthRequest({ session: incoming, client, variant, liveDesktopHref, onSession, onReload, onClose, hideTitle }: SmartAuthRequestProps) {
  const skin = SKINS[variant];
  // never let an older view (a late submit / list response) replace a newer step
  const latest = useRef<AuthSession | null>(null);
  const newest = pickNewer(latest.current, incoming);
  latest.current = newest;
  // older hosts / stored data: DEVICE_APPROVAL_REQUIRED is AUTHENTICATOR_APPROVAL
  const state = normalizeState(newest.state);
  const session = state === newest.state ? newest : { ...newest, state };
  const req = session.request;

  // "The page changed": an open form was replaced by a newer request the owner did not cause by answering here
  const shownReq = useRef<{ sid: string; id: string; seq: number } | null>(null);
  const answered = useRef<string | null>(null);
  const changedFor = useRef<string | null>(null);
  const savePref = useRef<Method | null>(null);
  const cur = needsOwner(session) && req ? { sid: session.id, id: req.id, seq: req.seq } : null;
  const prev = shownReq.current;
  if (prev && prev.sid !== session.id) {
    savePref.current = null;
    changedFor.current = null;
  }
  if (cur && prev && prev.sid === cur.sid && cur.id !== prev.id && cur.seq > prev.seq && answered.current !== prev.id) changedFor.current = cur.id;
  if ((cur?.id ?? null) !== (prev?.id ?? null)) shownReq.current = cur;
  const onAnswer = useCallback((id: string | null) => {
    answered.current = id;
  }, []);
  const changed = cur !== null && changedFor.current === cur.id && req?.error !== 'page_changed';

  return (
    <div className={skin.root} data-testid="smart-auth" data-state={session.state} data-request={req?.type ?? ''}>
      <Header session={session} skin={skin} hideTitle={hideTitle} />
      {changed && (
        <p role="status" aria-live="polite" data-testid="auth-page-changed" className={cx('rounded-xl px-3.5 py-3 text-text', TONE_BOX.info)}>
          The page changed — this is the current step.
        </p>
      )}
      {isTerminal(session) ? (
        <FinalState session={session} skin={skin} onClose={onClose} />
      ) : needsOwner(session) && req ? (
        // keyed by the request: a new step (e.g. the password after the e-mail) starts with an empty form
        <RequestForm
          key={req.id}
          session={session}
          req={req}
          client={client}
          skin={skin}
          liveDesktopHref={liveDesktopHref}
          onSession={onSession}
          onReload={onReload}
          onAnswer={onAnswer}
          savePref={savePref}
        />
      ) : (
        <ProgressWithCancel session={session} skin={skin} client={client} onSession={onSession} />
      )}
      <AuthDiagnostics events={session.events} history={session.history} skin={skin} />
    </div>
  );
}

function ProgressWithCancel({ session, skin, client, onSession }: { session: AuthSession; skin: Skin; client: SmartAuthClient; onSession?: (s: AuthSession) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<FormError | null>(null);
  return (
    <div className="space-y-3">
      <Progress session={session} skin={skin} />
      {error && (
        <div role="alert" className={cx('rounded-xl px-3.5 py-3', TONE_BOX.danger)}>
          <p className="text-text">{error.message}</p>
        </div>
      )}
      <CancelButton
        skin={skin}
        busy={busy}
        onCancel={async () => {
          setBusy(true);
          setError(null);
          try {
            onSession?.(await client.cancel(session.id));
          } catch (e) {
            setError(formError(e));
          } finally {
            setBusy(false);
          }
        }}
      />
    </div>
  );
}
