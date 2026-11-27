// Attachment chips: composer chips (upload progress / status / rejection) and compact chips for sent messages
// (thumbnail from /attachments/{id}/content?derived=…, extraction summary, honest vision state).
import { useState, type ReactNode } from 'react';
import { IconX } from '../../components/icons';
import { authedLinkProps, useAuthedUrl } from '../../lib/authedUrl';
import { formatBytes } from '../../lib/format';
import { contentUrl, extractionSummary, thumbnailPath, visionState, type Attachment } from './api';
import { KindIcon } from './icons';
import type { PendingAttachment } from './useAttachmentUploads';

const KIND_LABEL: Record<string, string> = {
  image: 'Image',
  pdf: 'PDF',
  docx: 'Word',
  text: 'Text',
  csv: 'CSV',
  json: 'JSON',
  zip: 'ZIP',
  code: 'Code',
  audio: 'Audio',
  voice: 'Voice',
  video: 'Video',
  other: 'File',
};

export function kindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? kind;
}

function guessKind(mime: string, name: string): string {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/pdf' || /\.pdf$/i.test(name)) return 'pdf';
  if (/\.zip$/i.test(name)) return 'zip';
  if (/\.docx$/i.test(name)) return 'docx';
  if (/\.csv$/i.test(name)) return 'csv';
  if (/\.json$/i.test(name)) return 'json';
  return 'other';
}

function Thumb({ att, size = 'md' }: { att: Attachment; size?: 'sm' | 'md' }) {
  const [broken, setBroken] = useState(false);
  const derived = thumbnailPath(att);
  const src = useAuthedUrl(derived ? contentUrl(att.id, derived) : null);
  const dim = size === 'sm' ? 'size-9' : 'size-11';
  if (!derived || broken || !src) {
    return (
      <span aria-hidden className={`grid ${dim} shrink-0 place-items-center rounded-lg border border-border bg-panel-2 text-muted [&>svg]:size-4`}>
        <KindIcon kind={att.kind} />
      </span>
    );
  }
  return (
    <img
      src={src}
      alt={att.kind === 'video' ? `First frame of ${att.name}` : `Preview of ${att.name}`}
      loading="lazy"
      onError={() => setBroken(true)}
      className={`${dim} shrink-0 rounded-lg border border-border bg-panel-2 object-cover`}
    />
  );
}

function Shell({ tone, children }: { tone: 'neutral' | 'danger' | 'warn'; children: ReactNode }) {
  const cls = tone === 'danger' ? 'border-danger/40 bg-danger/[0.06]' : tone === 'warn' ? 'border-warn/35 bg-warn/[0.05]' : 'border-border bg-panel-2/60';
  return <div className={`relative flex w-full min-w-0 items-start gap-2.5 rounded-xl border p-2 pr-9 sm:w-72 ${cls}`}>{children}</div>;
}

/** Chip in the composer while uploading / after upload, before the task is sent. */
export function PendingChip({ item, onRemove }: { item: PendingAttachment; onRemove: () => void }) {
  const att = item.attachment;
  const pct = item.size ? Math.min(100, Math.round((item.loaded / item.size) * 100)) : 0;
  const failed = item.status === 'error';
  const procFailed = att?.status === 'FAILED';
  const vision = att ? visionState(att) : null;
  const kind = att?.kind ?? guessKind(item.mime, item.name);
  return (
    <li data-testid="attachment-chip" data-status={att ? att.status : item.status}>
      <Shell tone={failed ? 'danger' : procFailed ? 'warn' : 'neutral'}>
        {att ? (
          <Thumb att={att} />
        ) : (
          <span aria-hidden className="grid size-11 shrink-0 place-items-center rounded-lg border border-border bg-panel-2 text-muted [&>svg]:size-4">
            <KindIcon kind={kind} />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium text-text" title={item.name}>
            {att?.name ?? item.name}
          </p>
          <p className="truncate text-2xs text-subtle">
            {kindLabel(kind)} · {formatBytes(att?.size ?? item.size)}
          </p>
          {item.status === 'uploading' && (
            <div className="mt-1.5">
              <div role="progressbar" aria-label={`Uploading ${item.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className="h-1 w-full overflow-hidden rounded-full bg-accent/15">
                <div className="h-full rounded-full bg-chart transition-[width] duration-200" style={{ width: `${pct}%` }} />
              </div>
              <p className="mt-0.5 text-2xs text-muted tabular-nums">{pct < 100 ? `Uploading ${pct}%` : 'Processing on the host…'}</p>
            </div>
          )}
          {failed && (
            <p className="mt-0.5 text-2xs leading-4 break-words text-danger" role="alert">
              Rejected: {item.error}
            </p>
          )}
          {att && <p className={`mt-0.5 text-2xs leading-4 break-words ${procFailed ? 'text-warn' : 'text-muted'}`}>{extractionSummary(att)}</p>}
          {vision && <p className={`mt-0.5 text-2xs leading-4 ${vision.tone === 'warn' ? 'text-warn' : vision.tone === 'success' ? 'text-success' : 'text-subtle'}`}>{vision.text}</p>}
        </div>
        <button
          type="button"
          onClick={onRemove}
          aria-label={item.status === 'uploading' ? `Cancel upload of ${item.name}` : `Remove ${item.name}`}
          className="absolute top-1.5 right-1.5 grid size-7 place-items-center rounded-md text-subtle transition-colors hover:bg-white/[0.06] hover:text-text focus-ring touch:size-10"
        >
          <IconX className="size-3.5" />
        </button>
      </Shell>
    </li>
  );
}

/** Attachments that belong to a sent task/message (clickable, opens the original). */
export function AttachmentStrip({ atts, className = '' }: { atts: Attachment[]; className?: string }) {
  if (atts.length === 0) return null;
  return (
    <ul className={`flex flex-wrap gap-2 ${className}`} aria-label="Attachments">
      {atts.map((a) => {
        const vision = visionState(a);
        return (
          <li key={a.id} className="min-w-0 max-w-full">
            <a
              {...authedLinkProps(contentUrl(a.id), a.name)}
              target="_blank"
              rel="noopener noreferrer"
              className="flex max-w-full min-w-0 items-start gap-2 rounded-lg border border-border bg-panel/70 p-1.5 pr-2.5 transition-colors hover:border-border-strong focus-ring sm:max-w-64"
              title={`${a.name} — open the original`}
            >
              <Thumb att={a} size="sm" />
              <span className="min-w-0">
                <span className="block truncate text-xs font-medium text-text">{a.name}</span>
                <span className={`block truncate text-2xs ${a.status === 'FAILED' ? 'text-warn' : 'text-subtle'}`}>
                  {kindLabel(a.kind)} · {formatBytes(a.size)} · {extractionSummary(a)}
                </span>
                {vision && <span className={`block truncate text-2xs ${vision.tone === 'warn' ? 'text-warn' : vision.tone === 'success' ? 'text-success' : 'text-subtle'}`}>{vision.text}</span>}
              </span>
            </a>
          </li>
        );
      })}
    </ul>
  );
}
