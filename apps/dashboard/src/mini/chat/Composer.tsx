// The sticky composer: attachments (action sheet → preview chips with upload progress), an auto-growing textarea
// (Enter = new line; only the button sends), voice recording where available, and a per-conversation draft.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent } from 'react';
import { isApiError, errorMessage } from '../../lib/http';
import { bytes } from '../format';
import { IcClip, IcMic, IcPlus, IcSend, IcX } from '../icons';
import { haptic } from '../telegram';
import type { Attachment } from '../types';
import { cx, IconBtn, Sheet, SheetAction } from '../uiKit';
import { kindOf, MAX_ATTACHMENTS, typeLabel, validateFile } from './attachments';
import { loadDraft, saveDraft } from './drafts';
import type { LocalAttachment } from './model';
import { formatClock, useRecorder, voiceSupport } from './voice';

export interface ComposerProps {
  /** Draft key (conversation id; `agent:<id>` for the legacy chat). */
  draftId: string;
  agentName: string;
  /** Why nothing can be sent right now (permissions, agent state…); null when sending is possible. */
  blocked: string | null;
  upload: (file: File, opts: { onProgress: (loaded: number, total: number) => void; signal: AbortSignal }) => Promise<Attachment>;
  onSend: (msg: { content: string; attachments: LocalAttachment[] }) => void;
  onSendVoice: (file: File, durationMs: number) => void;
}

let seq = 0;
const keyFor = (f: File) => `${Date.now()}-${(seq += 1)}-${f.name}`;

function canCapture(): boolean {
  try {
    const coarse = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
    return coarse && 'capture' in document.createElement('input');
  } catch {
    return false;
  }
}

export function Composer({ draftId, agentName, blocked, upload, onSend, onSendVoice }: ComposerProps) {
  const [text, setText] = useState(() => loadDraft(draftId));
  const [chips, setChips] = useState<LocalAttachment[]>([]);
  const [sheet, setSheet] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const media = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  const files = useRef<HTMLInputElement>(null);
  const ctl = useRef(new Map<string, AbortController>());
  const support = useMemo(() => voiceSupport(), []);
  const rec = useRecorder(support);
  const capture = useMemo(() => canCapture(), []);

  // draft: saved shortly after typing stops and when the screen goes away
  const latest = useRef(text);
  latest.current = text;
  useEffect(() => {
    const t = setTimeout(() => saveDraft(draftId, text), 250);
    return () => clearTimeout(t);
  }, [draftId, text]);
  useEffect(() => () => saveDraft(draftId, latest.current), [draftId]);

  // abort uploads still running when the screen closes
  useEffect(() => {
    const map = ctl.current;
    return () => {
      for (const c of map.values()) c.abort();
    };
  }, []);

  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`;
  }, [text]);

  useEffect(() => {
    if (rec.error) setNote(rec.error);
  }, [rec.error]);

  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), 7000);
    return () => clearTimeout(t);
  }, [note]);

  const patch = (key: string, p: Partial<LocalAttachment>) => setChips((xs) => xs.map((x) => (x.key === key ? { ...x, ...p } : x)));

  const startUpload = (f: File, key: string) => {
    const c = new AbortController();
    ctl.current.set(key, c);
    upload(f, {
      signal: c.signal,
      onProgress: (loaded, total) => patch(key, total > 0 && loaded >= total ? { progress: 1, status: 'processing' } : { progress: total > 0 ? loaded / total : 0 }),
    })
      .then((att) => {
        ctl.current.delete(key);
        if (att.status === 'FAILED' || att.status === 'failed') patch(key, { status: 'error', attachment: att, error: att.error ?? 'The server could not process this file', progress: 1 });
        else {
          patch(key, { status: 'ready', attachment: att, progress: 1 });
          haptic('selection');
        }
      })
      .catch((e: unknown) => {
        ctl.current.delete(key);
        if (e instanceof DOMException && e.name === 'AbortError') return;
        patch(key, { status: 'error', error: isApiError(e) && e.status === 0 ? 'Upload interrupted — check your connection' : errorMessage(e) });
      });
  };

  const addFiles = (list: FileList | File[] | null) => {
    const arr = list ? Array.from(list) : [];
    if (!arr.length) return;
    const room = Math.max(0, MAX_ATTACHMENTS - chips.length);
    if (arr.length > room) setNote(`Up to ${MAX_ATTACHMENTS} files per message.`);
    const next: LocalAttachment[] = [];
    for (const f of arr.slice(0, room)) {
      const key = keyFor(f);
      const invalid = validateFile(f);
      const kind = kindOf(f.name, f.type);
      const previewUrl = kind === 'image' && !invalid && typeof URL.createObjectURL === 'function' ? URL.createObjectURL(f) : undefined;
      next.push({ key, name: f.name, size: f.size, mime: f.type, kind, status: invalid ? 'error' : 'uploading', progress: 0, error: invalid ?? undefined, previewUrl });
      if (!invalid) startUpload(f, key);
    }
    setChips((xs) => [...xs, ...next]);
    for (const r of [media, camera, files]) if (r.current) r.current.value = '';
  };

  const remove = (key: string) => {
    ctl.current.get(key)?.abort();
    ctl.current.delete(key);
    setChips((xs) => {
      const gone = xs.find((x) => x.key === key);
      if (gone?.previewUrl) URL.revokeObjectURL(gone.previewUrl);
      return xs.filter((x) => x.key !== key);
    });
  };

  const busy = chips.some((c) => c.status === 'uploading' || c.status === 'processing');
  const broken = chips.some((c) => c.status === 'error');
  const ready = chips.filter((c) => c.status === 'ready' && c.attachment);
  const hasContent = Boolean(text.trim()) || ready.length > 0;
  const sendReason = blocked ?? (busy ? 'Wait until the files are uploaded' : broken ? 'Remove the files that could not be attached' : !hasContent ? 'Type a message first' : null);

  const send = () => {
    if (sendReason) {
      if (hasContent || busy || broken) setNote(sendReason);
      return;
    }
    const content = text.trim() || `Attached: ${ready.map((r) => r.name).join(', ')}`;
    onSend({ content, attachments: ready });
    setText('');
    setChips([]);
    saveDraft(draftId, '');
    ta.current?.focus({ preventScroll: true });
  };

  const sendVoice = async () => {
    const r = await rec.stop();
    if (r) onSendVoice(r.file, r.durationMs);
    else setNote('Nothing was recorded.');
  };
  rec.autoStop.current = () => void sendVoice();

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const fl = e.clipboardData?.files;
    if (fl && fl.length > 0 && !blocked) {
      e.preventDefault();
      addFiles(fl);
    }
  };

  const recording = rec.state !== 'idle';
  const showMic = !text.trim() && chips.length === 0;

  return (
    <div className="mini-chat-composer mini-glass nb-hairline-t mini-safe-x shrink-0 pt-2">
      <div className="mx-auto max-w-2xl">
        {note && (
          <div role="status" className="mb-2 flex animate-rise items-start gap-2 rounded-xl bg-panel-2 py-2 pr-1 pl-3 text-footnote text-muted">
            <span className="flex-1 pt-1.5">{note}</span>
            <button type="button" aria-label="Dismiss" onClick={() => setNote(null)} className="grid size-8 place-items-center rounded-full text-subtle focus-ring [&>svg]:size-4">
              <IcX />
            </button>
          </div>
        )}
        {chips.length > 0 && (
          <ul aria-label="Attachments" className="-mx-1 mb-2 flex gap-2 overflow-x-auto px-1 pb-1 scrollbar-none">
            {chips.map((c) => (
              <li key={c.key} className="flex w-[14rem] shrink-0 items-center gap-2.5 rounded-xl bg-panel-2 p-2" data-testid="attachment-chip" data-status={c.status}>
                {c.previewUrl ? (
                  <img src={c.previewUrl} alt="" className="size-10 shrink-0 rounded-lg object-cover" />
                ) : (
                  <span aria-hidden className="grid size-10 shrink-0 place-items-center rounded-lg bg-accent/15 text-[10px] font-semibold text-accent-soft uppercase">
                    {typeLabel(c.name, c.mime, c.voice).slice(0, 4)}
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-footnote font-medium text-text" title={c.name}>
                    {c.name}
                  </span>
                  <span className={cx('block truncate text-caption', c.status === 'error' ? 'text-danger' : 'text-muted')}>
                    {c.status === 'error'
                      ? c.error
                      : c.status === 'uploading'
                        ? `${Math.round(c.progress * 100)}% · ${bytes(c.size)}`
                        : c.status === 'processing'
                          ? 'Processing…'
                          : `${typeLabel(c.name, c.mime, c.voice)} · ${bytes(c.size)}`}
                  </span>
                  {(c.status === 'uploading' || c.status === 'processing') && (
                    <span className="mt-1 block h-1 overflow-hidden rounded-full bg-text/15">
                      <span className={cx('block h-full rounded-full bg-accent transition-[width] duration-200', c.status === 'processing' && 'nb-pulse')} style={{ width: `${Math.max(4, c.progress * 100)}%` }} />
                    </span>
                  )}
                </span>
                <button type="button" aria-label={`Remove ${c.name}`} onClick={() => remove(c.key)} className="grid size-9 shrink-0 place-items-center rounded-full text-subtle focus-ring [&>svg]:size-4">
                  <IcX />
                </button>
              </li>
            ))}
          </ul>
        )}

        {recording ? (
          <div className="flex items-center gap-1.5 pb-0.5" data-testid="recording">
            <IconBtn label="Cancel recording" tone="muted" icon={<IcX />} onClick={() => rec.cancel()} />
            <div className="flex min-h-11 flex-1 items-center gap-2 rounded-bubble bg-panel-2 px-4 text-body" role="status" aria-live="polite">
              <span aria-hidden className="size-2.5 rounded-full bg-danger nb-pulse" />
              <span className="tabular-nums text-text">{formatClock(rec.elapsedMs)}</span>
              <span className="text-muted">{rec.state === 'requesting' ? 'Waiting for the microphone…' : 'Recording'}</span>
            </div>
            <button
              type="button"
              aria-label="Send voice message"
              disabled={rec.state !== 'recording'}
              onClick={() => void sendVoice()}
              className="nb-press grid size-11 shrink-0 place-items-center rounded-full bg-accent-fill text-on-accent focus-ring disabled:opacity-45 [&>svg]:size-[22px]"
            >
              <IcSend />
            </button>
          </div>
        ) : (
          <div className="flex items-end gap-1.5 pb-0.5">
            <IconBtn label="Add attachment" icon={<IcPlus />} tone="muted" disabled={Boolean(blocked)} onClick={() => setSheet(true)} />
            <label htmlFor="mini-chat-input" className="sr-only">
              Message to {agentName}
            </label>
            <div className="nb-field flex min-h-11 flex-1 items-center rounded-bubble bg-panel-2 px-4">
              <textarea
                id="mini-chat-input"
                ref={ta}
                value={text}
                rows={1}
                onChange={(e) => setText(e.target.value)}
                onPaste={onPaste}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    send();
                  }
                }}
                placeholder={blocked ?? 'Message'}
                disabled={Boolean(blocked)}
                enterKeyHint="enter"
                autoComplete="off"
                className="nb-composer-input w-full bg-transparent text-message text-text outline-none placeholder:text-subtle disabled:cursor-not-allowed"
              />
            </div>
            {showMic ? (
              <button
                type="button"
                aria-label={support.ok ? 'Record a voice message' : 'Voice messages unavailable'}
                aria-disabled={!support.ok || Boolean(blocked) || undefined}
                title={support.ok ? 'Record a voice message' : support.reason}
                onClick={() => {
                  if (blocked) setNote(blocked);
                  else if (!support.ok) setNote(support.reason);
                  else void rec.start();
                }}
                className={cx('nb-press grid size-11 shrink-0 place-items-center rounded-full focus-ring [&>svg]:size-[22px]', support.ok && !blocked ? 'text-muted' : 'text-subtle opacity-50')}
                data-testid="mic"
              >
                <IcMic />
              </button>
            ) : (
              <button
                type="button"
                aria-label="Send"
                aria-disabled={Boolean(sendReason) || undefined}
                title={sendReason ?? 'Send'}
                onClick={send}
                className={cx('nb-press grid size-11 shrink-0 place-items-center rounded-full bg-accent-fill text-on-accent focus-ring [&>svg]:size-[22px]', sendReason && 'opacity-45')}
              >
                <IcSend />
              </button>
            )}
          </div>
        )}
      </div>

      <input ref={media} type="file" accept="image/*,video/*" multiple className="sr-only" tabIndex={-1} aria-label="Choose photos or videos" onChange={(e) => addFiles(e.target.files)} />
      {capture && <input ref={camera} type="file" accept="image/*" capture="environment" className="sr-only" tabIndex={-1} aria-label="Take a photo" onChange={(e) => addFiles(e.target.files)} />}
      <input ref={files} type="file" multiple className="sr-only" tabIndex={-1} aria-label="Choose files to attach" onChange={(e) => addFiles(e.target.files)} />

      <Sheet open={sheet} title="Attach" description="Up to 50 MB per file. Files go to the agent’s workspace." onClose={() => setSheet(false)}>
        <div className="pb-1">
          <SheetAction
            icon={<IcPlus />}
            label="Photo or video"
            onClick={() => {
              setSheet(false);
              media.current?.click();
            }}
          />
          {capture && (
            <SheetAction
              icon={<IcPlus />}
              label="Take photo"
              onClick={() => {
                setSheet(false);
                camera.current?.click();
              }}
            />
          )}
          <SheetAction
            icon={<IcClip />}
            label="Choose file"
            note="Documents, code, archives, audio…"
            onClick={() => {
              setSheet(false);
              files.current?.click();
            }}
          />
        </div>
      </Sheet>
    </div>
  );
}
