// Context menu for a file row: a positioned popover on desktop, an action sheet on phones.
// Opened by right-click, long-press or the "…" button; arrow keys move, Esc / Tab / outside click close.
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface MenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** Shown next to a disabled item so it is never a dead control. */
  hint?: string;
  separatorBefore?: boolean;
}

function isPhone(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 639px)').matches;
}

export function ContextMenu({
  x,
  y,
  title,
  items,
  onClose,
  returnFocus,
}: {
  x: number;
  y: number;
  title: string;
  items: MenuItem[];
  onClose: () => void;
  returnFocus?: HTMLElement | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  const [sheet] = useState(isPhone);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useLayoutEffect(() => {
    if (sheet || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const pad = 8;
    setPos({
      left: Math.max(pad, Math.min(x, window.innerWidth - r.width - pad)),
      top: Math.max(pad, Math.min(y, window.innerHeight - r.height - pad)),
    });
  }, [x, y, sheet]);

  useEffect(() => {
    const el = ref.current;
    el?.querySelector<HTMLButtonElement>('[role="menuitem"]:not([disabled])')?.focus();
    const close = () => onCloseRef.current();
    const onDown = (e: PointerEvent) => {
      if (el && !el.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    };
    const onScroll = (e: Event) => {
      if (!sheet && el && !el.contains(e.target as Node)) close();
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', close);
      if (returnFocus && document.contains(returnFocus)) returnFocus.focus({ preventScroll: true });
    };
  }, [sheet, returnFocus]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const btns = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])') ?? []);
    const i = btns.indexOf(document.activeElement as HTMLButtonElement);
    const go = (n: number) => btns[(n + btns.length) % btns.length]?.focus();
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      go(i + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      go(i - 1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      go(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      go(btns.length - 1);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      onClose();
    }
  };

  const list = (
    <div role="menu" aria-label={title} onKeyDown={onKeyDown} className="flex flex-col py-1">
      {items.map((it) => (
        <div key={it.id}>
          {it.separatorBefore && <div role="separator" className="my-1 h-px bg-border" />}
          <button
            type="button"
            role="menuitem"
            disabled={it.disabled}
            onClick={() => {
              onClose();
              it.onSelect();
            }}
            className={`flex min-h-11 w-full items-center gap-3 px-4 text-left text-sm focus:outline-none focus-visible:bg-panel-3 disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-9 sm:px-3 ${
              it.danger ? 'text-danger hover:bg-danger/10' : 'text-text hover:bg-panel-3'
            }`}
          >
            <span className="flex size-4 shrink-0 items-center justify-center text-muted" aria-hidden>
              {it.icon}
            </span>
            <span className="min-w-0 flex-1 truncate">{it.label}</span>
            {it.disabled && it.hint && <span className="shrink-0 text-[11px] text-subtle">{it.hint}</span>}
          </button>
        </div>
      ))}
    </div>
  );

  return createPortal(
    sheet ? (
      <div className="fixed inset-0 z-[95]">
        <div className="absolute inset-0 animate-fade-in bg-black/55" aria-hidden />
        <div
          ref={ref}
          className="absolute inset-x-0 bottom-0 max-h-[80dvh] animate-sheet-up overflow-y-auto rounded-t-2xl border border-border bg-panel pb-[env(safe-area-inset-bottom)] shadow-overlay"
        >
          <p className="truncate border-b border-border px-4 py-3 text-sm font-semibold text-text">{title}</p>
          {list}
          <div className="border-t border-border p-2">
            <button
              type="button"
              onClick={onClose}
              className="flex min-h-11 w-full items-center justify-center rounded-md text-sm font-medium text-muted hover:bg-panel-2 focus-visible:outline-2 focus-visible:outline-accent"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    ) : (
      <div
        ref={ref}
        className="fixed z-[95] w-64 animate-pop-in overflow-hidden rounded-lg border border-border bg-panel-2 shadow-pop"
        style={{ left: pos.left, top: pos.top }}
      >
        {list}
      </div>
    ),
    document.body,
  );
}
