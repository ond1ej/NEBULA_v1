// Small building blocks shared by the bot network page and the add-bot wizard.
import { useId, useState } from 'react';
import { IconCopy, IconExternal } from '../../components/icons';
import { useToast } from '../../components/Toast';
import { Badge, Button, Select, StatusDot, type Tone } from '../../components/ui';
import { useNow } from '../../hooks/useApi';
import { formatDuration } from '../../lib/format';
import { botsApi, isNotifyLevel, NOTIFY_HINT, NOTIFY_LABEL, NOTIFY_LEVELS, type BotPairing, type BotStatus, type NotifyLevel } from './api';

export const BOT_STATUS_TONE: Record<string, Tone> = { ACTIVE: 'success', DISABLED: 'neutral', ERROR: 'danger', REVOKED: 'danger' };

export const BOT_STATUS_HINT: Record<string, string> = {
  ACTIVE: 'Enabled; the gateway long-polls Telegram for this bot.',
  DISABLED: 'Disabled by you; no polling, no notifications.',
  ERROR: 'Polling failed repeatedly; see the last error. Reconnect to try again.',
  REVOKED: 'Telegram rejected the token (revoked or regenerated in @BotFather). Remove the binding and add the bot again with the new token.',
};

export function BotStatusBadge({ status }: { status: BotStatus }) {
  return (
    <Badge tone={BOT_STATUS_TONE[status] ?? 'neutral'} dot title={BOT_STATUS_HINT[status]}>
      {status}
    </Badge>
  );
}

export function PollingIndicator({ polling, enabled = true }: { polling: boolean | null | undefined; enabled?: boolean }) {
  const label = !enabled ? 'Not polling (disabled)' : polling ? 'Polling' : 'Not polling';
  return (
    <span className="inline-flex items-center gap-1.5 text-sm text-text">
      <StatusDot tone={!enabled ? 'neutral' : polling ? 'success' : 'warn'} pulse={Boolean(enabled && polling)} label={label} />
      <span>{label}</span>
    </span>
  );
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function CopyButton({ text, label }: { text: string; label: string }) {
  const toast = useToast();
  return (
    <Button
      size="xs"
      variant="ghost"
      icon={<IconCopy />}
      onClick={async () => {
        if (await copy(text)) toast.success('Copied to the clipboard');
        else toast.warn('Copy failed', 'Select the text and copy it manually.');
      }}
    >
      {label}
    </Button>
  );
}

/** One-time pairing code with deep link and live expiry countdown. */
export function PairingCode({ pairing, botUsername, onNew, busy }: { pairing: BotPairing; botUsername: string | null; onNew: () => void; busy: boolean }) {
  const now = useNow(1000) / 1000;
  const left = pairing.expires_at - now;
  const expired = left <= 0;
  return (
    <div className="rounded-xl border border-accent/35 bg-accent/[0.06] p-4" aria-live="polite" data-testid="bot-pairing">
      <p className="text-2xs font-semibold tracking-wider text-subtle uppercase">Pairing code{botUsername ? ` for @${botUsername}` : ''}</p>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <p className={`font-mono text-2xl tracking-[0.25em] break-all sm:text-3xl ${expired ? 'text-subtle line-through' : 'text-text'}`}>{pairing.code}</p>
        {!expired && <CopyButton text={pairing.code} label="Copy code" />}
      </div>
      <p className={`mt-1 text-sm tabular-nums ${expired ? 'text-danger' : left < 60 ? 'text-warn' : 'text-muted'}`} role="timer">
        {expired ? 'Expired — generate a new code.' : `Expires in ${formatDuration(left)}`}
      </p>
      {!expired && (
        <>
          <p className="mt-3 text-sm text-text">{pairing.instructions}</p>
          {pairing.deep_link && (
            <p className="mt-2 flex flex-wrap items-center gap-2 text-sm">
              <a className="inline-flex min-w-0 items-center gap-1 rounded break-all text-accent-soft underline-offset-2 hover:underline focus-ring" href={pairing.deep_link} target="_blank" rel="noopener noreferrer">
                {pairing.deep_link}
                <IconExternal className="size-3.5 shrink-0" />
              </a>
              <CopyButton text={pairing.deep_link} label="Copy link" />
            </p>
          )}
        </>
      )}
      <p className="mt-3 text-xs leading-5 text-muted">
        A Telegram user who is already an approved owner of the main NEBULA bot is <strong className="text-text">approved automatically</strong> when they send this code. Anyone else
        shows up here as <em>pending</em> and must be approved in the Dashboard. Codes are single-use.
      </p>
      {expired && (
        <Button className="mt-3" size="sm" onClick={onNew} loading={busy}>
          Generate a new code
        </Button>
      )}
    </div>
  );
}

/** Notification level for one paired Telegram user (main bot or agent bot). */
export function NotifyLevelSelect({
  userRowId,
  value,
  userName,
  onSaved,
}: {
  userRowId: string;
  value: string | null | undefined;
  userName: string;
  onSaved?: (level: NotifyLevel) => void;
}) {
  const toast = useToast();
  const id = useId();
  const [level, setLevel] = useState<NotifyLevel>(isNotifyLevel(value) ? value : 'important');
  const [saving, setSaving] = useState(false);
  const change = async (next: NotifyLevel) => {
    const prev = level;
    setLevel(next);
    setSaving(true);
    try {
      await botsApi.setNotifyLevel(userRowId, next);
      toast.success(`Notifications for ${userName}: ${NOTIFY_LABEL[next]}`);
      onSaved?.(next);
    } catch (e) {
      setLevel(prev);
      toast.error(e, 'Could not change the notification level');
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="sr-only">
        Notification level for {userName}
      </label>
      <Select id={id} value={level} disabled={saving} aria-describedby={`${id}-hint`} onChange={(e) => void change(e.target.value as NotifyLevel)} className="h-8 text-[13px] sm:w-48">
        {NOTIFY_LEVELS.map((lv) => (
          <option key={lv} value={lv}>
            {NOTIFY_LABEL[lv]}
          </option>
        ))}
      </Select>
      <p id={`${id}-hint`} className="mt-1 text-2xs text-subtle">
        {NOTIFY_HINT[level]}
      </p>
    </div>
  );
}
