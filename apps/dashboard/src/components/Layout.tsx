import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useNebulaEvents } from '../hooks/useEvents';
import { href } from '../hooks/useHashRoute';
import { useApprovals } from './Approval';
import { IconAgents, IconLogout, IconMenu, IconOverview, IconTasks, IconTeams, IconX } from './icons';
import { SideNav } from './SideNav';
import { useToast } from './Toast';
import { TopBar, useSystemTone } from './TopBar';
import { Avatar, Button, StatusDot } from './ui';

const TABS = [
  { id: 'overview', label: 'Home', path: '/overview', icon: <IconOverview className="size-[22px]" /> },
  { id: 'agents', label: 'Agents', path: '/agents', icon: <IconAgents className="size-[22px]" /> },
  { id: 'tasks', label: 'Tasks', path: '/tasks', icon: <IconTasks className="size-[22px]" /> },
  { id: 'teams', label: 'Teams', path: '/teams', icon: <IconTeams className="size-[22px]" /> },
];

function MobileTabBar({ active, onMore, moreOpen }: { active: string; onMore: () => void; moreOpen: boolean }) {
  const inTabs = TABS.some((t) => t.id === active);
  const cls = (on: boolean) =>
    `flex h-14 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-xl text-[10.5px] font-medium transition-colors focus-ring ${on ? 'text-text' : 'text-subtle active:text-muted'}`;
  return (
    <nav aria-label="Quick navigation" className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-bg/90 pb-safe backdrop-blur-xl backdrop-saturate-150 md:hidden">
      <div className="mx-auto flex max-w-lg items-stretch gap-1 px-2 pt-1">
        {TABS.map((t) => {
          const on = t.id === active;
          return (
            <a key={t.id} href={href(t.path)} aria-current={on ? 'page' : undefined} className={cls(on)}>
              <span className={on ? 'text-accent-soft' : ''}>{t.icon}</span>
              {t.label}
            </a>
          );
        })}
        <button type="button" onClick={onMore} aria-expanded={moreOpen} aria-label="More sections" className={cls(!inTabs || moreOpen)}>
          <span className={!inTabs ? 'text-accent-soft' : ''}>
            <IconMenu className="size-[22px]" />
          </span>
          More
        </button>
      </div>
    </nav>
  );
}

function NavDrawer({
  active,
  onClose,
  username,
  onLogout,
  loggingOut,
  badges,
}: {
  active: string;
  onClose: () => void;
  username: string | null;
  onLogout: () => void;
  loggingOut: boolean;
  badges: Record<string, number>;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const overall = useSystemTone();
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLElement>('[aria-current="page"], a, button')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const ov = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = ov;
      prev?.focus?.();
    };
  }, [onClose]);
  return createPortal(
    <div className="fixed inset-0 z-[80] md:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
      <button type="button" aria-label="Close navigation" tabIndex={-1} className="absolute inset-0 animate-fade-in bg-black/60" onClick={onClose} />
      <div ref={panel} className="absolute inset-y-0 left-0 flex w-[min(300px,86vw)] animate-slide-in-left flex-col border-r border-border-strong bg-panel pt-safe pb-safe shadow-overlay">
        <button
          type="button"
          onClick={onClose}
          aria-label="Close navigation"
          className="absolute top-[max(0.75rem,env(safe-area-inset-top))] right-3 z-10 grid size-11 place-items-center rounded-lg text-subtle hover:bg-white/[0.05] hover:text-text focus-ring"
        >
          <IconX className="size-5" />
        </button>
        <SideNav
          active={active}
          onNavigate={onClose}
          badges={badges}
          footer={
            <div className="space-y-3">
              <a href={href('/system')} onClick={onClose} className="flex items-center gap-2.5 rounded-lg px-1 py-1 text-xs text-muted focus-ring">
                <StatusDot tone={overall.tone} label={overall.label} />
                <span className="truncate">{overall.label}</span>
              </a>
              <div className="flex items-center gap-2.5">
                <Avatar name={username ?? '?'} size="sm" />
                <span className="min-w-0 flex-1 truncate text-sm text-text">{username ?? '—'}</span>
                <Button size="sm" variant="ghost" onClick={onLogout} loading={loggingOut} icon={<IconLogout />}>
                  Log out
                </Button>
              </div>
            </div>
          }
        />
      </div>
    </div>,
    document.body,
  );
}

/** Resource alerts are surfaced everywhere, not only on the Resource Monitor. */
function ResourceAlertToasts() {
  const toast = useToast();
  useNebulaEvents((ev) => {
    if (ev.type !== 'resource.alert') return;
    const msg = typeof ev.payload.message === 'string' ? ev.payload.message : 'Resource limit reached';
    if (ev.payload.level === 'critical') toast.error(new Error(msg), 'Resource alert');
    else toast.warn('Resource alert', msg);
  });
  return null;
}

export function Layout({
  active,
  username,
  onLogout,
  loggingOut,
  children,
}: {
  active: string;
  username: string | null;
  onLogout: () => void;
  loggingOut: boolean;
  children: ReactNode;
}) {
  const [drawer, setDrawer] = useState(false);
  const { count } = useApprovals();
  const badges: Record<string, number> = count ? { overview: count } : {};
  const close = useRef(() => setDrawer(false)).current;
  return (
    <div className="min-h-dvh bg-bg text-text">
      <a
        href="#main"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById('main')?.focus();
        }}
        className="sr-only z-[200] rounded-lg bg-accent px-3 py-2 text-white focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Skip to content
      </a>
      {/* tablet: icon rail; desktop (>= 1024 px): full side nav */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[68px] border-r border-border bg-panel/40 md:block lg:hidden">
        <SideNav active={active} compact badges={badges} />
      </aside>
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 border-r border-border bg-panel/40 lg:block">
        <SideNav active={active} badges={badges} />
      </aside>
      {drawer && <NavDrawer active={active} onClose={close} username={username} onLogout={onLogout} loggingOut={loggingOut} badges={badges} />}
      <div className="flex min-h-dvh min-w-0 flex-col md:pl-[68px] lg:pl-60">
        <TopBar username={username} onLogout={onLogout} loggingOut={loggingOut} onMenu={() => setDrawer(true)} />
        <main
          id="main"
          tabIndex={-1}
          className="mx-auto w-full max-w-[1360px] min-w-0 flex-1 px-4 pt-5 pb-[calc(env(safe-area-inset-bottom)+96px)] focus:outline-none sm:px-6 sm:pt-7 md:pb-12 lg:px-8"
        >
          {children}
        </main>
      </div>
      <MobileTabBar active={active} onMore={() => setDrawer(true)} moreOpen={drawer} />
      <ResourceAlertToasts />
    </div>
  );
}
