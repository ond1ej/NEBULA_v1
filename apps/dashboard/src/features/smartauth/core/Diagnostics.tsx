// "Diagnostics" of one sign-in (session detail only: GET /smart-auth/sessions/{id} returns `events` and `history`): the
// pages the sign-in went through and its latest events, collapsed by default. Everything shown is structural (fixed
// words, counts, origins) — the host never stores a value or page text in an event — and it renders as plain text.
import { useId, useState } from 'react';
import { hostOf, stepLabel } from './lib';
import { cx } from './parts';
import type { Skin } from './skin';
import type { AuthEventMeta, AuthHistoryStep, AuthSessionEvent } from './types';

const MAX_PARTS = 8;
const clip = (v: unknown, n = 40) => {
  const t = String(v);
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const list = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' || typeof x === 'number').map((x) => clip(x, 24)).join(', ') : clip(v));

/** Short readable summary of an event's structural metadata ("password · github.com · 2 inputs · quiet 350 ms"). */
export function metaSummary(meta: AuthEventMeta | null | undefined): string {
  if (!meta || typeof meta !== 'object') return '';
  const parts: string[] = [];
  const add = (p: string | null | undefined) => {
    if (p && parts.length < MAX_PARTS) parts.push(p);
  };
  if (typeof meta.from_step === 'string' && typeof meta.step === 'string') add(`${clip(meta.from_step, 24)} → ${clip(meta.step, 24)}`);
  else if (typeof meta.step === 'string') add(clip(meta.step, 24));
  if (typeof meta.from_origin === 'string' && typeof meta.origin === 'string') add(`${clip(hostOf(meta.from_origin))} → ${clip(hostOf(meta.origin))}`);
  else if (typeof meta.origin === 'string') add(clip(hostOf(meta.origin)));
  if (meta.step_id !== undefined && meta.step_id !== null) add(`#${clip(meta.step_id, 12)}`);
  if (typeof meta.confidence === 'string') add(`confidence ${clip(meta.confidence, 8)}`);
  for (const k of ['kind', 'method', 'request_type', 'error_code', 'reason'] as const) if (typeof meta[k] === 'string') add(clip(meta[k], 32));
  if (meta.evidence !== undefined) add(`evidence ${list(meta.evidence)}`);
  if (Array.isArray(meta.auto) && meta.auto.length) add(`auto ${list(meta.auto)}`);
  if (Array.isArray(meta.flags) && meta.flags.length) add(`flags ${list(meta.flags)}`);
  const d = meta.diag && typeof meta.diag === 'object' ? (meta.diag as Record<string, unknown>) : null;
  if (d) {
    if (Array.isArray(d.roles) && d.roles.length) add(`roles ${list(d.roles)}`);
    if (typeof d.inputs_visible === 'number') add(`${d.inputs_visible} input${d.inputs_visible === 1 ? '' : 's'}`);
    if (typeof d.quiet_ms === 'number') add(`quiet ${d.quiet_ms} ms`);
    if (typeof d.webauthn === 'string') add(`webauthn ${clip(d.webauthn, 16)}`);
    if (d.webauthn_pending === true) add('prompt open');
    if (typeof d.ready === 'string') add(clip(d.ready, 16));
    if (d.busy === true) add('busy');
    if (d.error === true) add('page error');
  }
  return parts.join(' · ');
}

function Time({ ts, skin }: { ts: number | null | undefined; skin: Skin }) {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return <span className={skin.small}>—</span>;
  const d = new Date(ts * 1000);
  return (
    <time className={cx(skin.small, 'shrink-0 font-mono tabular-nums')} dateTime={d.toISOString()}>
      {d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
    </time>
  );
}

/** Collapsible step history + latest events (collapsed by default; nothing renders without detail data). */
export function AuthDiagnostics({ events, history, skin }: { events?: AuthSessionEvent[] | null; history?: AuthHistoryStep[] | null; skin: Skin }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const evs = Array.isArray(events) ? events : [];
  const steps = Array.isArray(history) ? history : [];
  if (!evs.length && !steps.length) return null;
  // the host lists events newest first: shown in the order they happened
  const ordered = [...evs].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  return (
    <section className={cx(skin.panel, '!py-2')} data-testid="auth-diagnostics">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? `${id}-body` : undefined}
        onClick={() => setOpen((v) => !v)}
        className={cx(skin.small, 'flex min-h-9 w-full items-center justify-between gap-2 rounded-md text-left font-medium focus-ring')}
      >
        <span>
          Diagnostics
          <span className="font-normal opacity-75">
            {` · ${steps.length} page${steps.length === 1 ? '' : 's'}, ${evs.length} event${evs.length === 1 ? '' : 's'}`}
          </span>
        </span>
        <svg viewBox="0 0 24 24" aria-hidden className={cx('size-4 shrink-0 transition-transform', open && 'rotate-180')} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div id={`${id}-body`} className="space-y-3 pt-1 pb-1">
          {steps.length > 0 && (
            <div>
              <p className={cx(skin.small, 'mb-1 font-semibold')}>Pages</p>
              <ol className="space-y-1" aria-label="Sign-in pages" data-testid="auth-diag-history">
                {steps.map((h, i) => (
                  <li key={i} className="flex min-w-0 items-baseline gap-2">
                    <Time ts={h.at} skin={skin} />
                    <span className={cx(skin.small, 'min-w-0 break-words !text-text')}>
                      {[stepLabel(h.step) ?? 'Page', h.origin ? hostOf(h.origin) : null, h.trust, h.error ? clip(h.error.replace(/_/g, ' '), 32) : null].filter(Boolean).join(' · ')}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          )}
          {ordered.length > 0 && (
            <div>
              <p className={cx(skin.small, 'mb-1 font-semibold')}>Events</p>
              <ol className="space-y-1" aria-label="Sign-in events" data-testid="auth-diag-events">
                {ordered.map((e, i) => {
                  const summary = metaSummary(e.meta);
                  return (
                    <li key={i} className="flex min-w-0 items-baseline gap-2">
                      <Time ts={e.ts} skin={skin} />
                      <span className={cx(skin.small, 'min-w-0 break-words')}>
                        <span className="font-mono !text-text">{clip(e.type, 40)}</span>
                        {e.outcome && e.outcome !== 'ok' ? ` (${clip(e.outcome, 24)})` : ''}
                        {summary ? ` — ${summary}` : ''}
                      </span>
                    </li>
                  );
                })}
              </ol>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
