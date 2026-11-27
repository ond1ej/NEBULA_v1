// Core HTTP client of the NEBULA host API (/api/v1): envelope parsing, typed errors, CSRF and 401 handling.
//
// Contract (apps/host-api/nebula_host/api/common.py + errors.py):
//   success -> {data, request_id, job_id?}
//   error   -> {error: {code, message, details}, request_id} + HTTP status
// The session cookie is HttpOnly; every POST/PUT/PATCH/DELETE carries `x-csrf-token`.
//
// Who authenticates a request is a pluggable transport: the Dashboard uses the default cookie + CSRF transport; the
// Telegram Mini App installs a Bearer transport (mini/client.ts) while it reuses Dashboard pages (#/admin/…).
//
// Kept separate from the endpoint catalogue in ../api.ts so the Telegram Mini App (and the shared UI kit) can use it
// without bundling every Dashboard endpoint.
import type { Envelope } from '../types';

export const API_BASE = '/api/v1';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown>;
  readonly requestId: string | null;
  readonly jobId: string | null;

  constructor(
    status: number,
    code: string,
    message: string,
    details: Record<string, unknown> = {},
    requestId: string | null = null,
    jobId: string | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
    this.jobId = jobId;
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

/** Human readable message for any thrown value. */
export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

// ---------------------------------------------------------------- CSRF + 401 handling
let csrfToken: string | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

export function getCsrfToken(): string | null {
  return csrfToken;
}

type UnauthorizedHandler = (err: ApiError) => void;
let unauthorizedHandler: UnauthorizedHandler | null = null;

/** Called when any request fails with 401 `unauthenticated` (expired / revoked session). */
export function onUnauthorized(handler: UnauthorizedHandler | null): () => void {
  unauthorizedHandler = handler;
  return () => {
    if (unauthorizedHandler === handler) unauthorizedHandler = null;
  };
}

// ---------------------------------------------------------------- transport
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** 403 codes after which the request may be retried once: a fresh owner confirmation (step-up) or the vault passphrase. */
export const STEPUP_CODES: ReadonlySet<string> = new Set(['stepup_required', 'reauth_required']);

export function isStepUpError(e: unknown): e is ApiError {
  return e instanceof ApiError && e.status === 403 && STEPUP_CODES.has(e.code);
}

/** How requests to the host are authenticated. */
export interface HttpTransport {
  /** 'cookie': HttpOnly session cookie (+ CSRF); 'bearer': a token header, so <img src> / EventSource cannot be used. */
  readonly kind: 'cookie' | 'bearer';
  /** Authentication headers of one request (cookie mode adds the CSRF token to mutations only). */
  headers(method?: string): Record<string, string>;
  readonly credentials: RequestCredentials;
  /** A request failed with 401. */
  onUnauthorized?(err: ApiError): void;
  /**
   * A request failed with 403 `stepup_required` / `reauth_required`. Resolves true when the client confirmed (the
   * request is then retried once), false to fail with the original error. `sentAt` (ms) is when the request was sent.
   */
  onStepUp?(err: ApiError, sentAt: number): Promise<boolean>;
  /** Extra query parameters of authenticated WebSocket URLs (Live Desktop through the Mini App gateway). */
  wsParams?(): Record<string, string>;
}

/** The Dashboard's transport: same-origin session cookie, CSRF header on mutations, the onUnauthorized() handler. */
export const cookieTransport: HttpTransport = {
  kind: 'cookie',
  headers: (method = 'GET'): Record<string, string> => (MUTATING.has(method) && csrfToken ? { 'x-csrf-token': csrfToken } : {}),
  credentials: 'same-origin',
  onUnauthorized: (err) => {
    if (err.code === 'unauthenticated') unauthorizedHandler?.(err);
  },
};

let transport: HttpTransport = cookieTransport;

/** Installs a transport for every request(), upload and authenticated URL; returns a function restoring the previous one. */
export function setTransport(t: HttpTransport | null): () => void {
  const prev = transport;
  const next = t ?? cookieTransport;
  transport = next;
  return () => {
    if (transport === next) transport = prev;
  };
}

export function getTransport(): HttpTransport {
  return transport;
}

// ---------------------------------------------------------------- core request
export type Query = Record<string, string | number | boolean | null | undefined>;

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Query;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  keepalive?: boolean;
  idempotencyKey?: string;
  /** Raw request body (file uploads). Sent as-is with `contentType` (default application/octet-stream). */
  rawBody?: BodyInit;
  contentType?: string;
}

export function buildUrl(path: string, query?: Query): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined || v === null || v === '') continue;
    qs.set(k, String(v));
  }
  const s = qs.toString();
  return `${API_BASE}${path}${s ? `?${s}` : ''}`;
}

export function newIdempotencyKey(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

async function send(path: string, opts: RequestOptions, t: HttpTransport): Promise<Response> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = { Accept: 'application/json', ...(opts.headers ?? {}) };
  let body: BodyInit | undefined;
  if (opts.rawBody !== undefined) {
    headers['Content-Type'] = opts.contentType ?? 'application/octet-stream';
    body = opts.rawBody;
  } else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  Object.assign(headers, t.headers(method));
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  try {
    return await fetch(buildUrl(path, opts.query), {
      method,
      headers,
      body,
      credentials: t.credentials,
      signal: opts.signal,
      keepalive: opts.keepalive,
      cache: 'no-store',
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new ApiError(0, 'network_error', `Cannot reach the NEBULA host service (${errorMessage(e)})`);
  }
}

/** Sends a request; a 403 step-up / re-auth answer is retried once after the transport confirmed. */
async function sendOk(path: string, opts: RequestOptions): Promise<Response> {
  const t = transport;
  const sentAt = Date.now();
  let res = await send(path, opts, t);
  if (res.ok) return res;
  let err = await parseError(res);
  if (t.onStepUp && isStepUpError(err) && (await t.onStepUp(err, sentAt))) {
    res = await send(path, opts, t);
    if (res.ok) return res;
    err = await parseError(res);
  }
  if (res.status === 401) t.onUnauthorized?.(err);
  throw err;
}

function describeValidation(details: Record<string, unknown>): string | null {
  const errs = details.errors;
  if (!Array.isArray(errs) || errs.length === 0) return null;
  return errs
    .slice(0, 3)
    .map((e) => {
      const o = (e ?? {}) as { loc?: unknown[]; msg?: string };
      const loc = Array.isArray(o.loc) ? o.loc.filter((x) => x !== 'body').join('.') : '';
      return loc ? `${loc}: ${o.msg ?? 'invalid'}` : (o.msg ?? 'invalid');
    })
    .join('; ');
}

export async function parseError(res: Response): Promise<ApiError> {
  const headerRid = res.headers.get('x-request-id');
  let text = '';
  try {
    text = await res.text();
  } catch {
    text = '';
  }
  if (text) {
    try {
      const j = JSON.parse(text) as Partial<{ error: unknown; request_id: string; job_id: string }>;
      if (j && typeof j === 'object' && j.error && typeof j.error === 'object') {
        const err = j.error as { code?: unknown; message?: unknown; details?: unknown };
        const details = (err.details && typeof err.details === 'object' ? err.details : {}) as Record<string, unknown>;
        const code = typeof err.code === 'string' ? err.code : `http_${res.status}`;
        let message = typeof err.message === 'string' && err.message ? err.message : res.statusText;
        if (code === 'validation_error') {
          const v = describeValidation(details);
          if (v) message = `${message} (${v})`;
        }
        return new ApiError(res.status, code, message, details, j.request_id ?? headerRid, j.job_id ?? null);
      }
    } catch {
      // not JSON: fall through and report the raw body
    }
  }
  const msg = text.trim().slice(0, 300) || res.statusText || `HTTP ${res.status}`;
  return new ApiError(res.status, `http_${res.status}`, msg, {}, headerRid);
}

/** Full envelope (use when job_id / request_id matter). */
export async function requestEnvelope<T>(path: string, opts: RequestOptions = {}): Promise<Envelope<T>> {
  const res = await sendOk(path, opts);
  const rid = res.headers.get('x-request-id');
  let j: unknown;
  try {
    j = await res.json();
  } catch {
    throw new ApiError(res.status, 'bad_response', 'The host returned a response that is not JSON', {}, rid);
  }
  if (!j || typeof j !== 'object' || !('data' in (j as object))) {
    throw new ApiError(res.status, 'bad_envelope', 'The host response is missing the {data} envelope', {}, rid);
  }
  return j as Envelope<T>;
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  return (await requestEnvelope<T>(path, opts)).data;
}

export interface BlobResult {
  blob: Blob;
  headers: Headers;
  filename: string | null;
}

/** Binary endpoints (screenshot PNG, diagnostics tar.gz). Errors still use the JSON error envelope. */
export async function requestBlob(path: string, opts: RequestOptions = {}): Promise<BlobResult> {
  const res = await sendOk(path, { ...opts, headers: { Accept: '*/*', ...(opts.headers ?? {}) } });
  const cd = res.headers.get('content-disposition') ?? '';
  const m = /filename="?([^";]+)"?/i.exec(cd);
  return { blob: await res.blob(), headers: res.headers, filename: m ? m[1] : null };
}

export function artifactUrl(ref: string): string {
  return `${API_BASE}/artifacts/${ref.split('/').map(encodeURIComponent).join('/')}`;
}
