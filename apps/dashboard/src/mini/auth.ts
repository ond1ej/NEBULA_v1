// Mini App boot: decides the auth mode and produces a ready MiniClient (or a screen explaining what to do).
import { ApiError, buildUrl, errorMessage, parseError } from '../lib/http';
import type { AuthState } from '../types';
import { clearStoredSession, loadStoredSession, MiniClient, storeSession, type MiniSession } from './client';
import { isInTelegram, type TgWebApp } from './telegram';
import type { MiniMe } from './types';

export type BootResult =
  | { status: 'ready'; client: MiniClient; session: MiniSession | null; me: MiniMe | null; username: string | null }
  /** Telegram initData was refused (expired, replayed, bad signature) or the Mini App session ended. */
  | { status: 'reopen'; code: string; message: string }
  /** The Telegram account is not a paired, approved NEBULA owner. */
  | { status: 'not_paired'; message: string }
  /** Local preview without a dashboard login. */
  | { status: 'login'; initialized: boolean }
  /** Opened through the public gateway in a normal browser (no Telegram, no cookies allowed). */
  | { status: 'telegram_required' }
  | { status: 'error'; message: string };

const AUTH_PATH = '/api/mini/auth';

async function exchange(initData: string): Promise<MiniSession> {
  let res: Response;
  try {
    res = await fetch(AUTH_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ init_data: initData }),
      credentials: 'omit',
      cache: 'no-store',
    });
  } catch (e) {
    throw new ApiError(0, 'network_error', `Cannot reach NEBULA (${errorMessage(e)})`);
  }
  if (!res.ok) throw await parseError(res);
  const j = (await res.json()) as { data?: MiniSession };
  if (!j?.data?.token) throw new ApiError(res.status, 'bad_envelope', 'The Mini App login response is incomplete');
  return j.data;
}

/** Telegram user id from the (unverified, display-only) initDataUnsafe; used to avoid reusing another user's token. */
function telegramUserId(wa: TgWebApp | null): number | null {
  const id = wa?.initDataUnsafe?.user?.id;
  return typeof id === 'number' ? id : null;
}

async function bootTelegram(wa: TgWebApp): Promise<BootResult> {
  const uid = telegramUserId(wa);
  const stored = loadStoredSession();
  if (stored && (uid === null || stored.telegram_user?.id === uid)) {
    // A reload inside the same Telegram view: initData was already exchanged, reuse the session.
    const client = new MiniClient({ mode: 'telegram', token: stored.token, csrf: stored.csrf_token });
    try {
      const me = await client.request<MiniMe>('/miniapp/me');
      return { status: 'ready', client, session: stored, me, username: me.username ?? null };
    } catch (e) {
      if (e instanceof ApiError && e.status === 0) return { status: 'error', message: e.message };
      // expired / revoked: fall through and exchange the current initData
      clearStoredSession();
    }
  } else if (stored) {
    clearStoredSession();
  }
  let session: MiniSession;
  try {
    session = await exchange(wa.initData);
  } catch (e) {
    if (e instanceof ApiError) {
      if (e.code === 'not_paired') return { status: 'not_paired', message: e.message };
      if (e.status === 401 || e.status === 400 || e.code === 'replayed' || e.code === 'expired') {
        return { status: 'reopen', code: e.code, message: e.message };
      }
      return { status: 'error', message: e.message };
    }
    return { status: 'error', message: errorMessage(e) };
  }
  storeSession(session);
  const client = new MiniClient({ mode: 'telegram', token: session.token, csrf: session.csrf_token });
  let me: MiniMe | null = null;
  try {
    me = await client.request<MiniMe>('/miniapp/me');
  } catch {
    me = null; // informational only; the session itself is valid
  }
  return { status: 'ready', client, session, me, username: me?.username ?? null };
}

async function bootCookie(): Promise<BootResult> {
  let res: Response;
  try {
    res = await fetch(buildUrl('/auth/state'), { headers: { Accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store' });
  } catch (e) {
    return { status: 'error', message: `Cannot reach NEBULA (${errorMessage(e)})` };
  }
  if (!res.ok) {
    const err = await parseError(res);
    // The public Mini App gateway refuses everything that is not on its allow-list (cookies are never accepted there).
    if (err.code === 'not_available_remotely' || err.status === 401) return { status: 'telegram_required' };
    return { status: 'error', message: err.message };
  }
  const st = ((await res.json()) as { data: AuthState }).data;
  if (!st.authenticated) return { status: 'login', initialized: st.initialized };
  const client = new MiniClient({ mode: 'cookie', csrf: st.csrf_token });
  let me: MiniMe | null = null;
  try {
    me = await client.request<MiniMe>('/miniapp/me');
  } catch {
    me = null;
  }
  return { status: 'ready', client, session: null, me, username: st.user?.username ?? null };
}

export function bootAuth(wa: TgWebApp | null): Promise<BootResult> {
  return isInTelegram(wa) && wa ? bootTelegram(wa) : bootCookie();
}

/** POST /api/mini/logout (gateway) and forget the token. */
export async function logoutMini(client: MiniClient): Promise<void> {
  if (client.mode !== 'telegram') return;
  try {
    await fetch(AUTH_PATH.replace('/auth', '/logout'), {
      method: 'POST',
      headers: client.headers('POST'),
      credentials: 'omit',
      cache: 'no-store',
    });
  } finally {
    clearStoredSession();
  }
}
