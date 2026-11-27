import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api';
import { apiError, installFetch, ok } from '../test/fetchMock';
import { bootAuth, logoutMini } from './auth';
import { loadStoredSession, MiniClient, SESSION_KEY, type MiniSession } from './client';
import type { TgWebApp } from './telegram';

const INIT = 'query_id=AAH&user=%7B%22id%22%3A42%2C%22first_name%22%3A%22Ada%22%7D&auth_date=1700000000&hash=abcdef';

function webApp(over: Partial<TgWebApp> = {}): TgWebApp {
  return { initData: INIT, initDataUnsafe: { user: { id: 42, first_name: 'Ada' } }, ...over };
}

function session(over: Partial<MiniSession> = {}): MiniSession {
  return {
    token: 'mini-token-1',
    csrf_token: 'mini-csrf',
    session_id: 'sess-1',
    expires_at: Date.now() / 1000 + 3600,
    telegram_user: { id: 42, first_name: 'Ada' },
    bot: 'main',
    permissions: ['tasks', 'commands', 'desktop', 'approvals'],
    start_param: null,
    ...over,
  };
}

const me = { session_id: 'sess-1', telegram_user_id: 42, bot: 'main', permissions: ['tasks'], expires_in: 3600 };

describe('Mini App auth (Telegram initData → Bearer session)', () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(() => {
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it('exchanges initData once at /api/mini/auth, stores the token in sessionStorage and uses Bearer auth', async () => {
    const { calls } = installFetch({
      'POST /api/mini/auth': () => ok(session()),
      'GET /api/v1/miniapp/me': () => ok(me),
      'GET /api/v1/agents': () => ok([]),
      'POST /api/v1/agents/a1/tasks': () => ok({ id: 't1', state: 'QUEUED' }, 201),
    });
    const r = await bootAuth(webApp());
    expect(r.status).toBe('ready');
    if (r.status !== 'ready') return;

    const auth = calls.filter((c) => c.path === '/api/mini/auth');
    expect(auth).toHaveLength(1);
    expect(auth[0].body).toEqual({ init_data: INIT });
    expect(auth[0].init.credentials).toBe('omit');

    expect(JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? '{}').token).toBe('mini-token-1');
    expect(r.client.mode).toBe('telegram');

    await r.client.request('/agents');
    const list = calls.find((c) => c.path === '/api/v1/agents');
    expect(list?.headers.authorization).toBe('Bearer mini-token-1');
    expect(list?.init.credentials).toBe('omit');
    expect(list?.headers['x-csrf-token']).toBeUndefined();

    await r.client.request('/agents/a1/tasks', { method: 'POST', body: { prompt: 'hi', attachment_ids: [] } });
    const post = calls.find((c) => c.method === 'POST' && c.path === '/api/v1/agents/a1/tasks');
    expect(post?.headers.authorization).toBe('Bearer mini-token-1');
    expect(post?.headers['x-csrf-token']).toBeUndefined();
  });

  it('reuses a stored session after a reload instead of replaying the single-use initData', async () => {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session({ token: 'stored-token' })));
    const { calls } = installFetch({
      'POST /api/mini/auth': () => apiError(401, 'replayed', 'this initData was already used; reopen the Mini App'),
      'GET /api/v1/miniapp/me': () => ok(me),
    });
    const r = await bootAuth(webApp());
    expect(r.status).toBe('ready');
    expect(calls.some((c) => c.path === '/api/mini/auth')).toBe(false);
    expect(calls.find((c) => c.path === '/api/v1/miniapp/me')?.headers.authorization).toBe('Bearer stored-token');
  });

  it('does not reuse a stored session that belongs to another Telegram user', async () => {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session({ token: 'other-user', telegram_user: { id: 7 } })));
    const { calls } = installFetch({
      'POST /api/mini/auth': () => ok(session({ token: 'fresh' })),
      'GET /api/v1/miniapp/me': () => ok(me),
    });
    const r = await bootAuth(webApp());
    expect(r.status).toBe('ready');
    expect(calls.filter((c) => c.path === '/api/mini/auth')).toHaveLength(1);
    expect(loadStoredSession()?.token).toBe('fresh');
  });

  it('asks to reopen the Mini App when initData is refused (replayed / expired / bad signature)', async () => {
    installFetch({ 'POST /api/mini/auth': () => apiError(401, 'replayed', 'this initData was already used; reopen the Mini App') });
    const r = await bootAuth(webApp());
    expect(r).toEqual({ status: 'reopen', code: 'replayed', message: 'this initData was already used; reopen the Mini App' });
    expect(sessionStorage.getItem(SESSION_KEY)).toBeNull();
  });

  it('explains when the Telegram account is not a paired owner', async () => {
    installFetch({ 'POST /api/mini/auth': () => apiError(403, 'not_paired', 'this Telegram account is not a paired NEBULA owner') });
    const r = await bootAuth(webApp());
    expect(r.status).toBe('not_paired');
  });

  it('a 401 on any later call invalidates the session once, clears the token and notifies the app', async () => {
    installFetch({
      'POST /api/mini/auth': () => ok(session()),
      'GET /api/v1/miniapp/me': () => ok(me),
      'GET /api/v1/agents': () => apiError(401, 'unauthenticated', 'Mini App session required'),
    });
    const r = await bootAuth(webApp());
    if (r.status !== 'ready') throw new Error('not ready');
    const onExpired = vi.fn();
    r.client.onUnauthorized(onExpired);
    await expect(r.client.request('/agents')).rejects.toBeInstanceOf(ApiError);
    await expect(r.client.request('/agents')).rejects.toMatchObject({ status: 401 });
    expect(onExpired).toHaveBeenCalledTimes(1);
    expect(r.client.isExpired).toBe(true);
    expect(sessionStorage.getItem(SESSION_KEY)).toBeNull();
  });

  it('never puts the token into error messages', async () => {
    installFetch({
      'POST /api/mini/auth': () => ok(session({ token: 'super-secret-token' })),
      'GET /api/v1/miniapp/me': () => ok(me),
      'GET /api/v1/tasks': () => apiError(500, 'internal', 'boom'),
    });
    const r = await bootAuth(webApp());
    if (r.status !== 'ready') throw new Error('not ready');
    const err = await r.client.request('/tasks').catch((e: unknown) => e);
    expect(String((err as Error).message)).not.toContain('super-secret-token');
  });

  it('logout calls POST /api/mini/logout with the Bearer token and forgets it', async () => {
    const { calls } = installFetch({
      'POST /api/mini/auth': () => ok(session()),
      'GET /api/v1/miniapp/me': () => ok(me),
      'POST /api/mini/logout': () => ok({ logged_out: true }),
    });
    const r = await bootAuth(webApp());
    if (r.status !== 'ready') throw new Error('not ready');
    await logoutMini(r.client);
    const out = calls.find((c) => c.path === '/api/mini/logout');
    expect(out?.method).toBe('POST');
    expect(out?.headers.authorization).toBe('Bearer mini-token-1');
    expect(sessionStorage.getItem(SESSION_KEY)).toBeNull();
  });
});

describe('Mini App auth (local preview with the Dashboard cookie session)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses the cookie session and sends the CSRF token on mutations only', async () => {
    const { calls } = installFetch({
      'GET /api/v1/auth/state': () => ok({ initialized: true, authenticated: true, user: { username: 'owner' }, csrf_token: 'csrf-cookie' }),
      'GET /api/v1/miniapp/me': () => ok({ mode: 'dashboard', username: 'owner', permissions: ['tasks'] }),
      'GET /api/v1/agents': () => ok([]),
      'POST /api/v1/agents/a1/wake': () => ok({ id: 'a1' }),
    });
    const r = await bootAuth(webApp({ initData: '' }));
    expect(r.status).toBe('ready');
    if (r.status !== 'ready') return;
    expect(r.client.mode).toBe('cookie');
    expect(r.username).toBe('owner');
    expect(calls.some((c) => c.path === '/api/mini/auth')).toBe(false);

    await r.client.request('/agents');
    const get = calls.find((c) => c.path === '/api/v1/agents');
    expect(get?.headers.authorization).toBeUndefined();
    expect(get?.headers['x-csrf-token']).toBeUndefined();
    expect(get?.init.credentials).toBe('same-origin');

    await r.client.request('/agents/a1/wake', { method: 'POST' });
    expect(calls.find((c) => c.method === 'POST')?.headers['x-csrf-token']).toBe('csrf-cookie');
  });

  it('without a Dashboard login it asks to sign in to the Dashboard', async () => {
    installFetch({ 'GET /api/v1/auth/state': () => ok({ initialized: true, authenticated: false, user: null, csrf_token: null }) });
    expect(await bootAuth(null)).toEqual({ status: 'login', initialized: true });
  });

  it('through the public gateway without Telegram it explains that Telegram must open it', async () => {
    installFetch({ 'GET /api/v1/auth/state': () => apiError(403, 'not_available_remotely', 'this action is only available in the local Dashboard') });
    expect(await bootAuth(null)).toEqual({ status: 'telegram_required' });
  });

  it('reports an unreachable host', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    const r = await bootAuth(null);
    expect(r.status).toBe('error');
  });
});

describe('MiniClient', () => {
  it('appends the Mini App session token to the Live Desktop WebSocket URL in Bearer mode only', () => {
    const loc = { protocol: 'https:', host: 'nebula.example.ts.net' };
    const tg = new MiniClient({ mode: 'telegram', token: 'mini/tok+=' });
    expect(tg.wsUrl('/api/v1/live/ws/s1', 'view/tok', loc)).toBe(
      `wss://nebula.example.ts.net/api/v1/live/ws/s1?token=${encodeURIComponent('view/tok')}&session_token=${encodeURIComponent('mini/tok+=')}`,
    );
    const cookie = new MiniClient({ mode: 'cookie', csrf: 'x' });
    expect(cookie.wsUrl('/api/v1/live/ws/s1', 'view', { protocol: 'http:', host: '127.0.0.1:3101' })).toBe('ws://127.0.0.1:3101/api/v1/live/ws/s1?token=view');
  });

  it('sends multipart uploads without forcing a Content-Type (the browser adds the boundary)', async () => {
    const { calls } = installFetch({ 'POST /api/v1/agents/a1/attachments': () => ok({ id: 'att1' }, 201) });
    const c = new MiniClient({ mode: 'telegram', token: 't' });
    const fd = new FormData();
    fd.append('file', new Blob(['x']), 'x.txt');
    await c.request('/agents/a1/attachments', { method: 'POST', formData: fd });
    const call = calls[0];
    expect(call.headers['content-type']).toBeUndefined();
    expect(call.init.body).toBeInstanceOf(FormData);
    vi.unstubAllGlobals();
  });
});
