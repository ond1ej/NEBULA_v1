// Owner confirmations for the whole Mini App (V4.0: ONE confirmation instead of two secrets).
//
//  * 403 `stepup_required` — from MiniClient calls and from the Dashboard pages of the administration area (they share
//    MiniClient's transport) — and 403 `reauth_required` (showing / exporting vault secrets) land here.
//  * useOwnerConfirm() lets a screen confirm BEFORE an action that needs both a fresh owner and the vault (unlock,
//    reveal, a sign-in that would otherwise ask for the remote PIN): GET /auth/assurance tells whether anything is
//    needed at all; if so ONE sheet asks once — Face ID through Telegram's BiometricManager (which also unlocks the
//    vault when this device holds the vault key), or a single field: the vault passphrase (it confirms the owner AND
//    unlocks the vault) or, without a vault, the NEBULA password. POST /auth/confirm does both in one call.
//
// Requests that fail while the sheet is open share it; after a confirmation each of them is retried exactly once,
// after a cancel they fail with their original error. The sheet is its own chunk, loaded only when needed (nothing is
// requested at start).
import { createContext, Suspense, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { lazyNamed } from '../../lib/lazy';
import type { MiniClient } from '../client';
import type { Assurance } from '../types';
import { Spinner } from '../ui';
import { stepUpApi, type ConfirmBody, type ConfirmResult } from './api';
import { t } from '../../i18n';

const ConfirmSheet = lazyNamed(() => import('./ConfirmSheet'), 'ConfirmSheet');

/** Preloads the confirmation sheet (e.g. while the owner looks at a sign-in form). */
export const preloadConfirmSheet = () => ConfirmSheet.preload();

export interface OwnerConfirmOptions {
  /** The action needs the Password Vault unlocked: the same confirmation unlocks it. */
  unlockVault?: boolean;
  /** Showing / exporting secrets: the vault must be unlocked AND re-confirmed on this session (implies unlockVault). */
  reveal?: boolean;
  /** What is being confirmed (shown in the sheet and in the system's Face ID prompt). */
  reason?: string;
}

/** What the confirmation sheet asks for. */
export interface ConfirmPrompt {
  /** Send `unlock_vault`: unlock the vault (or re-confirm it for reveal) with the same confirmation. */
  unlockVault: boolean;
  reveal: boolean;
  reason: string;
  /** The methods of a 403 step-up answer; null: the sheet reads them from `assurance` (or loads it). */
  methods: string[] | null;
  assurance: Assurance | null;
}

interface StepUpCtx {
  /** Until when sensitive actions need no new confirmation (unix seconds), as far as this Mini App knows. */
  freshUntil: number | null;
  /** Records a confirmation made elsewhere in the app (e.g. GET /auth/assurance). */
  setFreshUntil: (v: number | null) => void;
  /** Confirms it's the owner (and unlocks / re-confirms the vault) only when needed; false when cancelled. */
  confirm: (opts?: OwnerConfirmOptions) => Promise<boolean>;
  /** One POST /auth/confirm with a secret the screen already holds (no sheet); throws on failure. */
  confirmWith: (body: ConfirmBody) => Promise<ConfirmResult>;
}

const Ctx = createContext<StepUpCtx>({
  freshUntil: null,
  setFreshUntil: () => {},
  confirm: () => Promise.resolve(false),
  confirmWith: () => Promise.reject(new Error('no owner confirmation here')),
});

export function useStepUp(): StepUpCtx {
  return useContext(Ctx);
}

/** The unified owner confirmation: `await confirm({ unlockVault, reveal, reason })` → true when confirmed. */
export function useOwnerConfirm(): StepUpCtx['confirm'] {
  return useContext(Ctx).confirm;
}

export const REASON_DEFAULT = t('confirm.reason.default');
export const REASON_REVEAL = t('confirm.reason.reveal');
export const REASON_UNLOCK = t('confirm.reason.unlock');
const MARGIN_MS = 5000;

const future = (until: number | null | undefined, now = Date.now()) => typeof until === 'number' && until * 1000 > now + MARGIN_MS;

export function StepUpProvider({ client, freshUntil: initial = null, children }: { client: MiniClient; freshUntil?: number | null; children: ReactNode }) {
  const [prompt, setPrompt] = useState<ConfirmPrompt | null>(null);
  const [freshUntil, setFresh] = useState<number | null>(initial);
  const api = useMemo(() => stepUpApi(client), [client]);
  const fresh = useRef(initial);
  const confirmedAt = useRef(0);
  const vaultUntil = useRef(0);
  const vaultConfirmedAt = useRef(0);
  const pending = useRef<{ promise: Promise<boolean>; resolve: (ok: boolean) => void; prompt: ConfirmPrompt } | null>(null);

  const setFreshUntil = useCallback((v: number | null) => {
    fresh.current = v;
    setFresh(v);
  }, []);

  /** Opens the sheet (or joins the one already open). */
  const ask = useCallback((p: ConfirmPrompt): Promise<boolean> => {
    if (pending.current) return pending.current.promise;
    let resolve: (ok: boolean) => void = () => {};
    const promise = new Promise<boolean>((r) => {
      resolve = r;
    });
    pending.current = { promise, resolve, prompt: p };
    setPrompt(p);
    return promise;
  }, []);

  const record = useCallback(
    (r: ConfirmResult) => {
      confirmedAt.current = Date.now();
      setFreshUntil(r.fresh_until ?? null);
      if (r.vault && !r.vault.locked) {
        vaultConfirmedAt.current = Date.now();
        vaultUntil.current = r.vault.reauth_until ?? 0;
      }
    },
    [setFreshUntil],
  );

  useLayoutEffect(() => {
    const off = client.setChallengeHandler((err, sentAt) => {
      if (err.code === 'stepup_required') {
        if (pending.current) return pending.current.promise;
        // sent before the last confirmation, which is still valid: retry without asking again
        if (sentAt < confirmedAt.current && future(fresh.current)) return Promise.resolve(true);
        const methods = Array.isArray(err.details.methods) ? err.details.methods.filter((m): m is string => typeof m === 'string') : ['password'];
        return ask({ unlockVault: false, reveal: false, reason: REASON_DEFAULT, methods, assurance: null });
      }
      if (err.code === 'reauth_required') {
        if (pending.current) return pending.current.promise;
        if (sentAt < vaultConfirmedAt.current && future(vaultUntil.current)) return Promise.resolve(true);
        return ask({ unlockVault: true, reveal: true, reason: REASON_REVEAL, methods: null, assurance: null });
      }
      return Promise.resolve(false);
    });
    return () => {
      off();
      pending.current?.resolve(false);
      pending.current = null;
    };
  }, [client, ask]);

  const confirm = useCallback(
    async (opts: OwnerConfirmOptions = {}): Promise<boolean> => {
      const reveal = Boolean(opts.reveal);
      const wantVault = reveal || Boolean(opts.unlockVault);
      const reason = opts.reason ?? (reveal ? REASON_REVEAL : wantVault ? REASON_UNLOCK : REASON_DEFAULT);
      let a: Assurance | null = null;
      try {
        a = await api.assurance();
      } catch {
        a = null; // the sheet decides without it
      }
      if (!a) return ask({ unlockVault: wantVault, reveal, reason, methods: null, assurance: null });
      if (a.fresh_until !== undefined) setFreshUntil(a.fresh_until);
      const isFresh = a.fresh === true || future(a.fresh_until);
      const v = a.vault;
      // an older host without vault state: let the confirmation unlock it
      const needVault = wantVault && (v ? v.exists && (v.locked || (reveal && !future(v.reauth_until))) : true);
      if (isFresh && !needVault) return true;
      return ask({ unlockVault: needVault, reveal, reason, methods: null, assurance: a });
    },
    [api, ask, setFreshUntil],
  );

  const confirmWith = useCallback(
    async (body: ConfirmBody) => {
      try {
        const r = await api.confirm(body);
        record(r);
        return r;
      } finally {
        body.passphrase = undefined;
        body.password = undefined;
        body.token = undefined;
      }
    },
    [api, record],
  );

  const done = useCallback(
    (r: ConfirmResult | null) => {
      if (r) record(r);
      const p = pending.current;
      pending.current = null;
      setPrompt(null);
      p?.resolve(r !== null);
    },
    [record],
  );

  /** The session became fresh although the vault part failed (e.g. Face ID passed, the passphrase was wrong). */
  const onFresh = useCallback(
    (until: number | null) => {
      if (until === null) return;
      confirmedAt.current = Date.now();
      setFreshUntil(until);
    },
    [setFreshUntil],
  );

  const value = useMemo<StepUpCtx>(() => ({ freshUntil, setFreshUntil, confirm, confirmWith }), [freshUntil, setFreshUntil, confirm, confirmWith]);
  return (
    <Ctx.Provider value={value}>
      {children}
      {prompt && (
        <Suspense
          fallback={
            <div className="fixed inset-0 z-[80] grid place-items-center bg-scrim">
              <Spinner label={t('confirm.loading')} />
            </div>
          }
        >
          <ConfirmSheet prompt={prompt} onDone={done} onFresh={onFresh} />
        </Suspense>
      )}
    </Ctx.Provider>
  );
}
