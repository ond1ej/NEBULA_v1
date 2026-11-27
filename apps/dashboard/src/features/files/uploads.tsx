// Upload queue: one file at a time, per-file progress, 409 -> ask to replace, cancel / retry.
import { useCallback, useEffect, useReducer, useRef } from 'react';
import { ApiError, errorMessage } from '../../api';
import { Button } from '../../components/ui';
import { formatBytes } from '../../lib/format';
import { MAX_UPLOAD_BYTES, uploadFile } from './api';
import { IconClose } from './icons';
import { displayPath, joinPath } from './paths';

export type UploadStatus = 'queued' | 'uploading' | 'done' | 'error' | 'exists' | 'cancelled';

export interface UploadItem {
  id: number;
  name: string;
  size: number;
  root: string;
  path: string;
  status: UploadStatus;
  loaded: number;
  overwrite: boolean;
  error: string | null;
  /** False for files that can never be uploaded (too large, folders). */
  retryable: boolean;
}

export type UploadAction =
  | { type: 'add'; items: UploadItem[] }
  | { type: 'start' | 'done' | 'exists' | 'cancel' | 'overwrite' | 'retry' | 'dismiss'; id: number }
  | { type: 'progress'; id: number; loaded: number }
  | { type: 'error'; id: number; error: string }
  | { type: 'clear' };

export function uploadsReducer(state: UploadItem[], a: UploadAction): UploadItem[] {
  const patch = (id: number, p: Partial<UploadItem>) => state.map((x) => (x.id === id ? { ...x, ...p } : x));
  switch (a.type) {
    case 'add':
      return [...state, ...a.items];
    case 'start':
      return patch(a.id, { status: 'uploading', loaded: 0, error: null });
    case 'progress':
      return patch(a.id, { loaded: a.loaded });
    case 'done':
      return state.map((x) => (x.id === a.id ? { ...x, status: 'done', loaded: x.size, error: null } : x));
    case 'exists':
      return patch(a.id, { status: 'exists', loaded: 0, error: null });
    case 'error':
      return patch(a.id, { status: 'error', error: a.error });
    case 'cancel':
      return patch(a.id, { status: 'cancelled' });
    case 'overwrite':
      return patch(a.id, { status: 'queued', overwrite: true, error: null });
    case 'retry':
      return patch(a.id, { status: 'queued', error: null });
    case 'dismiss':
      return state.filter((x) => x.id !== a.id);
    case 'clear':
      return state.filter((x) => x.status !== 'done' && x.status !== 'cancelled');
    default:
      return state;
  }
}

/** The next item to upload, or undefined while one is already uploading. */
export function nextQueued(items: UploadItem[]): UploadItem | undefined {
  if (items.some((x) => x.status === 'uploading')) return undefined;
  return items.find((x) => x.status === 'queued');
}

let seq = 1;

export function useUploads(onUploaded: (item: UploadItem) => void) {
  const [items, dispatch] = useReducer(uploadsReducer, []);
  const files = useRef(new Map<number, File>());
  const ctls = useRef(new Map<number, AbortController>());
  const onUploadedRef = useRef(onUploaded);
  onUploadedRef.current = onUploaded;

  const add = useCallback((list: File[], root: string, dir: string, rejected: { name: string; reason: string }[] = []) => {
    const next: UploadItem[] = [];
    for (const f of list) {
      const id = seq++;
      const tooBig = f.size > MAX_UPLOAD_BYTES;
      files.current.set(id, f);
      next.push({
        id,
        name: f.name,
        size: f.size,
        root,
        path: joinPath(dir, f.name),
        status: tooBig ? 'error' : 'queued',
        loaded: 0,
        overwrite: false,
        error: tooBig ? `Larger than ${formatBytes(MAX_UPLOAD_BYTES)} (the upload limit).` : null,
        retryable: !tooBig,
      });
    }
    for (const r of rejected)
      next.push({
        id: seq++,
        name: r.name,
        size: 0,
        root,
        path: joinPath(dir, r.name),
        status: 'error',
        loaded: 0,
        overwrite: false,
        error: r.reason,
        retryable: false,
      });
    if (next.length) dispatch({ type: 'add', items: next });
  }, []);

  useEffect(() => {
    const item = nextQueued(items);
    if (!item) return;
    const file = files.current.get(item.id);
    if (!file) {
      dispatch({ type: 'error', id: item.id, error: 'The file is no longer available — choose it again.' });
      return;
    }
    const ctl = new AbortController();
    ctls.current.set(item.id, ctl);
    dispatch({ type: 'start', id: item.id });
    let last = 0;
    uploadFile(item.root, item.path, file, {
      overwrite: item.overwrite,
      signal: ctl.signal,
      onProgress: (loaded) => {
        const now = performance.now();
        if (now - last < 120 && loaded < item.size) return;
        last = now;
        dispatch({ type: 'progress', id: item.id, loaded });
      },
    })
      .then(() => {
        dispatch({ type: 'done', id: item.id });
        files.current.delete(item.id);
        onUploadedRef.current(item);
      })
      .catch((e: unknown) => {
        if (e instanceof DOMException && e.name === 'AbortError') dispatch({ type: 'cancel', id: item.id });
        else if (e instanceof ApiError && e.status === 409) dispatch({ type: 'exists', id: item.id });
        else dispatch({ type: 'error', id: item.id, error: errorMessage(e) });
      })
      .finally(() => ctls.current.delete(item.id));
  }, [items]);

  const busy = items.some((x) => x.status === 'uploading' || x.status === 'queued');
  useEffect(() => {
    if (!busy) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [busy]);

  const cancel = useCallback(
    (id: number) => {
      const c = ctls.current.get(id);
      if (c) c.abort();
      else dispatch({ type: 'cancel', id });
    },
    [],
  );

  return {
    items,
    busy,
    add,
    cancel,
    overwrite: (id: number) => dispatch({ type: 'overwrite', id }),
    retry: (id: number) => dispatch({ type: 'retry', id }),
    dismiss: (id: number) => {
      files.current.delete(id);
      dispatch({ type: 'dismiss', id });
    },
    clear: () => dispatch({ type: 'clear' }),
  };
}

const STATUS_TEXT: Record<UploadStatus, string> = {
  queued: 'Waiting…',
  uploading: 'Uploading',
  done: 'Uploaded',
  error: 'Failed',
  exists: 'Already exists',
  cancelled: 'Cancelled',
};

export function UploadPanel({ uploads }: { uploads: ReturnType<typeof useUploads> }) {
  const { items } = uploads;
  if (items.length === 0) return null;
  const finished = items.filter((x) => x.status === 'done' || x.status === 'cancelled').length;
  return (
    <section aria-label="Uploads" className="rounded-lg border border-border bg-panel-2/60">
      <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5">
        <h3 className="text-xs font-semibold text-text">
          Uploads <span className="font-normal text-muted">({items.length - finished} pending)</span>
        </h3>
        {finished > 0 && (
          <Button size="sm" variant="ghost" onClick={uploads.clear} className="max-sm:min-h-11">
            Clear finished
          </Button>
        )}
      </header>
      <ul className="max-h-56 divide-y divide-border overflow-y-auto">
        {items.map((u) => {
          const pct = u.size > 0 ? Math.round((u.loaded / u.size) * 100) : u.status === 'done' ? 100 : 0;
          return (
            <li key={u.id} className="flex flex-col gap-1.5 px-3 py-2">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm text-text" title={u.name}>
                    {u.name}
                  </p>
                  <p className="truncate text-[11px] text-muted">
                    {formatBytes(u.size)} → {displayPath(u.path)}
                  </p>
                </div>
                <span
                  className={`shrink-0 text-xs ${
                    u.status === 'done' ? 'text-success' : u.status === 'error' ? 'text-danger' : u.status === 'exists' ? 'text-warn' : 'text-muted'
                  }`}
                >
                  {STATUS_TEXT[u.status]}
                  {u.status === 'uploading' ? ` ${pct}%` : ''}
                </span>
              </div>
              {(u.status === 'uploading' || u.status === 'queued') && (
                <div
                  role="progressbar"
                  aria-label={`Uploading ${u.name}`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={pct}
                  className="h-1.5 overflow-hidden rounded-full bg-panel-3"
                >
                  <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${pct}%` }} />
                </div>
              )}
              {u.error && <p className="text-xs break-words text-danger">{u.error}</p>}
              {u.status === 'exists' && <p className="text-xs text-muted">A file with this name already exists in this folder.</p>}
              <div className="flex flex-wrap gap-1.5">
                {u.status === 'exists' && (
                  <>
                    <Button size="sm" variant="primary" onClick={() => uploads.overwrite(u.id)} className="max-sm:min-h-11">
                      Replace
                    </Button>
                    <Button size="sm" onClick={() => uploads.dismiss(u.id)} className="max-sm:min-h-11">
                      Skip
                    </Button>
                  </>
                )}
                {(u.status === 'uploading' || u.status === 'queued') && (
                  <Button size="sm" variant="ghost" onClick={() => uploads.cancel(u.id)} className="max-sm:min-h-11">
                    Cancel
                  </Button>
                )}
                {u.status === 'error' && u.retryable && (
                  <Button size="sm" onClick={() => uploads.retry(u.id)} className="max-sm:min-h-11">
                    Retry
                  </Button>
                )}
                {(u.status === 'error' || u.status === 'cancelled' || u.status === 'done') && (
                  <button
                    type="button"
                    onClick={() => uploads.dismiss(u.id)}
                    aria-label={`Dismiss ${u.name}`}
                    className="flex size-8 items-center justify-center rounded text-subtle hover:bg-panel-3 hover:text-text focus-visible:outline-2 focus-visible:outline-accent max-sm:size-11"
                  >
                    <IconClose className="size-3.5" />
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
