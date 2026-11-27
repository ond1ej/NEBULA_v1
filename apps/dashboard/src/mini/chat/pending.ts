// Optimistic (not yet confirmed) messages per conversation. Kept outside the query cache so a background refetch can
// never drop a message the owner just sent; survives switching conversations within the session (memory only).
import { useSyncExternalStore } from 'react';
import type { PendingMessage } from './model';

const store = new Map<string, PendingMessage[]>();
const listeners = new Map<string, Set<() => void>>();
const EMPTY: PendingMessage[] = [];

export function getPending(key: string): PendingMessage[] {
  return store.get(key) ?? EMPTY;
}

export function setPending(key: string, fn: (xs: PendingMessage[]) => PendingMessage[]): void {
  const next = fn(getPending(key));
  if (next.length) store.set(key, next);
  else store.delete(key);
  for (const l of [...(listeners.get(key) ?? [])]) l();
}

export function updatePending(key: string, clientId: string, fn: (p: PendingMessage) => PendingMessage): void {
  setPending(key, (xs) => xs.map((p) => (p.client_id === clientId ? fn(p) : p)));
}

export function clearAllPending(): void {
  store.clear();
}

export function usePending(key: string): PendingMessage[] {
  return useSyncExternalStore(
    (cb) => {
      let set = listeners.get(key);
      if (!set) listeners.set(key, (set = new Set()));
      set.add(cb);
      return () => {
        set.delete(cb);
        if (set.size === 0 && listeners.get(key) === set) listeners.delete(key);
      };
    },
    () => getPending(key),
    () => EMPTY,
  );
}
