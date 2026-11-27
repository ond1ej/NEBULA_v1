// NEBULA UI kit, part 1: the primitives every screen needs first (buttons, badges, avatars, loading and error states).
// Shared by the Dashboard shell and the Telegram Mini App; import from './ui', which re-exports both parts.
import {
  forwardRef,
  type AnchorHTMLAttributes,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react';
import { ApiError } from '../lib/http';
import type { AgentAvatar } from '../types';
import { AvatarGlyph } from './avatarGlyphs';
import { IconXCircle } from './icons';
import { TONE_BADGE, TONE_DOT, type Tone } from './tone';

export type { Tone };

// ---------------------------------------------------------------- Button
export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'outline';
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg';

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-accent text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.16),0_1px_2px_rgb(0_0_0/0.4)] hover:bg-accent-hover disabled:hover:bg-accent',
  secondary:
    'border border-border-strong bg-panel-2 text-text shadow-[0_1px_2px_rgb(0_0_0/0.3)] hover:border-border-hover hover:bg-panel-3 disabled:hover:bg-panel-2',
  outline: 'border border-border-strong text-text hover:border-border-hover hover:bg-panel-2',
  danger: 'border border-danger/35 bg-danger/10 text-danger hover:border-danger/60 hover:bg-danger/[0.16]',
  ghost: 'text-muted hover:bg-white/[0.05] hover:text-text',
};

const SIZES: Record<ButtonSize, string> = {
  xs: 'h-7 gap-1.5 rounded-md px-2 text-xs touch:h-10',
  sm: 'h-8 gap-1.5 rounded-lg px-2.5 text-[13px] touch:h-11 touch:px-3',
  md: 'h-9 gap-2 rounded-lg px-3.5 text-sm touch:h-11',
  lg: 'h-10 gap-2 rounded-lg px-4 text-sm touch:h-12',
};

export function buttonClass(variant: ButtonVariant = 'secondary', size: ButtonSize = 'md', extra = ''): string {
  return `relative inline-flex shrink-0 select-none items-center justify-center font-medium whitespace-nowrap transition-[background-color,border-color,color,box-shadow,transform] duration-150 focus-ring active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50 disabled:active:translate-y-0 [&>svg]:size-4 ${SIZES[size]} ${VARIANTS[variant]} ${extra}`;
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  /** Shown as tooltip + sr text when disabled, so disabled buttons always explain why. */
  disabledReason?: string | null;
  /** Leading icon (hidden from assistive tech; the label names the button). */
  icon?: ReactNode;
  iconRight?: ReactNode;
}

export const Button = /* @__PURE__ */ forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading = false, disabled, disabledReason, className = '', children, title, icon, iconRight, ...rest },
  ref,
) {
  const isDisabled = Boolean(disabled || loading || disabledReason);
  return (
    <button
      ref={ref}
      type="button"
      {...rest}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      title={disabledReason ?? title}
      className={buttonClass(variant, size, className)}
    >
      {loading ? <Spinner className="size-3.5" /> : icon}
      {children}
      {iconRight}
      {disabledReason && <span className="sr-only"> (unavailable: {disabledReason})</span>}
    </button>
  );
});

/** A link that looks like a button (navigation, downloads). */
export function ButtonLink({
  variant = 'secondary',
  size = 'md',
  icon,
  className = '',
  children,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & { variant?: ButtonVariant; size?: ButtonSize; icon?: ReactNode }) {
  return (
    <a {...rest} className={buttonClass(variant, size, className)}>
      {icon}
      {children}
    </a>
  );
}

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** Required: icon buttons have no visible text. */
  label: string;
  icon: ReactNode;
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  loading?: boolean;
  disabledReason?: string | null;
}

export const IconButton = /* @__PURE__ */ forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, variant = 'ghost', size = 'md', loading, disabled, disabledReason, className = '', title, ...rest },
  ref,
) {
  const dim = size === 'sm' ? 'size-8 touch:size-11' : 'size-9 touch:size-11';
  return (
    <button
      ref={ref}
      type="button"
      aria-label={disabledReason ? `${label} (unavailable: ${disabledReason})` : label}
      title={disabledReason ?? title ?? label}
      disabled={Boolean(disabled || loading || disabledReason)}
      {...rest}
      className={`${buttonClass(variant, 'md', '')} !px-0 ${dim} ${className}`}
    >
      {loading ? <Spinner className="size-4" /> : icon}
    </button>
  );
});

// ---------------------------------------------------------------- Spinner
export function Spinner({ className = 'size-4', label }: { className?: string; label?: string }) {
  return (
    <span role={label ? 'status' : undefined} className="inline-flex items-center gap-2">
      <svg className={`animate-spin text-muted ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden>
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.22" strokeWidth="2.5" />
        <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
      </svg>
      {label && <span className="text-sm text-muted">{label}</span>}
    </span>
  );
}

// ---------------------------------------------------------------- Badges & indicators
export function Badge({
  tone = 'neutral',
  children,
  icon,
  className = '',
  title,
  dot = false,
}: {
  tone?: Tone;
  children: ReactNode;
  icon?: ReactNode;
  className?: string;
  title?: string;
  dot?: boolean;
}) {
  return (
    <span
      title={title}
      className={`inline-flex h-[22px] max-w-full items-center gap-1 rounded-md px-1.5 text-[11.5px] leading-none font-medium whitespace-nowrap ring-1 ring-inset [&>svg]:size-3 ${TONE_BADGE[tone]} ${className}`}
    >
      {dot && <span aria-hidden className={`size-1.5 rounded-full ${TONE_DOT[tone]}`} />}
      {icon}
      <span className="truncate">{children}</span>
    </span>
  );
}

/** Coloured dot with an accessible label (never colour alone: the label is read out / shown as tooltip). */
export function StatusDot({ tone = 'neutral', label, pulse = false, className = '' }: { tone?: Tone; label: string; pulse?: boolean; className?: string }) {
  return (
    <span className={`relative inline-flex size-2 shrink-0 ${className}`} role="img" aria-label={label} title={label}>
      {pulse && <span aria-hidden className={`absolute inset-0 animate-ping rounded-full opacity-40 motion-reduce:hidden ${TONE_DOT[tone]}`} />}
      <span aria-hidden className={`relative inline-flex size-2 rounded-full ${TONE_DOT[tone]}`} />
    </span>
  );
}

const AVATAR_TINTS = [
  'bg-[#2a2550] text-[#c9c2ff]',
  'bg-[#1f3348] text-[#a9d1fb]',
  'bg-[#1f3a31] text-[#9fe3c4]',
  'bg-[#3d2e1c] text-[#f5cf95]',
  'bg-[#3b2233] text-[#f2b3d2]',
  'bg-[#2b2f37] text-[#cfd5de]',
];

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** The agent's chosen avatar (`config.avatar`: emoji, initials or one of the fixed icons), else initials of the name. */
export function Avatar({
  name,
  id,
  size = 'md',
  className = '',
  avatar,
}: {
  name: string;
  id?: string;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  className?: string;
  avatar?: AgentAvatar | null;
}) {
  const initials =
    name
      .split(/[\s._-]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase())
      .join('') || '?';
  const dim = size === 'xs' ? 'size-5 text-[9px] rounded-md' : size === 'sm' ? 'size-7 text-[11px] rounded-lg' : size === 'lg' ? 'size-11 text-[15px] rounded-xl' : 'size-9 text-[13px] rounded-lg';
  const emoji = size === 'xs' ? 'text-[12px]' : size === 'sm' ? 'text-[15px]' : size === 'lg' ? 'text-[24px]' : 'text-[19px]';
  const glyph = size === 'xs' ? 'size-3.5' : size === 'sm' ? 'size-4' : size === 'lg' ? 'size-6' : 'size-5';
  const value = avatar?.value?.trim();
  const content =
    avatar?.kind === 'emoji' && value ? (
      <span className={`leading-none ${emoji}`}>{value}</span>
    ) : avatar?.kind === 'initials' && value ? (
      [...value].slice(0, 2).join('').toUpperCase()
    ) : avatar?.kind === 'icon' && value ? (
      <AvatarGlyph id={value} fallback={initials} className={glyph} />
    ) : (
      initials
    );
  return (
    <span
      aria-hidden
      data-avatar={avatar?.kind && value ? avatar.kind : 'name'}
      className={`inline-grid shrink-0 place-items-center font-semibold ring-1 ring-white/[0.06] ring-inset ${dim} ${AVATAR_TINTS[hash(id ?? name) % AVATAR_TINTS.length]} ${className}`}
    >
      {content}
    </span>
  );
}

/** `config.avatar` of an agent, validated (null when it has none). */
export function agentAvatarOf(agent: { config?: unknown } | null | undefined): AgentAvatar | null {
  const raw = (agent?.config as { avatar?: unknown } | undefined)?.avatar as Partial<AgentAvatar> | null | undefined;
  if (!raw || typeof raw !== 'object' || typeof raw.value !== 'string' || !raw.value.trim()) return null;
  return raw.kind === 'emoji' || raw.kind === 'initials' || raw.kind === 'icon' ? { kind: raw.kind, value: raw.value.trim() } : null;
}

// ---------------------------------------------------------------- Loading states
export function Skeleton({ className = 'h-4 w-full' }: { className?: string }) {
  return <span aria-hidden className={`block animate-shimmer rounded-md bg-panel-3/80 ${className}`} />;
}

export function LoadingRows({ rows = 4, label = 'Loading…' }: { rows?: number; label?: string }) {
  return (
    <div className="space-y-3 py-1">
      <span className="sr-only" role="status">
        {label}
      </span>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="size-2 rounded-full" />
          <Skeleton className={`h-3 ${i % 2 ? 'w-3/5' : 'w-4/5'}`} />
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- States
export function EmptyState({
  title,
  children,
  action,
  icon,
  compact = false,
}: {
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div
      className={`flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border-strong/80 bg-white/[0.01] text-center ${
        compact ? 'px-4 py-6' : 'px-6 py-12'
      }`}
    >
      {icon && <span className="mb-1 grid size-10 place-items-center rounded-xl border border-border bg-panel-2 text-muted [&>svg]:size-5">{icon}</span>}
      <p className="text-sm font-medium text-text">{title}</p>
      {children && <div className="max-w-md text-sm text-muted">{children}</div>}
      {action && <div className="mt-2 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}

export function ErrorBanner({ error, onRetry, title }: { error: unknown; onRetry?: () => void; title?: string }) {
  if (!error) return null;
  const e = error instanceof ApiError ? error : null;
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <div role="alert" className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-danger/30 bg-danger/[0.07] px-4 py-3">
      <div className="flex min-w-0 gap-3">
        <IconXCircle className="mt-0.5 size-4 shrink-0 text-danger" />
        <div className="min-w-0">
          <p className="text-sm font-semibold text-danger">{title ?? 'Could not load data'}</p>
          <p className="mt-0.5 text-sm break-words text-text">{msg}</p>
          {e && (
            <p className="mt-1 font-mono text-2xs break-all text-subtle">
              {e.code}
              {e.status ? ` · HTTP ${e.status}` : ''}
              {e.requestId ? ` · request ${e.requestId}` : ''}
            </p>
          )}
        </div>
      </div>
      {onRetry && (
        <Button size="sm" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

export function Meter({
  value,
  label,
  tone = 'accent',
  size = 'md',
}: {
  value: number;
  label: string;
  tone?: 'accent' | 'warn' | 'danger' | 'success' | 'info';
  size?: 'sm' | 'md';
}) {
  const bar = tone === 'danger' ? 'bg-danger' : tone === 'warn' ? 'bg-warn' : tone === 'success' ? 'bg-success' : tone === 'info' ? 'bg-info' : 'bg-chart';
  const track = tone === 'danger' ? 'bg-danger/15' : tone === 'warn' ? 'bg-warn/15' : tone === 'success' ? 'bg-success/15' : tone === 'info' ? 'bg-info/15' : 'bg-accent/15';
  const v = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(v)}
      className={`w-full overflow-hidden rounded-full ${track} ${size === 'sm' ? 'h-1.5' : 'h-2'}`}
    >
      <div className={`h-full rounded-full transition-[width] duration-500 ${bar}`} style={{ width: `${v}%` }} />
    </div>
  );
}

/** Severity for a percentage used (meters, stat tiles). */
export function usageTone(pct: number | null | undefined, warn = 75, danger = 90): 'accent' | 'warn' | 'danger' {
  if (pct == null || !Number.isFinite(pct)) return 'accent';
  return pct >= danger ? 'danger' : pct >= warn ? 'warn' : 'accent';
}

export function Mono({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <span className={`font-mono text-[12px] text-muted ${className}`}>{children}</span>;
}
