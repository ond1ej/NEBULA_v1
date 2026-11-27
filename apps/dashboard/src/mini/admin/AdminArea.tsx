// Administration area of the Telegram Mini App (V3.3, its own lazy chunk + lazily loaded stylesheet): the verified owner
// of the main bot gets every page of the local Dashboard, reused as is, under #/admin/<dashboard path>.
//
//  * Requests: the Dashboard modules call lib/http, whose transport is the Mini App session (Bearer token) — installed
//    by the Mini App shell (App.tsx). Authorization stays on the host; sensitive actions answer 403 `stepup_required`
//    and the shell's StepUpProvider asks ONE confirmation (Face ID, the vault passphrase or the NEBULA password), then
//    the request is retried once.
//  * Links: while this area is mounted the Dashboard's href()/navigate() add the '/admin' route base, so every page
//    links inside the Mini App (and Telegram's BackButton follows the Mini App history).
//  * Styles: admin.css (loaded with this chunk) holds the Dashboard's utilities, scoped to <html data-nb-admin>, which
//    is set only while this area is shown — the rest of the Mini App never changes appearance.
//  * Events: the pages use the Mini App's event hub (<EventsProvider> of the shell); no second stream is opened.
//  * Back: the pages' dialogs (Modal, Drawer, ConfirmDialog, the sign-in modal) register with the Mini App's back stack,
//    so Telegram's BackButton closes the top-most dialog first and only then navigates back.
import './admin.css';
import { useCallback, useLayoutEffect, useState, type ReactNode } from 'react';
import { api as dashboardApi, ApiError } from '../../api';
import { ApprovalsProvider } from '../../components/Approval';
import { LazyBoundary } from '../../components/LazyBoundary';
import { setDialogBackRegistrar } from '../../components/Modal';
import { setOwnerConfirmBridge } from '../../features/smartauth/api';
import { SmartAuthProvider } from '../../features/smartauth/SmartAuthProvider';
import { getRouteBase, setRouteBase } from '../../hooks/useHashRoute';
import { HealthProvider } from '../../hooks/useHealth';
import { DashboardRoutes } from '../../pages/DashboardRoutes';
import { logoutMini } from '../auth';
import { pushBack } from '../backStack';
import { isAdmin, useMini } from '../context';
import { clearQueryCache } from '../hooks';
import { mhref, navigate } from '../router';
import { useOwnerConfirm } from '../stepup/StepUpProvider';
import { Screen } from '../uiKit';
import { Notice } from '../uiExtra';
import { AdminHub } from './AdminHub';
import { ADMIN_TITLES } from './sections';
import { t } from '../../i18n';

export const ADMIN_BASE = '/admin';

/** Route base, the stylesheet scope and Back for dialogs, for exactly as long as the area is mounted. */
function useAdminMode(): void {
  // set during render: the pages call href() while rendering, before any effect runs
  if (getRouteBase() !== ADMIN_BASE) setRouteBase(ADMIN_BASE);
  useLayoutEffect(() => {
    const root = document.documentElement;
    setRouteBase(ADMIN_BASE);
    root.dataset.nbAdmin = '1';
    setDialogBackRegistrar(pushBack);
    return () => {
      setRouteBase('');
      delete root.dataset.nbAdmin;
      setDialogBackRegistrar(null);
    };
  }, []);
}

/** Dashboard sections that the Mini App shows with its own screens instead. */
export function nativeRedirect(segments: string[]): string | null {
  const [s0, s1, s2] = segments;
  if (s0 === 'vault') return '/settings/vault';
  if (s0 === 'agents' && s1 && s1 !== 'new' && s2 === 'live') return `/agents/${s1}/desktop`;
  if (s0 === 'setup' || s0 === 'login') return ADMIN_BASE;
  return null;
}

function Redirect({ to }: { to: string }) {
  useLayoutEffect(() => navigate(to, { replace: true }), [to]);
  return null;
}

/** The Dashboard's sign-in modal asks the owner's ONE confirmation (V4.0) instead of the remote PIN while shown here. */
function useOwnerConfirmBridge(admin: boolean): void {
  const confirm = useOwnerConfirm();
  useLayoutEffect(() => {
    if (!admin) return;
    return setOwnerConfirmBridge(({ unlockVault }) => confirm({ unlockVault, reason: unlockVault ? t('confirm.reason.signinVault') : t('confirm.reason.signinSend') }));
  }, [admin, confirm]);
}

export function AdminArea({ segments, query }: { segments: string[]; query: URLSearchParams }) {
  const ctx = useMini();
  useAdminMode();
  useOwnerConfirmBridge(isAdmin(ctx));
  if (!isAdmin(ctx)) {
    return (
      <Screen title="Administration">
        <Notice tone="warning" title="Only for the NEBULA owner">
          Administration is available to the verified owner of the main NEBULA bot.{' '}
          <a className="text-accent-soft underline" href={mhref('/settings')}>
            Back to Settings
          </a>
        </Notice>
      </Screen>
    );
  }
  const redirect = segments.length ? nativeRedirect(segments) : null;
  return (
    <HealthProvider>
      <ApprovalsProvider>
        <SmartAuthProvider>{redirect ? <Redirect to={redirect} /> : segments.length === 0 ? <AdminHub /> : <AdminPage segments={segments} query={query} />}</SmartAuthProvider>
      </ApprovalsProvider>
    </HealthProvider>
  );
}

function AdminPage({ segments, query }: { segments: string[]; query: URLSearchParams }) {
  const { client, username, session } = useMini();
  const [loggingOut, setLoggingOut] = useState(false);
  const path = `/${segments.map(encodeURIComponent).join('/')}`;

  // The Dashboard's Settings page signs out / reports a password change that ended every session.
  const ended = useCallback(
    (message: string) => {
      clearQueryCache();
      client.invalidate(new ApiError(401, 'unauthenticated', message));
    },
    [client],
  );
  const logout = useCallback(async () => {
    setLoggingOut(true);
    try {
      if (client.mode === 'telegram') await logoutMini(client);
      else await dashboardApi.auth.logout();
    } catch {
      // the session is forgotten locally either way
    } finally {
      setLoggingOut(false);
      ended('you signed out');
    }
  }, [client, ended]);

  const name = username ?? ([session?.telegram_user?.first_name, session?.telegram_user?.last_name].filter(Boolean).join(' ') || null);
  return (
    <Screen title={ADMIN_TITLES[segments[0]] ?? 'Administration'} subtitle="Administration" wide>
      <AdminPageBody>
        <LazyBoundary resetKey={path}>
          <DashboardRoutes
            route={{ path, segments, query }}
            username={name}
            onLogout={() => void logout()}
            onSignedOut={() => ended('the password was changed')}
            loggingOut={loggingOut}
          />
        </LazyBoundary>
      </AdminPageBody>
    </Screen>
  );
}

/** The Dashboard's base text style (14 px / 1.5) inside the Mini App's 15 px body. */
function AdminPageBody({ children }: { children: ReactNode }) {
  return (
    <div className="nb-admin-page pt-2" data-testid="admin-page">
      {children}
    </div>
  );
}
