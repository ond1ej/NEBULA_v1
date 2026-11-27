import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, artifactUrl, buildUrl, onUnauthorized, parseError, request, requestEnvelope, setCsrfToken } from './api';
import { apiError, installFetch, json, ok } from './test/fetchMock';

describe('API client', () => {
  beforeEach(() => {
    setCsrfToken(null);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    onUnauthorized(null);
  });

  it('unwraps the {data, request_id} envelope', async () => {
    installFetch({ 'GET /api/v1/agents': () => ok([{ id: 'a1', name: 'Dev' }]) });
    const agents = await api.agents.list();
    expect(agents).toEqual([{ id: 'a1', name: 'Dev' }]);
  });

  it('keeps job_id and request_id when the full envelope is requested', async () => {
    installFetch({ 'POST /api/v1/system/repair': () => ok({ job_id: 'j1' }, 202, { job_id: 'j1' }) });
    setCsrfToken('csrf-1');
    const env = await api.system.repair();
    expect(env).toEqual({ data: { job_id: 'j1' }, request_id: 'rid-test', job_id: 'j1' });
  });

  it('sends same-origin credentials and no CSRF header on GET', async () => {
    setCsrfToken('csrf-xyz');
    const { calls } = installFetch({ 'GET /api/v1/health': () => ok({ status: 'ok' }) });
    await api.health();
    expect(calls[0].init.credentials).toBe('same-origin');
    expect(calls[0].headers['x-csrf-token']).toBeUndefined();
  });

  it.each([
    ['POST', () => api.agents.pause('a1'), '/api/v1/agents/a1/pause'],
    ['PATCH', () => api.agents.patch('a1', { name: 'X' }), '/api/v1/agents/a1'],
    ['DELETE', () => api.live.disconnect('s1'), '/api/v1/live/sessions/s1'],
  ] as const)('adds x-csrf-token to %s', async (method, call, path) => {
    setCsrfToken('csrf-xyz');
    const { calls } = installFetch({ [`${method} ${path}`]: () => ok({}) });
    await call();
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe(method);
    expect(calls[0].headers['x-csrf-token']).toBe('csrf-xyz');
  });

  it('sends JSON bodies, query params and the Idempotency-Key header', async () => {
    setCsrfToken('c');
    const { calls } = installFetch({ 'DELETE /api/v1/agents/a1': () => ok({ agent_id: 'a1', telegram_topics: [] }) });
    await api.agents.remove('a1', true, 'idem-123');
    expect(calls[0].url).toBe('/api/v1/agents/a1?confirm=true&export=true');
    expect(calls[0].headers['idempotency-key']).toBe('idem-123');

    const c2 = installFetch({ 'POST /api/v1/approvals/ap1': () => ok({ id: 'ap1', decision: 'approved' }) });
    await api.approvals.resolve('ap1', 'approved');
    expect(c2.calls[0].body).toEqual({ decision: 'approved' });
    expect(c2.calls[0].headers['content-type']).toBe('application/json');
  });

  it('throws ApiError with code, message, details, status and request id', async () => {
    installFetch({
      'POST /api/v1/agents/a1/live/connect': () => apiError(409, 'desktop_not_running', 'agent desktop is SLEEP; wake it first', { a: 1 }),
    });
    setCsrfToken('c');
    const err = await api.live.connect('a1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    const e = err as ApiError;
    expect(e.status).toBe(409);
    expect(e.code).toBe('desktop_not_running');
    expect(e.message).toBe('agent desktop is SLEEP; wake it first');
    expect(e.details).toEqual({ a: 1 });
    expect(e.requestId).toBe('rid-err');
  });

  it('appends field errors to validation_error messages', async () => {
    installFetch({
      'POST /api/v1/providers/x/limits': () =>
        apiError(422, 'validation_error', 'request validation failed', {
          errors: [{ loc: ['body', 'daily_token_cap'], msg: 'Input should be greater than or equal to 1000' }],
        }),
    });
    const e = (await api.providers.setLimit('x', 5).catch((x: unknown) => x)) as ApiError;
    expect(e.code).toBe('validation_error');
    expect(e.message).toContain('daily_token_cap: Input should be greater than or equal to 1000');
  });

  it('maps non-JSON error bodies and network failures to ApiError', async () => {
    installFetch({ 'GET /api/v1/system': () => new Response('Bad Gateway', { status: 502, statusText: 'Bad Gateway' }) });
    const e = (await api.system.info().catch((x: unknown) => x)) as ApiError;
    expect(e).toBeInstanceOf(ApiError);
    expect(e.status).toBe(502);
    expect(e.code).toBe('http_502');
    expect(e.message).toBe('Bad Gateway');

    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }));
    const n = (await api.health().catch((x: unknown) => x)) as ApiError;
    expect(n.code).toBe('network_error');
    expect(n.status).toBe(0);
  });

  it('rejects success responses without the data envelope', async () => {
    installFetch({ 'GET /api/v1/health': () => json({ status: 'ok' }) });
    const e = (await api.health().catch((x: unknown) => x)) as ApiError;
    expect(e.code).toBe('bad_envelope');
  });

  it('notifies the unauthorized handler on 401 unauthenticated', async () => {
    const handler = vi.fn();
    onUnauthorized(handler);
    installFetch({ 'GET /api/v1/agents': () => apiError(401, 'unauthenticated', 'login required') });
    await expect(api.agents.list()).rejects.toMatchObject({ code: 'unauthenticated', status: 401 });
    expect(handler).toHaveBeenCalledTimes(1);

    installFetch({ 'POST /api/v1/auth/login': () => apiError(401, 'invalid_credentials', 'invalid username or password') });
    await expect(api.auth.login('a', 'b')).rejects.toMatchObject({ code: 'invalid_credentials' });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('builds URLs and artifact paths safely', () => {
    expect(buildUrl('/tasks', { state: 'FAILED', limit: 5, q: '', x: undefined })).toBe('/api/v1/tasks?state=FAILED&limit=5');
    expect(artifactUrl('agent 1/task/step-001.png')).toBe('/api/v1/artifacts/agent%201/task/step-001.png');
  });

  it('parseError falls back to statusText for empty bodies', async () => {
    const e = await parseError(new Response(null, { status: 503, statusText: 'Service Unavailable' }));
    expect(e.code).toBe('http_503');
    expect(e.message).toBe('Service Unavailable');
  });

  it('request / requestEnvelope are usable directly', async () => {
    installFetch({ 'GET /api/v1/x': () => ok(42) });
    await expect(request<number>('/x')).resolves.toBe(42);
    installFetch({ 'GET /api/v1/x': () => ok(42) });
    await expect(requestEnvelope<number>('/x')).resolves.toMatchObject({ data: 42, request_id: 'rid-test' });
  });
});
