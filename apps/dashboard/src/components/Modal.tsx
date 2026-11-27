import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useIsMobile } from '../hooks/useMediaQuery';
import { IconAlert, IconX } from './icons';
import { Button } from './ui';

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Body scroll lock shared by every open dialog (nested dialogs keep it until the last one closes).
let locks = 0;
let savedOverflow = '';
function lockScroll() {
  if (locks === 0) {
    savedOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
  locks += 1;
}
function unlockScroll() {
  locks = Math.max(0, locks - 1);
  if (locks === 0) document.body.style.overflow = savedOverflow;
}

// Only the top-most dialog reacts to Escape / Tab.
const stack: symbol[] = [];

/**
 * A host's Back button for dialogs (the Telegram Mini App's administration area hooks Telegram's BackButton in here):
 * every dialog opened while it is set registers its close (the top-most closes first); returns the unregister.
 */
export type DialogBackRegistrar = (close: () => void) => () => void;
let backRegistrar: DialogBackRegistrar | null = null;
export function setDialogBackRegistrar(fn: DialogBackRegistrar | null): void {
  backRegistrar = fn;
}

/** Focus trap, Escape to close, focus restore and scroll lock for any modal surface. */
function useDialog(open: boolean, panel: RefObject<HTMLDivElement | null>, onClose: () => void, dismissible: boolean) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const dismissRef = useRef(dismissible);
  dismissRef.current = dismissible;

  useEffect(() => {
    if (!open) return;
    const me = Symbol('dialog');
    stack.push(me);
    const prev = document.activeElement as HTMLElement | null;
    const el = panel.current;
    const first = el?.querySelector<HTMLElement>('[data-autofocus]') ?? el?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? el)?.focus();
    lockScroll();
    const onKey = (e: KeyboardEvent) => {
      if (stack[stack.length - 1] !== me) return;
      if (e.key === 'Escape' && dismissRef.current) {
        e.stopPropagation();
        onCloseRef.current();
      } else if (e.key === 'Tab' && el) {
        const nodes = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((n) => !n.closest('[inert]'));
        if (nodes.length === 0) return;
        const firstN = nodes[0];
        const lastN = nodes[nodes.length - 1];
        if (e.shiftKey && document.activeElement === firstN) {
          e.preventDefault();
          lastN.focus();
        } else if (!e.shiftKey && document.activeElement === lastN) {
          e.preventDefault();
          firstN.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    // Back closes the dialog like Escape (nothing while it may not be dismissed, e.g. a request is running)
    const offBack = backRegistrar?.(() => {
      if (dismissRef.current) onCloseRef.current();
    });
    return () => {
      document.removeEventListener('keydown', onKey);
      offBack?.();
      const i = stack.indexOf(me);
      if (i >= 0) stack.splice(i, 1);
      unlockScroll();
      prev?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return { onCloseRef, dismissRef };
}

function CloseButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Close dialog"
      className="-mr-1.5 grid size-8 shrink-0 place-items-center rounded-lg text-subtle transition-colors hover:bg-white/[0.06] hover:text-text focus-ring touch:size-11"
    >
      <IconX className="size-4" />
    </button>
  );
}

export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  size = 'md',
  dismissible = true,
  description,
  icon,
}: {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /** When false, Escape / backdrop do not close (e.g. while a request is running). */
  dismissible?: boolean;
  description?: ReactNode;
  icon?: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();
  const mobile = useIsMobile();
  const { onCloseRef, dismissRef } = useDialog(open, panel, onClose, dismissible);

  if (!open) return null;
  const width = size === 'sm' ? 'sm:max-w-md' : size === 'lg' ? 'sm:max-w-3xl' : size === 'xl' ? 'sm:max-w-5xl' : 'sm:max-w-xl';
  return createPortal(
    <div
      className={`fixed inset-0 z-[90] flex animate-fade-in bg-black/60 backdrop-blur-[2px] ${mobile ? 'items-end' : 'items-center justify-center p-4'}`}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && dismissRef.current) onCloseRef.current();
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={`flex w-full flex-col border border-border-strong bg-elevated shadow-overlay focus:outline-none ${width} ${
          mobile ? 'max-h-[92dvh] animate-sheet-up rounded-t-2xl pb-safe' : 'max-h-[88vh] animate-pop-in rounded-2xl'
        }`}
      >
        {mobile && <span aria-hidden className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-white/15" />}
        <header className="flex items-start justify-between gap-4 px-5 pt-4 pb-3">
          <div className="flex min-w-0 items-start gap-3">
            {icon}
            <div className="min-w-0">
              <h2 id={titleId} className="text-[15px] leading-6 font-semibold text-text">
                {title}
              </h2>
              {description && (
                <p id={descId} className="mt-0.5 text-sm text-muted">
                  {description}
                </p>
              )}
            </div>
          </div>
          {dismissible && <CloseButton onClick={onClose} />}
        </header>
        <div className="min-h-0 overflow-y-auto px-5 pb-4 text-sm text-text">{children}</div>
        {footer && <footer className="flex flex-wrap justify-end gap-2 border-t border-border px-5 py-3">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

/**
 * Side panel (desktop) / full-height sheet (phone) for editors and detail views.
 * Same accessibility contract as Modal: focus trap, Escape, restored focus.
 */
export function Drawer({
  open,
  title,
  onClose,
  children,
  footer,
  description,
  width = 'md',
  dismissible = true,
}: {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  description?: ReactNode;
  width?: 'md' | 'lg' | 'xl';
  dismissible?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();
  const { onCloseRef, dismissRef } = useDialog(open, panel, onClose, dismissible);
  if (!open) return null;
  const w = width === 'xl' ? 'sm:w-[min(920px,100vw)]' : width === 'lg' ? 'sm:w-[min(720px,100vw)]' : 'sm:w-[min(520px,100vw)]';
  return createPortal(
    <div
      className="fixed inset-0 z-[85] flex animate-fade-in justify-end bg-black/55 backdrop-blur-[2px]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && dismissRef.current) onCloseRef.current();
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={`flex h-dvh w-full animate-slide-in-right flex-col border-l border-border-strong bg-elevated shadow-overlay focus:outline-none ${w}`}
      >
        <header className="flex items-start justify-between gap-4 border-b border-border px-5 pt-[max(1rem,env(safe-area-inset-top))] pb-3.5">
          <div className="min-w-0">
            <h2 id={titleId} className="text-[15px] leading-6 font-semibold text-text">
              {title}
            </h2>
            {description && (
              <p id={descId} className="mt-0.5 text-sm text-muted">
                {description}
              </p>
            )}
          </div>
          {dismissible && <CloseButton onClick={onClose} />}
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 text-sm text-text">{children}</div>
        {footer && <footer className="flex flex-wrap justify-end gap-2 border-t border-border px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

/**
 * Confirmation dialog for destructive actions. `onConfirm` may be async; the dialog stays open
 * (and non-dismissible) while it runs, and closes only on success.
 */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel = 'Confirm',
  destructive = true,
  onConfirm,
  onCancel,
  busyText,
  confirmDisabled,
}: {
  open: boolean;
  title: ReactNode;
  children: ReactNode;
  confirmLabel?: string;
  destructive?: boolean;
  onConfirm: () => Promise<unknown> | unknown;
  onCancel: () => void;
  busyText?: string;
  /** Disable the confirm button with this reason (e.g. a required choice is missing). */
  confirmDisabled?: string | null;
}) {
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) setBusy(false);
  }, [open]);
  const run = async () => {
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      title={title}
      onClose={onCancel}
      size="sm"
      dismissible={!busy}
      icon={
        destructive ? (
          <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-lg border border-danger/25 bg-danger/10 text-danger">
            <IconAlert className="size-4" />
          </span>
        ) : undefined
      }
      footer={
        <>
          <Button onClick={onCancel} disabled={busy} data-autofocus>
            Cancel
          </Button>
          <Button variant={destructive ? 'danger' : 'primary'} onClick={run} loading={busy} disabledReason={confirmDisabled ?? null}>
            {busy && busyText ? busyText : confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-3 leading-relaxed text-muted [&_strong]:text-text">{children}</div>
    </Modal>
  );
}
