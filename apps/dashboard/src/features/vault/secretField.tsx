// One stored secret (password / notes) of a credential: masked until the owner clicks Reveal, hidden again after
// 30 s, on lock and on unmount. Copy writes to the clipboard only on click and says so.
import { useEffect, useRef, useState } from 'react';
import { useToast } from '../../components/Toast';
import { IconCopy, IconEye } from '../../components/icons';
import { Button } from '../../components/ui';
import { useAction } from '../../hooks/useApi';
import { vaultApi } from './api';
import { useSecondsLeft } from './clock';
import { useVaultLockSignal } from './hooks';
import type { RevealField } from './types';

export const REVEAL_SECONDS = 30;

const COPY_NOTICE = 'It stays on the clipboard until you copy something else — other apps on this Mac can read it. Clear it when you are done.';

/** Writes text to the clipboard. Called only from a click handler (never automatically). */
export async function copyToClipboard(text: string): Promise<void> {
  if (!navigator.clipboard?.writeText) throw new Error('The clipboard is not available here (it needs http://127.0.0.1 or HTTPS).');
  await navigator.clipboard.writeText(text);
}

export function CopyButton({ text, label, size = 'xs' }: { text: string; label: string; size?: 'xs' | 'sm' }) {
  const toast = useToast();
  return (
    <Button
      size={size}
      variant="ghost"
      icon={<IconCopy />}
      aria-label={`Copy ${label}`}
      onClick={async () => {
        try {
          await copyToClipboard(text);
          toast.info(`${label[0].toUpperCase()}${label.slice(1)} copied to the clipboard`, COPY_NOTICE);
        } catch (e) {
          toast.error(e, 'Copy failed');
        }
      }}
    >
      Copy
    </Button>
  );
}

export function SecretField({
  entryId,
  field,
  label,
  present,
  withReauth,
  onActivity,
  canReveal,
}: {
  entryId: string;
  field: RevealField;
  label: string;
  /** The host says a value is stored. */
  present: boolean;
  withReauth: <T>(fn: () => Promise<T>) => Promise<T>;
  onActivity?: () => void;
  canReveal: string | null;
}) {
  const toast = useToast();
  const { run, isPending } = useAction();
  const [value, setValue] = useState<string | null>(null);
  const [hideAt, setHideAt] = useState<number | null>(null);
  const left = useSecondsLeft(hideAt);
  const mounted = useRef(true);
  const lower = label.toLowerCase();

  const hide = () => {
    setValue(null);
    setHideAt(null);
  };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // Auto-hide 30 s after a reveal.
  useEffect(() => {
    if (value === null) return;
    const t = setTimeout(hide, REVEAL_SECONDS * 1000);
    return () => clearTimeout(t);
  }, [value]);
  useVaultLockSignal(hide);

  const fetchValue = () => run(`reveal-${field}`, () => withReauth(() => vaultApi.reveal(entryId, field)), { errorTitle: `Could not reveal the ${lower}` });

  const reveal = async () => {
    const v = await fetchValue();
    if (v === undefined || !mounted.current) return;
    setValue(v);
    setHideAt(Date.now() / 1000 + REVEAL_SECONDS);
    onActivity?.();
  };

  const copy = async () => {
    // Copying fetches the value without showing it when it is not revealed already.
    const v = value ?? (await fetchValue());
    if (v === undefined || !mounted.current) return;
    try {
      await copyToClipboard(v);
      toast.info(`${label} copied to the clipboard`, COPY_NOTICE);
      onActivity?.();
    } catch (e) {
      toast.error(e, 'Copy failed');
    }
  };

  if (!present) return <span className="text-sm text-subtle">Not stored</span>;
  const busy = isPending(`reveal-${field}`);
  return (
    <div className="min-w-0 space-y-1.5">
      {value === null ? (
        <span className="font-mono text-sm tracking-widest text-muted" aria-label={`${label} hidden`}>
          ••••••••••••
        </span>
      ) : (
        <div className={`rounded-lg border border-warn/30 bg-warn/[0.06] px-2.5 py-1.5 font-mono text-[13px] break-all text-text ${field === 'notes' ? 'whitespace-pre-wrap' : ''}`} data-testid={`revealed-${field}`}>
          {value}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        {value === null ? (
          <Button size="xs" variant="outline" icon={<IconEye />} loading={busy} disabledReason={canReveal} onClick={() => void reveal()} aria-label={`Reveal ${lower}`}>
            Reveal
          </Button>
        ) : (
          <Button size="xs" variant="outline" onClick={hide} aria-label={`Hide ${lower}`}>
            Hide
          </Button>
        )}
        {field !== 'notes' && (
          <Button size="xs" variant="ghost" icon={<IconCopy />} disabledReason={canReveal} disabled={busy} onClick={() => void copy()} aria-label={`Copy ${lower}`}>
            Copy
          </Button>
        )}
        {value !== null && (
          <span className="text-xs text-subtle" role="status">
            Hides in {Math.ceil(left)} s
          </span>
        )}
      </div>
    </div>
  );
}
