// Live events for the Mini App in Bearer mode.
//
// EventSource cannot send an Authorization header, so GET /api/v1/events (text/event-stream) is read with a
// streaming fetch() and parsed here. The hub resumes with ?since=<last sequence> after any interruption (exponential
// backoff). When streaming does not work at all (e.g. a proxy that buffers the response), it gives up and reports
// status 'idle': screens then fall back to polling (see useQuery in hooks.ts).
//
// It extends the dashboard EventHub so <EventsProvider hub=…>, useNebulaEvents, useLiveRefresh and the shared
// LiveDesktop component work unchanged.
import { ApiError, buildUrl, parseError } from '../lib/http';
import { EventHub, type EventStatus } from '../hooks/useEvents';
import type { MiniClient } from './client';

export interface SseMessage {
  event: string;
  data: string;
  id: string | null;
}

/** Incremental text/event-stream parser (https://html.spec.whatwg.org/multipage/server-sent-events.html). */
export class SseParser {
  private buf = '';
  private event = '';
  private data: string[] = [];
  private id: string | null = null;

  constructor(private readonly onMessage: (m: SseMessage) => void) {}

  push(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.search(/\r\n|\r|\n/)) >= 0) {
      const line = this.buf.slice(0, nl);
      const sepLen = this.buf.startsWith('\r\n', nl) ? 2 : 1;
      this.buf = this.buf.slice(nl + sepLen);
      this.line(line);
    }
  }

  private line(line: string): void {
    if (line === '') {
      if (this.data.length) this.onMessage({ event: this.event || 'message', data: this.data.join('\n'), id: this.id });
      this.event = '';
      this.data = [];
      return;
    }
    if (line.startsWith(':')) return; // comment / keepalive
    const c = line.indexOf(':');
    const field = c >= 0 ? line.slice(0, c) : line;
    let value = c >= 0 ? line.slice(c + 1) : '';
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.event = value;
    else if (field === 'data') this.data.push(value);
    else if (field === 'id') this.id = value;
  }
}

const STALL_MS = 40_000; // the host sends a keepalive every 15 s
const MAX_STALLS = 3;

export class StreamEventHub extends EventHub {
  private ctl: AbortController | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private stallTimer: ReturnType<typeof setTimeout> | null = null;
  private tries = 0;
  private stalls = 0;
  private active = false;

  constructor(private readonly client: MiniClient) {
    super();
  }

  override start(): void {
    if (this.active) return;
    this.active = true;
    this.tries = 0;
    this.stalls = 0;
    void this.connect();
  }

  override stop(): void {
    this.active = false;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.clearStall();
    this.ctl?.abort();
    this.ctl = null;
    this.emitStatus('idle');
  }

  /** True when streaming was abandoned and screens should poll. */
  get polling(): boolean {
    return !this.active && this.stalls >= MAX_STALLS;
  }

  // EventHub.setStatus is private in TypeScript only; it is the single place that notifies status listeners.
  private emitStatus(s: EventStatus): void {
    (this as unknown as { setStatus(x: EventStatus): void }).setStatus(s);
  }

  private clearStall(): void {
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.stallTimer = null;
  }

  private armStall(ctl: AbortController): void {
    this.clearStall();
    this.stallTimer = setTimeout(() => {
      this.stalls += 1;
      ctl.abort();
    }, STALL_MS);
  }

  private async connect(): Promise<void> {
    if (!this.active || this.client.isExpired) return;
    const ctl = new AbortController();
    this.ctl = ctl;
    this.emitStatus(this.tries === 0 ? 'connecting' : 'reconnecting');
    const since = this.lastSequence;
    this.armStall(ctl); // a buffering proxy may not even send the response headers
    try {
      const res = await fetch(buildUrl('/events', since !== null ? { since } : undefined), {
        headers: this.client.headers('GET', { Accept: 'text/event-stream' }),
        credentials: this.client.mode === 'telegram' ? 'omit' : 'same-origin',
        cache: 'no-store',
        signal: ctl.signal,
      });
      if (!res.ok) {
        const err = await parseError(res);
        if (res.status === 401) {
          this.client.invalidate(err);
          this.stop();
          return;
        }
        throw err;
      }
      if (!res.body) throw new ApiError(0, 'no_stream', 'Streaming responses are not supported here');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const parser = new SseParser((m) => {
        if (m.event === 'message' && !m.data) return;
        this.handle(new MessageEvent(m.event, { data: m.data }));
      });
      this.armStall(ctl);
      let opened = false;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!opened) {
          opened = true;
          this.tries = 0;
          this.stalls = 0;
          this.emitStatus('open');
        }
        this.armStall(ctl);
        parser.push(decoder.decode(value, { stream: true }));
      }
      throw new ApiError(0, 'stream_closed', 'The event stream ended');
    } catch (e) {
      this.clearStall();
      if (!this.active || this.ctl !== ctl) return;
      if (e instanceof DOMException && e.name === 'AbortError' && this.stalls === 0) return;
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (!this.active) return;
    if (this.stalls >= MAX_STALLS) {
      // The stream connects but never delivers data: a buffering proxy. Give up; screens poll instead.
      this.active = false;
      this.emitStatus('idle');
      return;
    }
    this.tries += 1;
    this.emitStatus('reconnecting');
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(this.tries - 1, 5));
    this.retry = setTimeout(() => void this.connect(), delay);
  }
}
