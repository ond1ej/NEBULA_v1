// Settings: grouped, searchable sections (Account · Agents & Automation · Data · Connections · System) and their
// sub-pages. Things the gateway only lets the Mini App read are shown read-only with "Manage in the local Dashboard".
// V3.3: for the verified owner (me.admin) an "Administration" section opens every Dashboard page (#/admin/…), and the
// local-only items open the matching administration page instead.
import { useMemo, useState, type ReactNode } from 'react';
import { StatusPill } from '../../components/StatusPill';
import {
  IconAgents,
  IconBell,
  IconBots,
  IconCompanies,
  IconDisk,
  IconFiles,
  IconHost,
  IconKey,
  IconLogout,
  IconMemory,
  IconMonitor,
  IconProviders,
  IconRemote,
  IconResources,
  IconSchedules,
  IconSettings,
  IconShield,
  IconSkills,
  IconSun,
  IconTeams,
  IconTelegram,
  IconTerminal,
  IconUser,
  IconVoice,
  IconWorkflows,
} from '../../components/icons';
import { formatBytes, formatTime, relativeTime } from '../../lib/format';
import type { Agent, Health, LiveSessions, ResourceSnapshot } from '../../types';
import { logoutMini } from '../auth';
import { isAdmin, useMini } from '../context';
import { clearQueryCache, useQuery } from '../hooks';
import { mhref } from '../router';
import { SecuritySection } from '../stepup/SecuritySection';
import { getWebApp } from '../telegram';
import { setThemeMode, useTheme, type ThemeMode } from '../theme';
import type { HostRoot, VoiceOverview } from '../types';
import { agentAvatar, Avatar, Btn, Card, cx, Empty, ErrorState, Glyph, List, Pill, QueryView, Row, Screen, SearchField, Section, SkeletonList, tapLinkClass, type Tone } from '../uiKit';
import { ConfirmSheet, KV, Meter, Notice, usageTone } from '../uiExtra';

interface Item {
  id: string;
  section: string;
  title: string;
  subtitle?: string;
  keywords?: string;
  icon: ReactNode;
  tone: Tone;
  href?: string;
  /** Not possible from the Mini App: shown disabled with this note. */
  localOnly?: string;
}

const LOCAL = 'Manage in the local Dashboard';

const ITEMS: Item[] = [
  { id: 'account', section: 'Account', title: 'Profile & session', subtitle: 'Who is signed in, session expiry', keywords: 'user profile telegram account expiry permissions', icon: <IconUser />, tone: 'accent', href: '/settings/account' },
  { id: 'tg-account', section: 'Account', title: 'Telegram connection', subtitle: 'This Mini App and its bot', keywords: 'telegram mini app bot pairing', icon: <IconTelegram />, tone: 'info', href: '/settings/telegram' },
  { id: 'security', section: 'Account', title: 'Security', subtitle: 'Permissions of this session', keywords: 'security permissions privacy gateway', icon: <IconShield />, tone: 'danger', href: '/settings/security' },
  { id: 'logout', section: 'Account', title: 'Sessions & log out', subtitle: 'End this Mini App session', keywords: 'logout sign out session', icon: <IconLogout />, tone: 'neutral', href: '/settings/account#logout' },

  { id: 'agents', section: 'Agents & Automation', title: 'Agents', keywords: 'agents bots assistants', icon: <IconAgents />, tone: 'accent', href: '/agents' },
  { id: 'companies', section: 'Agents & Automation', title: 'AI companies', subtitle: 'Teams of agents with roles and projects', keywords: 'companies company runs projects org chart ceo', icon: <IconCompanies />, tone: 'info', href: '/companies' },
  { id: 'teams', section: 'Agents & Automation', title: 'Teams', keywords: 'teams team runs', icon: <IconTeams />, tone: 'success', href: '/teams' },
  { id: 'workflows', section: 'Agents & Automation', title: 'Workflows', subtitle: 'Run, stop and monitor automations', keywords: 'workflows automation runs', icon: <IconWorkflows />, tone: 'warning', href: '/workflows' },
  { id: 'schedules', section: 'Agents & Automation', title: 'Schedules', keywords: 'schedules cron timer recurring', icon: <IconSchedules />, tone: 'danger', href: '/schedules' },
  { id: 'skills', section: 'Agents & Automation', title: 'Skills', subtitle: 'Per agent', keywords: 'skills plugins tools', icon: <IconSkills />, tone: 'neutral', href: '/settings/pick-skills' },
  { id: 'memory', section: 'Agents & Automation', title: 'Memory', subtitle: 'Per agent', keywords: 'memory memories facts notes', icon: <IconMemory />, tone: 'info', href: '/settings/pick-memory' },

  { id: 'files', section: 'Data', title: 'Files', subtitle: 'Agent workspaces and shared folders', keywords: 'files folders upload download workspace', icon: <IconFiles />, tone: 'success', href: '/files' },
  { id: 'vault', section: 'Data', title: 'Password Vault', subtitle: 'Credentials, agent access, sign-in security', keywords: 'vault passwords credentials secrets lock keys pin smart sign-in trust', icon: <IconKey />, tone: 'accent', href: '/settings/vault' },
  { id: 'backups', section: 'Data', title: 'Backups', keywords: 'backup restore export', icon: <IconDisk />, tone: 'neutral', localOnly: 'Only in the local Dashboard' },

  { id: 'providers', section: 'Connections', title: 'AI providers', subtitle: 'Connection status', keywords: 'providers models openai anthropic api keys', icon: <IconProviders />, tone: 'accent', href: '/settings/providers' },
  { id: 'telegram', section: 'Connections', title: 'Telegram', subtitle: 'Bot and Mini App', keywords: 'telegram bot mini app webapp', icon: <IconTelegram />, tone: 'info', href: '/settings/telegram' },
  { id: 'bots', section: 'Connections', title: 'Bot network', keywords: 'bot network bots telegram agents', icon: <IconBots />, tone: 'neutral', localOnly: LOCAL },
  { id: 'voice', section: 'Connections', title: 'Voice', subtitle: 'Speech-to-text and voice replies', keywords: 'voice speech transcription stt tts microphone', icon: <IconVoice />, tone: 'success', href: '/settings/voice' },
  { id: 'host', section: 'Connections', title: 'Host access', subtitle: 'Folders agents may use on the Mac', keywords: 'host mac folders roots access', icon: <IconHost />, tone: 'warning', href: '/settings/host' },
  { id: 'remote', section: 'Connections', title: 'Remote access', keywords: 'remote access tunnel gateway public url', icon: <IconRemote />, tone: 'neutral', href: '/settings/remote' },

  { id: 'system', section: 'System', title: 'System status', subtitle: 'Health, resources, Ubuntu VM', keywords: 'system health resources cpu memory disk vm status monitor', icon: <IconResources />, tone: 'success', href: '/settings/system' },
  { id: 'desktops', section: 'System', title: 'Live Desktops', subtitle: 'Active streams and agent desktops', keywords: 'live desktop vnc stream control', icon: <IconMonitor />, tone: 'accent', href: '/settings/desktops' },
  { id: 'notifications', section: 'System', title: 'Notifications', subtitle: 'Results, failures and alerts', keywords: 'notifications alerts history', icon: <IconBell />, tone: 'danger', href: '/notifications' },
  { id: 'logs', section: 'System', title: 'Logs & diagnostics', keywords: 'logs diagnostics debug support', icon: <IconTerminal />, tone: 'neutral', localOnly: 'Only in the local Dashboard' },
  { id: 'appearance', section: 'System', title: 'Appearance', subtitle: 'System, dark or light', keywords: 'theme dark light appearance colours', icon: <IconSun />, tone: 'warning', href: '/settings/appearance' },
];

const SECTION_ORDER = ['Administration', 'Account', 'Agents & Automation', 'Data', 'Connections', 'System'];

const ADMIN_ITEM: Item = {
  id: 'admin',
  section: 'Administration',
  title: 'Administration',
  subtitle: 'Every Dashboard page: agents, providers, backups, logs…',
  keywords: 'administration admin owner dashboard manage providers backups logs bots host remote delete',
  icon: <IconSettings />,
  tone: 'accent',
  href: '/admin',
};

/** Administration pages of the items that are local-only for everyone else. */
const ADMIN_PAGE: Record<string, string> = { backups: '/admin/system', bots: '/admin/bots', logs: '/admin/system' };

/** The settings list of this session: the owner (me.admin) gets Administration and no local-only items. */
export function settingsItems(admin: boolean): Item[] {
  if (!admin) return ITEMS;
  return [ADMIN_ITEM, ...ITEMS.map((i) => (i.localOnly && ADMIN_PAGE[i.id] ? { ...i, localOnly: undefined, href: ADMIN_PAGE[i.id], subtitle: 'In Administration' } : i))];
}

/** Settings items matching a search (title, subtitle, section and keywords). */
export function filterSettings(term: string, items: Item[] = ITEMS): Item[] {
  const words = term.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return items;
  return items.filter((i) => {
    const hay = `${i.title} ${i.subtitle ?? ''} ${i.section} ${i.keywords ?? ''}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

export function SettingsScreen({ page }: { page: string | null }) {
  switch (page) {
    case 'account':
      return <AccountPage />;
    case 'security':
      return <SecurityPage />;
    case 'appearance':
      return <AppearancePage />;
    case 'providers':
      return <ProvidersPage />;
    case 'telegram':
      return <TelegramPage />;
    case 'voice':
      return <VoicePage />;
    case 'host':
      return <HostPage />;
    case 'remote':
      return <RemotePage />;
    case 'system':
      return <SystemPage />;
    case 'desktops':
      return <DesktopsPage />;
    case 'pick-skills':
      return <AgentPicker section="skills" title="Skills" />;
    case 'pick-memory':
      return <AgentPicker section="memory" title="Memory" />;
    default:
      return <SettingsHome />;
  }
}

function SettingsHome() {
  const ctx = useMini();
  const { client, session, username } = ctx;
  const admin = isAdmin(ctx);
  const [term, setTerm] = useState('');
  const items = useMemo(() => filterSettings(term, settingsItems(admin)), [term, admin]);
  const name = client.mode === 'telegram' ? [session?.telegram_user?.first_name, session?.telegram_user?.last_name].filter(Boolean).join(' ') || 'Telegram owner' : (username ?? 'Dashboard owner');
  return (
    <Screen large title="Settings">
      <div className="mb-4">
        <SearchField label="Search settings" value={term} onChange={setTerm} placeholder="Search settings" />
      </div>
      {!term && (
        <Section>
          <List>
            <Row href={mhref('/settings/account')} leading={<Avatar name={name} id={String(session?.telegram_user?.id ?? username ?? 'owner')} />} title={<span className="font-semibold">{name}</span>} subtitle={client.mode === 'telegram' ? 'Telegram Mini App · secure gateway' : 'Local preview · Dashboard session'} />
          </List>
        </Section>
      )}
      {items.length === 0 ? (
        <p className="py-8 text-center text-subhead text-subtle" role="status">
          No settings match “{term}”.
        </p>
      ) : (
        SECTION_ORDER.map((sec) => {
          const rows = items.filter((i) => i.section === sec);
          if (!rows.length) return null;
          return (
            <Section key={sec} title={sec}>
              <List>
                {rows.map((i) => (
                  <Row
                    key={i.id}
                    href={i.href ? mhref(i.href) : undefined}
                    leading={<Glyph tone={i.tone}>{i.icon}</Glyph>}
                    title={i.title}
                    subtitle={i.localOnly ?? i.subtitle}
                    disabled={Boolean(i.localOnly)}
                    label={i.localOnly ? `${i.title}: ${i.localOnly}` : undefined}
                  />
                ))}
              </List>
            </Section>
          );
        })
      )}
      {client.mode === 'cookie' && !term && (
        <p className="px-4 text-footnote text-subtle">
          You are previewing the Mini App with your Dashboard session.{' '}
          <a className="text-accent-soft underline" href="/">
            Back to the Dashboard
          </a>
        </p>
      )}
    </Screen>
  );
}

// ---------------------------------------------------------------- account & security
function AccountPage() {
  const { client, session, me, username, inTelegram } = useMini();
  const [loggedOut, setLoggedOut] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const tgUser = session?.telegram_user;
  const perms = session?.permissions ?? me?.permissions ?? [];
  const wa = getWebApp();

  const logout = async () => {
    setBusy(true);
    try {
      await logoutMini(client);
    } catch {
      // the token is forgotten locally either way
    } finally {
      clearQueryCache();
      setBusy(false);
      setConfirm(false);
      setLoggedOut(true);
    }
  };

  if (loggedOut) {
    return (
      <Screen title="Signed out">
        <Notice tone="success" title="This Mini App session was ended">
          Close the Mini App. Opening it again from Telegram signs you in with a new, short-lived session.
        </Notice>
        {inTelegram && (
          <Btn variant="primary" className="mt-4 w-full" onClick={() => wa?.close?.()}>
            Close Mini App
          </Btn>
        )}
      </Screen>
    );
  }

  return (
    <Screen title="Profile & session">
      <Section title="Signed in">
        <Card>
          <KV
            items={[
              ['Signed in as', client.mode === 'telegram' ? `${tgUser?.first_name ?? ''} ${tgUser?.last_name ?? ''}`.trim() || `Telegram ${tgUser?.id ?? ''}` : (username ?? 'Dashboard owner')],
              ['Mode', client.mode === 'telegram' ? 'Telegram Mini App (secure gateway)' : 'Local preview (Dashboard session)'],
              ...(client.mode === 'telegram'
                ? ([
                    ['Telegram user', tgUser?.username ? `@${tgUser.username}` : String(tgUser?.id ?? '—')],
                    ['Bot', session?.bot === 'main' ? 'Main NEBULA bot' : (session?.bot ?? '—')],
                    ['Expires', session ? formatTime(session.expires_at) : '—'],
                  ] as [string, string][])
                : []),
            ]}
          />
        </Card>
      </Section>
      <Section title="Permissions of this session">
        <div className="flex flex-wrap gap-1.5 px-1" aria-label="Permissions of this session">
          {perms.length ? perms.map((p) => <Pill key={p}>{p}</Pill>) : <span className="text-subhead text-muted">read-only</span>}
        </div>
      </Section>
      <div id="logout">
        <Section title="Session">
          {client.mode === 'telegram' ? (
            <List>
              <Row title="Log out of the Mini App" destructive onClick={() => setConfirm(true)} leading={<Glyph tone="danger"><IconLogout /></Glyph>} chevron={false} />
            </List>
          ) : (
            <a className={tapLinkClass('secondary', 'w-full')} href="/">
              Open the Dashboard
            </a>
          )}
        </Section>
      </div>
      <ConfirmSheet open={confirm} title="Log out of the Mini App?" confirmLabel="Log out" tone="danger" busy={busy} onCancel={() => setConfirm(false)} onConfirm={() => void logout()}>
        This Mini App session ends now. Reopen NEBULA from Telegram to sign in again.
      </ConfirmSheet>
    </Screen>
  );
}

function SecurityPage() {
  const ctx = useMini();
  const { client, session, me } = ctx;
  const perms = new Set(session?.permissions ?? me?.permissions ?? []);
  const rows: [string, string, string][] = [
    ['tasks', 'Send messages and tasks', 'Chat, attachments, voice'],
    ['commands', 'Control agents and tasks', 'Wake, sleep, pause, resume, stop'],
    ['approvals', 'Decide approvals', 'Approve or deny agent actions'],
    ['desktop', 'Live Desktop', 'Watch and take control'],
    ['files', 'Files', 'Browse, upload, download'],
    ['companies', 'AI companies', 'Create companies, start runs'],
    ['workflows', 'Workflows', 'Run, stop, enable'],
    ['screenshot', 'Screenshots', 'Agent desktop screenshots'],
  ];
  return (
    <Screen title="Security">
      <SecuritySection />
      <Section title="This session may" footer={client.mode === 'cookie' ? 'Local preview: your Dashboard session applies.' : 'Permissions are set when the Telegram account is paired.'}>
        <List>
          {rows.map(([p, title, sub]) => {
            const ok = client.mode === 'cookie' || perms.has(p);
            return <Row key={p} title={title} subtitle={sub} value={ok ? 'Allowed' : 'Not allowed'} chevron={false} />;
          })}
        </List>
      </Section>
      {isAdmin(ctx) ? (
        <Notice tone="info" title="You administer NEBULA from here">
          As the verified owner you can change everything in{' '}
          <a className="text-accent-soft underline" href={mhref('/admin')}>
            Administration
          </a>
          . Sensitive changes ask for Face ID or your NEBULA password first.
        </Notice>
      ) : (
        <Notice tone="info" title="Owner-only actions stay on your Mac">
          Providers and API keys, folders, remote access, deleting agents and managing the Password Vault are available only in the local NEBULA Dashboard — never
          through Telegram.
        </Notice>
      )}
    </Screen>
  );
}

/** "Manage in Administration" for the owner, the local-only note for everyone else. */
function ManageOr({ to, label, className = 'mt-3', children }: { to: string; label: string; className?: string; children: ReactNode }) {
  const ctx = useMini();
  if (isAdmin(ctx)) {
    return (
      <List className={className}>
        <Row href={mhref(to)} leading={<Glyph tone="accent"><IconSettings /></Glyph>} title={label} subtitle="Administration" />
      </List>
    );
  }
  return <p className={cx(className, 'px-4 text-footnote text-subtle')}>{children}</p>;
}

// ---------------------------------------------------------------- appearance
function AppearancePage() {
  const { mode, scheme } = useTheme();
  const opts: { id: ThemeMode; label: string; note: string }[] = [
    { id: 'system', label: 'System', note: 'Follows Telegram / your device' },
    { id: 'dark', label: 'Dark', note: 'Always dark' },
    { id: 'light', label: 'Light', note: 'Always light' },
  ];
  return (
    <Screen title="Appearance">
      <Section title="Theme" footer={`Currently ${scheme}.`}>
        <ul className="overflow-hidden rounded-card bg-panel" role="radiogroup" aria-label="Theme">
          {opts.map((o) => (
            <li key={o.id} className="group/row">
              <button
                type="button"
                role="radio"
                aria-checked={mode === o.id}
                onClick={() => setThemeMode(o.id)}
                className="nb-row flex min-h-14 w-full items-center gap-3 pl-4 text-left focus-ring"
              >
                <span className="flex min-w-0 flex-1 items-center self-stretch border-b border-border py-2.5 pr-4 group-last/row:border-b-0">
                  <span className="flex-1">
                    <span className="block text-body text-text">{o.label}</span>
                    <span className="block text-footnote text-muted">{o.note}</span>
                  </span>
                  <span aria-hidden className={cx('grid size-6 place-items-center rounded-full border-2', mode === o.id ? 'border-accent bg-accent' : 'border-subtle')}>
                    {mode === o.id && <span className="size-2 rounded-full bg-white" />}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </Section>
    </Screen>
  );
}

// ---------------------------------------------------------------- connections
function useHealth() {
  const { api } = useMini();
  return useQuery<Health>('health', (s) => api.health(s), {
    refreshOn: (ev) => ev.type === 'system.health' || ev.type.startsWith('vm.') || ev.type === 'provider.state.changed',
  });
}

function ProvidersPage() {
  const health = useHealth();
  return (
    <Screen title="AI providers">
      <QueryView q={health} rows={2}>
        {(h) =>
          Object.keys(h.providers).length ? (
            <List>
              {Object.entries(h.providers).map(([id, st]) => (
                <Row key={id} title={id} trailing={<StatusPill state={st} />} chevron={false} />
              ))}
            </List>
          ) : (
            <Empty title="No AI providers connected" />
          )
        }
      </QueryView>
      <ManageOr to="/admin/providers" label="Manage AI providers">
        Connect providers and keys only in the Dashboard on your Mac mini — never through Telegram.
      </ManageOr>
    </Screen>
  );
}

function TelegramPage() {
  const { inTelegram, me, session } = useMini();
  const health = useHealth();
  const wa = getWebApp();
  return (
    <Screen title="Telegram">
      <Section title="Bot">
        <Card>
          <KV
            items={[
              ['Bot polling', health.data ? (health.data.telegram.polling ? 'Online' : 'Stopped') : '…'],
              ['Signed-in bot', session?.bot === 'main' ? 'Main NEBULA bot' : (session?.bot ?? '—')],
            ]}
          />
        </Card>
      </Section>
      <Section title="Mini App">
        <Card>
          <KV
            items={[
              ['Opened in', inTelegram ? `Telegram ${wa?.platform ?? ''}`.trim() : 'Web browser'],
              ['WebApp version', wa?.version ?? '—'],
              ['Public address', me?.public_url ?? '—'],
            ]}
          />
        </Card>
      </Section>
      <ManageOr to="/admin/telegram" label="Manage Telegram" className="">
        Pair accounts, topics and notification levels in the local Dashboard (Telegram).
      </ManageOr>
    </Screen>
  );
}

function VoicePage() {
  const { api } = useMini();
  const q = useQuery<VoiceOverview>('voice:status', (s) => api.voice.status(s));
  return (
    <Screen title="Voice">
      <QueryView q={q} rows={2}>
        {(v) => (
          <>
            <Section title="Speech-to-text" footer={v.stt.backend ? 'Voice messages you send are transcribed on the Mac.' : (v.stt.setup_hint ?? 'Set it up in the local Dashboard.')}>
              <Card>
                <KV
                  items={[
                    ['Transcription', v.stt.backend ? (v.stt.backend === 'whisper_cpp' ? 'Local (whisper.cpp)' : v.stt.backend === 'openai' ? 'Cloud (OpenAI)' : String(v.stt.backend)) : 'Not configured'],
                    ['Language', v.stt.language ?? 'auto'],
                  ]}
                />
              </Card>
            </Section>
            <Section title="Voice replies" footer="Per-agent reply mode: Agents → agent → Settings.">
              <Card>
                <KV items={[['Text-to-speech', v.tts && (v.tts as { available?: boolean }).available === false ? 'Unavailable' : String((v.tts as { provider?: string })?.provider ?? 'macOS')]]} />
              </Card>
            </Section>
          </>
        )}
      </QueryView>
      <ManageOr to="/admin/voice" label="Manage voice" className="">
        Change voice settings in the local Dashboard.
      </ManageOr>
    </Screen>
  );
}

function HostPage() {
  const { api } = useMini();
  const q = useQuery<HostRoot[]>('host:roots', (s) => api.host.roots(s));
  return (
    <Screen title="Host access">
      <QueryView q={q} isEmpty={(d) => d.length === 0} empty={<Empty title="No authorised folders">Agents on the Mac mini can only use folders you authorise in the Dashboard.</Empty>}>
        {(roots) => (
          <List>
            {roots.map((r) => (
              <Row key={r.id} title={String(r.name ?? r.id)} subtitle={typeof r.path === 'string' ? r.path : undefined} value={typeof r.mode === 'string' ? r.mode : undefined} chevron={false} />
            ))}
          </List>
        )}
      </QueryView>
      <ManageOr to="/admin/host" label="Manage host access">
        {LOCAL}: add, change or revoke folders.
      </ManageOr>
    </Screen>
  );
}

function RemotePage() {
  const { me, client } = useMini();
  return (
    <Screen title="Remote access">
      <Card>
        <KV
          items={[
            ['Public address', me?.public_url ?? '—'],
            ['This session', client.mode === 'telegram' ? 'Through the Mini App gateway (allow-listed API only)' : 'Local network (Dashboard session)'],
          ]}
        />
      </Card>
      <ManageOr to="/admin/remote" label="Manage remote access & Mini App sessions">
        {LOCAL}: tunnel, public URL and LAN access.
      </ManageOr>
    </Screen>
  );
}

// ---------------------------------------------------------------- system
function SystemPage() {
  const { api } = useMini();
  const health = useHealth();
  const res = useQuery<ResourceSnapshot>('resources', (s) => api.resources(s), { pollMs: 30_000 });
  const h = health.data;
  const host = res.data?.host ?? null;
  const guest = res.data?.guest ?? null;
  const guestUsed = guest?.mem_total_mb && guest.mem_available_mb != null ? 100 - (guest.mem_available_mb / guest.mem_total_mb) * 100 : null;
  const diskUsed = host && host.disk_total_bytes ? 100 - (host.disk_free_bytes / host.disk_total_bytes) * 100 : null;
  return (
    <Screen title="System status">
      <Section title="NEBULA">
        {h ? (
          <Card>
            <KV
              items={[
                ['Status', h.status === 'ok' ? 'Healthy' : 'Degraded'],
                ['Version', `v${h.version}`],
                ['Ubuntu VM', h.vm.state ?? 'unknown'],
                ['Guest agent', `${h.guest.status.replace(/_/g, ' ')}${h.guest.latency_ms != null ? ` · ${Math.round(h.guest.latency_ms)} ms` : ''}`],
                ['AI providers', `${Object.values(h.providers).filter((s) => s.startsWith('Connected')).length}/${Object.keys(h.providers).length} connected`],
                ['Telegram bot', h.telegram.polling ? 'Online' : 'Stopped'],
              ]}
            />
          </Card>
        ) : health.error ? (
          <ErrorState error={health.error} onRetry={health.reload} />
        ) : (
          <SkeletonList rows={2} avatar={false} />
        )}
      </Section>
      <Section title="Resources">
        <Card className="space-y-4">
          {host ? (
            <>
              <Usage label="Mac mini memory" pct={host.memory_used_percent ?? 100 - host.memory_free_percent} hint={`${formatBytes(host.memory_available_bytes)} free · ${host.memory_pressure}`} />
              {host.cpu_percent != null && <Usage label="Mac mini CPU" pct={host.cpu_percent} hint={`load ${host.load_avg?.[0]?.toFixed(2) ?? '—'}`} />}
              {diskUsed != null && <Usage label="Disk" pct={diskUsed} hint={`${formatBytes(host.disk_free_bytes)} free`} />}
              {guestUsed != null && <Usage label="Ubuntu VM memory" pct={guestUsed} hint={`${guest?.mem_available_mb ?? '—'} MB free`} />}
              {res.data && (
                <p className="text-footnote text-muted">
                  {res.data.active_workers} active worker{res.data.active_workers === 1 ? '' : 's'} · {res.data.queue.length} queued · profile {res.data.limits.profile} · max {res.data.limits.max_active_effective} active agents
                </p>
              )}
            </>
          ) : res.error ? (
            <ErrorState error={res.error} onRetry={res.reload} />
          ) : (
            <SkeletonList rows={2} avatar={false} />
          )}
        </Card>
      </Section>
      <ManageOr to="/admin/system" label="System, backups & logs" className="">
        Logs, diagnostics, VM controls and resource profiles: {LOCAL.toLowerCase()}.
      </ManageOr>
    </Screen>
  );
}

function Usage({ label, pct, hint }: { label: string; pct: number; hint?: string }) {
  const v = Math.max(0, Math.min(100, pct));
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2 text-subhead">
        <span className="text-text">{label}</span>
        <span className="text-footnote text-muted tabular-nums">
          {Math.round(v)}%{hint ? ` · ${hint}` : ''}
        </span>
      </div>
      <Meter value={v} label={label} tone={usageTone(v)} />
    </div>
  );
}

function DesktopsPage() {
  const { api } = useMini();
  const sessions = useQuery<LiveSessions>('live:sessions', () => api.live.sessions(), { refreshOn: (ev) => ev.type.startsWith('live.') });
  const agents = useQuery<Agent[]>('agents', (s) => api.agents.list(s));
  const names = new Map((agents.data ?? []).map((a) => [a.id, a.name]));
  const active = (sessions.data?.sessions ?? []).filter((x) => !x.ended_at);
  return (
    <Screen title="Live Desktops">
      <Section title="Active streams">
        {sessions.data ? (
          active.length ? (
            <List>
              {active.map((s, i) => (
                <Row
                  key={s.id ?? i}
                  href={mhref(`/agents/${s.agent_id}/desktop`)}
                  title={names.get(s.agent_id) ?? 'Agent'}
                  subtitle={`${s.state.toLowerCase()}${s.control_lease ? ' · someone holds control' : ''} · since ${relativeTime(s.created_at)}`}
                />
              ))}
            </List>
          ) : (
            <p className="rounded-card bg-panel px-4 py-3.5 text-subhead text-muted">No desktop is being streamed right now.</p>
          )
        ) : sessions.error ? (
          <ErrorState error={sessions.error} onRetry={sessions.reload} />
        ) : (
          <SkeletonList rows={1} />
        )}
      </Section>
      <Section title="Open an agent’s desktop">
        <QueryView q={agents} isEmpty={(d) => d.length === 0} empty={<Empty title="No agents" />}>
          {(list) => (
            <List>
              {list.map((a) => (
                <Row key={a.id} href={mhref(`/agents/${a.id}/desktop`)} leading={<Avatar name={a.name} id={a.id} size="sm" avatar={agentAvatar(a)} />} title={a.name} subtitle={a.state.toLowerCase()} />
              ))}
            </List>
          )}
        </QueryView>
      </Section>
    </Screen>
  );
}

function AgentPicker({ section, title }: { section: 'skills' | 'memory'; title: string }) {
  const { api } = useMini();
  const agents = useQuery<Agent[]>('agents', (s) => api.agents.list(s));
  return (
    <Screen title={title} subtitle="Choose an agent">
      <QueryView q={agents} isEmpty={(d) => d.length === 0} empty={<Empty title="No agents" />}>
        {(list) => (
          <List>
            {list.map((a) => (
              <Row key={a.id} href={mhref(`/agents/${a.id}/${section}`)} leading={<Avatar name={a.name} id={a.id} size="sm" avatar={agentAvatar(a)} />} title={a.name} subtitle={a.model_id ?? 'no AI model'} />
            ))}
          </List>
        )}
      </QueryView>
    </Screen>
  );
}

