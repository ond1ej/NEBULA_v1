import { useEventStatus } from '../hooks/useEvents';
import { href, navigate } from '../hooks/useHashRoute';
import { useHealth } from '../hooks/useHealth';
import { useApprovals } from './Approval';
import { IconBell, IconLogout, IconMenu, IconSettings, IconUser } from './icons';
import { DropdownMenu } from './Menu';
import { BrandMark } from './SideNav';
import { toneFor, type Tone } from './StatusPill';
import { TONE_DOT } from './tone';
import { StatusDot } from './ui';

const PROVIDER_ISSUES = new Set(['Quota Reached', 'Re-auth Required', 'Error']);

export function providerSummary(providers: Record<string, string> | undefined): { label: string; tone: Tone } {
  const states = Object.values(providers ?? {});
  const connected = states.filter((s) => s.startsWith('Connected')).length;
  const issues = states.filter((s) => PROVIDER_ISSUES.has(s)).length;
  if (issues) return { label: `Providers: ${connected} connected · ${issues} need attention`, tone: 'warn' };
  if (connected) return { label: `Providers: ${connected} connected`, tone: 'success' };
  return { label: 'Providers: none connected', tone: 'neutral' };
}

function Chip({ tone, label, value, to }: { tone: Tone; label: string; value: string; to?: string }) {
  const body = (
    <>
      <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${TONE_DOT[tone]}`} />
      <span className="text-subtle">{label}</span>
      <span className="truncate text-text">{value}</span>
    </>
  );
  const cls = 'inline-flex h-7 max-w-[220px] items-center gap-1.5 rounded-md border border-border bg-panel/60 px-2 text-xs whitespace-nowrap';
  return to ? (
    <a href={to} className={`${cls} transition-colors hover:border-border-strong hover:bg-panel-2 focus-ring`} aria-label={`${label}: ${value}`}>
      {body}
    </a>
  ) : (
    <span className={cls} aria-label={`${label}: ${value}`}>
      {body}
    </span>
  );
}

/** One overall indicator for small screens. */
export function useSystemTone(): { tone: Tone; label: string } {
  const { health, error } = useHealth();
  const ev = useEventStatus();
  if (error && !health) return { tone: 'danger', label: 'Host API unreachable' };
  if (!health) return { tone: 'neutral', label: 'Checking system status' };
  const vm = health.vm.state;
  if (vm !== 'running') return { tone: vm === 'error' ? 'danger' : 'warn', label: `VM ${vm ?? 'unknown'}` };
  if (health.guest.status !== 'ok') return { tone: 'warn', label: `Guest ${health.guest.status.replace(/_/g, ' ')}` };
  if (health.db !== 'ok') return { tone: 'danger', label: 'Database error' };
  if (ev === 'reconnecting') return { tone: 'warn', label: 'Live events reconnecting' };
  const prov = providerSummary(health.providers);
  if (prov.tone === 'warn') return { tone: 'warn', label: prov.label };
  return { tone: 'success', label: 'All systems operational' };
}

export function ApprovalsButton({ compact = false }: { compact?: boolean }) {
  const { count, openPanel } = useApprovals();
  return (
    <button
      type="button"
      onClick={openPanel}
      aria-label={count ? `Approvals: ${count} waiting` : 'Approvals: nothing waiting'}
      title="Approvals"
      className={`relative inline-flex h-9 items-center gap-2 rounded-lg px-2.5 text-[13px] font-medium transition-colors focus-ring touch:h-11 touch:min-w-11 ${
        count ? 'border border-warn/35 bg-warn/[0.08] text-warn hover:bg-warn/[0.14]' : 'text-muted hover:bg-white/[0.05] hover:text-text'
      }`}
    >
      <IconBell className="size-[18px]" />
      {!compact && <span className="hidden lg:inline">Approvals</span>}
      {count > 0 && <span className="grid h-[18px] min-w-[18px] place-items-center rounded-full bg-warn px-1 text-[10.5px] font-semibold text-black tabular-nums">{count > 99 ? '99+' : count}</span>}
    </button>
  );
}

export function TopBar({
  username,
  onLogout,
  loggingOut,
  onMenu,
}: {
  username: string | null;
  onLogout: () => void;
  loggingOut: boolean;
  onMenu: () => void;
}) {
  const { health, error } = useHealth();
  const ev = useEventStatus();
  const overall = useSystemTone();
  const vmState = health?.vm.state ?? null;
  const guest = health?.guest;
  const prov = providerSummary(health?.providers);

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-bg/85 pt-safe backdrop-blur-xl backdrop-saturate-150">
      <div className="flex h-14 items-center gap-2 px-3 sm:px-5 md:h-[52px] lg:px-7">
        {/* phone: brand + overall status */}
        <a href={href('/overview')} className="flex min-w-0 items-center gap-2 rounded-lg focus-ring md:hidden" aria-label="NEBULA Command Center">
          <BrandMark className="size-7" />
          <span className="text-sm font-semibold tracking-[0.14em] text-text">NEBULA</span>
        </a>
        <a href={href('/system')} className="ml-1 inline-flex size-9 items-center justify-center rounded-lg focus-ring md:hidden" aria-label={`System status: ${overall.label}`}>
          <StatusDot tone={overall.tone} label={overall.label} pulse={overall.tone === 'danger'} />
        </a>

        {/* tablet / desktop: status chips */}
        <div className="hidden min-w-0 flex-1 items-center gap-1.5 overflow-hidden md:flex" aria-label="System status">
          {error && !health ? (
            <Chip tone="danger" label="Host" value="unreachable" to={href('/system')} />
          ) : (
            <>
              <Chip tone={toneFor(vmState ?? 'unknown')} label="VM" value={vmState ?? 'unknown'} to={href('/system')} />
              <Chip
                tone={toneFor(guest?.status ?? 'unknown')}
                label="Guest"
                value={`${guest?.status?.replace(/_/g, ' ') ?? 'unknown'}${guest?.latency_ms != null ? ` · ${Math.round(guest.latency_ms)} ms` : ''}`}
              />
              <span className="hidden xl:contents">
                <Chip tone={prov.tone} label="Providers" value={prov.label.replace(/^Providers: /, '')} to={href('/providers')} />
              </span>
              {health && health.db !== 'ok' && <Chip tone="danger" label="Database" value="error" />}
            </>
          )}
          <Chip
            tone={ev === 'open' ? 'success' : ev === 'reconnecting' ? 'warn' : 'neutral'}
            label="Events"
            value={ev === 'open' ? 'live' : ev === 'reconnecting' ? 'reconnecting' : 'connecting'}
          />
        </div>

        <div className="ml-auto flex items-center gap-1">
          {health?.version && <span className="mr-1 hidden font-mono text-2xs text-subtle xl:inline">v{health.version}</span>}
          <ApprovalsButton />
          <span className="hidden md:inline-flex">
            <DropdownMenu
              label="Account"
              icon={<IconUser className="size-4" />}
              buttonLabel={<span className="max-w-[140px] truncate">{username ?? 'Account'}</span>}
              variant="ghost"
              size="sm"
              items={[
                { label: 'Settings & security', icon: <IconSettings />, onSelect: () => navigate('/settings') },
                { label: loggingOut ? 'Signing out…' : 'Log out', icon: <IconLogout />, onSelect: onLogout, disabled: loggingOut, separatorBefore: true },
              ]}
            />
          </span>
          <button
            type="button"
            className="grid size-10 place-items-center rounded-lg text-muted transition-colors hover:bg-white/[0.05] hover:text-text focus-ring md:hidden touch:size-11"
            onClick={onMenu}
            aria-label="Open navigation"
          >
            <IconMenu className="size-5" />
          </button>
        </div>
      </div>
    </header>
  );
}
