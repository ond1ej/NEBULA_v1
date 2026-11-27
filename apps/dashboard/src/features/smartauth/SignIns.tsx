// Sign-in requests in the Dashboard: a card per active session (Approval Center, agent chat), the agent chat block
// (GET /smart-auth/sessions?agent_id=&active=true) and the Password Vault's recent sign-ins. Lists refresh on auth
// events (no polling) and load quietly: an older host without the endpoint simply shows nothing.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ConfirmDialog } from '../../components/Modal';
import { IconKey } from '../../components/icons';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Mono } from '../../components/ui';
import { useNow } from '../../hooks/useApi';
import { useLiveRefresh } from '../../hooks/useEvents';
import { href } from '../../hooks/useHashRoute';
import { formatTime, relativeTime } from '../../lib/format';
import type { NebulaEvent } from '../../types';
import { smartAuthApi } from './api';
import { countdown, isAuthEvent, isTerminal, needsOwner, shownOrigin, stateLabel, stateText, stateTone, stepLabel, taskRef } from './core/lib';
import type { AuthSession } from './core/types';
import { useSmartAuth } from './SmartAuthProvider';

const BADGE_TONE = { success: 'success', danger: 'danger', warning: 'warn', neutral: 'neutral', accent: 'info' } as const;

/** Sessions from one query, refreshed on matching auth events; failures stay quiet (the section just hides). */
export function useSignIns(load: (signal: AbortSignal) => Promise<AuthSession[]>, deps: unknown[], match: (ev: NebulaEvent) => boolean) {
  const [data, setData] = useState<AuthSession[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  const ctl = useRef<AbortController | null>(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const reload = useCallback(() => {
    ctl.current?.abort();
    const c = new AbortController();
    ctl.current = c;
    loadRef.current(c.signal).then(
      (xs) => {
        if (c.signal.aborted) return;
        setData(xs);
        setError(null);
      },
      (e: unknown) => {
        if (c.signal.aborted || (e instanceof DOMException && e.name === 'AbortError')) return;
        setError(e);
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    reload();
    return () => ctl.current?.abort();
  }, [reload]);
  useLiveRefresh(reload, match, 300);
  return { data, error, reload, setData };
}

function Expiry({ at }: { at: number }) {
  const now = useNow(1000) / 1000;
  const left = Math.max(0, at - now);
  return (
    <span role="timer" className={`text-xs tabular-nums ${left < 60 ? 'text-warn' : 'text-muted'}`}>
      {left <= 0 ? 'Expired' : `Expires in ${countdown(left)}`}
    </span>
  );
}

/** One active sign-in: what, where, who — Continue opens the modal, Cancel asks first. */
export function SignInCard({ s, onChanged }: { s: AuthSession; onChanged?: (s: AuthSession) => void }) {
  const { open } = useSmartAuth();
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const waiting = needsOwner(s);
  const { origin } = shownOrigin(s);
  const step = stepLabel(s.request?.step ?? s.step);
  return (
    <article className="rounded-xl border border-warn/25 bg-warn/[0.04] p-4" aria-label={`Sign-in request: ${s.agent_name} → ${s.site}`} data-testid="signin-card" data-state={s.state}>
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <IconKey className="size-4 shrink-0 text-warn" />
          <Badge tone="warn">Authentication required</Badge>
          <Mono className="text-text">{s.site}</Mono>
        </div>
        {!isTerminal(s) && <Expiry at={s.request?.expires_at ?? s.expires_at} />}
      </header>
      <p className="mt-2 text-sm text-text">
        <a href={href(`/agents/${s.agent_id}`)} className="rounded font-medium hover:underline focus-ring">
          {s.agent_name}
        </a>{' '}
        needs you to sign in to <span className="font-mono text-[13px] break-all">{origin}</span>
      </p>
      <p className="mt-1 text-xs text-muted">
        {stateText(s)}
        {step ? ` · ${step}` : ''} · task <Mono className="text-[11px]">{taskRef(s.task_id)}</Mono>
      </p>
      {!isTerminal(s) && (
        <div className="mt-3.5 flex flex-wrap gap-2">
          <Button variant="primary" size="sm" onClick={() => open(s)}>
            {waiting ? 'Continue sign-in' : 'Show details'}
          </Button>
          <Button variant="danger" size="sm" onClick={() => setConfirm(true)}>
            Cancel
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={confirm}
        title="Cancel this sign-in?"
        confirmLabel="Cancel sign-in"
        onCancel={() => setConfirm(false)}
        onConfirm={async () => {
          try {
            const r = await smartAuthApi.cancel(s.id);
            toast.success('Sign-in cancelled', `${s.agent_name} continues without signing in to ${s.site}.`);
            onChanged?.(r);
            setConfirm(false);
          } catch (e) {
            toast.error(e, 'Could not cancel the sign-in');
          }
        }}
      >
        <p>
          <strong>{s.agent_name}</strong> cannot sign in to <strong>{s.site}</strong> for this task. The task continues without it.
        </p>
      </ConfirmDialog>
    </article>
  );
}

/** Agent chat tab: the agent's active sign-ins, inline above the composer. */
export function AgentSignIns({ agentId }: { agentId: string }) {
  const q = useSignIns((sig) => smartAuthApi.sessions({ agentId, active: true }, sig), [agentId], (ev) => isAuthEvent(ev) && ev.agent_id === agentId);
  const list = (q.data ?? []).filter((s) => !isTerminal(s));
  if (!list.length) return null;
  const replace = (s: AuthSession) => q.setData((xs) => (xs ? xs.map((x) => (x.id === s.id ? { ...x, ...s } : x)) : xs));
  return (
    <div className="space-y-3" data-testid="agent-signins">
      {list.map((s) => (
        <SignInCard key={s.id} s={s} onChanged={replace} />
      ))}
    </div>
  );
}

/** Password Vault: the latest sign-in requests (state, site, agent, time). */
export function SignInRequestsCard() {
  const { open } = useSmartAuth();
  const q = useSignIns((sig) => smartAuthApi.sessions({ limit: 20 }, sig), [], isAuthEvent);
  const rows = q.data ?? [];
  return (
    <Card
      title="Sign-in requests"
      icon={<IconKey />}
      subtitle="When an agent’s task reaches a website login, NEBULA asks you here, in the Approval Center or in the Mini App. What you type goes only to the isolated sign-in browser — never to the agent or the AI."
      padded={false}
    >
      {q.data === null ? (
        <p className="px-4 py-4 text-sm text-muted sm:px-5">{q.error ? 'Sign-in requests are not available on this host.' : 'Loading sign-in requests…'}</p>
      ) : rows.length === 0 ? (
        <p className="px-4 py-4 text-sm text-muted sm:px-5">No sign-in requests yet.</p>
      ) : (
        <ul className="divide-y divide-border/60" aria-label="Recent sign-in requests" data-testid="signin-requests">
          {rows.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 sm:px-5">
              <Badge tone={BADGE_TONE[stateTone(s)]} dot>
                {stateLabel(s.state)}
              </Badge>
              <Mono className="text-text">{s.site}</Mono>
              <span className="text-sm text-muted">{s.agent_name}</span>
              <time className="ml-auto text-xs text-subtle" dateTime={new Date(s.created_at * 1000).toISOString()} title={formatTime(s.created_at)}>
                {relativeTime(s.created_at)}
              </time>
              {!isTerminal(s) && (
                <Button size="xs" variant={needsOwner(s) ? 'primary' : 'secondary'} onClick={() => open(s)}>
                  {needsOwner(s) ? 'Continue' : 'Details'}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
