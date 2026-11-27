// One chat message: owner (right, accent-tinted bubble), agent (left, neutral surface, Markdown), system (centred,
// muted). Attachments: image thumbnails (tap: full view), audio player with transcript (or an honest "not
// configured"), file chips. Tap a bubble for Copy and the exact time; failed sends offer "Retry".
import { memo, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { downloadBlob } from '../../lib/format';
import { useMini } from '../context';
import { bytes, clockTime } from '../format';
import { useQuery } from '../hooks';
import { IcAlert, IcCheck, IcClip, IcCopy, IcRetry, IcX } from '../icons';
import { haptic } from '../telegram';
import type { AgentAvatar } from '../../types';
import type { Attachment, AttachmentTranscript, Message, SttStatus } from '../types';
import { AuthImage } from '../uiExtra';
import { Avatar, cx, Spinner } from '../uiKit';
import { kindOf, typeLabel } from './attachments';
import { copyText, Markdown } from './markdown';
import type { LocalAttachment, PendingMessage } from './model';
import { TaskInline } from './TaskInline';

// ---------------------------------------------------------------- attachments
type AnyAttachment = { local?: LocalAttachment; server?: Partial<Attachment> & { id?: string }; ref?: string };

function normalize(m: Message, local?: PendingMessage): AnyAttachment[] {
  const server: AnyAttachment[] = (m.attachments ?? []).map((a) => (typeof a === 'string' ? { ref: a } : { server: a }));
  if (server.length || !local) return server;
  return local.attachments.map((l) => ({ local: l, server: l.attachment }));
}

function Lightbox({ url, alt, onClose }: { url: string; alt: string; onClose: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', k);
    return () => document.removeEventListener('keydown', k);
  }, [onClose]);
  return createPortal(
    <div role="dialog" aria-modal="true" aria-label={alt} className="fixed inset-0 z-[90] grid animate-fade place-items-center bg-black p-4" onClick={onClose}>
      <img src={url} alt={alt} className="max-h-full max-w-full rounded-lg object-contain" />
      <button type="button" aria-label="Close" onClick={onClose} className="nb-lightbox-close absolute right-3 grid size-11 place-items-center rounded-full bg-white/15 text-white focus-ring">
        <IcX />
      </button>
    </div>,
    document.body,
  );
}

function ImageThumb({ load, alt, localUrl }: { load: () => Promise<Blob>; alt: string; localUrl?: string }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      {localUrl ? (
        <button type="button" onClick={() => setOpen(localUrl)} className="block rounded-xl focus-ring" aria-label={`Open ${alt}`}>
          <img src={localUrl} alt={alt} className="max-h-60 w-full max-w-[16rem] rounded-xl object-cover" />
        </button>
      ) : (
        <AuthImage load={load} alt={alt} className="max-h-60 w-full max-w-[16rem] min-h-24" onOpen={setOpen} />
      )}
      {open && <Lightbox url={open} alt={alt} onClose={() => setOpen(null)} />}
    </>
  );
}

function useSttStatus(enabled: boolean) {
  const { api } = useMini();
  return useQuery<SttStatus>(enabled ? 'voice:stt' : null, (s) => api.voice.stt(s));
}

function Transcript({ t, sttKnown }: { t: AttachmentTranscript | undefined; sttKnown: boolean }) {
  const stt = useSttStatus(!t && sttKnown);
  if (t?.ok && t.text) {
    return (
      <p className="mt-1.5 text-footnote text-muted italic [overflow-wrap:anywhere]" data-testid="transcript">
        “{t.text}”
      </p>
    );
  }
  const notConfigured = (t && !t.ok && /not configured/i.test(t.error ?? '')) || (!t && stt.data && !stt.data.backend);
  if (notConfigured) return <p className="mt-1.5 text-caption text-subtle">Transcription not configured</p>;
  if (t && !t.ok) return <p className="mt-1.5 text-caption text-subtle">Transcription failed</p>;
  return null;
}

function AudioPlayer({ load, localUrl, label }: { load: () => Promise<Blob>; localUrl?: string; label: string }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [src, setSrc] = useState<string | null>(localUrl ?? null);
  const [loading, setLoading] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  const [dur, setDur] = useState(0);
  const [failed, setFailed] = useState(false);
  const owned = useRef<string | null>(null);
  useEffect(() => () => {
    if (owned.current) URL.revokeObjectURL(owned.current);
  }, []);
  const toggle = async () => {
    const el = audio.current;
    if (!src) {
      setLoading(true);
      try {
        const b = await load();
        const u = URL.createObjectURL(b);
        owned.current = u;
        setSrc(u);
        setTimeout(() => void audio.current?.play().catch(() => setFailed(true)), 0);
      } catch {
        setFailed(true);
      } finally {
        setLoading(false);
      }
      return;
    }
    if (!el) return;
    if (el.paused) void el.play().catch(() => setFailed(true));
    else el.pause();
  };
  const fmt = (s: number) => (Number.isFinite(s) && s > 0 ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '0:00');
  return (
    <div className="flex min-w-52 items-center gap-2.5">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          void toggle();
        }}
        aria-label={playing ? `Pause ${label}` : `Play ${label}`}
        className="nb-press grid size-10 shrink-0 place-items-center rounded-full bg-accent-fill text-on-accent focus-ring"
      >
        {loading ? (
          <Spinner className="size-4 text-on-accent" />
        ) : playing ? (
          <svg viewBox="0 0 24 24" aria-hidden className="size-4" fill="currentColor">
            <rect x="6" y="5" width="4" height="14" rx="1" />
            <rect x="14" y="5" width="4" height="14" rx="1" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" aria-hidden className="ml-0.5 size-4" fill="currentColor">
            <path d="M7 5.5v13a1 1 0 0 0 1.5.9l10.4-6.5a1 1 0 0 0 0-1.8L8.5 4.6A1 1 0 0 0 7 5.5Z" />
          </svg>
        )}
      </button>
      <div className="min-w-0 flex-1">
        <div className="h-1 overflow-hidden rounded-full bg-text/15">
          <div className="h-full rounded-full bg-accent transition-[width] duration-200" style={{ width: dur ? `${Math.min(100, (pos / dur) * 100)}%` : '0%' }} />
        </div>
        <div className="mt-1 text-caption text-muted tabular-nums">{failed ? 'Audio unavailable' : `${fmt(pos)} / ${fmt(dur)}`}</div>
      </div>
      {src && (
        <audio
          ref={audio}
          src={src}
          preload="metadata"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          onTimeUpdate={(e) => setPos(e.currentTarget.currentTime)}
          onLoadedMetadata={(e) => setDur(e.currentTarget.duration)}
          onDurationChange={(e) => setDur(e.currentTarget.duration)}
          className="hidden"
        />
      )}
    </div>
  );
}

function FileChip({ name, size, mime, onOpen }: { name: string; size?: number; mime?: string; onOpen?: () => void }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onOpen?.();
      }}
      disabled={!onOpen}
      className="nb-press flex min-h-12 max-w-full items-center gap-2.5 rounded-xl bg-text/8 py-2 pr-3 pl-2.5 text-left focus-ring disabled:cursor-default"
    >
      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent/15 text-accent-soft [&>svg]:size-[18px]">
        <IcClip />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-subhead font-medium text-text">{name}</span>
        <span className="block text-caption text-muted">
          {typeLabel(name, mime)}
          {size ? ` · ${bytes(size)}` : ''}
        </span>
      </span>
    </button>
  );
}

function AttachmentItem({ a }: { a: AnyAttachment }) {
  const { api } = useMini();
  if (a.ref) {
    const ref = a.ref;
    return <ImageThumb load={async () => (await api.artifact(ref)).blob} alt="Screenshot from the task" />;
  }
  const s = a.server;
  const l = a.local;
  const name = s?.name ?? l?.name ?? 'attachment';
  const mime = s?.mime ?? l?.mime;
  const kind = kindOf(name, mime, s?.kind);
  const id = s?.id;
  const loadContent = async () => {
    if (!id) throw new Error('not uploaded');
    return (await api.attachments.content(id)).blob;
  };
  if (kind === 'image') return <ImageThumb load={loadContent} alt={name} localUrl={l?.previewUrl} />;
  if (kind === 'audio') {
    const transcript = (s?.extracted as { transcript?: AttachmentTranscript } | null | undefined)?.transcript;
    return (
      <div>
        <AudioPlayer load={loadContent} localUrl={l?.previewUrl} label={l?.voice || /^voice\./.test(name) ? 'voice message' : name} />
        {(s?.status || l?.status === 'ready') && <Transcript t={transcript} sttKnown={Boolean(id)} />}
      </div>
    );
  }
  return (
    <FileChip
      name={name}
      size={s?.size ?? l?.size}
      mime={mime}
      onOpen={
        id
          ? () =>
              void api.attachments
                .content(id)
                .then((r) => downloadBlob(r.blob, r.filename ?? name))
                .catch(() => undefined)
          : undefined
      }
    />
  );
}

function Attachments({ items }: { items: AnyAttachment[] }) {
  if (!items.length) return null;
  return (
    <div className="mb-1 flex flex-col gap-1.5">
      {items.map((a, i) => (
        <AttachmentItem key={a.ref ?? a.server?.id ?? a.local?.key ?? i} a={a} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- bubbles
function Actions({ text, at, align }: { text: string; at: number; align: 'start' | 'end' }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className={cx('mt-1 flex animate-rise items-center gap-1 text-caption text-subtle', align === 'end' ? 'justify-end' : 'justify-start')}>
      <span className="px-1">{new Date(at * 1000).toLocaleString()}</span>
      <button
        type="button"
        onClick={async (e) => {
          e.stopPropagation();
          if (await copyText(text)) {
            haptic('selection');
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }
        }}
        className="nb-press flex min-h-9 items-center gap-1 rounded-full bg-panel px-3 font-medium text-muted focus-ring [&>svg]:size-3.5"
      >
        {copied ? <IcCheck /> : <IcCopy />}
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

export interface MessageViewProps {
  message: Message;
  local?: PendingMessage;
  agentName: string;
  agentId: string;
  agentAvatar?: AgentAvatar | null;
  /** First message of a run from the same sender (avatar / spacing). */
  first: boolean;
  selected: boolean;
  onSelect: (id: string | null) => void;
}

export const MessageView = memo(function MessageView({ message: m, local, agentName, agentId, agentAvatar, first, selected, onSelect }: MessageViewProps) {
  const toggle = () => onSelect(selected ? null : m.id);
  const longPress = useRef<ReturnType<typeof setTimeout> | null>(null);
  const press = {
    onClick: toggle,
    onContextMenu: (e: ReactMouseEvent) => {
      e.preventDefault();
      onSelect(m.id);
    },
    onTouchStart: () => {
      longPress.current = setTimeout(() => {
        haptic('selection');
        onSelect(m.id);
      }, 450);
    },
    onTouchEnd: () => longPress.current && clearTimeout(longPress.current),
    onTouchMove: () => longPress.current && clearTimeout(longPress.current),
  };
  const atts = normalize(m, local);
  if (m.role === 'user') {
    const status = local?.status;
    return (
      <li className={cx('flex flex-col items-end', first ? 'mt-3' : 'mt-1')} data-testid="msg-user" data-client-id={m.client_id ?? local?.client_id ?? undefined}>
        <div
          {...press}
          tabIndex={0}
          onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), toggle())}
          className="max-w-[84%] cursor-default rounded-bubble rounded-br-md bg-bubble px-3.5 py-2 text-message text-bubble-fg focus-ring select-text"
        >
          <Attachments items={atts} />
          {m.content && <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{m.content}</p>}
          <p className="mt-0.5 -mb-0.5 flex items-center justify-end gap-1 text-[11px] text-muted">
            {status === 'sending' ? 'Sending…' : clockTime(m.created_at)}
          </p>
        </div>
        {selected && <Actions text={m.content} at={m.created_at} align="end" />}
        {m.task && <TaskInline task={m.task} />}
      </li>
    );
  }
  if (m.role === 'assistant') {
    return (
      <li className={cx('flex items-end gap-2', first ? 'mt-3' : 'mt-1')} data-testid="msg-agent">
        <span className="w-7 shrink-0">{first && <Avatar name={agentName} id={agentId} size="xs" avatar={agentAvatar} />}</span>
        <div className="min-w-0 max-w-[84%]">
          <div {...press} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), toggle())} className="cursor-default rounded-bubble rounded-bl-md bg-panel px-3.5 py-2.5 text-message text-text focus-ring select-text">
            <Attachments items={atts} />
            {m.content && <Markdown text={m.content} />}
            <p className="mt-0.5 -mb-0.5 text-right text-[11px] text-subtle">{clockTime(m.created_at)}</p>
          </div>
          {selected && <Actions text={m.content} at={m.created_at} align="start" />}
        </div>
      </li>
    );
  }
  return (
    <li className="my-3 px-6 text-center text-footnote text-subtle [overflow-wrap:anywhere]" data-testid="msg-system">
      {m.content}
    </li>
  );
});

/** An owner message that has not reached the server yet (sending / failed). */
export function PendingView({ p, onRetry, onDiscard }: { p: PendingMessage; onRetry: (clientId: string) => void; onDiscard: (clientId: string) => void }) {
  const atts: AnyAttachment[] = p.attachments.map((l) => ({ local: l, server: l.attachment }));
  const uploading = p.attachments.find((a) => a.status === 'uploading' || a.status === 'processing');
  return (
    <li className="mt-3 flex flex-col items-end" data-testid="msg-pending" data-status={p.status} data-client-id={p.client_id}>
      <div className={cx('max-w-[84%] rounded-bubble rounded-br-md bg-bubble px-3.5 py-2 text-message text-bubble-fg', p.status === 'failed' && 'opacity-75')}>
        <Attachments items={atts} />
        {p.content && <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{p.content}</p>}
        <p className="mt-0.5 -mb-0.5 text-right text-[11px] text-muted">
          {p.status === 'sending' ? (uploading ? `Uploading ${Math.round(uploading.progress * 100)}%…` : 'Sending…') : clockTime(p.created_at)}
        </p>
      </div>
      {p.status === 'failed' && (
        <div className="mt-1 flex items-center gap-1 text-footnote text-danger" role="alert">
          <IcAlert className="size-3.5" />
          <span>Not sent{p.error ? ` · ${p.error}` : ''}</span>
          <button type="button" onClick={() => onRetry(p.client_id)} className="nb-press ml-1 flex min-h-9 items-center gap-1 rounded-full bg-danger/10 px-3 font-semibold focus-ring [&>svg]:size-3.5">
            <IcRetry /> Retry
          </button>
          <button type="button" onClick={() => onDiscard(p.client_id)} aria-label="Discard message" className="grid size-9 place-items-center rounded-full text-subtle focus-ring [&>svg]:size-4">
            <IcX />
          </button>
        </div>
      )}
    </li>
  );
}
