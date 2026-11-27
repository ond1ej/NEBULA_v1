import { useCallback, useEffect, useRef, useState } from 'react';
import { api, onUnauthorized, setCsrfToken } from './api';
import { ApprovalsProvider } from './components/Approval';
import { LazyBoundary } from './components/LazyBoundary';
import { Layout } from './components/Layout';
import { SmartAuthProvider } from './features/smartauth/SmartAuthProvider';
import { BrandMark } from './components/SideNav';
import { useToast } from './components/Toast';
import { Button, ErrorBanner, Spinner } from './components/ui';
import { EventsProvider, useEventStatus } from './hooks/useEvents';
import { navigate, parseHash, useHashRoute, type Route } from './hooks/useHashRoute';
import { HealthProvider } from './hooks/useHealth';
import { DashboardRoutes } from './pages/DashboardRoutes';
import { lazyNamed } from './lib/lazy';
import { preloadRoute } from './pages/lazyPages';
import type { AuthState, LoginResult } from './types';
import { t } from './i18n';

const auth = () => import('./pages/AuthPages');
const LoginPage = lazyNamed(auth, 'LoginPage');
const SetupPage = lazyNamed(auth, 'SetupPage');

// Fetch the first screen's chunk while the auth state request is in flight.
if (typeof window !== 'undefined') {
  const first = parseHash(window.location.hash).segments;
  if (first[0] === 'setup') void SetupPage.preload();
  else if (first[0] === 'login') void LoginPage.preload();
  else preloadRoute(first);
}

/**
 * /health is public, so an expired session may otherwise go unnoticed while the event stream keeps
 * failing. When the stream drops, re-check the session and return to the login screen if it ended.
 */
function SessionWatcher({ onEnded }: { onEnded: () => void }) {
  const status = useEventStatus();
  useEffect(() => {
    if (status !== 'reconnecting') return;
    let cancelled = false;
    api.auth
      .state()
      .then((s) => {
        if (!cancelled && !s.authenticated) onEnded();
      })
      .catch((e: unknown) => console.warn('NEBULA: session check failed (host unreachable?)', e));
    return () => {
      cancelled = true;
    };
  }, [status, onEnded]);
  return null;
}

function BootScreen() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-bg p-6">
      <BrandMark className="size-10" />
      <Spinner className="size-5" label="Connecting to NEBULA…" />
    </div>
  );
}

export function activeNav(route: Route): string {
  const s = route.segments[0];
  if (!s || s === 'overview' || s === 'setup' || s === 'login') return 'overview';
  return s;
}

const TITLES: Record<string, string> = {
  overview: 'Command Center',
  agents: 'Agents',
  companies: 'AI Companies',
  approvals: 'Approval Center',
  teams: 'Teams',
  tasks: 'Tasks',
  schedules: 'Schedules',
  workflows: 'Workflows',
  memory: 'Memory',
  files: 'Files',
  skills: 'Skills',
  resources: 'Resource Monitor',
  providers: 'AI Providers',
  telegram: 'Telegram',
  bots: 'Bot Network',
  host: 'Host Access',
  remote: 'Remote Access',
  voice: 'Voice',
  system: 'System',
  settings: 'Settings',
  vault: 'Password Vault',
  devices: t('nav.devices'),
};

export function App() {
  const route = useHashRoute();
  const toast = useToast();
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [authError, setAuthError] = useState<unknown>(null);
  const [loggingOut, setLoggingOut] = useState(false);

  // hash routing does not reset the scroll position between pages
  useEffect(() => {
    window.scrollTo?.(0, 0);
  }, [route.path]);

  const section = activeNav(route);
  useEffect(() => {
    document.title = `${TITLES[section] ?? 'NEBULA'} · NEBULA`;
  }, [section]);

  const loadAuth = useCallback(async () => {
    setAuthError(null);
    try {
      const s = await api.auth.state();
      setCsrfToken(s.csrf_token);
      setAuth(s);
    } catch (e) {
      setAuthError(e);
      toast.error(e, 'Cannot reach NEBULA');
    }
  }, [toast]);

  useEffect(() => {
    void loadAuth();
  }, [loadAuth]);

  const signedOut = useCallback(() => {
    setCsrfToken(null);
    setAuth((a) => (a ? { ...a, authenticated: false, user: null, csrf_token: null } : a));
  }, []);

  const sessionEnded = useCallback(() => {
    toast.info('Session ended', 'Please sign in again.');
    signedOut();
  }, [toast, signedOut]);

  const authRef = useRef(auth);
  authRef.current = auth;
  useEffect(
    () =>
      onUnauthorized(() => {
        const a = authRef.current;
        if (a?.authenticated) {
          authRef.current = { ...a, authenticated: false }; // several parallel 401s -> one notice
          sessionEnded();
        } else setCsrfToken(null);
      }),
    [sessionEnded],
  );

  const signedIn = (r: LoginResult) => {
    setCsrfToken(r.csrf_token);
    setAuth({ initialized: true, authenticated: true, user: { username: r.user.username }, csrf_token: r.csrf_token });
    if (route.segments[0] === 'setup' || route.segments[0] === 'login') navigate('/overview', { replace: true });
  };

  const logout = async () => {
    setLoggingOut(true);
    try {
      await api.auth.logout();
      toast.success('Signed out');
      signedOut();
    } catch (e) {
      toast.error(e, 'Logout failed');
    } finally {
      setLoggingOut(false);
    }
  };

  if (!auth) {
    return authError ? (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-bg p-6">
        <BrandMark className="size-10" />
        <div className="w-full max-w-lg space-y-3">
          <ErrorBanner error={authError} title="Cannot reach the NEBULA host service" />
          <Button onClick={() => void loadAuth()}>Retry</Button>
        </div>
      </div>
    ) : (
      <BootScreen />
    );
  }

  if (!auth.initialized) {
    const token = route.segments[0] === 'setup' ? route.query.get('token') : null;
    return (
      <LazyBoundary fallback={<BootScreen />}>
        <SetupPage initialToken={token} onDone={signedIn} />
      </LazyBoundary>
    );
  }

  if (!auth.authenticated) {
    return (
      <LazyBoundary fallback={<BootScreen />}>
        <LoginPage onDone={signedIn} />
      </LazyBoundary>
    );
  }

  return (
    <EventsProvider>
      <HealthProvider>
        <ApprovalsProvider>
          <SmartAuthProvider>
            <Layout active={section} username={auth.user?.username ?? null} onLogout={logout} loggingOut={loggingOut}>
              <LazyBoundary resetKey={route.path}>
                <DashboardRoutes route={route} username={auth.user?.username ?? null} onLogout={logout} onSignedOut={signedOut} loggingOut={loggingOut} />
              </LazyBoundary>
            </Layout>
            <SessionWatcher onEnded={sessionEnded} />
          </SmartAuthProvider>
        </ApprovalsProvider>
      </HealthProvider>
    </EventsProvider>
  );
}
