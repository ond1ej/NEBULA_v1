// State hooks of the Password Vault UI: live status, the "vault locked" signal and passphrase re-confirmation.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useApi } from '../../hooks/useApi';
import { useLiveRefresh, useNebulaEvents } from '../../hooks/useEvents';
import { vaultApi } from './api';
import { ReauthDialog } from './forms';
import { errCode } from './lib';
import type { VaultCoreStatus, VaultStatus } from './types';

const isStatusEvent = (ev: { type: string }) => ev.type === 'vault.status.changed';
/** Status changes, plus settings changed elsewhere (broker / LAN / auto-lock are announced as `vault.access`). */
const refreshesStatus = (ev: { type: string; payload?: Record<string, unknown> }) =>
  isStatusEvent(ev) || (ev.type === 'vault.access' && ev.payload?.operation === 'settings');

/** Calls `onLocked` as soon as the host announces that the vault was locked (owner, auto-lock, shutdown). */
export function useVaultLockSignal(onLocked: () => void): void {
  const ref = useRef(onLocked);
  ref.current = onLocked;
  useNebulaEvents((ev) => {
    if (isStatusEvent(ev) && (ev.payload as { locked?: unknown }).locked === true) ref.current();
  });
}

/**
 * GET /vault/status, kept live: a `vault.status.changed` event with locked=true is applied at once (so views that hold
 * secrets unmount immediately), then the full status is refetched.
 */
export function useVaultStatus() {
  const st = useApi((signal) => vaultApi.status(signal), []);
  const { setData, reload } = st;
  useVaultLockSignal(() => setData((prev) => (prev ? { ...prev, locked: true, lock_at: null, unlocked_at: null } : prev)));
  useLiveRefresh(reload, refreshesStatus, 150);
  /** Applies the core status returned by create / unlock / rotate / settings (keeps broker + management_local). */
  const merge = useCallback(
    (core: Partial<VaultCoreStatus>) => setData((prev) => (prev ? ({ ...prev, ...core } as VaultStatus) : prev)),
    [setData],
  );
  return { ...st, merge };
}

interface Pending {
  run: () => Promise<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

const cancelled = () => new DOMException('Passphrase confirmation cancelled', 'AbortError');

/**
 * Reveal / export / import need a passphrase confirmation within the last 5 minutes. `withReauth(fn)` runs `fn`; on
 * 403 `reauth_required` it asks for the passphrase (dialog), confirms it with POST /vault/reauth and retries `fn` once.
 * Cancelling rejects with an AbortError (toasts ignore those). The typed passphrase lives only in the dialog's state.
 */
export function useReauth() {
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingRef = useRef<Pending | null>(null);
  pendingRef.current = pending;

  useEffect(
    () => () => {
      pendingRef.current?.reject(cancelled());
    },
    [],
  );

  // A pending confirmation is pointless once the vault locked: cancel it.
  useVaultLockSignal(() => {
    pendingRef.current?.reject(cancelled());
    setPending(null);
  });

  const withReauth = useCallback(
    <T,>(fn: () => Promise<T>): Promise<T> =>
      fn().catch((e: unknown) => {
        if (errCode(e) !== 'reauth_required') throw e;
        return new Promise<T>((resolve, reject) => setPending({ run: fn, resolve: resolve as (v: unknown) => void, reject }));
      }),
    [],
  );

  const cancel = () => {
    pending?.reject(cancelled());
    setPending(null);
  };

  const confirm = async (passphrase: string) => {
    const p = pendingRef.current;
    if (!p) return;
    await vaultApi.reauth(passphrase); // wrong passphrase: throws, the dialog shows the message and stays open
    setPending(null);
    try {
      p.resolve(await p.run());
    } catch (e) {
      p.reject(e);
    }
  };

  const reauthDialog = pending ? <ReauthDialog onCancel={cancel} onConfirm={confirm} /> : null;
  return { withReauth, reauthDialog };
}
