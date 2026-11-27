import type { ReactNode } from 'react';
import { href } from '../hooks/useHashRoute';
import { preloadRoute } from '../pages/lazyPages';
import { IconAgents, IconApprovals, IconBots, IconCompanies, IconDevices, IconFiles, IconHost, IconMemory, IconOverview, IconProviders, IconRemote, IconResources, IconSchedules, IconSettings, IconSkills, IconSystem, IconTasks, IconTeams, IconTelegram, IconVault, IconVoice, IconWorkflows } from './icons';
import { t } from '../i18n';

export interface NavItem {
  id: string;
  label: string;
  path: string;
  icon: ReactNode;
}

export const NAV_GROUPS: { label: string | null; items: NavItem[] }[] = [
  { label: null, items: [{ id: 'overview', label: 'Command Center', path: '/overview', icon: <IconOverview /> }] },
  {
    label: 'Work',
    items: [
      { id: 'agents', label: 'Agents', path: '/agents', icon: <IconAgents /> },
      { id: 'companies', label: 'Companies', path: '/companies', icon: <IconCompanies /> },
      { id: 'teams', label: 'Teams', path: '/teams', icon: <IconTeams /> },
      { id: 'tasks', label: 'Tasks', path: '/tasks', icon: <IconTasks /> },
      { id: 'schedules', label: 'Schedules', path: '/schedules', icon: <IconSchedules /> },
      { id: 'workflows', label: 'Workflows', path: '/workflows', icon: <IconWorkflows /> },
      { id: 'approvals', label: 'Approvals', path: '/approvals', icon: <IconApprovals /> },
    ],
  },
  {
    label: 'Knowledge',
    items: [
      { id: 'memory', label: 'Memory', path: '/memory', icon: <IconMemory /> },
      { id: 'files', label: 'Files', path: '/files', icon: <IconFiles /> },
      { id: 'skills', label: 'Skills', path: '/skills', icon: <IconSkills /> },
    ],
  },
  {
    label: 'Connections',
    items: [
      { id: 'providers', label: 'AI Providers', path: '/providers', icon: <IconProviders /> },
      { id: 'telegram', label: 'Telegram', path: '/telegram', icon: <IconTelegram /> },
      { id: 'bots', label: 'Bot Network', path: '/bots', icon: <IconBots /> },
      { id: 'voice', label: 'Voice', path: '/voice', icon: <IconVoice /> },
      { id: 'host', label: 'Host Access', path: '/host', icon: <IconHost /> },
      { id: 'remote', label: 'Remote Access', path: '/remote', icon: <IconRemote /> },
    ],
  },
  {
    label: 'System',
    items: [
      { id: 'resources', label: 'Resources', path: '/resources', icon: <IconResources /> },
      { id: 'system', label: 'System', path: '/system', icon: <IconSystem /> },
      { id: 'vault', label: 'Password Vault', path: '/vault', icon: <IconVault /> },
      { id: 'devices', label: t('nav.devices'), path: '/devices', icon: <IconDevices /> },
      { id: 'settings', label: 'Settings', path: '/settings', icon: <IconSettings /> },
    ],
  },
];

/** Flat list (kept for compatibility with V1 imports). */
export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

export function BrandMark({ className = 'size-7' }: { className?: string }) {
  return (
    <span aria-hidden className={`relative grid shrink-0 place-items-center rounded-lg bg-gradient-to-b from-[#7d6ff5] to-[#5b4ce0] shadow-[inset_0_1px_0_rgb(255_255_255/0.25),0_2px_8px_-2px_rgb(110_95_240/0.6)] ${className}`}>
      <svg viewBox="0 0 24 24" className="size-[62%]" fill="none">
        <circle cx="12" cy="12" r="3.2" fill="white" />
        <ellipse cx="12" cy="12" rx="9" ry="3.6" stroke="white" strokeOpacity="0.75" strokeWidth="1.5" transform="rotate(-24 12 12)" />
      </svg>
    </span>
  );
}

export function SideNav({
  active,
  onNavigate,
  compact = false,
  badges = {},
  footer,
}: {
  active: string;
  onNavigate?: () => void;
  compact?: boolean;
  /** e.g. { overview: 3 } shows a counter next to an item */
  badges?: Record<string, number>;
  footer?: ReactNode;
}) {
  return (
    <nav aria-label="Main" className="flex h-full flex-col">
      <a
        href={href('/overview')}
        onClick={onNavigate}
        className={`mx-3 mt-3 mb-4 flex h-10 items-center gap-2.5 rounded-lg px-1.5 focus-ring ${compact ? 'justify-center' : ''}`}
      >
        <BrandMark />
        <span className={`text-[15px] font-semibold tracking-[0.14em] text-text ${compact ? 'sr-only' : ''}`}>NEBULA</span>
      </a>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 scrollbar-none">
        {NAV_GROUPS.map((g, gi) => (
          <div key={gi} className={gi ? 'mt-5' : ''}>
            {g.label &&
              (compact ? (
                <div aria-hidden className="mx-2 mb-2 h-px bg-border" />
              ) : (
                <p className="mb-1.5 px-2.5 text-2xs font-medium tracking-wider text-subtle uppercase">{g.label}</p>
              ))}
            <ul className="space-y-0.5">
              {g.items.map((item) => {
                const isActive = item.id === active;
                const badge = badges[item.id];
                return (
                  <li key={item.id}>
                    <a
                      href={href(item.path)}
                      onClick={onNavigate}
                      onPointerEnter={() => preloadRoute([item.id])}
                      onFocus={() => preloadRoute([item.id])}
                      aria-current={isActive ? 'page' : undefined}
                      title={compact ? item.label : undefined}
                      className={`group relative flex h-9 items-center gap-3 rounded-lg px-2.5 text-[13.5px] font-medium transition-colors focus-ring touch:h-11 ${
                        compact ? 'justify-center' : ''
                      } ${isActive ? 'bg-white/[0.06] text-text' : 'text-muted hover:bg-white/[0.035] hover:text-text'}`}
                    >
                      {isActive && <span aria-hidden className="absolute top-2 bottom-2 -left-3 w-[3px] rounded-r-full bg-accent-soft" />}
                      <span className={isActive ? 'text-accent-soft' : 'text-subtle transition-colors group-hover:text-muted'}>{item.icon}</span>
                      <span className={compact ? 'sr-only' : 'flex-1 truncate'}>{item.label}</span>
                      {badge ? (
                        <span
                          className={`grid h-[18px] min-w-[18px] place-items-center rounded-full bg-warn/90 px-1 text-[10.5px] font-semibold text-black tabular-nums ${
                            compact ? 'absolute top-0.5 right-0.5' : ''
                          }`}
                        >
                          {badge > 99 ? '99+' : badge}
                          <span className="sr-only"> pending</span>
                        </span>
                      ) : null}
                    </a>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
      {footer && <div className="border-t border-border p-3">{footer}</div>}
    </nav>
  );
}
