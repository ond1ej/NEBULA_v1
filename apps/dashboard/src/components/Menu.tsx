// Dropdown and context menus (role="menu"): arrow keys, Home/End, Enter/Space, Escape returns focus.
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { IconMore } from './icons';
import { Button, IconButton, type ButtonSize, type ButtonVariant } from './ui';

export interface MenuItem {
  label: ReactNode;
  onSelect: () => void;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  /** Tooltip explaining why an item is disabled. */
  disabledReason?: string;
  hint?: ReactNode;
  separatorBefore?: boolean;
}

interface Point {
  x: number;
  y: number;
}

function MenuSurface({
  items,
  anchor,
  align = 'end',
  onClose,
  label,
  id,
  restoreFocus,
}: {
  items: MenuItem[];
  anchor: DOMRect | Point;
  align?: 'start' | 'end';
  onClose: () => void;
  label: string;
  id?: string;
  restoreFocus?: HTMLElement | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const enabled = items.map((it, i) => (it.disabled ? -1 : i)).filter((i) => i >= 0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left: number;
    let top: number;
    if ('width' in anchor) {
      left = align === 'end' ? anchor.right - w : anchor.left;
      top = anchor.bottom + 6;
      if (top + h > vh - 8) top = Math.max(8, anchor.top - h - 6);
    } else {
      left = anchor.x;
      top = anchor.y;
      if (top + h > vh - 8) top = Math.max(8, vh - h - 8);
    }
    left = Math.min(Math.max(8, left), vw - w - 8);
    setPos({ left, top });
  }, [anchor, align]);

  useEffect(() => {
    const first = enabled[0];
    if (first !== undefined) itemRefs.current[first]?.focus();
    const onDown = (e: Event) => {
      const t = e.target as Node;
      if (ref.current && !ref.current.contains(t) && !restoreFocus?.contains(t)) onClose();
    };
    const onScroll = () => onClose();
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('touchstart', onDown, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('touchstart', onDown, true);
      window.removeEventListener('resize', onScroll);
      restoreFocus?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const move = (dir: 1 | -1 | 'first' | 'last') => {
    if (enabled.length === 0) return;
    const cur = itemRefs.current.findIndex((b) => b === document.activeElement);
    const pos = enabled.indexOf(cur);
    let next: number;
    if (dir === 'first') next = enabled[0];
    else if (dir === 'last') next = enabled[enabled.length - 1];
    else next = enabled[(pos + dir + enabled.length) % enabled.length];
    itemRefs.current[next]?.focus();
  };

  return createPortal(
    <div
      ref={ref}
      id={id}
      role="menu"
      aria-label={label}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          move(1);
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          move(-1);
        } else if (e.key === 'Home') {
          e.preventDefault();
          move('first');
        } else if (e.key === 'End') {
          e.preventDefault();
          move('last');
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        } else if (e.key === 'Tab') {
          onClose();
        }
      }}
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999 }}
      className="fixed z-[120] min-w-[200px] max-w-[calc(100vw-16px)] animate-pop-in rounded-xl border border-border-strong bg-elevated p-1 shadow-pop focus:outline-none"
    >
      {items.map((it, i) => (
        <div key={i}>
          {it.separatorBefore && <div role="separator" className="my-1 h-px bg-border" />}
          <button
            ref={(el) => {
              itemRefs.current[i] = el;
            }}
            type="button"
            role="menuitem"
            disabled={it.disabled}
            aria-disabled={it.disabled || undefined}
            title={it.disabled ? it.disabledReason : undefined}
            tabIndex={-1}
            onClick={() => {
              onClose();
              it.onSelect();
            }}
            className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] transition-colors focus:outline-none disabled:cursor-not-allowed disabled:opacity-45 touch:py-3 [&>svg]:size-4 ${
              it.danger ? 'text-danger hover:bg-danger/10 focus:bg-danger/10' : 'text-text hover:bg-white/[0.06] focus:bg-white/[0.06]'
            }`}
          >
            {it.icon ?? <span className="size-4" aria-hidden />}
            <span className="min-w-0 flex-1 truncate">{it.label}</span>
            {it.hint && <span className="text-2xs text-subtle">{it.hint}</span>}
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}

/** A trigger button + menu. Defaults to a "More actions" kebab icon button. */
export function DropdownMenu({
  items,
  label = 'More actions',
  buttonLabel,
  icon,
  variant,
  size = 'sm',
  align = 'end',
  disabled,
}: {
  items: MenuItem[];
  /** Accessible name of the trigger and the menu. */
  label?: string;
  /** Visible text: renders a normal button instead of an icon button. */
  buttonLabel?: ReactNode;
  icon?: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  align?: 'start' | 'end';
  disabled?: boolean;
}) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const open = anchor !== null;
  const toggle = () => {
    if (open) setAnchor(null);
    else if (btn.current) setAnchor(btn.current.getBoundingClientRect());
  };
  const common = {
    ref: btn,
    'aria-haspopup': 'menu' as const,
    'aria-expanded': open,
    'aria-controls': open ? menuId : undefined,
    onClick: (e: MouseEvent) => {
      e.stopPropagation();
      toggle();
    },
    onKeyDown: (e: ReactKeyboardEvent) => {
      if (e.key === 'ArrowDown' && !open && btn.current) {
        e.preventDefault();
        setAnchor(btn.current.getBoundingClientRect());
      }
    },
    disabled,
  };
  return (
    <>
      {buttonLabel ? (
        <Button {...common} variant={variant ?? 'secondary'} size={size} icon={icon}>
          {buttonLabel}
        </Button>
      ) : (
        <IconButton {...common} label={label} icon={icon ?? <IconMore className="size-4" />} variant={variant ?? 'ghost'} size={size === 'md' || size === 'lg' ? 'md' : 'sm'} />
      )}
      {open && <MenuSurface id={menuId} items={items} anchor={anchor} align={align} label={label} onClose={() => setAnchor(null)} restoreFocus={btn.current} />}
    </>
  );
}

/** Right-click menu for an area (the same actions must also be reachable through a visible control). */
export function useContextMenu(label: string) {
  const [state, setState] = useState<{ point: Point; items: MenuItem[] } | null>(null);
  const open = useCallback((e: MouseEvent, items: MenuItem[]) => {
    e.preventDefault();
    setState({ point: { x: e.clientX, y: e.clientY }, items });
  }, []);
  const element = state ? <MenuSurface items={state.items} anchor={state.point} label={label} onClose={() => setState(null)} /> : null;
  return { open, element };
}
