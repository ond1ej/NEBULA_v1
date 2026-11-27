// HTTP client of the Mini App. Two authentication modes:
//
//  * telegram — opened inside Telegram: Telegram.WebApp.initData is exchanged ONCE at POST /api/mini/auth (Mini App
//    gateway) for a short-lived session token. Every API call carries `Authorization: Bearer <token>`, never cookies
//    (the gateway forwards only an allow-list of /api/v1 routes). initData is single-use by design, so a 401 means
//    "reopen the Mini App from Telegram".
//  * cookie   — local preview at http(s)://<dashboard>/mini/ in a normal browser: the dashboard owner's cookie session
//    is reused (GET /api/v1/auth/state gives the CSRF token for mutations).
//
// Tokens are kept only in this object and in sessionStorage (requirement of the gateway design); they are never
// logged or put into error messages.
//
// Owner confirmations (V3.3): a 403 `stepup_required` goes to the challenge handler (mini/stepup/StepUpProvider.tsx);
// when it confirms, the request is retried once. `transport()` lends the same authentication to the Dashboard modules
// the Mini App reuses (lib/http request(), uploads, authenticated images).
import { ApiError, buildUrl, errorMessage, isStepUpError, parseError, type HttpTransport, type Query } from '../lib/http';
import type { BlobResult } from '../lib/http';
import type { Envelope } from '../types';

export type AuthMode = 'telegram' | 'cookie';

export interface TelegramUserInfo {
  id: number;
  first_name?: string | null;
  last_name?: string | null;
  username?: string | null;
  language_code?: string | null;
  photo_url?: string | null;
}

/** Result of POST /api/mini/auth (and what we keep in sessionStorage). */
export interface MiniSession {
  token: string;
  csrf_token: string;
  session_id: string;
  expires_at: number;
  telegram_user: TelegramUserInfo | null;
  bot: string | null;
  permissions: string[];
  start_param: string | null;
}

export const SESSION_KEY = 'nebula.mini.session.v1';

export interface MiniRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Query;
  signal?: AbortSignal;
  keepalive?: boolean;
  idempotencyKey?: string;
  /** multipart/form-data (attachments); the browser sets the boundary. */
  formData?: FormData;
  /** raw body (file upload) sent with `contentType`. */
  rawBody?: BodyInit;
  contentType?: string;
  /**
   * A step-up request itself (password / biometric answer, challenge): never handed to the challenge handler, and a 401
   * means a wrong password or response, not an ended session.
   */
  confirmation?: boolean;
}

type UnauthorizedListener = (err: ApiError) => void;
/** Answers a 403 step-up / re-auth error: true when the owner confirmed and the request should be retried once. */
export type ChallengeHandler = (err: ApiError, sentAt: number) => Promise<boolean>;

/** 401 that ends the session (the gateway and the host answer `unauthenticated`); other 401s are wrong credentials. */
export const endsSession = (err: ApiError): boolean => err.status === 401 && (err.code === 'unauthenticated' || err.code === 'http_401');

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export class MiniClient {
  readonly mode: AuthMode;
  private token: string | null;
  private csrf: string | null;
  private listeners = new Set<UnauthorizedListener>();
  private expired = false;
  private challenge: ChallengeHandler | null = null;

  constructor(opts: { mode: AuthMode; token?: string | null; csrf?: string | null }) {
    this.mode = opts.mode;
    this.token = opts.token ?? null;
    this.csrf = opts.csrf ?? null;
  }

  /** The Mini App session token (telegram mode). Needed for the Live Desktop WebSocket URL only. */
  get sessionToken(): string | null {
    return this.token;
  }

  get isExpired(): boolean {
    return this.expired;
  }

  setCsrf(token: string | null): void {
    this.csrf = token;
  }

  onUnauthorized(fn: UnauthorizedListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Installs the step-up handler (one at a time); returns a function removing it. */
  setChallengeHandler(fn: ChallengeHandler | null): () => void {
    this.challenge = fn;
    return () => {
      if (this.challenge === fn) this.challenge = null;
    };
  }

  /** Asks the challenge handler (no handler: not confirmed). */
  confirm(err: ApiError, sentAt: number): Promise<boolean> {
    return this.challenge && isStepUpError(err) ? this.challenge(err, sentAt) : Promise.resolve(false);
  }

  /** The same authentication for Dashboard modules reused inside the Mini App (lib/http's transport). */
  transport(): HttpTransport {
    return {
      kind: this.mode === 'telegram' ? 'bearer' : 'cookie',
      headers: (method = 'GET') => {
        const h = this.headers(method);
        delete h.Accept;
        return h;
      },
      credentials: this.credentials(),
      onUnauthorized: (err) => {
        if (endsSession(err)) this.invalidate(err);
      },
      onStepUp: (err, sentAt) => this.confirm(err, sentAt),
      wsParams: (): Record<string, string> => (this.mode === 'telegram' && this.token ? { session_token: this.token } : {}),
    };
  }

  /** Marks the session dead (401) and notifies the app shell exactly once. */
  invalidate(err: ApiError): void {
    if (this.expired) return;
    this.expired = true;
    if (this.mode === 'telegram') clearStoredSession();
    for (const l of [...this.listeners]) {
      try {
        l(err);
      } catch (e) {
        console.error('NEBULA: unauthorized listener failed', e);
      }
    }
  }

  headers(method: string, extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { Accept: 'application/json', ...extra };
    if (this.mode === 'telegram' && this.token) h.Authorization = `Bearer ${this.token}`;
    if (this.mode === 'cookie' && MUTATING.has(method) && this.csrf) h['x-csrf-token'] = this.csrf;
    return h;
  }

  private credentials(): RequestCredentials {
    // Bearer mode never sends cookies: the gateway ignores them and they would only widen the CSRF surface.
    return this.mode === 'telegram' ? 'omit' : 'same-origin';
  }

  async fetch(path: string, opts: MiniRequestOptions = {}, accept = 'application/json'): Promise<Response> {
    const sentAt = Date.now();
    let res = await this.send(path, opts, accept);
    if (res.ok) return res;
    let err = await parseError(res);
    if (!opts.confirmation && (await this.confirm(err, sentAt))) {
      res = await this.send(path, opts, accept);
      if (res.ok) return res;
      err = await parseError(res);
    }
    if (endsSession(err)) this.invalidate(err);
    throw err;
  }

  private async send(path: string, opts: MiniRequestOptions, accept: string): Promise<Response> {
    const method = opts.method ?? 'GET';
    const extra: Record<string, string> = { Accept: accept };
    let body: BodyInit | undefined;
    if (opts.formData) {
      body = opts.formData;
    } else if (opts.rawBody !== undefined) {
      extra['Content-Type'] = opts.contentType ?? 'application/octet-stream';
      body = opts.rawBody;
    } else if (opts.body !== undefined) {
      extra['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
    if (opts.idempotencyKey) extra['Idempotency-Key'] = opts.idempotencyKey;
    try {
      return await fetch(buildUrl(path, opts.query), {
        method,
        headers: this.headers(method, extra),
        body,
        credentials: this.credentials(),
        signal: opts.signal,
        keepalive: opts.keepalive,
        cache: 'no-store',
      });
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') throw e;
      throw new ApiError(0, 'network_error', `Cannot reach NEBULA (${errorMessage(e)})`);
    }
  }

  async request<T>(path: string, opts: MiniRequestOptions = {}): Promise<T> {
    const res = await this.fetch(path, opts);
    let j: unknown;
    try {
      j = await res.json();
    } catch {
      throw new ApiError(res.status, 'bad_response', 'NEBULA returned a response that is not JSON');
    }
    if (!j || typeof j !== 'object' || !('data' in (j as object))) {
      throw new ApiError(res.status, 'bad_envelope', 'The response is missing the {data} envelope');
    }
    return (j as Envelope<T>).data;
  }

  async blob(path: string, query?: Query, signal?: AbortSignal): Promise<BlobResult> {
    const res = await this.fetch(path, { query, signal }, '*/*');
    const cd = res.headers.get('content-disposition') ?? '';
    const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
    const plain = /filename="?([^";]+)"?/i.exec(cd);
    let filename: string | null = null;
    try {
      filename = star ? decodeURIComponent(star[1]) : plain ? plain[1] : null;
    } catch {
      filename = plain ? plain[1] : null;
    }
    return { blob: await res.blob(), headers: res.headers, filename };
  }

  /** Live Desktop WebSocket URL. Through the gateway the Mini App session token must accompany the viewer token. */
  wsUrl(wsPath: string, viewerToken: string, loc: Pick<Location, 'protocol' | 'host'> = window.location): string {
    const proto = loc.protocol === 'https:' ? 'wss' : 'ws';
    let url = `${proto}://${loc.host}${wsPath}?token=${encodeURIComponent(viewerToken)}`;
    if (this.mode === 'telegram' && this.token) url += `&session_token=${encodeURIComponent(this.token)}`;
    return url;
  }
}

// ---------------------------------------------------------------- session storage
function storage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function loadStoredSession(now = Date.now() / 1000): MiniSession | null {
  const s = storage();
  if (!s) return null;
  try {
    const raw = s.getItem(SESSION_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as MiniSession;
    if (!v || typeof v.token !== 'string' || !v.token || typeof v.expires_at !== 'number') return null;
    if (v.expires_at - 30 <= now) {
      s.removeItem(SESSION_KEY);
      return null;
    }
    return v;
  } catch {
    return null;
  }
}

export function storeSession(sess: MiniSession): void {
  try {
    storage()?.setItem(SESSION_KEY, JSON.stringify(sess));
  } catch {
    // private mode / quota: the session still works for this page view
  }
}

export function clearStoredSession(): void {
  try {
    storage()?.removeItem(SESSION_KEY);
  } catch {
    // ignore
  }
}
