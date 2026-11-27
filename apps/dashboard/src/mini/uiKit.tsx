// Mini App primitives for lazy screens: screen chrome (glass top bar, large titles), grouped lists, cards, pills,
// query states and bottom sheets. Re-exports the core primitives (ui.tsx), so screens import from here only.
import { useEffect, useId, useRef, useState, type AnchorHTMLAttributes, type CSSProperties, type FocusEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { errorMessage, isApiError } from '../lib/http';
import { useMini } from './context';
import { IcBack, IcChevron, IcX } from './icons';
import { goBack, isTabRoot, parentPath, useMiniRoute } from './router';
import { liveViewportHeight } from './telegram';
import { cx, ErrorState, IconBtn, SkeletonList, type Tone } from './ui';

export * from './ui';

const TONE_PILL: Record<Tone, string> = {
  accent: 'bg-accent/15 text-accent-soft',
  success: 'bg-success/15 text-success',
  warning: 'bg-warn/15 text-warn',
  danger: 'bg-danger/15 text-danger',
  neutral: 'bg-text/8 text-muted',
  info: 'bg-info/15 text-info',
};

export function IconLink({ label, icon, className = '', ...rest }: { label: string; icon: ReactNode } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a aria-label={label} title={label} className={cx('nb-press grid size-11 shrink-0 place-items-center rounded-full text-accent-soft focus-ring [&>svg]:size-[22px]', className)} {...rest}>
      {icon}
    </a>
  );
}

// ---------------------------------------------------------------- screen chrome
/**
 * Screen with an iOS-style glass top bar. `large`: tab roots show a large title under the bar that collapses into the
 * bar while scrolling. The in-app back arrow is shown only outside Telegram (inside, Telegram's BackButton is used).
 */
export function Screen({
  title,
  subtitle,
  actions,
  leading,
  children,
  back,
  large = false,
  wide = false,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  leading?: ReactNode;
  children: ReactNode;
  back?: boolean;
  large?: boolean;
  wide?: boolean;
}) {
  const { inTelegram } = useMini();
  const route = useMiniRoute();
  const showBack = (back ?? !isTabRoot(route)) && !inTelegram;
  const sentinel = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState(!large);
  useEffect(() => {
    if (!large) return;
    const el = sentinel.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([e]) => setCollapsed(!e.isIntersecting), { rootMargin: '-56px 0px 0px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [large]);
  return (
    <div className={cx('mx-auto w-full', wide ? 'max-w-5xl' : 'max-w-2xl')}>
      <header
        className={cx(
          'mini-topbar mini-glass sticky top-0 z-30 -mx-4 px-2',
          collapsed && 'nb-hairline',
        )}
      >
        <div className="flex min-h-13 items-center gap-1">
          {showBack ? <IconBtn label="Back" icon={<IcBack />} onClick={() => goBack(parentPath(route))} /> : leading ?? <span className="w-2" />}
          <div className={cx('min-w-0 flex-1 px-1', large && !collapsed && 'opacity-0')} aria-hidden={large && !collapsed ? true : undefined}>
            {large ? (
              <p className="truncate text-headline font-semibold text-text">{title}</p>
            ) : (
              <h1 className="truncate text-headline font-semibold text-text">{title}</h1>
            )}
            {subtitle && !large && <div className="truncate text-caption text-muted">{subtitle}</div>}
          </div>
          {actions && <div className="flex shrink-0 items-center">{actions}</div>}
        </div>
      </header>
      {large && (
        <div className="px-1 pt-1 pb-3">
          <h1 className="text-large font-semibold tracking-tight text-text">{title}</h1>
          {subtitle && <div className="mt-0.5 text-subhead text-muted">{subtitle}</div>}
          <div ref={sentinel} aria-hidden className="h-px" />
        </div>
      )}
      {!large && <div className="h-2" />}
      {children}
    </div>
  );
}

export function Section({ title, action, footer, children, className = '' }: { title?: ReactNode; action?: ReactNode; footer?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx('mb-6', className)}>
      {(title || action) && (
        <div className="mb-1.5 flex min-h-7 items-end justify-between gap-2 px-4">
          {title && <h2 className="text-footnote font-medium tracking-wide text-subtle uppercase">{title}</h2>}
          {action}
        </div>
      )}
      {children}
      {footer && <p className="mt-1.5 px-4 text-footnote text-subtle">{footer}</p>}
    </section>
  );
}

/** Grouped list (inset group, hairline separators aligned with the text). */
export function List({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <ul className={cx('overflow-hidden rounded-card bg-panel', className)}>{children}</ul>;
}

export function Row({
  href,
  onClick,
  onPointerDown,
  leading,
  title,
  subtitle,
  value,
  trailing,
  chevron,
  destructive = false,
  disabled = false,
  className = '',
  label,
}: {
  href?: string;
  onClick?: () => void;
  onPointerDown?: () => void;
  leading?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  /** Short value on the right (iOS settings style). */
  value?: ReactNode;
  trailing?: ReactNode;
  chevron?: boolean;
  destructive?: boolean;
  disabled?: boolean;
  className?: string;
  /** Accessible name when the visible content is not enough. */
  label?: string;
}) {
  const interactive = Boolean((href || onClick) && !disabled);
  const inner = (
    <>
      {leading && <span className="shrink-0 py-2.5">{leading}</span>}
      <span className="flex min-w-0 flex-1 items-center gap-2 self-stretch border-b border-border py-2.5 group-last/row:border-b-0">
        <span className="min-w-0 flex-1">
          <span className={cx('block truncate text-body', destructive ? 'text-danger' : 'text-text', disabled && 'opacity-50')}>{title}</span>
          {subtitle && <span className="mt-0.5 block text-footnote text-muted [overflow-wrap:anywhere]">{subtitle}</span>}
        </span>
        {value !== undefined && value !== null && <span className="shrink-0 truncate text-body text-muted max-w-[45%]">{value}</span>}
        {trailing && <span className="flex shrink-0 items-center gap-1.5">{trailing}</span>}
        {(chevron ?? interactive) && <IcChevron aria-hidden className="size-4 shrink-0 text-subtle" />}
      </span>
    </>
  );
  const cls = cx('flex min-h-12 w-full items-center gap-3 pl-4 pr-3 text-left', className);
  return (
    <li className="group/row">
      {href && !disabled ? (
        <a href={href} aria-label={label} onPointerDown={onPointerDown} className={cx(cls, 'nb-row focus-ring')}>
          {inner}
        </a>
      ) : onClick && !disabled ? (
        <button type="button" onClick={onClick} onPointerDown={onPointerDown} aria-label={label} className={cx(cls, 'nb-row focus-ring')}>
          {inner}
        </button>
      ) : (
        <div className={cls} aria-disabled={disabled || undefined} aria-label={label}>
          {inner}
        </div>
      )}
    </li>
  );
}

/** 30 px rounded glyph tile for settings rows. */
export function Glyph({ children, tone = 'accent' }: { children: ReactNode; tone?: Tone }) {
  const bg: Record<Tone, string> = {
    accent: 'bg-accent-fill',
    success: 'bg-success',
    warning: 'bg-warn',
    danger: 'bg-danger',
    neutral: 'bg-subtle',
    info: 'bg-info',
  };
  return <span className={cx('grid size-[30px] place-items-center rounded-lg text-white [&>svg]:size-[18px]', bg[tone])}>{children}</span>;
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={cx('rounded-card bg-panel p-4', className)}>{children}</div>;
}

export function Clamp({ children, lines = 2, className = '' }: { children: ReactNode; lines?: 1 | 2 | 3 | 4; className?: string }) {
  const c = lines === 1 ? 'line-clamp-1' : lines === 2 ? 'line-clamp-2' : lines === 3 ? 'line-clamp-3' : 'line-clamp-4';
  return <span className={cx(c, '[overflow-wrap:anywhere]', className)}>{children}</span>;
}

export function Pill({ tone = 'neutral', children, className = '' }: { tone?: Tone; children: ReactNode; className?: string }) {
  return <span className={cx('inline-flex h-6 items-center gap-1 rounded-full px-2.5 text-caption font-medium whitespace-nowrap', TONE_PILL[tone], className)}>{children}</span>;
}

/** Standard loading / error / empty handling for a query; stale data stays visible with a quiet note. */
export function QueryView<T>({
  q,
  children,
  empty,
  isEmpty,
  rows = 4,
}: {
  q: { data: T | null; error: unknown; loading: boolean; reload: () => void };
  children: (data: T) => ReactNode;
  empty?: ReactNode;
  isEmpty?: (data: T) => boolean;
  rows?: number;
}) {
  if (q.data === null) {
    if (q.error) return <ErrorState error={q.error} onRetry={q.reload} />;
    return <SkeletonList rows={rows} />;
  }
  return (
    <>
      {q.error ? (
        <p role="status" className="mb-2 rounded-xl bg-warn/10 px-3 py-2 text-footnote text-warn">
          Showing the last loaded data — {isApiError(q.error) && q.error.status === 0 ? 'offline' : errorMessage(q.error)}
        </p>
      ) : null}
      {isEmpty?.(q.data) && empty ? empty : children(q.data)}
    </>
  );
}

// ---------------------------------------------------------------- bottom sheet
let sheetLocks = 0;

/**
 * Keeps a sheet inside the *visible* viewport: with the iOS keyboard open (visualViewport) or Telegram's
 * viewportChanged, the sheet sits right above the keyboard and a focused field scrolls into view.
 */
function useViewportBox(enabled: boolean): { top: number; height: number } | null {
  const [box, setBox] = useState<{ top: number; height: number } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const vv = window.visualViewport ?? null;
    const apply = () => {
      const h = liveViewportHeight();
      if (!h) return;
      const top = vv ? Math.max(0, vv.offsetTop) : 0;
      setBox((b) => (b && b.top === top && b.height === h ? b : { top, height: h }));
    };
    apply();
    vv?.addEventListener('resize', apply);
    vv?.addEventListener('scroll', apply);
    window.addEventListener('resize', apply);
    const wa = window.Telegram?.WebApp;
    try {
      wa?.onEvent?.('viewportChanged', apply);
    } catch {
      // not in Telegram
    }
    return () => {
      vv?.removeEventListener('resize', apply);
      vv?.removeEventListener('scroll', apply);
      window.removeEventListener('resize', apply);
      try {
        wa?.offEvent?.('viewportChanged', apply);
      } catch {
        // ignore
      }
    };
  }, [enabled]);
  return enabled ? box : null;
}

/**
 * Bottom sheet / action sheet: scrim, slide-up panel above the home indicator, Escape and scrim tap close it,
 * focus moves in and returns to the opener; Tab stays inside.
 */
export function Sheet({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  dismissible = true,
  keyboardAware = false,
  full = false,
  testId = 'sheet',
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  dismissible?: boolean;
  /** Forms: follow the visual viewport so the on-screen keyboard never covers the sheet. */
  keyboardAware?: boolean;
  /** Full-screen sheet (long forms): the whole visible viewport, its footer (action bar) right above the keyboard. */
  full?: boolean;
  testId?: string;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const box = useViewportBox(open && keyboardAware);
  const titleId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const dismissRef = useRef(dismissible);
  dismissRef.current = dismissible;
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (scrollTimer.current) clearTimeout(scrollTimer.current);
    },
    [],
  );
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    if (sheetLocks === 0) document.body.style.overflow = 'hidden';
    sheetLocks += 1;
    const t = setTimeout(() => {
      const el = panel.current;
      if (el && !el.contains(document.activeElement)) (el.querySelector<HTMLElement>('[data-autofocus]') ?? el).focus();
    }, 0);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && dismissRef.current) {
        e.stopPropagation();
        closeRef.current();
      } else if (e.key === 'Tab' && panel.current) {
        const f = [...panel.current.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])')];
        if (!f.length) return;
        const first = f[0];
        const last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(t);
      document.removeEventListener('keydown', onKey);
      sheetLocks = Math.max(0, sheetLocks - 1);
      if (sheetLocks === 0) document.body.style.overflow = '';
      if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
    };
  }, [open]);
  if (!open) return null;
  const frame: CSSProperties | undefined = box ? { top: box.top, height: box.height, bottom: 'auto' } : undefined;
  const panelStyle: CSSProperties | undefined = box && !full ? { maxHeight: Math.max(240, Math.round(box.height - 12)) } : undefined;
  const onFocusIn = keyboardAware
    ? (e: FocusEvent<HTMLDivElement>) => {
        const t = e.target as HTMLElement;
        if (!(t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement)) return;
        // after the keyboard animation: keep the focused field visible inside the sheet (cleared when the sheet goes)
        if (scrollTimer.current) clearTimeout(scrollTimer.current);
        scrollTimer.current = setTimeout(() => {
          scrollTimer.current = null;
          if (document.activeElement === t && typeof t.scrollIntoView === 'function') t.scrollIntoView({ block: 'nearest' });
        }, 300);
      }
    : undefined;
  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-end justify-center" style={frame} data-testid={testId}>
      <div aria-hidden className="absolute inset-0 animate-fade bg-scrim" onClick={() => dismissRef.current && closeRef.current()} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        style={panelStyle}
        onFocus={onFocusIn}
        className={cx(
          'mini-sheet mini-safe-x relative flex w-full animate-sheet-in flex-col shadow-overlay outline-none',
          full ? 'mini-topbar h-full max-w-2xl bg-bg' : 'max-h-[86dvh] max-w-xl rounded-t-sheet bg-panel',
        )}
      >
        {!full && <span aria-hidden className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-text/15" />}
        <header className="flex items-start gap-2 pt-2 pb-2">
          <div className="min-w-0 flex-1 pt-1.5">
            <h2 id={titleId} className="text-headline font-semibold text-text">
              {title}
            </h2>
            {description && <p className="mt-0.5 text-subhead text-muted">{description}</p>}
          </div>
          {dismissible && <IconBtn label="Close" tone="muted" icon={<IcX />} onClick={() => closeRef.current()} className="-mr-2" />}
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-2">{children}</div>
        {footer && <footer className={cx('flex gap-2 pt-2', full && 'nb-hairline-t -mx-4 px-4')}>{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

/** One row of an action sheet. */
export function SheetAction({
  icon,
  label,
  note,
  onClick,
  destructive = false,
  disabled = false,
  href,
}: {
  icon?: ReactNode;
  label: string;
  note?: string;
  onClick?: () => void;
  destructive?: boolean;
  disabled?: boolean;
  href?: string;
}) {
  const cls = cx(
    'nb-row flex min-h-12 w-full items-center gap-3 rounded-xl px-3 text-left focus-ring [&>svg]:size-[22px] [&>svg]:shrink-0',
    destructive ? 'text-danger' : 'text-text',
    disabled && 'cursor-not-allowed opacity-45',
  );
  const body = (
    <>
      {icon}
      <span className="min-w-0 flex-1 py-2">
        <span className="block text-body">{label}</span>
        {note && <span className="block text-footnote text-muted">{note}</span>}
      </span>
    </>
  );
  if (href && !disabled)
    return (
      <a href={href} className={cls} onClick={onClick}>
        {body}
      </a>
    );
  return (
    <button type="button" className={cls} onClick={disabled ? undefined : onClick} aria-disabled={disabled || undefined} disabled={disabled}>
      {body}
    </button>
  );
}

