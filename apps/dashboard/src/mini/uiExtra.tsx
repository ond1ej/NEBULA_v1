// Mini App primitives used only by lazy screens (kept out of the initial shell bundle).
import { useEffect, useState, type ReactNode } from 'react';
import { Btn, cx, Pill, Sheet, Skeleton, type Tone } from './uiKit';
import { isAdmin, useMini } from './context';
import { mhref } from './router';
import type { ExecEnv } from './types';

/**
 * Footnote of a read-only screen: for the owner (me.admin) a link to the administration page that edits it, for every
 * other session the "do it in the local Dashboard" note.
 */
export function OwnerNote({ to, link, children, className = '' }: { to: string; link: ReactNode; children: ReactNode; className?: string }) {
  const admin = isAdmin(useMini());
  return (
    <p className={cx('px-4 text-footnote text-subtle', className)}>
      {admin ? (
        <a className="text-accent-soft underline" href={mhref(to)}>
          {link}
        </a>
      ) : (
        children
      )}
    </p>
  );
}

/** Key / value rows inside a card (iOS "info" list). */
export function KV({ items, className = '' }: { items: [ReactNode, ReactNode][]; className?: string }) {
  return (
    <dl className={cx('-my-2', className)}>
      {items.map(([k, v], i) => (
        <div key={i} className="flex min-h-11 items-baseline justify-between gap-4 border-b border-border py-2.5 last:border-b-0">
          <dt className="shrink-0 text-subhead text-muted">{k}</dt>
          <dd className="min-w-0 text-right text-subhead text-text [overflow-wrap:anywhere]">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Notice({ tone = 'info', title, children, className = '' }: { tone?: Tone; title?: ReactNode; children?: ReactNode; className?: string }) {
  const ring: Record<Tone, string> = {
    info: 'bg-info/10',
    accent: 'bg-accent/10',
    success: 'bg-success/10',
    warning: 'bg-warn/10',
    danger: 'bg-danger/10',
    neutral: 'bg-panel',
  };
  const text: Record<Tone, string> = {
    info: 'text-info',
    accent: 'text-accent-soft',
    success: 'text-success',
    warning: 'text-warn',
    danger: 'text-danger',
    neutral: 'text-text',
  };
  return (
    <div role="note" className={cx('rounded-card px-4 py-3', ring[tone], className)}>
      {title && <p className={cx('text-subhead font-semibold', text[tone])}>{title}</p>}
      {children && <div className={cx('text-subhead text-muted', title ? 'mt-0.5' : '')}>{children}</div>}
    </div>
  );
}

export function Tile({ label, value, hint, tone, href }: { label: ReactNode; value: ReactNode; hint?: ReactNode; tone?: 'danger' | 'warn' | 'success' | Tone; href?: string }) {
  const toneText = tone === 'danger' ? 'text-danger' : tone === 'warn' || tone === 'warning' ? 'text-warn' : tone === 'success' ? 'text-success' : 'text-text';
  const body = (
    <>
      <span className="block truncate text-caption font-medium text-muted">{label}</span>
      <span className={cx('mt-1 block truncate text-title font-semibold tabular-nums', toneText)}>{value}</span>
      {hint && <span className="mt-0.5 block truncate text-caption text-subtle">{hint}</span>}
    </>
  );
  const cls = 'block min-h-11 min-w-0 rounded-card bg-panel px-4 py-3';
  return href ? (
    <a href={href} className={cx(cls, 'nb-row focus-ring')}>
      {body}
    </a>
  ) : (
    <div className={cls}>{body}</div>
  );
}

export function Meter({ value, label, tone = 'accent' }: { value: number; label: string; tone?: Tone }) {
  const v = Math.max(0, Math.min(100, value));
  const fill: Record<Tone, string> = { accent: 'bg-accent', success: 'bg-success', warning: 'bg-warn', danger: 'bg-danger', neutral: 'bg-subtle', info: 'bg-info' };
  return (
    <div role="meter" aria-label={label} aria-valuenow={Math.round(v)} aria-valuemin={0} aria-valuemax={100} className="h-1.5 w-full overflow-hidden rounded-full bg-text/8">
      <div className={cx('h-full rounded-full transition-[width]', fill[tone])} style={{ width: `${v}%` }} />
    </div>
  );
}

export const usageTone = (pct: number): Tone => (pct >= 90 ? 'danger' : pct >= 75 ? 'warning' : 'accent');

/** Segmented route tabs (scroll horizontally inside themselves; never widen the page). */
export function ScreenTabs<T extends string>({ tabs, active, hrefFor, label }: { tabs: { id: T; label: string; badge?: ReactNode }[]; active: T; hrefFor: (id: T) => string; label: string }) {
  return (
    <nav aria-label={label} className="-mx-4 mb-4 overflow-x-auto px-4 scrollbar-none">
      <div className="flex w-max min-w-full gap-1.5">
        {tabs.map((t) => {
          const on = t.id === active;
          return (
            <a
              key={t.id}
              href={hrefFor(t.id)}
              aria-current={on ? 'page' : undefined}
              className={cx(
                'nb-press inline-flex min-h-11 items-center gap-1.5 rounded-full px-4 text-subhead font-medium whitespace-nowrap focus-ring',
                on ? 'bg-text text-bg' : 'bg-panel text-muted',
              )}
            >
              {t.label}
              {t.badge}
            </a>
          );
        })}
      </div>
    </nav>
  );
}

/** Segmented control for local filters. */
export function Segmented<T extends string>({ options, value, onChange, label }: { options: { id: T; label: string; badge?: number }[]; value: T; onChange: (v: T) => void; label: string }) {
  return (
    <div role="tablist" aria-label={label} className="flex gap-1 overflow-x-auto rounded-xl bg-text/8 p-1 scrollbar-none">
      {options.map((o) => {
        const on = o.id === value;
        return (
          <button
            key={o.id}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onChange(o.id)}
            className={cx(
              'nb-press flex min-h-9 flex-1 items-center justify-center gap-1 rounded-lg px-3 text-footnote font-semibold whitespace-nowrap focus-ring',
              on ? 'bg-panel text-text shadow-card' : 'text-muted',
            )}
          >
            {o.label}
            {o.badge ? <span className="rounded-full bg-danger px-1.5 text-[11px] text-white">{o.badge}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

export function EnvBadge({ env }: { env: ExecEnv | string | null | undefined }) {
  // amber: host execution works on the owner's real Mac (authorised folders), not in the isolated VM
  if (env === 'host') return <Pill tone="warning">Mac mini</Pill>;
  if (env === 'vm') return <Pill tone="accent">Ubuntu VM</Pill>;
  return <Pill tone="neutral">Environment ?</Pill>;
}

export const envLabel = (env: string | null | undefined) => (env === 'host' ? 'Mac mini (host)' : env === 'vm' ? 'Ubuntu VM' : 'unknown');

/** Image from an authenticated endpoint (Bearer tokens cannot ride on <img src>). */
export function AuthImage({ load, alt, className = '', onOpen }: { load: () => Promise<Blob>; alt: string; className?: string; onOpen?: (url: string) => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const loadRef = useState(() => load)[0];
  useEffect(() => {
    let alive = true;
    let u: string | null = null;
    loadRef()
      .then((b) => {
        if (!alive) return;
        u = URL.createObjectURL(b);
        setUrl(u);
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
      if (u) URL.revokeObjectURL(u);
    };
  }, [loadRef]);
  if (failed) return <div className={cx('grid place-items-center rounded-xl bg-panel-2 text-caption text-muted', className)}>Image unavailable</div>;
  if (!url) return <Skeleton className={cx('rounded-xl', className)} />;
  const img = <img src={url} alt={alt} className={cx('rounded-xl object-cover', className)} />;
  return onOpen ? (
    <button type="button" onClick={() => onOpen(url)} className="block rounded-xl focus-ring" aria-label={`Open ${alt}`}>
      {img}
    </button>
  ) : (
    img
  );
}

/** Confirmation as a bottom sheet (destructive or decisive actions). */
export function ConfirmSheet({
  open,
  title,
  children,
  confirmLabel,
  onConfirm,
  onCancel,
  busy = false,
  tone = 'primary',
}: {
  open: boolean;
  title: ReactNode;
  children?: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
  tone?: 'primary' | 'danger';
}) {
  return (
    <Sheet
      open={open}
      title={title}
      onClose={onCancel}
      dismissible={!busy}
      footer={
        <>
          <Btn className="flex-1" onClick={onCancel} disabled={busy}>
            Cancel
          </Btn>
          <Btn className="flex-1" variant={tone === 'danger' ? 'danger' : 'primary'} loading={busy} onClick={onConfirm}>
            {confirmLabel}
          </Btn>
        </>
      }
    >
      <div className="text-subhead text-muted">{children}</div>
    </Sheet>
  );
}
