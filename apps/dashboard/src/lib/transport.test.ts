// Pluggable transport of lib/http (V3.3): the Dashboard's cookie + CSRF default, the Mini App's Bearer transport for
// reused Dashboard modules (request / requestBlob, XHR uploads, downloads, event stream, Live Desktop WebSocket URL),
// the one-time retry after a step-up confirmation and the 401 handling.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { dashboardLiveClient, wsUrl } from '../components/LiveDesktop';
import { uploadAttachment } from '../features/attachments/api';
import { uploadFile } from '../features/files/api';
import { downloadFile } from '../features/files/download';
import { EventHub } from '../hooks/useEvents';
import { MiniClient } from '../mini/client';
import { installXhrOverFetch } from '../mini/test/kit';
import { apiError, installFetch, ok } from '../test/fetchMock';
import { cookieTransport, getTransport, onUnauthorized, request, requestBlob, setCsrfToken, setTransport } from './http';

vi.mock('@novnc/novnc', () => ({ default: class {} }));

const bearer = () => new MiniClient({ mode: 'telegram', token: 'tok-1', csrf: 'csrf-1' });

describe('lib/http transport', () => {
  let restore: (() => void) | null = null;
  beforeEach(() => {
    setCsrfToken('csrf-dash');
  });
  afterEach(() => {
    restore?.();
    restore = null;
    setTransport(null);
    setCsrfToken(null);
    vi.unstubAllGlobals();
  });

  it('default: same-origin cookie, CSRF on mutations only, no Authorization (the Dashboard is unchanged)', async () => {
    const net = installFetch({ 'GET /api/v1/agents': () => ok([]), 'POST /api/v1/agents/a1/wake': () => ok({ id: 'a1' }) });
    expect(getTransport()).toBe(cookieTransport);
    await api.agents.list();
    await api.agents.wake('a1');
    const [get, post] = net.calls;
    expect(get.init.credentials).toBe('same-origin');
    expect(get.headers['x-csrf-token']).toBeUndefined();
    expect(get.headers.authorization).toBeUndefined();
    expect(post.init.credentials).toBe('same-origin');
    expect(post.headers['x-csrf-token']).toBe('csrf-dash');
  });

  it('a Mini App Bearer transport: Authorization header, no cookies, no CSRF; restoring brings the cookie transport back', async () => {
    const net = installFetch({ 'GET /api/v1/agents': () => ok([]), 'POST /api/v1/agents/a1/wake': () => ok({ id: 'a1' }) });
    restore = setTransport(bearer().transport());
    expect(getTransport().kind).toBe('bearer');
    await api.agents.list();
    await api.agents.wake('a1');
    for (const c of net.calls) {
      expect(c.headers.authorization).toBe('Bearer tok-1');
      expect(c.init.credentials).toBe('omit');
      expect(c.headers['x-csrf-token']).toBeUndefined();
    }
    restore();
    restore = null;
    expect(getTransport()).toBe(cookieTransport);
    await api.agents.list();
    expect(net.calls[2].headers.authorization).toBeUndefined();
    expect(net.calls[2].init.credentials).toBe('same-origin');
  });

  it('a 403 stepup_required is retried exactly once after the client confirmed; no handler = the original error', async () => {
    let n = 0;
    const net = installFetch({
      'DELETE /api/v1/agents/a1': () => (++n === 1 ? apiError(403, 'stepup_required', 'Confirm it is you', { level: 'fresh', methods: ['password'] }) : ok({ deleted: 'a1' })),
    });
    const client = bearer();
    restore = setTransport(client.transport());
    // without a challenge handler the error surfaces unchanged
    await expect(request('/agents/a1', { method: 'DELETE' })).rejects.toMatchObject({ status: 403, code: 'stepup_required' });
    n = 0;
    const handler = vi.fn(async (_err: unknown, _sentAt: number) => true);
    client.setChallengeHandler(handler);
    await expect(request('/agents/a1', { method: 'DELETE' })).resolves.toEqual({ deleted: 'a1' });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toMatchObject({ code: 'stepup_required' });
    expect(net.calls.filter((c) => c.method === 'DELETE')).toHaveLength(3);
  });

  it('a second 403 after the retry fails instead of asking again; a cancelled confirmation fails at once', async () => {
    const net = installFetch({ 'GET /api/v1/providers': () => apiError(403, 'stepup_required', 'Confirm it is you') });
    const client = bearer();
    restore = setTransport(client.transport());
    const handler = vi.fn(async () => true);
    client.setChallengeHandler(handler);
    await expect(request('/providers')).rejects.toMatchObject({ code: 'stepup_required' });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(net.calls).toHaveLength(2);
    handler.mockResolvedValueOnce(false);
    net.calls.length = 0;
    await expect(request('/providers')).rejects.toMatchObject({ code: 'stepup_required' });
    expect(net.calls).toHaveLength(1);
  });

  it('requestBlob uses the transport and the same step-up retry', async () => {
    let n = 0;
    const net = installFetch({
      'GET /api/v1/system/diagnostics': () => (++n === 1 ? apiError(403, 'stepup_required', 'Confirm') : new Response('tgz', { status: 200, headers: { 'content-disposition': 'attachment; filename="d.tgz"' } })),
    });
    const client = bearer();
    client.setChallengeHandler(async () => true);
    restore = setTransport(client.transport());
    const r = await requestBlob('/system/diagnostics');
    expect(r.filename).toBe('d.tgz');
    expect(net.calls.map((c) => c.headers.authorization)).toEqual(['Bearer tok-1', 'Bearer tok-1']);
  });

  it('401 unauthenticated ends the Mini App session; a 401 for a wrong password does not', async () => {
    installFetch({
      'GET /api/v1/agents': () => apiError(401, 'unauthenticated', 'Mini App session required'),
      'POST /api/v1/auth/password': () => apiError(401, 'invalid_credentials', 'invalid username or password'),
    });
    const client = bearer();
    const gone = vi.fn();
    client.onUnauthorized(gone);
    restore = setTransport(client.transport());
    await expect(request('/auth/password', { method: 'POST', body: {} })).rejects.toMatchObject({ status: 401 });
    expect(gone).not.toHaveBeenCalled();
    await expect(request('/agents')).rejects.toMatchObject({ status: 401 });
    expect(gone).toHaveBeenCalledTimes(1);
  });

  it('the cookie transport still reports 401 unauthenticated to the Dashboard handler', async () => {
    installFetch({ 'GET /api/v1/agents': () => apiError(401, 'unauthenticated', 'login required') });
    const h = vi.fn();
    const off = onUnauthorized(h);
    await expect(request('/agents')).rejects.toMatchObject({ status: 401 });
    expect(h).toHaveBeenCalledTimes(1);
    off();
  });

  it('XHR uploads (files, attachments) carry the Bearer token without cookies, the Dashboard CSRF otherwise', async () => {
    installFetch({
      'POST /api/v1/files/upload': () => ok({ path: '/a.txt', size: 3 }),
      'POST /api/v1/agents/a1/attachments': () => ok({ id: 'att1', name: 'a.png' }),
    });
    const xhr = installXhrOverFetch();
    // cookie (Dashboard)
    await uploadFile('ws', '/a.txt', new Blob(['abc']));
    expect(xhr.sent[0].headers['x-csrf-token']).toBe('csrf-dash');
    expect(xhr.sent[0].headers.Authorization).toBeUndefined();
    expect(xhr.sent[0].withCredentials).toBe(true);
    // Bearer (Mini App administration area)
    restore = setTransport(bearer().transport());
    await uploadFile('ws', '/a.txt', new Blob(['abc']));
    await uploadAttachment('a1', new File(['x'], 'a.png', { type: 'image/png' }));
    for (const x of xhr.sent.slice(1)) {
      expect(x.headers.Authorization).toBe('Bearer tok-1');
      expect(x.headers['x-csrf-token']).toBeUndefined();
      expect(x.withCredentials).toBe(false);
    }
    expect(xhr.sent[1].headers['Content-Type']).toBe('application/octet-stream');
    expect(xhr.sent[2].headers['Content-Type']).toBeUndefined(); // multipart boundary set by the browser
  });

  it('an upload answered with 403 stepup_required is sent again once after the confirmation', async () => {
    let n = 0;
    installFetch({ 'POST /api/v1/files/upload': () => (++n === 1 ? apiError(403, 'stepup_required', 'Confirm') : ok({ path: '/a.txt', size: 3 })) });
    const xhr = installXhrOverFetch();
    const client = bearer();
    const handler = vi.fn(async () => true);
    client.setChallengeHandler(handler);
    restore = setTransport(client.transport());
    await expect(uploadFile('ws', '/a.txt', new Blob(['abc']))).resolves.toEqual({ path: '/a.txt', size: 3 });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(xhr.sent).toHaveLength(2);
  });

  it('downloads: a Bearer session fetches every file (a plain link cannot carry the token)', async () => {
    const net = installFetch({ 'GET /api/v1/files/download': () => new Response('data', { status: 200 }) });
    const created: string[] = [];
    vi.stubGlobal('URL', Object.assign(Object.create(URL), URL, { createObjectURL: () => (created.push('blob:x'), 'blob:x'), revokeObjectURL: () => {} }));
    restore = setTransport(bearer().transport());
    await downloadFile('ws', '/big.iso', 'big.iso', 80 * 1024 * 1024);
    expect(net.calls).toHaveLength(1);
    expect(net.calls[0].url).toBe('/api/v1/files/download?root=ws&path=%2Fbig.iso');
    expect(net.calls[0].headers.authorization).toBe('Bearer tok-1');
    expect(created).toEqual(['blob:x']);
  });

  it('EventSource is never opened with a Bearer transport (the Mini App supplies its own streaming hub)', () => {
    const es = vi.fn();
    vi.stubGlobal('EventSource', es);
    restore = setTransport(bearer().transport());
    const hub = new EventHub();
    hub.start();
    expect(es).not.toHaveBeenCalled();
    hub.stop();
  });

  it('Live Desktop: the WebSocket URL carries the Mini App session and no subprotocol is requested through the gateway', () => {
    const loc = { protocol: 'https:', host: 'mini.example' };
    expect(wsUrl('/api/v1/live/ws/s1', 'vt', loc)).toBe('wss://mini.example/api/v1/live/ws/s1?token=vt');
    expect(dashboardLiveClient.wsProtocols).toEqual(['binary']);
    restore = setTransport(bearer().transport());
    expect(wsUrl('/api/v1/live/ws/s1', 'vt', loc)).toBe('wss://mini.example/api/v1/live/ws/s1?token=vt&session_token=tok-1');
    expect(dashboardLiveClient.wsProtocols).toEqual([]);
  });
});
