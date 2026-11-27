// Telegram Mini App shell: boot/auth gate, providers, bottom tab bar (Chats · Agents · Activity · Settings),
// Telegram BackButton and routing. Chats (the first screen) ships with the shell; every other screen is a lazy chunk.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { EventHub, EventsProvider } from '../hooks/useEvents';
import { setTransport } from '../lib/http';
import { lazyNamed } from '../lib/lazy';
import { createMiniApi } from './api';
import { popBack, useBackDepth } from './backStack';
import { ConversationScreen } from './chunks';
import { bootAuth, type BootResult } from './auth';
import { agentBotFullScreen, agentBotParent, agentBotView } from './agentBot';
import { canDecide, canManageVault, isAgentBot, MiniProvider, useMini, type MiniContextValue } from './context';
import { StreamEventHub } from './events';
import { approvalCenterEvent, clearQueryCache, useCachedQuery, useOnline, useQuery } from './hooks';
import { IcActivity, IcAgents, IcAlert, IcChats, IcSettings } from './icons';
import {
  goBack,
  hidesTabBar,
  historyIndex,
  initRouter,
  isTabRoot,
  mhref,
  NEW_AGENT,
  parentPath,
  parseMiniHash,
  tabFor,
  TAB_ROOTS,
  useMiniRoute,
  type MiniRoute,
  type TabId,
} from './router';
import { ChatsScreen, CONVERSATIONS_KEY } from './screens/ChatsScreen';
import { StepUpProvider } from './stepup/StepUpProvider';
import { bindBackButton, getWebApp, initTelegram, isInTelegram, type TgWebApp } from './telegram';
import { initTheme } from './theme';
import type { Agent } from '../types';
import type { Conversation } from './types';
import { Btn, cx, ErrorState, ScreenBoundary, Skeleton, SkeletonList, Spinner, tapLinkClass, Wordmark } from './ui';

// Every screen except Chats is its own chunk, loaded on first visit (or preloaded on touch).
const agents = () => import('./screens/AgentsScreen');
const agentDetail = () => import('./screens/AgentDetailScreen');
const agentSettings = () => import('./screens/AgentSettingsScreen');
const desktop = () => import('./screens/DesktopScreen');
const activity = () => import('./screens/ActivityScreen');
const settings = () => import('./screens/SettingsScreen');
const vault = () => import('./screens/VaultScreens');
const vaultManager = () => import('./vault/VaultManager');
const automation = () => import('./screens/AutomationScreens');
const companies = () => import('./screens/CompaniesScreen');
const companyDetail = () => import('./screens/CompanyDetailScreen');
const files = () => import('./screens/FilesScreen');
const notifications = () => import('./screens/NotificationsScreen');
const taskDetail = () => import('./screens/TaskDetailScreen');
const workflows = () => import('./screens/WorkflowsScreen');
const signIn = () => import('./screens/AuthScreen');
const admin = () => import('./admin/AdminArea');

const AgentsScreen = lazyNamed(agents, 'AgentsScreen');
const AgentDetailScreen = lazyNamed(agentDetail, 'AgentDetailScreen');
const AgentSettingsScreen = lazyNamed(agentSettings, 'AgentSettingsScreen');
const DesktopScreen = lazyNamed(desktop, 'DesktopScreen');
const ActivityScreen = lazyNamed(activity, 'ActivityScreen');
const SettingsScreen = lazyNamed(settings, 'SettingsScreen');
const ArchivedScreen = lazyNamed(() => import('./screens/ChatsExtras'), 'ArchivedScreen');
const VaultScreen = lazyNamed(vault, 'VaultScreen');
const AgentVaultScreen = lazyNamed(vault, 'AgentVaultScreen');
// the owner manages the vault (create / unlock / credentials / grants / settings); everyone else sees metadata only
const VaultManager = lazyNamed(vaultManager, 'VaultManager');
const AgentVaultManager = lazyNamed(vaultManager, 'AgentVaultManager');
const TeamsScreen = lazyNamed(automation, 'TeamsScreen');
const SchedulesScreen = lazyNamed(automation, 'SchedulesScreen');
const CompaniesScreen = lazyNamed(companies, 'CompaniesScreen');
const CompanyCreateScreen = lazyNamed(companies, 'CompanyCreateScreen');
const CompanyDetailScreen = lazyNamed(companyDetail, 'CompanyDetailScreen');
const CompanyRunScreen = lazyNamed(companyDetail, 'CompanyRunScreen');
const FilesScreen = lazyNamed(files, 'FilesScreen');
const NotificationsScreen = lazyNamed(notifications, 'NotificationsScreen');
const TaskDetailScreen = lazyNamed(taskDetail, 'TaskDetailScreen');
const WorkflowDetailScreen = lazyNamed(workflows, 'WorkflowDetailScreen');
const WorkflowRunScreen = lazyNamed(workflows, 'WorkflowRunScreen');
const WorkflowsScreen = lazyNamed(workflows, 'WorkflowsScreen');
const AuthScreen = lazyNamed(signIn, 'AuthScreen');
const AdminArea = lazyNamed(admin, 'AdminArea');
// an agent's own bot (role "agent_bot"): its agent's tasks, and the notice for everything else
const agentBotScreens = () => import('./screens/AgentBotScreens');
const AgentBotTasksScreen = lazyNamed(agentBotScreens, 'AgentBotTasksScreen');
const AgentBotUnavailableScreen = lazyNamed(agentBotScreens, 'AgentBotUnavailableScreen');
/** Query key of an agent bot's own agent (GET /agents, which the host filters to that agent). */
const AGENT_BOT_AGENT_KEY = 'agent-bot:agents';

/** Starts loading a screen's chunk (deep links: while the Telegram auth exchange runs; tab bar: on touch). */
export function preloadScreen(segments: string[]): void {
  const [a, b, c] = segments;
  switch (a ?? '') {
    case 'chats':
      if (b) void ConversationScreen.preload();
      break;
    case 'agents':
      if (!b) void AgentsScreen.preload();
      else if (b === NEW_AGENT && !c) {
        void AgentsScreen.preload();
        void import('./screens/AgentCreator').catch(() => undefined);
      } else if (!c || c === 'chat') void ConversationScreen.preload();
      else if (c === 'settings') void AgentSettingsScreen.preload();
      else if (c === 'desktop') void DesktopScreen.preload();
      else if (c === 'vault') void vaultManager().catch(() => undefined);
      else void AgentDetailScreen.preload();
      break;
    case 'tasks':
      void (b ? TaskDetailScreen : ActivityScreen).preload();
      break;
    case 'activity':
    case 'approvals':
      void ActivityScreen.preload();
      break;
    case 'settings':
      if (b === 'vault') void vaultManager().catch(() => undefined);
      else void SettingsScreen.preload();
      break;
    case 'companies':
      void (b === 'new' ? CompanyCreateScreen : b ? CompanyDetailScreen : CompaniesScreen).preload();
      break;
    case 'company-runs':
      void CompanyRunScreen.preload();
      break;
    case 'workflows':
    case 'workflow-runs':
      void WorkflowsScreen.preload();
      break;
    case 'files':
      void FilesScreen.preload();
      break;
    case 'notifications':
      void NotificationsScreen.preload();
      break;
    case 'auth':
      void AuthScreen.preload();
      break;
    case 'teams':
    case 'schedules':
      void TeamsScreen.preload();
      break;
    case 'admin':
      void AdminArea.preload();
      break;
    default:
  }
}

function ScreenSkeleton() {
  return (
    <div className="mx-auto w-full max-w-2xl" data-testid="screen-skeleton">
      <div className="mini-topbar -mx-4 mb-3 flex min-h-13 items-center px-4">
        <Skeleton className="h-5 w-40" />
      </div>
      <SkeletonList rows={5} />
    </div>
  );
}

/** Fallback while a conversation / Live Desktop chunk loads: header + bubbles, no tab bar. */
function ChatSkeleton() {
  return (
    <div className="mini-chat" data-testid="screen-skeleton">
      <div className="mini-topbar nb-hairline flex min-h-13 items-center gap-3 px-4">
        <Skeleton className="size-9 rounded-full" />
        <Skeleton className="h-4 w-32" />
      </div>
      <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-3 px-4 pt-6">
        {[55, 35, 70].map((w, i) => (
          <div key={i} className={cx('flex', i % 2 ? 'justify-end' : 'justify-start')}>
            <span aria-hidden className="nb-skel block h-11 rounded-bubble" style={{ width: `${w}%` }} />
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- boot
export function MiniApp({ webApp }: { webApp?: TgWebApp | null }) {
  const wa = webApp === undefined ? getWebApp() : webApp;
  const [boot, setBoot] = useState<BootResult | null>(null);
  const [attempt, setAttempt] = useState(0);
  const started = useRef(false);
  // initData is single-use: one exchange per attempt, even when effects run twice (StrictMode, remounts).
  const pending = useRef<{ n: number; p: Promise<BootResult> } | null>(null);

  useEffect(() => initTelegram(wa), [wa]);
  useEffect(() => initTheme(wa), [wa]);

  useEffect(() => {
    if (!started.current) {
      started.current = true;
      // Strip Telegram's launch params from the URL right away and apply a startapp deep link.
      initRouter(wa?.initDataUnsafe?.start_param ?? null);
      // A deep link's screen chunk downloads in parallel with the initData exchange.
      preloadScreen(parseMiniHash(window.location.hash).segments);
    }
    if (!pending.current || pending.current.n !== attempt) pending.current = { n: attempt, p: bootAuth(wa) };
    let alive = true;
    pending.current.p.then((r) => {
      if (alive) setBoot(r);
    });
    return () => {
      alive = false;
    };
  }, [wa, attempt]);

  if (!boot) {
    return (
      <div className="grid min-h-[var(--mini-vh,100dvh)] place-items-center">
        <div className="flex flex-col items-center gap-4">
          <Wordmark className="text-title" />
          <Spinner className="size-5" label="Connecting to NEBULA…" />
        </div>
      </div>
    );
  }
  if (boot.status !== 'ready') {
    const retry = () => {
      setBoot(null);
      setAttempt((n) => n + 1);
    };
    return <AuthGate result={boot} onRetry={retry} inTelegram={isInTelegram(wa)} />;
  }
  return <ReadyApp boot={boot} inTelegram={isInTelegram(wa)} />;
}

// ---------------------------------------------------------------- not signed in
export function AuthGate({ result, onRetry, inTelegram }: { result: Exclude<BootResult, { status: 'ready' }>; onRetry?: () => void; inTelegram: boolean }) {
  let title: string;
  let body: ReactNode;
  let action: ReactNode = null;
  switch (result.status) {
    case 'reopen':
      title = 'Reopen the Mini App from Telegram';
      body = (
        <>
          This Mini App session has ended or its Telegram launch data was already used ({result.message}). For your security every launch can sign
          in only once. Close this window and open NEBULA again from the bot’s menu button or a message button.
        </>
      );
      action = inTelegram ? (
        <Btn variant="primary" onClick={() => getWebApp()?.close?.()}>
          Close Mini App
        </Btn>
      ) : null;
      break;
    case 'not_paired':
      title = 'This Telegram account is not paired';
      body = (
        <>
          Only a paired and approved NEBULA owner can use the Mini App. Pair this account with the bot in the NEBULA Dashboard (Telegram → Pairing), then
          reopen the Mini App. <span className="block pt-1 text-subtle">{result.message}</span>
        </>
      );
      break;
    case 'login':
      title = result.initialized ? 'Sign in to the NEBULA Dashboard' : 'NEBULA is not set up yet';
      body = (
        <>
          This is the local preview of the Telegram Mini App. It uses your Dashboard session: sign in to the Dashboard in this browser, then come back
          here.
        </>
      );
      action = (
        <a className={tapLinkClass('primary')} href="/">
          Open the Dashboard
        </a>
      );
      break;
    case 'telegram_required':
      title = 'Open NEBULA from Telegram';
      body = <>The Mini App only works when Telegram opens it (the bot’s menu button or a message button). It never accepts passwords or cookies here.</>;
      break;
    default:
      title = 'NEBULA is not reachable';
      body = <>{result.message}</>;
      action = onRetry ? (
        <Btn variant="primary" onClick={onRetry}>
          Try again
        </Btn>
      ) : null;
  }
  return (
    <main className="mini-safe-x mx-auto grid min-h-[var(--mini-vh,100dvh)] max-w-md place-items-center px-6 py-10 text-center">
      <div className="animate-rise">
        <Wordmark className="mb-8 text-body" />
        <h1 className="text-title font-semibold text-text">{title}</h1>
        <p className="mt-2 text-subhead leading-relaxed text-muted">{body}</p>
        {action && <div className="mt-6 flex justify-center">{action}</div>}
      </div>
    </main>
  );
}

// ---------------------------------------------------------------- signed in
function ReadyApp({ boot, inTelegram }: { boot: Extract<BootResult, { status: 'ready' }>; inTelegram: boolean }) {
  const { client } = boot;
  const [expired, setExpired] = useState(false);
  const hub = useMemo<EventHub>(() => (client.mode === 'telegram' ? new StreamEventHub(client) : new EventHub()), [client]);
  const ctx = useMemo<MiniContextValue>(
    () => ({ client, api: createMiniApi(client), session: boot.session, me: boot.me, username: boot.username, inTelegram }),
    [client, boot.session, boot.me, boot.username, inTelegram],
  );

  useEffect(
    () =>
      client.onUnauthorized(() => {
        clearQueryCache();
        setExpired(true);
      }),
    [client],
  );
  // Dashboard modules reused here (administration area, Live Desktop, files) authenticate like the Mini App: the
  // session token in Bearer mode. A layout effect, so it is in place before any child's data effect runs.
  useLayoutEffect(() => setTransport(client.transport()), [client]);

  if (expired) {
    return client.mode === 'telegram' ? (
      <AuthGate inTelegram={inTelegram} result={{ status: 'reopen', code: 'unauthenticated', message: 'the session expired after one hour or was revoked' }} />
    ) : (
      <AuthGate inTelegram={inTelegram} result={{ status: 'login', initialized: true }} />
    );
  }
  return (
    <MiniProvider value={ctx}>
      <StepUpProvider client={client} freshUntil={boot.me?.assurance?.fresh_until ?? null}>
        <EventsProvider hub={hub}>
          <Shell />
        </EventsProvider>
      </StepUpProvider>
    </MiniProvider>
  );
}

/** While a text field has focus on a touch device the tab bar steps aside (nothing fixed over the keyboard). */
function useKeyboardFlag(): void {
  useEffect(() => {
    let coarse = false;
    try {
      coarse = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
    } catch {
      coarse = false;
    }
    if (!coarse) return;
    const root = document.documentElement;
    const isField = (el: EventTarget | null) =>
      el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && !['checkbox', 'radio', 'button', 'submit', 'range', 'file'].includes(el.type)) || (el instanceof HTMLElement && el.isContentEditable);
    let t: ReturnType<typeof setTimeout> | null = null;
    const onIn = (e: FocusEvent) => {
      if (!isField(e.target)) return;
      if (t) clearTimeout(t);
      root.dataset.miniKeyboard = '1';
    };
    const onOut = () => {
      if (t) clearTimeout(t);
      t = setTimeout(() => {
        if (!isField(document.activeElement)) delete root.dataset.miniKeyboard;
      }, 120);
    };
    document.addEventListener('focusin', onIn);
    document.addEventListener('focusout', onOut);
    return () => {
      document.removeEventListener('focusin', onIn);
      document.removeEventListener('focusout', onOut);
      if (t) clearTimeout(t);
      delete root.dataset.miniKeyboard;
    };
  }, []);
}

function Shell() {
  const route = useMiniRoute();
  const online = useOnline();
  const scrolls = useRef(new Map<number, number>());
  const prevIdx = useRef(route.index);
  const agentBot = isAgentBot(useMini());
  useKeyboardFlag();

  // Telegram BackButton mirrors the in-app stack (hidden on tab roots, where Android back closes the app). An open
  // overlay (the sign-in sheet) takes it over: Back closes the overlay first. An agent bot's home is its agent's chat.
  const botParent = agentBot ? agentBotParent(route.segments) : null;
  const root = agentBot ? botParent === null : isTabRoot(route);
  const parent = agentBot ? (botParent ?? '/') : parentPath(route);
  const overlays = useBackDepth();
  useEffect(
    () =>
      bindBackButton(
        root && overlays === 0
          ? null
          : () => {
              if (!popBack()) goBack(parent);
            },
      ),
    [root, parent, overlays],
  );

  // Scroll restoration: back returns to where you were; new screens start at the top.
  useEffect(() => {
    const idx = historyIndex();
    const was = prevIdx.current;
    prevIdx.current = idx;
    if (idx < was && scrolls.current.has(idx)) window.scrollTo(0, scrolls.current.get(idx) ?? 0);
    else window.scrollTo(0, 0);
    const save = () => scrolls.current.set(idx, window.scrollY);
    window.addEventListener('scroll', save, { passive: true });
    return () => window.removeEventListener('scroll', save);
  }, [route.path, route.index]);

  // an agent bot has no tab bar: its agent's chat is home, the agent's tasks are one tap away in the chat header
  const tabs = !agentBot && !hidesTabBar(route);
  const chatLike = agentBot ? agentBotFullScreen(route.segments) : !tabs;
  return (
    <div className="mini-shell">
      {!online && (
        <div role="status" className="mini-banner sticky top-0 z-40 flex items-center justify-center gap-2 bg-warn/15 px-4 py-1.5 text-caption font-medium text-warn">
          <IcAlert className="size-3.5" /> Offline — showing the last loaded data
        </div>
      )}
      <main className="mini-main mini-safe-x" data-tabbar={tabs ? '1' : '0'}>
        <ScreenBoundary resetKey={route.path} fallback={chatLike ? <ChatSkeleton /> : <ScreenSkeleton />}>
          {agentBot ? <AgentBotRoutes route={route} /> : <Routes route={route} />}
        </ScreenBoundary>
      </main>
      {!agentBot && <TabBar active={tabFor(route)} hidden={!tabs} />}
    </div>
  );
}

/** An agent's own bot: only that agent's chat and tasks (see ./agentBot.ts). The host filters GET /agents to it. */
function AgentBotRoutes({ route }: { route: MiniRoute }) {
  const { api } = useMini();
  const agents = useQuery<Agent[]>(AGENT_BOT_AGENT_KEY, (s) => api.agents.list(s));
  if (!agents.data) {
    return agents.error ? (
      <div className="mx-auto max-w-2xl px-1 pt-6">
        <ErrorState error={agents.error} onRetry={agents.reload} title="Could not load this bot’s agent" />
      </div>
    ) : (
      <ChatSkeleton />
    );
  }
  const mine = agents.data[0] ?? null;
  if (!mine) return <AgentBotUnavailableScreen agent={null} />;
  const view = agentBotView(route.segments, mine.id);
  switch (view.kind) {
    case 'chat':
      return view.conversationId ? (
        <ConversationScreen key={`c:${view.conversationId}`} conversationId={view.conversationId} />
      ) : (
        <ConversationScreen key={`a:${mine.id}`} agentId={mine.id} />
      );
    case 'desktop':
      return <DesktopScreen key={mine.id} agentId={mine.id} />;
    case 'tasks':
      return <AgentBotTasksScreen agent={mine} />;
    case 'task':
      return <TaskDetailScreen key={view.taskId} taskId={view.taskId} />;
    default:
      return <AgentBotUnavailableScreen agent={mine} />;
  }
}

function Routes({ route }: { route: MiniRoute }) {
  const [a, b, c] = route.segments;
  const owner = canManageVault(useMini());
  switch (a ?? '') {
    case '':
      return <ChatsScreen />;
    case 'chats':
      return b ? <ConversationScreen key={`c:${b}`} conversationId={b} /> : <ChatsScreen />;
    case 'archived':
      return <ArchivedScreen />;
    case 'agents':
      if (!b) return <AgentsScreen />;
      if (b === NEW_AGENT && !c) return <AgentsScreen creating />;
      if (!c || c === 'chat') return <ConversationScreen key={`a:${b}`} agentId={b} />;
      if (c === 'settings') return <AgentSettingsScreen key={b} agentId={b} />;
      if (c === 'desktop') return <DesktopScreen key={b} agentId={b} />;
      if (c === 'vault') return owner ? <AgentVaultManager key={b} agentId={b} /> : <AgentVaultScreen key={b} agentId={b} />;
      return <AgentDetailScreen key={b} agentId={b} section={c} query={route.query} />;
    case 'tasks':
      return b ? <TaskDetailScreen key={b} taskId={b} /> : <ActivityScreen />;
    case 'activity':
      return <ActivityScreen />;
    case 'approvals':
      return <ActivityScreen focus="approvals" />;
    case 'companies':
      if (b === 'new') return <CompanyCreateScreen />;
      return b ? <CompanyDetailScreen key={b} companyId={b} tab={c ?? 'overview'} /> : <CompaniesScreen />;
    case 'company-runs':
      return b ? <CompanyRunScreen key={b} runId={b} /> : <CompaniesScreen />;
    case 'workflows':
      return b ? <WorkflowDetailScreen key={b} workflowId={b} /> : <WorkflowsScreen />;
    case 'workflow-runs':
      return b ? <WorkflowRunScreen key={b} runId={b} /> : <WorkflowsScreen />;
    case 'files':
      return <FilesScreen query={route.query} />;
    case 'notifications':
      return <NotificationsScreen />;
    case 'auth':
      return b ? <AuthScreen key={b} sessionId={b} /> : <ActivityScreen />;
    case 'teams':
      return <TeamsScreen />;
    case 'schedules':
      return <SchedulesScreen />;
    case 'settings':
      if (b === 'vault') return owner ? <VaultManager sub={route.segments.slice(2)} /> : <VaultScreen />;
      return <SettingsScreen page={b ?? null} />;
    case 'more':
      return <SettingsScreen page={null} />;
    case 'admin':
      return <AdminArea segments={route.segments.slice(1)} query={route.query} />;
    default:
      return (
        <div className="mini-topbar mx-auto max-w-2xl px-1 pt-6">
          <h1 className="text-title font-semibold text-text">Not found</h1>
          <p className="mt-1 text-subhead text-muted">
            This screen does not exist.{' '}
            <a className="text-accent-soft underline" href={mhref('/')}>
              Back to Chats
            </a>
          </p>
        </div>
      );
  }
}

const TABS: { id: TabId; label: string; icon: ReactNode }[] = [
  { id: 'chats', label: 'Chats', icon: <IcChats /> },
  { id: 'agents', label: 'Agents', icon: <IcAgents /> },
  { id: 'activity', label: 'Activity', icon: <IcActivity /> },
  { id: 'settings', label: 'Settings', icon: <IcSettings /> },
];

function TabBar({ active, hidden }: { active: TabId; hidden: boolean }) {
  const ctx = useMini();
  const { api } = ctx;
  // One shared request per key: the Activity screen and this badge use the same query. The badge counts what waits
  // for a decision, so only the owner (who can decide) polls it.
  const pending = useQuery(canDecide(ctx) ? 'approvals:count' : null, (s) => api.approvals.center(s), {
    refreshOn: approvalCenterEvent,
    pollMs: 30_000,
  });
  // Unread total only from what Chats already loaded (never an extra request).
  const convs = useCachedQuery<Conversation[]>(CONVERSATIONS_KEY);
  const unread = (convs ?? []).reduce((n, c) => n + (c.unread_count > 0 ? 1 : 0), 0);
  // approvals and active sign-ins (approval-center `sign_ins`): one object each, no extra request
  const approvals = (pending.data?.pending.length ?? 0) + (pending.data?.sign_ins?.length ?? 0);
  return (
    <nav aria-label="Primary" data-hidden={hidden ? '1' : '0'} aria-hidden={hidden || undefined} className="mini-tabbar nb-hairline-t fixed inset-x-0 z-50">
      <ul className="mini-safe-x mx-auto flex max-w-2xl">
        {TABS.map((t) => {
          const on = t.id === active;
          const badge = t.id === 'activity' ? approvals : t.id === 'chats' ? unread : 0;
          const label = t.id === 'activity' && badge ? `${t.label}, ${badge} pending` : t.id === 'chats' && badge ? `${t.label}, ${badge} unread` : t.label;
          return (
            <li key={t.id} className="flex-1">
              <a
                href={mhref(TAB_ROOTS[t.id])}
                tabIndex={hidden ? -1 : undefined}
                onPointerDown={() => preloadScreen([TAB_ROOTS[t.id].split('/')[1] ?? ''])}
                aria-current={on ? 'page' : undefined}
                aria-label={label}
                className={cx(
                  'mini-tab nb-press relative flex flex-col items-center justify-center gap-0.5 text-[10.5px] font-medium focus-ring',
                  on ? 'text-accent' : 'text-subtle',
                )}
              >
                {t.icon}
                <span aria-hidden>{t.label}</span>
                {badge > 0 && (
                  <span aria-hidden className={cx('mini-tab-badge absolute rounded-full px-1 text-center text-[11px] font-semibold text-white', t.id === 'activity' ? 'bg-danger' : 'bg-accent-fill')}>
                    {badge > 99 ? '99+' : badge}
                  </span>
                )}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
