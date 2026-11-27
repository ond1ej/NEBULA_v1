// NEBULA Mini App design system: small, mobile-first primitives on the tokens of mini.css.
// Every tap target is >= 44 x 44 px, pressed / disabled / focus states are explicit, motion is 150–250 ms and
// honours prefers-reduced-motion (theme.css). This module ships with the initial shell (Chats); screen chrome, lists
// and sheets live in uiKit.tsx and the rest in uiExtra.tsx (lazy screens only).
import { Component, forwardRef, Suspense, useId, type ButtonHTMLAttributes, type ErrorInfo, type ReactNode } from 'react';
import { errorMessage, isApiError } from '../lib/http';
import { lazyNamed } from '../lib/lazy';
import type { AgentAvatar } from '../types';
import { IcRetry, IcSearch, IcX } from './icons';

// The 16 avatar icons are their own small chunk: the shell only draws them once an agent uses one.
const AvatarGlyph = lazyNamed(() => import('../components/avatarGlyphs'), 'AvatarGlyph');

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

// ---------------------------------------------------------------- tones
export type Tone = 'accent' | 'success' | 'warning' | 'danger' | 'neutral' | 'info';

export const TONE_DOT: Record<Tone, string> = {
  accent: 'bg-accent',
  success: 'bg-success',
  warning: 'bg-warn',
  danger: 'bg-danger',
  neutral: 'bg-subtle',
  info: 'bg-info',
};

/** Agent state → dot tone + human label ("Working", "Sleeping", …). */
export function agentStatus(state: string | null | undefined): { tone: Tone; label: string; busy: boolean } {
  switch ((state ?? '').toUpperCase()) {
    case 'ACTIVE':
    case 'EXECUTING':
    case 'RUNNING':
      return { tone: 'accent', label: 'Working', busy: true };
    case 'READY':
      return { tone: 'success', label: 'Ready', busy: false };
    case 'IDLE':
      return { tone: 'success', label: 'Idle', busy: false };
    case 'SLEEP':
      return { tone: 'neutral', label: 'Sleeping', busy: false };
    case 'STOPPED':
      return { tone: 'neutral', label: 'Stopped', busy: false };
    case 'PAUSED':
      return { tone: 'warning', label: 'Paused', busy: false };
    case 'ERROR':
      return { tone: 'danger', label: 'Error', busy: false };
    case 'CREATING':
      return { tone: 'info', label: 'Starting', busy: true };
    case 'DELETING':
      return { tone: 'warning', label: 'Deleting', busy: false };
    default: {
      const s = (state ?? 'unknown').toLowerCase().replace(/_/g, ' ');
      return { tone: 'neutral', label: s.charAt(0).toUpperCase() + s.slice(1), busy: false };
    }
  }
}

export function Wordmark({ className = '' }: { className?: string }) {
  return (
    <span className={cx('nb-wordmark inline-flex items-center gap-2 font-semibold text-text', className)}>
      <span aria-hidden className="nb-wordmark-dot size-2.5 rounded-full bg-accent" />
      NEBULA
    </span>
  );
}

// ---------------------------------------------------------------- buttons
export type BtnVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'tinted';
type BtnSize = 'sm' | 'md' | 'lg';

const BTN_VARIANT: Record<BtnVariant, string> = {
  primary: 'bg-accent-fill text-on-accent hover:bg-accent-fill-hover',
  secondary: 'bg-panel-2 text-text',
  tinted: 'bg-accent/15 text-accent-soft',
  ghost: 'text-accent-soft',
  danger: 'bg-danger/15 text-danger',
};
const BTN_SIZE: Record<BtnSize, string> = {
  sm: 'min-h-9 px-3 text-footnote rounded-lg gap-1.5 [&_svg]:size-4',
  md: 'min-h-11 px-4 text-body rounded-xl gap-2 [&_svg]:size-[18px]',
  lg: 'min-h-12 px-5 text-headline rounded-2xl gap-2 [&_svg]:size-5',
};

export function btnClass(variant: BtnVariant = 'secondary', size: BtnSize = 'md', extra = ''): string {
  return cx(
    'nb-press inline-flex select-none items-center justify-center font-semibold whitespace-nowrap focus-ring',
    'disabled:cursor-not-allowed disabled:opacity-45 aria-disabled:cursor-not-allowed aria-disabled:opacity-45',
    BTN_VARIANT[variant],
    BTN_SIZE[size],
    extra,
  );
}

export interface BtnProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: BtnVariant;
  size?: BtnSize;
  icon?: ReactNode;
  loading?: boolean;
  /** Disables the button and says why (title + screen reader text). */
  disabledReason?: string | null;
}

export const Btn = forwardRef<HTMLButtonElement, BtnProps>(function Btn(
  { variant = 'secondary', size = 'md', icon, loading = false, disabledReason, className = '', children, disabled, type = 'button', ...rest },
  ref,
) {
  const descId = useId();
  const off = Boolean(disabled || loading || disabledReason);
  return (
    <button
      ref={ref}
      type={type}
      disabled={off}
      aria-busy={loading || undefined}
      title={disabledReason ?? rest.title}
      aria-describedby={disabledReason ? descId : rest['aria-describedby']}
      className={btnClass(variant, size, className)}
      {...rest}
    >
      {loading ? <Spinner className="size-4" /> : icon}
      {children}
      {disabledReason && (
        <span id={descId} className="sr-only">
          {disabledReason}
        </span>
      )}
    </button>
  );
});

/** Backwards-compatible name used by the screens. */
export const TapButton = Btn;

export function tapLinkClass(variant: 'primary' | 'secondary' | 'ghost' | 'outline' | 'tinted' = 'secondary', extra = ''): string {
  return btnClass(variant === 'outline' ? 'secondary' : variant, 'md', extra);
}

/** Round 44 px icon button (top bars, composer). */
export function IconBtn({
  label,
  icon,
  className = '',
  tone = 'accent',
  ...rest
}: { label: string; icon: ReactNode; tone?: 'accent' | 'fg' | 'muted' } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cx(
        'nb-press grid size-11 shrink-0 place-items-center rounded-full focus-ring disabled:opacity-40 [&>svg]:size-[22px]',
        tone === 'accent' ? 'text-accent-soft' : tone === 'fg' ? 'text-text' : 'text-muted',
        className,
      )}
      {...rest}
    >
      {icon}
    </button>
  );
}

export function StatusDot({ tone = 'neutral', pulse = false, className = '' }: { tone?: Tone; pulse?: boolean; className?: string }) {
  return <span aria-hidden className={cx('inline-block size-2 shrink-0 rounded-full', TONE_DOT[tone], pulse && 'nb-pulse', className)} />;
}

// ---------------------------------------------------------------- avatar
const AVATAR_HUES = ['#8b7cf6', '#5aa9e6', '#36c991', '#f4b860', '#f07178', '#c792ea', '#4fc1c9', '#e5a06b'];

export function hueFor(id: string): string {
  let h = 2166136261;
  for (let i = 0; i < id.length; i += 1) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return AVATAR_HUES[(h >>> 0) % AVATAR_HUES.length];
}

export function initials(name: string): string {
  const parts = name.trim().split(/[\s_\-.]+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = [...parts[0]][0] ?? '';
  const second = parts.length > 1 ? ([...parts[parts.length - 1]][0] ?? '') : ([...parts[0]][1] ?? '');
  return (first + second).toUpperCase();
}

const AVATAR_SIZE = { xs: 'size-7 text-[11px]', sm: 'size-9 text-[13px]', md: 'size-12 text-base', lg: 'size-16 text-[22px]' } as const;
const AVATAR_EMOJI = { xs: 'text-[15px]', sm: 'text-[19px]', md: 'text-[26px]', lg: 'text-[34px]' } as const;
const AVATAR_GLYPH = { xs: 'size-4', sm: 'size-5', md: 'size-6', lg: 'size-8' } as const;

/** The agent's chosen avatar (`config.avatar`), validated; null when it has none. */
export function agentAvatar(agent: { config?: unknown } | null | undefined): AgentAvatar | null {
  const raw = (agent?.config as { avatar?: unknown } | undefined)?.avatar as Partial<AgentAvatar> | null | undefined;
  if (!raw || typeof raw !== 'object' || typeof raw.value !== 'string' || !raw.value.trim()) return null;
  return raw.kind === 'emoji' || raw.kind === 'initials' || raw.kind === 'icon' ? { kind: raw.kind, value: raw.value.trim() } : null;
}

/**
 * The agent's avatar on a stable tint derived from the id (same colour everywhere for one agent): its emoji, initials
 * or icon when it has one (`avatar`), else initials from the name.
 */
export function Avatar({
  name,
  id,
  size = 'md',
  badge,
  className = '',
  avatar,
}: {
  name: string;
  id?: string;
  size?: keyof typeof AVATAR_SIZE;
  badge?: ReactNode;
  className?: string;
  avatar?: AgentAvatar | null;
}) {
  const hue = hueFor(id ?? name);
  const fallback = initials(name);
  let kind: string = 'name';
  let content: ReactNode = fallback;
  if (avatar?.kind === 'emoji' && avatar.value) {
    kind = 'emoji';
    content = <span className={cx('leading-none', AVATAR_EMOJI[size])}>{avatar.value}</span>;
  } else if (avatar?.kind === 'initials' && avatar.value) {
    kind = 'initials';
    content = [...avatar.value].slice(0, 2).join('').toUpperCase();
  } else if (avatar?.kind === 'icon' && avatar.value) {
    kind = 'icon';
    content = (
      <Suspense fallback={fallback}>
        <AvatarGlyph id={avatar.value} fallback={fallback} className={AVATAR_GLYPH[size]} strokeWidth={1.8} />
      </Suspense>
    );
  }
  return (
    <span className={cx('relative inline-grid shrink-0', className)}>
      <span
        aria-hidden
        data-avatar={kind}
        className={cx('grid place-items-center rounded-full font-semibold select-none', AVATAR_SIZE[size])}
        style={{
          backgroundColor: `color-mix(in oklab, ${hue} 24%, var(--color-panel-2))`,
          color: `color-mix(in oklab, ${hue} 78%, var(--color-text))`,
        }}
      >
        {content}
      </span>
      {badge && <span className="nb-ring-bg absolute -right-0.5 -bottom-0.5 rounded-full">{badge}</span>}
    </span>
  );
}

// ---------------------------------------------------------------- loading / empty / error
export function Spinner({ className = 'size-5', label }: { className?: string; label?: string }) {
  return (
    <span role={label ? 'status' : undefined} className="inline-flex items-center gap-2 text-muted">
      <svg viewBox="0 0 24 24" aria-hidden className={cx('animate-spin', className)} fill="none">
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2.5" />
        <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
      </svg>
      {label && <span className="text-subhead">{label}</span>}
    </span>
  );
}

export function Skeleton({ className = 'h-4 w-full' }: { className?: string }) {
  return <span aria-hidden className={cx('nb-skel block', /\brounded/.test(className) ? '' : 'rounded-md', className)} />;
}

export function SkeletonList({ rows = 4, label = 'Loading…', avatar = true }: { rows?: number; label?: string; avatar?: boolean }) {
  return (
    <div className="overflow-hidden rounded-card bg-panel">
      <span className="sr-only" role="status">
        {label}
      </span>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex min-h-16 items-center gap-3 px-4 py-3">
          {avatar && <Skeleton className="size-11 shrink-0 rounded-full" />}
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3.5 w-2/5" />
            <Skeleton className="h-3 w-4/5" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function Empty({ title, children, icon, action }: { title: ReactNode; children?: ReactNode; icon?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-12 text-center">
      {icon && <span className="mb-3 grid size-14 place-items-center rounded-full bg-panel-2 text-muted [&>svg]:size-7">{icon}</span>}
      <p className="text-headline font-semibold text-text">{title}</p>
      {children && <p className="mt-1.5 max-w-xs text-subhead text-muted">{children}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry, title }: { error: unknown; onRetry?: () => void; title?: string }) {
  const offline = isApiError(error) && error.status === 0;
  const forbidden = isApiError(error) && (error.code === 'not_available_remotely' || error.code === 'forbidden' || error.status === 403);
  return (
    <div role="alert" className="rounded-card bg-panel px-5 py-6 text-center">
      <p className="text-headline font-semibold text-text">{title ?? (offline ? 'You are offline' : forbidden ? 'Not available in the Mini App' : 'Could not load')}</p>
      <p className="mx-auto mt-1 max-w-sm text-subhead break-words text-muted">
        {offline ? 'NEBULA cannot be reached right now. Check your connection.' : forbidden ? 'Use the NEBULA Dashboard on your Mac for this.' : errorMessage(error)}
      </p>
      {isApiError(error) && error.requestId && !offline && <p className="mt-1 font-mono text-caption break-all text-subtle">request {error.requestId}</p>}
      {onRetry && (
        <Btn className="mt-4" variant="tinted" icon={<IcRetry />} onClick={onRetry}>
          Try again
        </Btn>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- search
export function SearchField({
  value,
  onChange,
  placeholder = 'Search',
  label,
  autoFocus,
  onCancel,
  id,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  label: string;
  autoFocus?: boolean;
  onCancel?: () => void;
  id?: string;
}) {
  const auto = useId();
  const fid = id ?? auto;
  return (
    <div className="flex items-center gap-2" role="search">
      <label htmlFor={fid} className="nb-field flex min-h-10 flex-1 items-center gap-2 rounded-xl bg-text/8 px-3 text-muted">
        <IcSearch className="size-[18px] shrink-0" />
        <span className="sr-only">{label}</span>
        <input
          id={fid}
          type="search"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          autoFocus={autoFocus}
          autoComplete="off"
          autoCorrect="off"
          enterKeyHint="search"
          className="nb-search min-w-0 flex-1 bg-transparent py-2 text-body text-text outline-none placeholder:text-subtle"
        />
        {value && (
          <button type="button" aria-label="Clear search" onClick={() => onChange('')} className="-mr-1 grid size-8 place-items-center rounded-full text-subtle focus-ring">
            <IcX className="size-4" />
          </button>
        )}
      </label>
      {onCancel && (
        <button type="button" onClick={onCancel} className="min-h-11 px-1 text-body text-accent-soft focus-ring">
          Cancel
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- code-split screens
/** Is this a failed dynamic import (offline, or the host was updated and the old chunk is gone)? */
function isChunkError(e: unknown): boolean {
  const msg = e instanceof Error ? `${e.name} ${e.message}` : String(e);
  return /dynamically imported module|Importing a module script failed|error loading dynamically|Failed to fetch|ChunkLoadError/i.test(msg);
}

class Boundary extends Component<{ children: ReactNode; resetKey?: string }, { error: unknown; key?: string }> {
  state: { error: unknown; key?: string } = { error: null, key: this.props.resetKey };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  static getDerivedStateFromProps(props: { resetKey?: string }, state: { error: unknown; key?: string }) {
    return props.resetKey !== state.key ? { error: null, key: props.resetKey } : null;
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('NEBULA Mini App: screen failed', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    const chunk = isChunkError(this.state.error);
    return (
      <div className="mini-topbar mx-auto mt-12 max-w-md px-2">
        <ErrorState
          error={this.state.error}
          title={chunk ? 'This screen could not be loaded' : 'Something went wrong'}
          onRetry={() => (chunk ? window.location.reload() : this.setState({ error: null }))}
        />
      </div>
    );
  }
}

/** Suspense + error boundary for lazy screens: a skeleton while the chunk loads, a recoverable error otherwise. */
export function ScreenBoundary({ children, resetKey, fallback }: { children: ReactNode; resetKey?: string; fallback: ReactNode }) {
  return (
    <Boundary resetKey={resetKey}>
      <Suspense fallback={fallback}>{children}</Suspense>
    </Boundary>
  );
}
