import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError } from '../lib/http';
import { IconAlert, IconCheckCircle, IconInfo, IconX, IconXCircle } from './icons';

export type ToastKind = 'success' | 'error' | 'info' | 'warn';

export interface ToastItem {
  id: number;
  kind: ToastKind;
  title: string;
  message?: string;
  meta?: string;
}

export interface ToastApi {
  success: (title: string, message?: string) => void;
  info: (title: string, message?: string) => void;
  warn: (title: string, message?: string) => void;
  /** Shows ApiError.message (+ code / request id) or any Error. */
  error: (err: unknown, title?: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

let nextId = 1;

const ICON: Record<ToastKind, ReactNode> = {
  success: <IconCheckCircle className="size-4 text-success" />,
  error: <IconXCircle className="size-4 text-danger" />,
  info: <IconInfo className="size-4 text-info" />,
  warn: <IconAlert className="size-4 text-warn" />,
};

const SR: Record<ToastKind, string> = { success: 'Success: ', error: 'Failure: ', info: '', warn: 'Warning: ' };

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    setItems((xs) => xs.filter((x) => x.id !== id));
    const t = timers.current.get(id);
    if (t) clearTimeout(t);
    timers.current.delete(id);
  }, []);

  const push = useCallback(
    (t: Omit<ToastItem, 'id'>) => {
      const id = nextId++;
      setItems((xs) => [...xs.slice(-4), { ...t, id }]);
      const ttl = t.kind === 'error' ? 12_000 : t.kind === 'warn' ? 9_000 : 5_000;
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), ttl),
      );
    },
    [dismiss],
  );

  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const t of map.values()) clearTimeout(t);
      map.clear();
    };
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      success: (title, message) => push({ kind: 'success', title, message }),
      info: (title, message) => push({ kind: 'info', title, message }),
      warn: (title, message) => push({ kind: 'warn', title, message }),
      error: (err, title) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        if (err instanceof ApiError) {
          const meta = [err.code, err.status ? `HTTP ${err.status}` : null, err.requestId ? `request ${err.requestId}` : null]
            .filter(Boolean)
            .join(' · ');
          push({ kind: 'error', title: title ?? 'Request failed', message: err.message, meta });
        } else {
          push({ kind: 'error', title: title ?? 'Error', message: err instanceof Error ? err.message : String(err) });
        }
      },
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        className="pointer-events-none fixed inset-x-3 bottom-[calc(env(safe-area-inset-bottom)+76px)] z-[130] flex flex-col items-stretch gap-2 sm:inset-x-auto sm:right-5 sm:bottom-5 sm:w-[380px] md:bottom-5"
        aria-live="polite"
        aria-relevant="additions"
      >
        {items.map((t) => (
          <div
            key={t.id}
            role={t.kind === 'error' ? 'alert' : 'status'}
            className="pointer-events-auto animate-toast-in rounded-xl border border-border-strong bg-elevated/95 px-3.5 py-3 shadow-overlay backdrop-blur-md"
          >
            <div className="flex items-start gap-3">
              <span aria-hidden className="mt-0.5 shrink-0">
                {ICON[t.kind]}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[13px] leading-5 font-semibold text-text">
                  <span className="sr-only">{SR[t.kind]}</span>
                  {t.title}
                </p>
                {t.message && <p className="mt-0.5 text-[13px] leading-5 break-words text-muted">{t.message}</p>}
                {t.meta && <p className="mt-1 font-mono text-2xs break-all text-subtle">{t.meta}</p>}
              </div>
              <button
                type="button"
                onClick={() => dismiss(t.id)}
                className="-mt-0.5 -mr-1 grid size-7 shrink-0 place-items-center rounded-md text-subtle transition-colors hover:bg-white/[0.06] hover:text-text focus-ring touch:size-10"
                aria-label="Dismiss notification"
              >
                <IconX className="size-3.5" />
              </button>
            </div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}
