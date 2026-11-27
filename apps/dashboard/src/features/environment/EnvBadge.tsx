// Shared execution-environment badge ("Mac mini · native" vs "Ubuntu VM") with an inheritance-chain tooltip,
// plus the chain visualisation used by the agent Environment tab and the project environment panel.
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { IconArrowRight, IconHost, IconPackage } from '../../components/icons';
import type { EnvChainStep, EnvId } from './types';

/** Short, honest labels: host = native macOS execution on the Mac mini, vm = the shared Ubuntu VM. */
export const ENV_SHORT: Record<EnvId, string> = { host: 'Mac mini · native', vm: 'Ubuntu VM' };
export const ENV_LONG: Record<EnvId, string> = { host: 'Mac mini — Native Execution', vm: 'Ubuntu VM — Isolated Execution' };

export const LEVEL_LABEL: Record<string, string> = {
  agent: 'Agent setting',
  company: 'Company default',
  project: 'Project',
  member: 'Employee override',
  assignment: 'Project assignment',
};

/** Order of the company inheritance chain (least → most specific). */
export const COMPANY_LEVELS = ['company', 'project', 'member', 'assignment'] as const;

export function isEnv(v: unknown): v is EnvId {
  return v === 'vm' || v === 'host';
}

export function envLabel(env: string | null | undefined): string {
  return isEnv(env) ? ENV_SHORT[env] : 'Not decided yet';
}

export function levelLabel(level: string | null | undefined): string {
  if (!level) return 'unknown';
  return LEVEL_LABEL[level] ?? level.replace(/_/g, ' ');
}

/** One sentence that says where an environment comes from (also used as screen-reader text). */
export function describeEnv(env: string | null | undefined, source?: string | null, chain?: EnvChainStep[] | null): string {
  if (!isEnv(env)) return 'Execution environment not decided yet';
  const parts = [`Runs on ${ENV_LONG[env]}`];
  if (source) parts.push(`decided by ${levelLabel(source).toLowerCase()}`);
  if (chain && chain.length > 1) parts.push(`chain: ${chain.map((c) => `${levelLabel(c.level)} ${envLabel(c.env)}`).join(' → ')}`);
  return parts.join('; ');
}

const STYLE: Record<EnvId, string> = {
  host: 'bg-accent/15 text-accent-soft ring-accent/35',
  vm: 'bg-[#11262d] text-[#8fd3e8] ring-[#8fd3e8]/25',
};

export function EnvIcon({ env, className = 'size-3.5' }: { env: EnvId; className?: string }) {
  return env === 'host' ? <IconHost className={className} /> : <IconPackage className={className} />;
}

/** Fixed-position tooltip rendered in a portal (never clipped by scroll containers, clamped to the viewport). */
function Tip({ anchor, id, children }: { anchor: HTMLElement; id: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = anchor.getBoundingClientRect();
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth || 1024;
    const vh = window.innerHeight || 768;
    const left = Math.max(8, Math.min(r.left, vw - w - 8));
    let top = r.bottom + 6;
    if (top + h > vh - 8) top = Math.max(8, r.top - h - 6);
    setPos({ left, top });
  }, [anchor]);
  return createPortal(
    <div
      ref={ref}
      id={id}
      role="tooltip"
      style={{ position: 'fixed', left: pos?.left ?? -9999, top: pos?.top ?? -9999 }}
      className="pointer-events-none z-[140] w-max max-w-[min(320px,calc(100vw-16px))] animate-fade-in rounded-lg border border-border-strong bg-elevated px-3 py-2.5 text-xs text-text shadow-pop"
    >
      {children}
    </div>,
    document.body,
  );
}

export interface EnvBadgeProps {
  env: string | null | undefined;
  /** Level that decided the environment (agent, company, project, member, assignment). */
  source?: string | null;
  chain?: EnvChainStep[] | null;
  /** Host folder shown in the tooltip (name or path). */
  rootLabel?: string | null;
  /** Also print the source next to the label ("Ubuntu VM · project"). */
  showSource?: boolean;
  size?: 'sm' | 'md';
  /** false inside clickable cards/buttons: no tab stop (tooltip still opens on hover). */
  interactive?: boolean;
  className?: string;
}

export function EnvBadge({ env, source, chain, rootLabel, showSource = false, size = 'sm', interactive = true, className = '' }: EnvBadgeProps) {
  const anchor = useRef<HTMLSpanElement>(null);
  const tipId = useId();
  const [open, setOpen] = useState(false);
  const known = isEnv(env);
  const hasDetails = known && Boolean(source || (chain && chain.length) || rootLabel);
  const show = () => {
    if (hasDetails) setOpen(true);
  };
  const hide = () => setOpen(false);
  const dim = size === 'md' ? 'h-7 gap-1.5 px-2.5 text-[12.5px] [&>svg]:size-4' : 'h-[22px] gap-1 px-1.5 text-[11.5px] [&>svg]:size-3.5';
  const winner = chain && chain.length ? chain.length - 1 : -1;
  return (
    <>
      <span
        ref={anchor}
        tabIndex={interactive && hasDetails ? 0 : undefined}
        aria-describedby={open ? tipId : undefined}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onKeyDown={(e) => {
          if (e.key === 'Escape') hide();
        }}
        data-env={known ? env : 'unknown'}
        className={`inline-flex max-w-full shrink-0 items-center rounded-md leading-none font-medium whitespace-nowrap ring-1 ring-inset focus-ring ${dim} ${
          known ? STYLE[env] : 'bg-white/[0.04] text-subtle ring-white/10'
        } ${className}`}
      >
        {known && <EnvIcon env={env} />}
        <span className="truncate">{known ? ENV_SHORT[env] : 'Not decided yet'}</span>
        {showSource && source && known && <span className="truncate opacity-70">· {levelLabel(source).toLowerCase()}</span>}
        {hasDetails && <span className="sr-only">. {describeEnv(env, source, chain)}</span>}
      </span>
      {open && anchor.current && (
        <Tip anchor={anchor.current} id={tipId}>
          <p className="font-semibold">{known ? ENV_LONG[env] : ''}</p>
          {source && <p className="mt-0.5 text-muted">Decided by: {levelLabel(source)}</p>}
          {chain && chain.length > 0 && (
            <ol className="mt-2 space-y-1">
              {chain.map((c, i) => (
                <li key={`${c.level}-${i}`} className={`flex items-center justify-between gap-3 ${i === winner ? 'text-text' : 'text-subtle line-through decoration-subtle/60'}`}>
                  <span>{levelLabel(c.level)}</span>
                  <span className="font-medium">{envLabel(c.env)}</span>
                </li>
              ))}
            </ol>
          )}
          {chain && chain.length > 1 && <p className="mt-1.5 text-2xs text-subtle">The most specific level wins.</p>}
          {rootLabel && env === 'host' && <p className="mt-1.5 break-all text-muted">Folder: {rootLabel}</p>}
        </Tip>
      )}
    </>
  );
}

/**
 * Inheritance chain as a row of steps. With `levels`, every level is shown and the ones that do not set a value
 * read "inherits"; the step that decided the effective environment is highlighted.
 */
export function EnvChain({ chain, levels, label = 'Environment inheritance chain' }: { chain: EnvChainStep[]; levels?: readonly string[]; label?: string }) {
  const set = new Map(chain.map((c) => [c.level, c.env]));
  const winner = chain.length ? chain[chain.length - 1].level : null;
  const rows: { level: string; env: EnvId | null }[] = levels ? levels.map((l) => ({ level: l, env: set.get(l) ?? null })) : chain.map((c) => ({ level: c.level, env: c.env }));
  return (
    <ol aria-label={label} className="flex flex-wrap items-center gap-1.5">
      {rows.map((r, i) => {
        const win = r.level === winner;
        return (
          <li key={r.level} className="flex min-w-0 items-center gap-1.5">
            {i > 0 && <IconArrowRight className="size-3 shrink-0 text-subtle" />}
            <span
              aria-current={win ? 'step' : undefined}
              className={`inline-flex min-w-0 flex-col rounded-lg border px-2.5 py-1.5 ${win ? 'border-accent/50 bg-accent/[0.08]' : 'border-border bg-panel-2'}`}
            >
              <span className="text-2xs tracking-wide text-subtle uppercase">{levelLabel(r.level)}</span>
              <span className={`text-xs font-medium ${r.env ? 'text-text' : 'text-subtle italic'}`}>{r.env ? ENV_SHORT[r.env] : 'inherits'}</span>
              {win && <span className="sr-only"> (decides)</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
