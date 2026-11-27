// A side column on large screens (lg+) that becomes a bottom sheet below lg.
import { useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { IconClose } from './icons';

const QUERY = '(min-width: 1024px)';

function subscribe(cb: () => void) {
  if (typeof window.matchMedia !== 'function') return () => {};
  const m = window.matchMedia(QUERY);
  m.addEventListener?.('change', cb);
  return () => m.removeEventListener?.('change', cb);
}

/** True on lg+ screens (side columns), false when panels are bottom sheets. */
export function useWideLayout(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => (typeof window.matchMedia === 'function' ? window.matchMedia(QUERY).matches : true),
    () => true,
  );
}

export function Sheet({
  open,
  onClose,
  title,
  children,
  className = '',
  headerExtra,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  className?: string;
  headerExtra?: ReactNode;
}) {
  const wide = useWideLayout();
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const asSheet = !wide && open;

  useEffect(() => {
    if (!asSheet) return;
    const prev = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (prev && document.contains(prev)) prev.focus({ preventScroll: true });
    };
  }, [asSheet]);

  if (!wide && !open) return null;
  return (
    <>
      {asSheet && <div className="fixed inset-0 z-[70] animate-fade-in bg-black/55" onClick={onClose} aria-hidden />}
      <aside
        aria-label={title}
        role={asSheet ? 'dialog' : undefined}
        aria-modal={asSheet || undefined}
        className={
          asSheet
            ? 'fixed inset-x-0 bottom-0 z-[75] flex max-h-[78dvh] animate-sheet-up flex-col rounded-t-2xl border border-border bg-panel pb-[env(safe-area-inset-bottom)] shadow-overlay'
            : `flex min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-panel ${className}`
        }
      >
        <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2">
          <h2 className="truncate text-sm font-semibold text-text">{title}</h2>
          <div className="flex items-center gap-1">
            {headerExtra}
            {asSheet && (
              <button
                ref={closeRef}
                type="button"
                onClick={onClose}
                aria-label={`Close ${title}`}
                className="flex size-11 items-center justify-center rounded-md text-muted hover:bg-panel-2 hover:text-text focus-visible:outline-2 focus-visible:outline-accent"
              >
                <IconClose />
              </button>
            )}
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</div>
      </aside>
    </>
  );
}
