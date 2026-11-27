// NEBULA UI kit, part 2: layout, forms, tabs, tables (pages only; loaded with the screens that use them).
// Import from './ui', which re-exports both parts.
import {
  forwardRef,
  useId,
  useRef,
  type AnchorHTMLAttributes,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { useIsMobile } from '../hooks/useMediaQuery';
import { IconAlert, IconCheckCircle, IconChevronRight, IconInfo, IconXCircle } from './icons';
import { TONE_PANEL, TONE_TEXT, type Tone } from './tone';
import { Skeleton } from './uiBase';

// ---------------------------------------------------------------- Surfaces
export function Card({
  title,
  actions,
  children,
  className = '',
  bodyClassName = '',
  subtitle,
  icon,
  footer,
  padded = true,
  id,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  bodyClassName?: string;
  icon?: ReactNode;
  footer?: ReactNode;
  /** false: body without padding (lists / tables that run edge to edge). */
  padded?: boolean;
  id?: string;
}) {
  return (
    <section id={id} className={`min-w-0 rounded-xl border border-border bg-panel shadow-card ${className}`}>
      {(title || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2 border-b border-border px-4 py-3 sm:px-5">
          <div className="flex min-w-0 items-start gap-2.5">
            {icon && <span className="mt-px text-subtle [&>svg]:size-4">{icon}</span>}
            <div className="min-w-0">
              {title && <h2 className="text-[13.5px] leading-5 font-semibold text-text">{title}</h2>}
              {subtitle && <p className="mt-0.5 text-xs leading-5 text-muted">{subtitle}</p>}
            </div>
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={`${padded ? 'px-4 py-4 sm:px-5' : ''} ${bodyClassName}`}>{children}</div>
      {footer && <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-4 py-3 sm:px-5">{footer}</footer>}
    </section>
  );
}

export interface Crumb {
  label: ReactNode;
  href?: string;
}

export function PageHeader({
  title,
  description,
  actions,
  breadcrumbs,
  meta,
  icon,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  breadcrumbs?: Crumb[];
  /** Small chips under the title (state, ids, …). */
  meta?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-col gap-4 sm:mb-7 md:flex-row md:items-end md:justify-between">
      <div className="min-w-0">
        {breadcrumbs && breadcrumbs.length > 0 && (
          <nav aria-label="Breadcrumb" className="mb-2">
            <ol className="flex flex-wrap items-center gap-1 text-xs text-subtle">
              {breadcrumbs.map((c, i) => (
                <li key={i} className="flex min-w-0 items-center gap-1">
                  {c.href ? (
                    <a href={c.href} className="truncate rounded hover:text-text focus-ring">
                      {c.label}
                    </a>
                  ) : (
                    <span className="truncate text-muted" aria-current="page">
                      {c.label}
                    </span>
                  )}
                  {i < breadcrumbs.length - 1 && <IconChevronRight className="size-3 shrink-0 text-subtle/70" />}
                </li>
              ))}
            </ol>
          </nav>
        )}
        <div className="flex min-w-0 items-center gap-3">
          {icon}
          <h1 className="min-w-0 text-[22px] leading-tight font-semibold tracking-[-0.015em] text-text sm:text-2xl">{title}</h1>
        </div>
        {meta && <div className="mt-2 flex flex-wrap items-center gap-2">{meta}</div>}
        {description && <p className="mt-1.5 max-w-3xl text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2 md:shrink-0 md:justify-end">{actions}</div>}
    </div>
  );
}

export function SectionHeader({ title, description, actions, as: H = 'h2' }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; as?: 'h2' | 'h3' }) {
  return (
    <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
      <div className="min-w-0">
        <H className="text-sm font-semibold text-text">{title}</H>
        {description && <p className="mt-0.5 text-xs text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Divider({ className = '' }: { className?: string }) {
  return <hr className={`border-0 border-t border-border ${className}`} />;
}

// ---------------------------------------------------------------- Form controls
const CONTROL =
  'w-full min-w-0 rounded-lg border border-border-strong bg-input px-3 text-sm text-text shadow-[inset_0_1px_1px_rgb(0_0_0/0.25)] transition-[border-color,box-shadow] placeholder:text-subtle hover:border-border-hover focus:border-accent focus:outline-none focus-visible:ring-[3px] focus-visible:ring-accent/25 disabled:cursor-not-allowed disabled:opacity-55 aria-[invalid=true]:border-danger/70';

export function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
  required,
  aside,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
  htmlFor: string;
  required?: boolean;
  /** Right-aligned content next to the label (e.g. a counter or helper link). */
  aside?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={htmlFor} className="text-[13px] font-medium text-text">
          {label}
          {required && (
            <span className="ml-0.5 text-danger" aria-hidden>
              *
            </span>
          )}
        </label>
        {aside && <span className="text-xs text-subtle">{aside}</span>}
      </div>
      {children}
      {hint && !error && (
        <p className="text-xs leading-5 text-muted" id={`${htmlFor}-hint`}>
          {hint}
        </p>
      )}
      {error && (
        <p className="text-xs leading-5 text-danger" id={`${htmlFor}-error`} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export const Input = /* @__PURE__ */ forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className = '', ...rest }, ref) {
  return <input ref={ref} {...rest} className={`${CONTROL} h-9 touch:h-11 ${className}`} />;
});

export const Select = /* @__PURE__ */ forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className = '', children, ...rest },
  ref,
) {
  return (
    <select ref={ref} {...rest} className={`nb-select ${CONTROL} h-9 cursor-pointer touch:h-11 ${className}`}>
      {children}
    </select>
  );
});

export const Textarea = /* @__PURE__ */ forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
  { className = '', ...rest },
  ref,
) {
  return <textarea ref={ref} {...rest} className={`${CONTROL} py-2 leading-relaxed ${className}`} />;
});

export function Checkbox({
  label,
  checked,
  onChange,
  description,
  disabled,
}: {
  label: ReactNode;
  checked: boolean;
  onChange: (v: boolean) => void;
  description?: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-start gap-3">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 size-4 shrink-0 cursor-pointer rounded border-border-strong accent-accent focus-ring disabled:cursor-not-allowed touch:size-5"
      />
      <label htmlFor={id} className={`text-sm text-text ${disabled ? 'opacity-60' : 'cursor-pointer'}`}>
        {label}
        {description && <span className="mt-0.5 block text-xs leading-5 text-muted">{description}</span>}
      </label>
    </div>
  );
}

/** On/off toggle (role="switch"). Use for settings that apply immediately. */
export function Switch({
  checked,
  onChange,
  label,
  description,
  disabled,
  loading,
  id: idProp,
  hideLabel = false,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  loading?: boolean;
  id?: string;
  /** Visually hide the label (it is still the accessible name). */
  hideLabel?: boolean;
}) {
  const gen = useId();
  const id = idProp ?? gen;
  const descId = `${id}-desc`;
  return (
    <div className="flex items-start gap-3">
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-describedby={description ? descId : undefined}
        aria-labelledby={`${id}-label`}
        disabled={disabled || loading}
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border transition-colors duration-150 focus-ring disabled:cursor-not-allowed disabled:opacity-50 touch:my-2.5 ${
          checked ? 'border-accent bg-accent' : 'border-border-strong bg-panel-3'
        }`}
      >
        <span
          aria-hidden
          className={`inline-block size-3.5 rounded-full bg-white shadow transition-transform duration-150 ${checked ? 'translate-x-[18px]' : 'translate-x-[3px]'} ${
            loading ? 'opacity-60' : ''
          }`}
        />
      </button>
      <div className={hideLabel ? 'sr-only' : 'min-w-0'}>
        <label id={`${id}-label`} htmlFor={id} className={`text-sm text-text ${disabled ? 'opacity-60' : 'cursor-pointer'}`}>
          {label}
        </label>
        {description && (
          <p id={descId} className="mt-0.5 text-xs leading-5 text-muted">
            {description}
          </p>
        )}
      </div>
    </div>
  );
}

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
  title?: string;
}

/** Single choice from a few options (role="radiogroup", arrow keys move the selection). */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
  size = 'md',
  className = '',
  disabled,
}: {
  options: SegmentOption<T>[];
  value: T;
  onChange: (v: T) => void;
  label: string;
  size?: 'sm' | 'md';
  className?: string;
  disabled?: boolean;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const enabled = options.filter((o) => !o.disabled);
  const onKey = (e: KeyboardEvent) => {
    const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!dir || enabled.length === 0) return;
    e.preventDefault();
    const i = enabled.findIndex((o) => o.value === value);
    const next = enabled[(i + dir + enabled.length) % enabled.length];
    onChange(next.value);
    refs.current[options.indexOf(next)]?.focus();
  };
  return (
    <div
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKey}
      className={`inline-flex max-w-full items-center gap-0.5 overflow-x-auto rounded-lg border border-border bg-input p-0.5 scrollbar-none ${className}`}
    >
      {options.map((o, i) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            disabled={disabled || o.disabled}
            title={o.title}
            onClick={() => onChange(o.value)}
            className={`inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-colors focus-ring disabled:cursor-not-allowed disabled:opacity-45 [&>svg]:size-3.5 ${
              size === 'sm' ? 'h-7 px-2.5 text-xs touch:h-10' : 'h-8 px-3 text-[13px] touch:h-10'
            } ${active ? 'bg-panel-3 text-text shadow-[0_1px_2px_rgb(0_0_0/0.4),inset_0_0_0_1px_rgb(255_255_255/0.06)]' : 'text-muted hover:text-text'}`}
          >
            {o.icon}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-border-strong bg-panel-2 px-1 py-px font-mono text-[10.5px] text-muted">{children}</kbd>;
}

export function SkeletonText({ lines = 3, className = '' }: { lines?: number; className?: string }) {
  return (
    <span aria-hidden className={`block space-y-2 ${className}`}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={`h-3 ${i === lines - 1 ? 'w-2/3' : 'w-full'}`} />
      ))}
    </span>
  );
}

/** Placeholder grid while a list loads; announces itself once for screen readers. */
export function LoadingCards({ count = 3, label = 'Loading…', className = 'grid gap-4 md:grid-cols-2 xl:grid-cols-3' }: { count?: number; label?: string; className?: string }) {
  return (
    <div className={className}>
      <span className="sr-only" role="status">
        {label}
      </span>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="rounded-xl border border-border bg-panel p-5">
          <div className="flex items-center gap-3">
            <Skeleton className="size-9 rounded-lg" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-3.5 w-1/2" />
              <Skeleton className="h-3 w-1/3" />
            </div>
          </div>
          <SkeletonText lines={3} className="mt-5" />
        </div>
      ))}
    </div>
  );
}

const NOTICE_ICON: Record<string, ReactNode> = {
  info: <IconInfo className="mt-0.5 size-4 shrink-0 text-info" />,
  warn: <IconAlert className="mt-0.5 size-4 shrink-0 text-warn" />,
  danger: <IconXCircle className="mt-0.5 size-4 shrink-0 text-danger" />,
  success: <IconCheckCircle className="mt-0.5 size-4 shrink-0 text-success" />,
};

export function Notice({
  tone = 'info',
  title,
  children,
  action,
}: {
  tone?: 'info' | 'warn' | 'danger' | 'success';
  title?: ReactNode;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className={`flex gap-3 rounded-xl border px-4 py-3 text-sm ${TONE_PANEL[tone === 'danger' ? 'danger' : tone === 'warn' ? 'warn' : tone === 'success' ? 'success' : 'info']}`}>
      {NOTICE_ICON[tone]}
      <div className="min-w-0 flex-1">
        {title && <p className="mb-0.5 font-semibold text-text">{title}</p>}
        <div className="leading-relaxed text-muted [&_strong]:text-text">{children}</div>
        {action && <div className="mt-2.5 flex flex-wrap gap-2">{action}</div>}
      </div>
    </div>
  );
}

export function KeyValue({ items, className = '' }: { items: [ReactNode, ReactNode][]; className?: string }) {
  return (
    <dl className={`grid grid-cols-[minmax(92px,max-content)_minmax(0,1fr)] gap-x-5 gap-y-2.5 text-sm ${className}`}>
      {items.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className="min-w-0 break-words text-text">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Stat({
  label,
  value,
  hint,
  icon,
  tone,
  href,
  onClick,
  chart,
  className = '',
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  tone?: Tone;
  href?: string;
  onClick?: () => void;
  chart?: ReactNode;
  className?: string;
}) {
  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs font-medium text-muted">{label}</span>
        {icon && <span className={`[&>svg]:size-4 ${tone ? TONE_TEXT[tone] : 'text-subtle'}`}>{icon}</span>}
      </div>
      <div className="mt-2 flex items-end justify-between gap-3">
        <div className="min-w-0 text-[22px] leading-none font-semibold tracking-tight text-text tabular-nums">{value}</div>
        {chart}
      </div>
      {hint && <div className="mt-2 truncate text-xs text-muted">{hint}</div>}
    </>
  );
  const cls = `block min-w-0 rounded-xl border border-border bg-panel px-4 py-3.5 text-left shadow-card ${className}`;
  if (href)
    return (
      <a href={href} className={`${cls} transition-colors hover:border-border-strong hover:bg-panel-2 focus-ring`}>
        {body}
      </a>
    );
  if (onClick)
    return (
      <button type="button" onClick={onClick} className={`${cls} w-full transition-colors hover:border-border-strong hover:bg-panel-2 focus-ring`}>
        {body}
      </button>
    );
  return <div className={cls}>{body}</div>;
}

// ---------------------------------------------------------------- Tabs
export interface TabItem<T extends string> {
  id: T;
  label: string;
  icon?: ReactNode;
  badge?: ReactNode;
}

/** Route tabs (links, aria-current). */
export function Tabs<T extends string>({
  tabs,
  active,
  hrefFor,
  label,
}: {
  tabs: TabItem<T>[];
  active: T;
  hrefFor: (id: T) => string;
  label: string;
}) {
  return (
    <nav aria-label={label} className="-mx-4 mb-6 overflow-x-auto border-b border-border px-4 scrollbar-none sm:mx-0 sm:px-0">
      <div className="flex w-max min-w-full gap-1">
        {tabs.map((t) => {
          const on = t.id === active;
          return (
            <a
              key={t.id}
              href={hrefFor(t.id)}
              aria-current={on ? 'page' : undefined}
              className={`relative -mb-px inline-flex h-10 items-center gap-2 rounded-t-md border-b-2 px-3 text-[13px] font-medium whitespace-nowrap transition-colors focus-ring touch:h-11 [&>svg]:size-4 ${
                on ? 'border-accent-soft text-text' : 'border-transparent text-muted hover:text-text'
              }`}
            >
              {t.icon}
              {t.label}
              {t.badge}
            </a>
          );
        })}
      </div>
    </nav>
  );
}

/** In-page tabs (role="tablist"); the caller renders the panel for `active`. */
export function TabBar<T extends string>({
  tabs,
  active,
  onChange,
  label,
  idPrefix,
}: {
  tabs: TabItem<T>[];
  active: T;
  onChange: (id: T) => void;
  label: string;
  idPrefix?: string;
}) {
  const gen = useId();
  const pre = idPrefix ?? gen;
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent) => {
    const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    const i = tabs.findIndex((t) => t.id === active);
    const n = (i + dir + tabs.length) % tabs.length;
    onChange(tabs[n].id);
    refs.current[n]?.focus();
  };
  return (
    <div className="-mx-4 mb-5 overflow-x-auto border-b border-border px-4 scrollbar-none sm:mx-0 sm:px-0">
      <div role="tablist" aria-label={label} onKeyDown={onKey} className="flex w-max min-w-full gap-1">
        {tabs.map((t, i) => {
          const on = t.id === active;
          return (
            <button
              key={t.id}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`${pre}-tab-${t.id}`}
              aria-selected={on}
              aria-controls={`${pre}-panel-${t.id}`}
              tabIndex={on ? 0 : -1}
              onClick={() => onChange(t.id)}
              className={`relative -mb-px inline-flex h-10 items-center gap-2 rounded-t-md border-b-2 px-3 text-[13px] font-medium whitespace-nowrap transition-colors focus-ring touch:h-11 [&>svg]:size-4 ${
                on ? 'border-accent-soft text-text' : 'border-transparent text-muted hover:text-text'
              }`}
            >
              {t.icon}
              {t.label}
              {t.badge}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function TabPanel({ id, idPrefix, children }: { id: string; idPrefix: string; children: ReactNode }) {
  return (
    <div role="tabpanel" id={`${idPrefix}-panel-${id}`} aria-labelledby={`${idPrefix}-tab-${id}`}>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------- Data table (cards on phones)
export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  className?: string;
  headerClassName?: string;
  align?: 'left' | 'right';
  /**
   * Phone layout: 'title' = card heading, 'subtitle' = under the heading, 'meta' (default) = label/value
   * row, 'aside' = top-right of the card, 'hidden' = not shown on phones.
   */
  mobile?: 'title' | 'subtitle' | 'meta' | 'aside' | 'hidden';
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  selectedKey,
  label,
  rowLabel,
  minWidth = 640,
  dense = false,
  className = '',
  stickyHeader = false,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  selectedKey?: string | null;
  label: string;
  /** Accessible name of the row's open control (when onRowClick is set). */
  rowLabel?: (row: T) => string;
  minWidth?: number;
  dense?: boolean;
  className?: string;
  stickyHeader?: boolean;
}) {
  const mobile = useIsMobile();
  if (mobile) {
    const title = columns.filter((c) => c.mobile === 'title');
    const subtitle = columns.filter((c) => c.mobile === 'subtitle');
    const aside = columns.filter((c) => c.mobile === 'aside');
    const meta = columns.filter((c) => !c.mobile || c.mobile === 'meta');
    return (
      <ul aria-label={label} className={`space-y-2 ${className}`}>
        {rows.map((r) => {
          const k = rowKey(r);
          const content = (
            <>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1 space-y-1">
                  {title.map((c) => (
                    <div key={c.key} className="min-w-0 text-sm font-medium text-text">
                      {c.cell(r)}
                    </div>
                  ))}
                  {subtitle.map((c) => (
                    <div key={c.key} className="min-w-0 text-xs text-muted">
                      {c.cell(r)}
                    </div>
                  ))}
                </div>
                {aside.length > 0 && <div className="flex shrink-0 flex-col items-end gap-1">{aside.map((c) => <div key={c.key}>{c.cell(r)}</div>)}</div>}
              </div>
              {meta.length > 0 && (
                <dl className="mt-2.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">
                  {meta.map((c) => (
                    <div key={c.key} className="contents">
                      <dt className="text-subtle">{c.header}</dt>
                      <dd className="min-w-0 break-words text-text">{c.cell(r)}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </>
          );
          return (
            <li key={k}>
              {onRowClick ? (
                <div
                  role="button"
                  tabIndex={0}
                  aria-label={rowLabel?.(r)}
                  onClick={() => onRowClick(r)}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return;
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onRowClick(r);
                    }
                  }}
                  className={`block w-full cursor-pointer rounded-xl border bg-panel px-4 py-3 text-left transition-colors focus-ring active:bg-panel-2 ${
                    selectedKey === k ? 'border-accent/50 bg-accent/[0.06]' : 'border-border'
                  }`}
                >
                  {content}
                </div>
              ) : (
                <div className="rounded-xl border border-border bg-panel px-4 py-3">{content}</div>
              )}
            </li>
          );
        })}
      </ul>
    );
  }
  const pad = dense ? 'px-3 py-2' : 'px-4 py-3';
  return (
    <div className={`relative overflow-x-auto rounded-xl border border-border bg-panel shadow-card ${className}`}>
      <table className="w-full text-left text-sm" style={{ minWidth }} aria-label={label}>
        <thead className={`text-2xs font-medium tracking-wide text-subtle uppercase ${stickyHeader ? 'sticky top-0 z-10 bg-panel' : ''}`}>
          <tr className="border-b border-border">
            {columns.map((c) => (
              <th key={c.key} scope="col" className={`${pad} font-medium ${c.align === 'right' ? 'text-right' : ''} ${c.headerClassName ?? ''}`}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const k = rowKey(r);
            const sel = selectedKey === k;
            return (
              <tr
                key={k}
                onClick={onRowClick ? () => onRowClick(r) : undefined}
                tabIndex={onRowClick ? 0 : undefined}
                aria-label={onRowClick ? rowLabel?.(r) : undefined}
                aria-current={sel ? 'true' : undefined}
                onKeyDown={
                  onRowClick
                    ? (e) => {
                        if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
                          e.preventDefault();
                          onRowClick(r);
                        }
                      }
                    : undefined
                }
                className={`border-b border-border/60 transition-colors last:border-0 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-soft ${onRowClick ? 'cursor-pointer hover:bg-white/[0.025]' : ''} ${
                  sel ? 'bg-accent/[0.07] shadow-[inset_2px_0_0_var(--color-accent-soft)]' : ''
                }`}
              >
                {columns.map((c) => (
                  <td key={c.key} className={`${pad} align-top ${c.align === 'right' ? 'text-right' : ''} ${c.className ?? ''}`}>
                    {c.cell(r)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Inline text link with the product's link style. */
export function TextLink({ className = '', children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a {...rest} className={`rounded text-accent-soft underline-offset-2 hover:underline focus-ring ${className}`}>
      {children}
    </a>
  );
}
