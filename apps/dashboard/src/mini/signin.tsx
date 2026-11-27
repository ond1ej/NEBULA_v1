// Smart Authentication in the Mini App: the sign-in bottom sheet (hosting the shared <SmartAuthRequest>), the compact
// card in a conversation's timeline, the finished-session status line and the "Needs you" row of Activity.
// One session object everywhere: the detail, the conversation list and approval-center `sign_ins` are patched together.
import { Suspense, useEffect, useState } from 'react';
import { lazyNamed } from '../lib/lazy';
import { relativeTime } from '../lib/format';
import { isTerminal, needsOwner, pickNewer, stateText, stateTone } from '../features/smartauth/core/lib';
import type { AuthSession } from '../features/smartauth/core/types';
import { useBackOverlay } from './backStack';
import { canDecide, useMini } from './context';
import { peekQuery, setQueryData, useActions } from './hooks';
import { IcLock, IcX } from './icons';
import type { ApprovalCenter } from './types';
import { Btn, cx, Spinner, StatusDot, type Tone } from './uiKit';
import { ConfirmSheet } from './uiExtra';

export const authSessionKey = (id: string) => `auth-session:${id}`;
export const convSignInsKey = (conversationId: string) => `auth-sessions:conv:${conversationId}`;
export const APPROVAL_CENTER_KEY = 'approvals:count';

const replace = (xs: AuthSession[], s: AuthSession) => (xs.some((x) => x.id === s.id) ? xs.map((x) => (x.id === s.id ? pickNewer(x, { ...x, ...s }) : x)) : xs);

/**
 * Applies a session returned by submit / cancel to every cached view of it (detail, conversation list, Activity). A late
 * response never replaces a newer step that arrived meanwhile (pickNewer).
 */
export function applySession(s: AuthSession): void {
  setQueryData<AuthSession>(authSessionKey(s.id), (prev) => (prev ? pickNewer(prev, { ...prev, ...s }) : s));
  if (s.conversation_id && peekQuery(convSignInsKey(s.conversation_id))) setQueryData<AuthSession[]>(convSignInsKey(s.conversation_id), (xs) => (xs ? replace(xs, s) : xs));
  if (peekQuery(APPROVAL_CENTER_KEY))
    setQueryData<ApprovalCenter>(APPROVAL_CENTER_KEY, (ac) => {
      if (!ac?.sign_ins) return ac;
      const list = isTerminal(s) ? ac.sign_ins.filter((x) => x.id !== s.id) : ac.sign_ins.map((x) => (x.id === s.id ? { ...x, ...s, kind: 'sign_in' as const } : x));
      return { ...ac, sign_ins: list };
    });
}

const TONE: Record<ReturnType<typeof stateTone>, Tone> = { success: 'success', danger: 'danger', warning: 'warning', neutral: 'neutral', accent: 'accent' };

// ---------------------------------------------------------------- the sheet (own chunk: loaded on first use)
const AuthSheetImpl = lazyNamed(() => import('./signinSheet'), 'AuthSheet');

/** Starts loading the sign-in form while the owner looks at a card / notification. */
export const preloadAuthSheet = () => AuthSheetImpl.preload();

/**
 * Bottom sheet for one sign-in session (the shared <SmartAuthRequest>). `seed` (a list row) renders at once; Escape,
 * the scrim, the close button and Telegram's BackButton close it, which drops every typed value.
 */
export function AuthSheet(props: { sessionId: string; seed?: AuthSession | null; onClose: () => void }) {
  return (
    <Suspense fallback={null}>
      <AuthSheetImpl {...props} />
    </Suspense>
  );
}

// ---------------------------------------------------------------- conversation card
/** Compact card in a conversation's timeline; finished sessions shrink to a status line. */
export function AuthRequestCard({ s, onOpen }: { s: AuthSession; onOpen: (s: AuthSession) => void }) {
  const ctx = useMini();
  const { api } = ctx;
  const canAnswer = canDecide(ctx);
  const { run, isPending } = useActions();
  const [confirm, setConfirm] = useState(false);
  const waiting = needsOwner(s);
  useEffect(() => {
    if (waiting) void preloadAuthSheet();
  }, [waiting]);
  // Telegram's BackButton closes the "Cancel this sign-in?" sheet first
  useBackOverlay(confirm && !isTerminal(s), () => {
    if (!isPending('cancel')) setConfirm(false);
  });
  if (isTerminal(s)) {
    const tone = TONE[stateTone(s)];
    return (
      <li className="my-2 flex justify-center px-4" data-testid="auth-status" data-state={s.state}>
        <span className={cx('inline-flex max-w-full items-center gap-1.5 rounded-full bg-panel px-3 py-1 text-caption', tone === 'success' ? 'text-success' : tone === 'danger' ? 'text-danger' : 'text-muted')}>
          <StatusDot tone={tone} />
          <span className="truncate">{s.state === 'AUTHENTICATED' ? `Signed in to ${s.site} ✓` : s.state === 'FAILED' ? `Sign-in to ${s.site} failed` : stateText(s)}</span>
        </span>
      </li>
    );
  }
  const cancel = async () => {
    const r = await run('cancel', () => api.smartAuth.cancel(s.id), { success: 'Sign-in cancelled', errorTitle: 'Could not cancel the sign-in' });
    if (r) {
      applySession(r);
      setConfirm(false);
    }
  };
  return (
    <li className="my-3" data-testid="auth-card" data-state={s.state}>
      <div className={cx('rounded-card bg-panel p-3.5 ring-1', waiting ? 'ring-warn/35' : 'ring-border')} role="group" aria-label={`Authentication required for ${s.site}`}>
        <p className="flex flex-wrap items-center gap-x-1.5 text-footnote font-semibold text-warn">
          <span>Authentication required</span>
          <span aria-hidden className="text-subtle">
            ·
          </span>
          <span className="font-mono text-text">{s.site}</span>
          <span aria-hidden className="text-subtle">
            ·
          </span>
          <span className="font-medium text-muted">Agent: {s.agent_name}</span>
        </p>
        <p className="mt-1 flex items-center gap-2 text-subhead text-muted" role="status">
          {!waiting && <Spinner className="size-3.5" />}
          {stateText(s)}
        </p>
        <div className="mt-3 flex gap-2">
          <Btn size="sm" variant={waiting && canAnswer ? 'primary' : 'tinted'} className="flex-1" onClick={() => onOpen(s)}>
            {waiting && canAnswer ? 'Continue sign-in' : 'Show details'}
          </Btn>
          {canAnswer && (
            <Btn size="sm" variant="secondary" icon={<IcX />} onClick={() => setConfirm(true)}>
              Cancel
            </Btn>
          )}
        </div>
      </div>
      <ConfirmSheet open={confirm} title="Cancel this sign-in?" confirmLabel="Cancel sign-in" tone="danger" busy={isPending('cancel')} onCancel={() => setConfirm(false)} onConfirm={() => void cancel()}>
        {s.agent_name} cannot sign in to {s.site} for this task. The task continues without it.
      </ConfirmSheet>
    </li>
  );
}

// ---------------------------------------------------------------- Activity "Needs you"
export function SignInRow({ s, onOpen }: { s: AuthSession; onOpen: (s: AuthSession) => void }) {
  const waiting = needsOwner(s);
  return (
    <li className="group/row">
      <button type="button" onClick={() => onOpen(s)} className="nb-row flex min-h-14 w-full items-center gap-3 pl-4 text-left focus-ring" data-testid="signin-row">
        <span className={cx('grid size-9 shrink-0 place-items-center rounded-full [&>svg]:size-[18px]', waiting ? 'bg-warn/15 text-warn' : 'bg-accent/15 text-accent-soft')}>
          {waiting ? <IcLock /> : <Spinner className="size-4" />}
        </span>
        <span className="min-w-0 flex-1 border-b border-border py-2.5 pr-3 group-last/row:border-b-0">
          <span className="flex items-center gap-2">
            <span className="truncate text-subhead font-semibold text-text">Sign in to {s.site}</span>
            <span className="ml-auto shrink-0 text-caption text-subtle">{relativeTime(s.created_at)}</span>
          </span>
          <span className="block truncate text-footnote text-muted">
            {s.agent_name} · {stateText(s)}
          </span>
        </span>
      </button>
    </li>
  );
}
