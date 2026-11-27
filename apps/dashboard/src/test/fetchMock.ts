// Test-only fetch mock: routes `METHOD /path` to handlers and records every call.
import { vi } from 'vitest';

export interface RecordedCall {
  method: string;
  url: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
  init: RequestInit;
}

type Handler = (call: RecordedCall) => Response | Promise<Response>;

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'x-request-id': 'rid-test', ...headers },
  });
}

export function ok(data: unknown, status = 200, extra: Record<string, unknown> = {}): Response {
  return json({ data, request_id: 'rid-test', ...extra }, status);
}

export function apiError(status: number, code: string, message: string, details: Record<string, unknown> = {}): Response {
  return json({ error: { code, message, details }, request_id: 'rid-err' }, status);
}

export function installFetch(routes: Record<string, Handler>) {
  const calls: RecordedCall[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init.method ?? 'GET').toUpperCase();
    const path = url.split('?')[0];
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
    const call: RecordedCall = { method, url, path, headers, body, init };
    calls.push(call);
    const h = routes[`${method} ${path}`];
    if (!h) return apiError(404, 'not_found', `no mock for ${method} ${path}`);
    return h(call);
  });
  vi.stubGlobal('fetch', fn);
  return { calls, fn };
}
