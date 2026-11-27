// Overlays (bottom sheets that must survive Telegram's BackButton, e.g. the sign-in sheet) register here: while one is
// open, the BackButton closes the top-most overlay instead of navigating, and it is shown even on tab roots.
import { useEffect, useRef, useSyncExternalStore } from 'react';

const stack: { id: symbol; close: () => void }[] = [];
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of [...listeners]) l();
}

export function pushBack(close: () => void): () => void {
  const id = Symbol('overlay');
  stack.push({ id, close });
  emit();
  return () => {
    const i = stack.findIndex((x) => x.id === id);
    if (i >= 0) stack.splice(i, 1);
    emit();
  };
}

/** Closes the top-most overlay; false when none is open. */
export function popBack(): boolean {
  const top = stack[stack.length - 1];
  if (!top) return false;
  top.close();
  return true;
}

export function useBackDepth(): number {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => stack.length,
    () => 0,
  );
}

/** While `open`, Telegram's BackButton calls `onClose` (latest) instead of navigating back. */
export function useBackOverlay(open: boolean, onClose: () => void): void {
  const ref = useRef(onClose);
  ref.current = onClose;
  useEffect(() => {
    if (!open) return;
    return pushBack(() => ref.current());
  }, [open]);
}
