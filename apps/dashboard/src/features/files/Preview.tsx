// Preview (text / code, CSV table, image, PDF, binary info), text editor and version history of one file.
import { useEffect, useId, useMemo, useState } from 'react';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { Button, EmptyState, ErrorBanner, KeyValue, Notice, Spinner } from '../../components/ui';
import { authedLinkProps } from '../../lib/authedUrl';
import { formatBytes, formatTime } from '../../lib/format';
import { filesApi } from './api';
import { downloadFile } from './download';
import { detectDelimiter, parseCsv } from './csv';
import { IconDownload } from './icons';
import { base64ToBytes, displayPath, mimeFor, versionPath, versionTimestamp } from './paths';
import type { FileEntry, FilePreview, FileVersion } from './types';

const touch = 'max-sm:min-h-11';
const MAX_TABLE_ROWS = 500;

function useBlobUrl(b64: string | null | undefined, mime: string): string | null {
  const url = useMemo(() => {
    if (!b64) return null;
    try {
      return URL.createObjectURL(new Blob([base64ToBytes(b64)], { type: mime }));
    } catch {
      return null;
    }
  }, [b64, mime]);
  useEffect(
    () => () => {
      if (url) URL.revokeObjectURL(url);
    },
    [url],
  );
  return url;
}

function TextView({ text }: { text: string }) {
  const [wrap, setWrap] = useState(true);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex justify-end">
        <Button size="sm" variant="ghost" onClick={() => setWrap((w) => !w)} aria-pressed={wrap} className={touch}>
          {wrap ? 'No wrap' : 'Wrap lines'}
        </Button>
      </div>
      <pre
        tabIndex={0}
        aria-label="File content"
        className={`max-h-[60vh] overflow-auto rounded-md border border-border bg-bg p-3 font-mono text-[12.5px] leading-relaxed text-text focus-visible:outline-2 focus-visible:outline-accent ${
          wrap ? 'break-words whitespace-pre-wrap' : 'whitespace-pre'
        }`}
      >
        {text || <span className="text-subtle">(empty file)</span>}
      </pre>
    </div>
  );
}

function CsvView({ text, path, truncated }: { text: string; path: string; truncated: boolean }) {
  const [raw, setRaw] = useState(false);
  const delim = useMemo(() => detectDelimiter(path, text), [path, text]);
  const csv = useMemo(() => parseCsv(text, delim, MAX_TABLE_ROWS + 1), [text, delim]);
  if (raw) {
    return (
      <div className="flex flex-col gap-2">
        <div className="flex justify-end">
          <Button size="sm" variant="ghost" onClick={() => setRaw(false)} className={touch}>
            Show as table
          </Button>
        </div>
        <TextView text={text} />
      </div>
    );
  }
  const [head, ...body] = csv.rows;
  const shown = body.slice(0, MAX_TABLE_ROWS);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
        <span>
          {shown.length} row(s){csv.truncated || body.length > MAX_TABLE_ROWS ? ` shown (first ${MAX_TABLE_ROWS})` : ''}
          {truncated ? ' · the preview covers the first 256 KiB of the file' : ''} · delimiter “{delim === '\t' ? 'tab' : delim}”
        </span>
        <Button size="sm" variant="ghost" onClick={() => setRaw(true)} className={touch}>
          Show raw text
        </Button>
      </div>
      {csv.rows.length === 0 ? (
        <p className="text-sm text-muted">(empty file)</p>
      ) : (
        <div className="max-h-[60vh] overflow-auto rounded-md border border-border" tabIndex={0} aria-label="Table preview">
          <table className="min-w-full border-collapse text-left text-xs">
            <thead className="sticky top-0 bg-panel-2">
              <tr>
                {Array.from({ length: csv.columns }, (_, i) => (
                  <th key={i} scope="col" className="border-b border-border px-2.5 py-2 font-semibold whitespace-nowrap text-text">
                    {head?.[i] ?? ''}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((r, ri) => (
                <tr key={ri} className="odd:bg-white/[0.015]">
                  {Array.from({ length: csv.columns }, (_, i) => (
                    <td key={i} className="max-w-[24rem] truncate border-b border-border/60 px-2.5 py-1.5 align-top text-muted" title={r[i]}>
                      {r[i] ?? ''}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function PreviewBody({ preview, name, downloadUrl }: { preview: FilePreview; name: string; downloadUrl: string }) {
  const mime = mimeFor(name, preview.kind);
  const url = useBlobUrl(preview.kind === 'image' || preview.kind === 'pdf' ? preview.data_b64 : null, mime);
  const info = (
    <KeyValue
      items={[
        ['Size', formatBytes(preview.size)],
        ['Modified', formatTime(preview.mtime)],
        ['Path', <span className="font-mono text-xs break-all">{displayPath(preview.path)}</span>],
      ]}
    />
  );
  if (preview.kind === 'text') return <TextView text={preview.text ?? ''} />;
  if (preview.kind === 'csv') return <CsvView text={preview.text ?? ''} path={preview.path} truncated={preview.truncated} />;
  if (preview.kind === 'image' || preview.kind === 'pdf') {
    if (!preview.data_b64 || !url)
      return (
        <div className="flex flex-col gap-3">
          <Notice title="Too large to preview">Images and PDFs up to 8 MiB are shown here. Download the file to open it.</Notice>
          {info}
        </div>
      );
    return preview.kind === 'image' ? (
      <div className="flex justify-center rounded-md border border-border bg-[repeating-conic-gradient(#1a1a1f_0%_25%,#141418_0%_50%)] bg-[length:16px_16px] p-2">
        <img src={url} alt={name} className="max-h-[60vh] max-w-full object-contain" />
      </div>
    ) : (
      <div className="flex flex-col gap-2">
        <iframe src={url} title={`PDF preview of ${name}`} className="h-[60vh] w-full rounded-md border border-border bg-white" />
        <p className="text-xs text-muted">
          If the PDF does not render here,{' '}
          <a href={url} target="_blank" rel="noopener noreferrer" className="text-accent-soft underline">
            open it in a new tab
          </a>{' '}
          or{' '}
          <a {...authedLinkProps(downloadUrl, name)} download={name} className="text-accent-soft underline">
            download it
          </a>
          .
        </p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <Notice title="No preview for this file type">This looks like a binary file. Download it to open it with another app.</Notice>
      {info}
    </div>
  );
}

export function PreviewDialog({
  root,
  entry,
  versioned,
  startMode = 'view',
  onClose,
  onChanged,
}: {
  root: string;
  entry: FileEntry;
  /** The exchange folder does not keep versions. */
  versioned: boolean;
  startMode?: 'view' | 'edit' | 'versions';
  onClose: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const editorId = useId();
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [nonce, setNonce] = useState(0);
  const [mode, setMode] = useState<'view' | 'edit' | 'versions'>(startMode === 'versions' && versioned ? 'versions' : 'view');
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState<null | 'close' | 'view'>(null);
  const [downloading, setDownloading] = useState(false);
  const downloadUrl = filesApi.downloadUrl(root, entry.path);

  useEffect(() => {
    const c = new AbortController();
    setError(null);
    filesApi
      .preview(root, entry.path, c.signal)
      .then((p) => {
        setPreview(p);
        if (startMode === 'edit' && nonce === 0 && (p.kind === 'text' || p.kind === 'csv') && !p.truncated) {
          setDraft(p.text ?? '');
          setMode('edit');
        }
      })
      .catch((e: unknown) => {
        if (!c.signal.aborted) setError(e);
      });
    return () => c.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, entry.path, nonce]);

  const editable = !!preview && (preview.kind === 'text' || preview.kind === 'csv') && !preview.truncated;
  const dirty = mode === 'edit' && preview !== null && draft !== (preview.text ?? '');

  const save = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    try {
      const r = await filesApi.saveText(root, entry.path, draft);
      toast.success('Saved', versioned ? `${formatBytes(r.size)} · the previous version was kept` : formatBytes(r.size));
      setPreview((p) => (p ? { ...p, text: draft, size: r.size, mtime: Date.now() / 1000 } : p));
      setMode('view');
      onChanged();
    } catch (e) {
      toast.error(e, 'Could not save the file');
    } finally {
      setSaving(false);
    }
  };

  const requestClose = () => {
    if (dirty) setConfirmDiscard('close');
    else onClose();
  };

  const footer =
    mode === 'edit' ? (
      <>
        <Button onClick={() => (dirty ? setConfirmDiscard('view') : setMode('view'))} disabled={saving} className={touch}>
          Cancel
        </Button>
        <Button variant="primary" onClick={() => void save()} loading={saving} disabledReason={dirty ? null : 'No changes to save'} className={touch}>
          Save
        </Button>
      </>
    ) : (
      <>
        <Button
          onClick={() => {
            setDownloading(true);
            downloadFile(root, entry.path, entry.name, preview?.size ?? entry.size)
              .catch((e: unknown) => toast.error(e, `Could not download ${entry.name}`))
              .finally(() => setDownloading(false));
          }}
          loading={downloading}
          className={touch}
        >
          <IconDownload /> Download
        </Button>
        {versioned && (
          <Button onClick={() => setMode(mode === 'versions' ? 'view' : 'versions')} className={touch}>
            {mode === 'versions' ? 'Back to file' : 'Versions'}
          </Button>
        )}
        {editable && (
          <Button
            variant="primary"
            onClick={() => {
              setDraft(preview?.text ?? '');
              setMode('edit');
            }}
            className={touch}
          >
            Edit
          </Button>
        )}
      </>
    );

  return (
    <Modal open size="xl" title={entry.name} onClose={requestClose} dismissible={!saving} footer={footer}>
      {confirmDiscard && (
        <div role="alert" className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm">
          <span className="text-text">Discard your unsaved changes?</span>
          <span className="flex gap-2">
            <Button size="sm" onClick={() => setConfirmDiscard(null)} className={touch}>
              Keep editing
            </Button>
            <Button
              size="sm"
              variant="danger"
              onClick={() => {
                const what = confirmDiscard;
                setConfirmDiscard(null);
                setMode('view');
                if (what === 'close') onClose();
              }}
              className={touch}
            >
              Discard
            </Button>
          </span>
        </div>
      )}
      {error ? (
        <ErrorBanner error={error} onRetry={() => setNonce((n) => n + 1)} title="Could not preview the file" />
      ) : !preview ? (
        <Spinner label="Loading preview…" />
      ) : mode === 'edit' ? (
        <div className="flex flex-col gap-2">
          <label htmlFor={editorId} className="text-xs text-muted">
            Editing <span className="font-mono">{displayPath(entry.path)}</span>
            {versioned ? ' — saving keeps the previous version.' : ' — the Mac exchange folder does not keep versions.'} ⌘/Ctrl S saves.
          </label>
          <textarea
            id={editorId}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
                e.preventDefault();
                void save();
              }
            }}
            spellCheck={false}
            autoFocus
            className="h-[58vh] w-full resize-y rounded-md border border-border bg-bg p-3 font-mono text-[12.5px] leading-relaxed text-text focus:border-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          />
        </div>
      ) : mode === 'versions' ? (
        <Versions
          root={root}
          entry={entry}
          onRestored={() => {
            setNonce((n) => n + 1);
            setMode('view');
            onChanged();
          }}
        />
      ) : (
        <div className="flex flex-col gap-3">
          {preview.truncated && preview.kind !== 'image' && preview.kind !== 'pdf' && (
            <Notice tone="warn" title="Partial preview">
              Only the first 256 KiB are shown ({formatBytes(preview.size)} in total), so the file cannot be edited here. Download it to see everything.
            </Notice>
          )}
          <PreviewBody preview={preview} name={entry.name} downloadUrl={downloadUrl} />
        </div>
      )}
    </Modal>
  );
}

function Versions({ root, entry, onRestored }: { root: string; entry: FileEntry; onRestored: () => void }) {
  const toast = useToast();
  const [versions, setVersions] = useState<FileVersion[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [nonce, setNonce] = useState(0);
  const [open, setOpen] = useState<{ v: FileVersion; preview: FilePreview | null; error: unknown } | null>(null);
  const [restoring, setRestoring] = useState(false);

  useEffect(() => {
    const c = new AbortController();
    setVersions(null);
    setError(null);
    filesApi
      .versions(root, entry.path, c.signal)
      .then((r) => setVersions([...r.versions].sort((a, b) => (versionTimestamp(b.name) ?? b.mtime) - (versionTimestamp(a.name) ?? a.mtime))))
      .catch((e: unknown) => {
        if (!c.signal.aborted) setError(e);
      });
    return () => c.abort();
  }, [root, entry.path, nonce]);

  const view = async (v: FileVersion) => {
    setOpen({ v, preview: null, error: null });
    try {
      const p = await filesApi.preview(root, versionPath(entry.path, v.name));
      setOpen({ v, preview: p, error: null });
    } catch (e) {
      setOpen({ v, preview: null, error: e });
    }
  };

  const restore = async () => {
    const p = open?.preview;
    if (!p || p.truncated || p.kind === 'binary' || typeof p.text !== 'string') return;
    setRestoring(true);
    try {
      await filesApi.saveText(root, entry.path, p.text);
      toast.success('Version restored', 'The current content was kept as a version.');
      onRestored();
    } catch (e) {
      toast.error(e, 'Could not restore the version');
    } finally {
      setRestoring(false);
    }
  };

  if (error) return <ErrorBanner error={error} onRetry={() => setNonce((n) => n + 1)} title="Could not load versions" />;
  if (!versions) return <Spinner label="Loading versions…" />;
  if (versions.length === 0)
    return <EmptyState title="No previous versions">NEBULA keeps the last 5 versions when a file is overwritten (editor saves and uploads with “replace”).</EmptyState>;

  const restorable = !!open?.preview && !open.preview.truncated && open.preview.kind !== 'binary' && typeof open.preview.text === 'string';
  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-1">
        {versions.map((v) => {
          const ts = versionTimestamp(v.name) ?? v.mtime;
          const active = open?.v.name === v.name;
          return (
            <li key={v.name}>
              <button
                type="button"
                onClick={() => void view(v)}
                aria-pressed={active}
                className={`flex min-h-11 w-full items-center justify-between gap-3 rounded-md border px-3 text-left text-sm focus-visible:outline-2 focus-visible:outline-accent ${
                  active ? 'border-accent/60 bg-accent/10' : 'border-border hover:bg-panel-2'
                }`}
              >
                <span className="text-text">{formatTime(ts)}</span>
                <span className="text-xs text-muted">{formatBytes(v.size)}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {open && (
        <div className="flex flex-col gap-2 border-t border-border pt-3">
          {open.error ? (
            <ErrorBanner error={open.error} title="Could not open this version" />
          ) : !open.preview ? (
            <Spinner label="Loading version…" />
          ) : (
            <>
              {open.preview.kind === 'binary' ? (
                <Notice>This version is binary and cannot be shown or restored here.</Notice>
              ) : (
                <TextView text={open.preview.text ?? ''} />
              )}
              {open.preview.truncated && <Notice tone="warn">This version is larger than 256 KiB and cannot be restored here.</Notice>}
              <div>
                <Button variant="primary" onClick={() => void restore()} loading={restoring} disabledReason={restorable ? null : 'Only text versions up to 256 KiB can be restored'} className={touch}>
                  Restore this version
                </Button>
              </div>
            </>
          )}
        </div>
      )}
      <p className="text-xs text-subtle">Restoring writes the old content back; the current content becomes a version.</p>
    </div>
  );
}
