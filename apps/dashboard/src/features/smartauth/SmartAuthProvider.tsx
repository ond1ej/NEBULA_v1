// Dashboard side of Smart Authentication: a notice when an agent needs the owner to sign in somewhere (`auth.request`
// event, no polling and no request until the owner opens it) and one modal that hosts the shared <SmartAuthRequest>.
// Every list (Approval Center, agent chat, Password Vault) opens sign-ins through `useSmartAuth().open`.
// The Dashboard on this Mac is local: no remote PIN is asked here (the host decides `local`).
import { createContext, Suspense, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { IconVault, IconX } from '../../components/icons';
import { Button } from '../../components/ui';
import { useNebulaEvents } from '../../hooks/useEvents';
import { lazyNamed } from '../../lib/lazy';
import { authEventPayload, authEventSession, OWNER_WAIT_STATES } from './core/state';
import type { AuthSession, AuthState } from './core/types';

// The form (shared <SmartAuthRequest>) is its own chunk: loaded when a notice appears or a list opens a sign-in.
const AuthModal = lazyNamed(() => import('./AuthModal'), 'AuthModal');

interface SmartAuthCtx {
  /** Opens the sign-in modal (a list row renders at once while the detail loads). */
  open: (s: AuthSession | string) => void;
  /** The session currently shown in the modal, if any. */
  openId: string | null;
}

const Ctx = createContext<SmartAuthCtx>({ open: () => {}, openId: null });

export function useSmartAuth(): SmartAuthCtx {
  return useContext(Ctx);
}

interface Notice {
  sessionId: string;
  agent: string;
  site: string;
  origin: string | null;
}

export function SmartAuthProvider({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState<{ id: string; seed: AuthSession | null } | null>(null);
  const [notices, setNotices] = useState<Notice[]>([]);
  const currentId = current?.id ?? null;
  const currentRef = useRef(currentId);
  currentRef.current = currentId;

  const open = useCallback((s: AuthSession | string) => {
    const id = typeof s === 'string' ? s : s.id;
    setCurrent({ id, seed: typeof s === 'string' ? null : s });
    setNotices((xs) => xs.filter((n) => n.sessionId !== id));
  }, []);

  useNebulaEvents((ev) => {
    const id = authEventSession(ev);
    if (!id) return;
    const p = authEventPayload(ev);
    if (ev.type === 'auth.request') {
      if (currentRef.current === id) return; // already open: the modal refreshes itself
      const n: Notice = { sessionId: id, agent: p.agent_name ?? 'An agent', site: p.site ?? 'a website', origin: p.origin ?? null };
      setNotices((xs) => [...xs.filter((x) => x.sessionId !== id), n].slice(-3));
      void AuthModal.preload();
      return;
    }
    // answered elsewhere (Mini App, another tab) or finished: the notice goes away
    const st = p.state as AuthState | undefined;
    if (st && !OWNER_WAIT_STATES.has(st)) setNotices((xs) => xs.filter((x) => x.sessionId !== id));
  });

  const value = useMemo<SmartAuthCtx>(() => ({ open, openId: currentId }), [open, currentId]);
  return (
    <Ctx.Provider value={value}>
      {children}
      {notices.length > 0 && (
        <div className="pointer-events-none fixed inset-x-3 top-3 z-[120] flex flex-col items-stretch gap-2 sm:inset-x-auto sm:top-16 sm:right-5 sm:w-[400px]" aria-live="assertive">
          {notices.map((n) => (
            <div key={n.sessionId} role="alert" data-testid="auth-notice" className="pointer-events-auto animate-toast-in rounded-xl border border-warn/40 bg-elevated/95 px-4 py-3 shadow-overlay backdrop-blur-md">
              <div className="flex items-start gap-3">
                <span aria-hidden className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg bg-warn/15 text-warn [&>svg]:size-4">
                  <IconVault />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] leading-5 font-semibold text-text">
                    Authentication required — {n.agent} needs you to sign in to {n.site}
                  </p>
                  {n.origin && <p className="mt-0.5 font-mono text-xs break-all text-muted">{n.origin}</p>}
                  <div className="mt-2.5 flex flex-wrap gap-2">
                    <Button size="sm" variant="primary" onClick={() => open(n.sessionId)}>
                      Open
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setNotices((xs) => xs.filter((x) => x.sessionId !== n.sessionId))}>
                      Later
                    </Button>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setNotices((xs) => xs.filter((x) => x.sessionId !== n.sessionId))}
                  className="-mt-0.5 -mr-1 grid size-7 shrink-0 place-items-center rounded-md text-subtle hover:bg-white/[0.06] hover:text-text focus-ring touch:size-10"
                  aria-label="Dismiss sign-in notice"
                >
                  <IconX className="size-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {current && (
        <Suspense fallback={null}>
          <AuthModal key={current.id} sessionId={current.id} seed={current.seed} onClose={() => setCurrent(null)} />
        </Suspense>
      )}
    </Ctx.Provider>
  );
}

