// Reusable file manager for one root (agent workspace, team folder or the Mac exchange folder).
// Embedded on the agent page as <FileManager root={"agent:" + agentId} />; FilesPage adds a root chooser.
import { useCallback, useEffect, useId, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';
import { ConfirmDialog } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { Button, Checkbox, EmptyState, ErrorBanner, Mono, Select, Spinner } from '../../components/ui';
import { useApi } from '../../hooks/useApi';
import { useLiveRefresh } from '../../hooks/useEvents';
import { formatBytes, formatTime, relativeTime } from '../../lib/format';
import { filesApi } from './api';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { CopyMoveDialog, HistoryDialog, NameDialog, TransferDialog, type TransferPreset } from './dialogs';
import { downloadFile } from './download';
import {
  IconChevron,
  IconClose,
  IconDownload,
  IconFolderPlus,
  IconHistory,
  IconMac,
  IconMore,
  IconRefresh,
  IconSearch,
  IconSend,
  IconUp,
  IconUpload,
  KindIcon,
  RootIcon,
} from './icons';
import { baseName, breadcrumbs, displayPath, fileKind, isTextLike, joinPath, normalizePath, parentPath, ROOT_PATH, sortEntries, type SortKey } from './paths';
import { PreviewDialog } from './Preview';
import type { FileEntry, FileRoot, UsageResult } from './types';
import { UploadPanel, useUploads } from './uploads';

export interface FileManagerProps {
  /** Fixed root (`agent:<id>`, `team:<id>`, `exchange`). Without it the manager shows its own root selector. */
  root?: string;
  /** Denser layout for embedding (e.g. the agent detail page). */
  compact?: boolean;
  /** Folder shown first (relative to the root). */
  initialPath?: string;
  /** Called whenever the visible folder changes (FilesPage mirrors it in the URL). */
  onLocationChange?: (root: string, path: string) => void;
}

type Dialog =
  | { kind: 'mkdir' }
  | { kind: 'rename'; entry: FileEntry }
  | { kind: 'copy' | 'move'; entry: FileEntry }
  | { kind: 'delete'; entry: FileEntry }
  | { kind: 'transfer'; entry: FileEntry; preset: TransferPreset }
  | { kind: 'preview'; entry: FileEntry; mode: 'view' | 'edit' | 'versions' }
  | { kind: 'history' };

const touch = 'max-sm:min-h-11';

export function rootFallbackLabel(root: string): string {
  if (root === 'exchange') return 'Mac exchange folder';
  if (root.startsWith('agent:')) return 'Agent workspace';
  if (root.startsWith('team:')) return 'Team folder';
  return root;
}

function hasFiles(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files');
}

/** "Nov 16, 09:41" this year, "Nov 16, 2025" otherwise (the full time is in the title). */
export function shortTime(ts: number, nowMs = Date.now()): string {
  const d = new Date(ts * 1000);
  const sameYear = d.getFullYear() === new Date(nowMs).getFullYear();
  return d.toLocaleString(
    undefined,
    sameYear ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' } : { year: 'numeric', month: 'short', day: 'numeric' },
  );
}


export function FileManager({ root: fixedRoot, compact = false, initialPath, onLocationChange }: FileManagerProps) {
  const toast = useToast();
  const uid = useId();
  const roots = useApi((s) => filesApi.roots(s), []);
  const [chosenRoot, setChosenRoot] = useState<string | null>(null);
  const root = fixedRoot ?? chosenRoot ?? roots.data?.[0]?.id ?? null;
  const rootInfo: FileRoot | undefined = roots.data?.find((r) => r.id === root);
  const rootLabel = rootInfo?.label ?? (root ? rootFallbackLabel(root) : 'Files');
  const versioned = root !== 'exchange';
  const exchange = roots.data?.find((r) => r.type === 'exchange') ?? null;

  const [path, setPath] = useState(() => normalizePath(initialPath));
  const [q, setQ] = useState('');
  const [searchQ, setSearchQ] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'name', dir: 'asc' });
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [menu, setMenu] = useState<{ entry: FileEntry; x: number; y: number; trigger: HTMLElement | null } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [recursive, setRecursive] = useState(false);
  const [usage, setUsage] = useState<{ key: string; data?: UsageResult; error?: unknown; loading: boolean } | null>(null);
  const dragDepth = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const longPress = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number; fired: boolean } | null>(null);

  // reset when the root changes
  const prevRoot = useRef(root);
  useEffect(() => {
    if (prevRoot.current === root) return;
    prevRoot.current = root;
    setPath(ROOT_PATH);
    setQ('');
    setSearchQ(null);
    setUsage(null);
  }, [root]);

  const onLoc = useRef(onLocationChange);
  onLoc.current = onLocationChange;
  useEffect(() => {
    if (root) onLoc.current?.(root, path);
  }, [root, path]);

  const listing = useApi((s) => (root ? filesApi.list(root, path, s) : Promise.resolve(null)), [root, path]);
  const search = useApi((s) => (root && searchQ ? filesApi.search(root, searchQ, path, s) : Promise.resolve(null)), [root, path, searchQ]);

  // debounced search
  useEffect(() => {
    const t = setTimeout(() => setSearchQ(q.trim() ? q.trim().slice(0, 200) : null), 500);
    return () => clearTimeout(t);
  }, [q]);

  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listingReload = listing.reload;
  const searchReload = search.reload;
  const refresh = useCallback(() => {
    if (reloadTimer.current) clearTimeout(reloadTimer.current);
    reloadTimer.current = setTimeout(() => {
      listingReload();
      searchReload();
      setUsage(null);
    }, 250);
  }, [listingReload, searchReload]);
  useEffect(() => () => {
    if (reloadTimer.current) clearTimeout(reloadTimer.current);
  }, []);

  const uploads = useUploads(refresh);
  // files written through NEBULA (workflows, other dashboard tabs, transfers) appear without a manual refresh
  useLiveRefresh(
    refresh,
    (ev) => ev.type === 'file.created' && (ev.payload as { root?: unknown } | null)?.root === root,
    800,
  );

  const usageKey = root ? `${root}|${path}` : '';
  const calcUsage = useCallback(() => {
    if (!root) return;
    const key = `${root}|${path}`;
    setUsage({ key, loading: true });
    filesApi
      .usage(root, path)
      .then((data) => setUsage((u) => (u?.key === key ? { key, data, loading: false } : u)))
      .catch((error: unknown) => setUsage((u) => (u?.key === key ? { key, error, loading: false } : u)));
  }, [root, path]);
  // the root folder's total is shown automatically; sub-folders on request (it walks the whole tree)
  useEffect(() => {
    if (root && path === ROOT_PATH && !usage) calcUsage();
  }, [root, path, usage, calcUsage]);

  const go = (p: string) => {
    setPath(normalizePath(p));
    setQ('');
    setSearchQ(null);
    setMenu(null);
  };

  const searching = !!searchQ;
  const entries = useMemo(() => {
    if (searching) return search.data?.results ?? [];
    return sortEntries(listing.data?.entries ?? [], sort.key, sort.dir);
  }, [searching, search.data, listing.data, sort]);
  const names = useMemo(() => new Set((listing.data?.entries ?? []).map((e) => e.name)), [listing.data]);

  const open = (e: FileEntry, mode: 'view' | 'edit' | 'versions' = 'view') => {
    if (e.type === 'dir') go(e.path);
    else if (e.type === 'file') setDialog({ kind: 'preview', entry: e, mode });
    else toast.info('Symbolic link', 'NEBULA never follows symlinks, so this entry cannot be opened.');
  };

  const menuItems = (e: FileEntry): MenuItem[] => {
    const isFile = e.type === 'file';
    const isDir = e.type === 'dir';
    const link = e.type === 'symlink';
    const items: MenuItem[] = [
      { id: 'open', label: isDir ? 'Open folder' : 'Preview', icon: <KindIcon kind={fileKind(e)} className="size-4" />, onSelect: () => open(e), disabled: link, hint: link ? 'symlink' : undefined },
    ];
    if (isFile && isTextLike(e)) items.push({ id: 'edit', label: 'Edit text', onSelect: () => open(e, 'edit') });
    if (isFile && root)
      items.push({
        id: 'download',
        label: 'Download',
        icon: <IconDownload />,
        onSelect: () => {
          downloadFile(root, e.path, e.name, e.size).catch((err: unknown) => toast.error(err, `Could not download ${e.name}`));
        },
      });
    items.push(
      { id: 'rename', label: 'Rename…', separatorBefore: true, onSelect: () => setDialog({ kind: 'rename', entry: e }), disabled: link, hint: link ? 'symlink' : undefined },
      { id: 'copy', label: 'Copy to…', onSelect: () => setDialog({ kind: 'copy', entry: e }), disabled: link, hint: link ? 'symlink' : undefined },
      { id: 'move', label: 'Move to…', onSelect: () => setDialog({ kind: 'move', entry: e }), disabled: link, hint: link ? 'symlink' : undefined },
    );
    if (isFile) {
      items.push({
        id: 'transfer',
        label: root === 'exchange' ? 'Send to agent…' : 'Send to agent or team…',
        icon: <IconSend />,
        separatorBefore: true,
        onSelect: () => setDialog({ kind: 'transfer', entry: e, preset: 'agent' }),
      });
      if (root !== 'exchange' && exchange)
        items.push({ id: 'exchange', label: 'Copy to Mac exchange folder…', icon: <IconMac />, onSelect: () => setDialog({ kind: 'transfer', entry: e, preset: 'exchange' }) });
      if (versioned) items.push({ id: 'versions', label: 'Versions…', icon: <IconHistory />, onSelect: () => open(e, 'versions') });
    }
    items.push({
      id: 'delete',
      label: 'Delete…',
      danger: true,
      separatorBefore: true,
      onSelect: () => {
        setRecursive(false);
        setDialog({ kind: 'delete', entry: e });
      },
      disabled: link,
      hint: link ? 'symlink' : undefined,
    });
    return items;
  };

  const openMenuAt = (entry: FileEntry, x: number, y: number, trigger: HTMLElement | null) => setMenu({ entry, x, y, trigger });
  const openMenuFor = (entry: FileEntry, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    openMenuAt(entry, r.right - 256, r.bottom + 4, el);
  };

  // ------------------------------------------------------------ row interaction
  const rowKeyDown = (e: KeyboardEvent<HTMLButtonElement>, entry: FileEntry) => {
    const focusRow = (delta: number) => {
      const rows = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('[data-file-row]') ?? []);
      const i = rows.indexOf(e.currentTarget);
      rows[Math.max(0, Math.min(rows.length - 1, i + delta))]?.focus();
    };
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      focusRow(1);
    } else if (e.key === 'ArrowUp' && !e.altKey) {
      e.preventDefault();
      focusRow(-1);
    } else if (e.key === 'ArrowUp' && e.altKey) {
      e.preventDefault();
      go(parentPath(path));
    } else if (e.key === 'Delete' && entry.type !== 'symlink') {
      e.preventDefault();
      setRecursive(false);
      setDialog({ kind: 'delete', entry });
    } else if (e.key === 'F2' && entry.type !== 'symlink') {
      e.preventDefault();
      setDialog({ kind: 'rename', entry });
    } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      e.preventDefault();
      openMenuFor(entry, e.currentTarget);
    }
  };
  const cancelLongPress = () => {
    if (longPress.current) clearTimeout(longPress.current.timer);
  };
  const rowPointerDown = (e: PointerEvent<HTMLButtonElement>, entry: FileEntry) => {
    if (e.pointerType === 'mouse') return;
    cancelLongPress();
    const el = e.currentTarget;
    const x = e.clientX;
    const y = e.clientY;
    longPress.current = {
      x,
      y,
      fired: false,
      timer: setTimeout(() => {
        if (longPress.current) longPress.current.fired = true;
        navigator.vibrate?.(12);
        openMenuAt(entry, x, y, el);
      }, 550),
    };
  };
  const rowPointerMove = (e: PointerEvent<HTMLButtonElement>) => {
    const lp = longPress.current;
    if (lp && !lp.fired && Math.hypot(e.clientX - lp.x, e.clientY - lp.y) > 10) clearTimeout(lp.timer);
  };
  const rowClick = (e: MouseEvent<HTMLButtonElement>, entry: FileEntry) => {
    if (longPress.current?.fired) {
      e.preventDefault();
      longPress.current = null;
      return;
    }
    open(entry);
  };

  // ------------------------------------------------------------ drag & drop upload
  const onDragEnter = (e: DragEvent<HTMLDivElement>) => {
    if (!hasFiles(e) || !root) return;
    e.preventDefault();
    dragDepth.current += 1;
    setDragOver(true);
  };
  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!hasFiles(e) || !root) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };
  const onDragLeave = () => {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragOver(false);
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    if (!hasFiles(e) || !root) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDragOver(false);
    const files: File[] = [];
    const rejected: { name: string; reason: string }[] = [];
    const items = Array.from(e.dataTransfer.items ?? []);
    if (items.length) {
      for (const it of items) {
        if (it.kind !== 'file') continue;
        const entry = (it as DataTransferItem & { webkitGetAsEntry?: () => { isDirectory: boolean; name: string } | null }).webkitGetAsEntry?.();
        const f = it.getAsFile();
        if (entry?.isDirectory) rejected.push({ name: entry.name, reason: 'Folders cannot be uploaded — upload the files inside, or zip the folder first.' });
        else if (f) files.push(f);
      }
    } else files.push(...Array.from(e.dataTransfer.files));
    uploads.add(files, root, path, rejected);
  };

  // ------------------------------------------------------------ render
  if (!fixedRoot && roots.error && !roots.data) return <ErrorBanner error={roots.error} onRetry={roots.reload} title="Could not load file locations" />;
  if (!root) {
    if (roots.loading) return <Spinner label="Loading file locations…" />;
    return <EmptyState title="No file locations">Create an agent to get a workspace.</EmptyState>;
  }

  const crumbs = breadcrumbs(path, rootLabel);
  const listError = searching ? search.error : listing.error;
  const loadingList = searching ? !search.data && search.loading : !listing.data && listing.loading;
  const sortBtn = (key: SortKey, label: string, cls = '') => (
    <button
      type="button"
      onClick={() => setSort((s) => ({ key, dir: s.key === key && s.dir === 'asc' ? 'desc' : 'asc' }))}
      aria-sort={sort.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
      className={`rounded px-1 text-left text-[11px] font-semibold tracking-wide uppercase hover:text-text focus-visible:outline-2 focus-visible:outline-accent ${
        sort.key === key ? 'text-text' : 'text-subtle'
      } ${cls}`}
    >
      {label}
      {sort.key === key ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}
    </button>
  );

  return (
    <div className={`flex min-w-0 flex-col ${compact ? 'gap-2' : 'gap-3'}`}>
      {/* ---------------------------------------------------------- location bar */}
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {!fixedRoot && roots.data && (
          <div className="w-full sm:w-64">
            <label htmlFor={`${uid}-root`} className="sr-only">
              Location
            </label>
            <Select id={`${uid}-root`} value={root} onChange={(e) => setChosenRoot(e.target.value)} className={touch}>
              {roots.data.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </Select>
          </div>
        )}
        <button
          type="button"
          onClick={() => go(parentPath(path))}
          disabled={path === ROOT_PATH}
          aria-label="Parent folder"
          title="Parent folder (Alt+↑)"
          className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border text-muted hover:bg-panel-2 hover:text-text focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40 max-sm:size-11"
        >
          <IconUp />
        </button>
        <nav aria-label="Folder path" className="min-w-0 flex-1 overflow-x-auto">
          <ol className="flex items-center gap-0.5 whitespace-nowrap">
            {crumbs.map((c, i) => (
              <li key={c.path} className="flex items-center gap-0.5">
                {i > 0 && <IconChevron className="size-3.5 shrink-0 text-subtle" />}
                <button
                  type="button"
                  onClick={() => go(c.path)}
                  aria-current={i === crumbs.length - 1 ? 'location' : undefined}
                  className={`flex min-h-9 items-center gap-1.5 rounded px-1.5 text-sm hover:bg-panel-2 focus-visible:outline-2 focus-visible:outline-accent max-sm:min-h-11 ${
                    i === crumbs.length - 1 ? 'font-medium text-text' : 'text-muted'
                  }`}
                >
                  {i === 0 && <RootIcon type={rootInfo?.type ?? (root === 'exchange' ? 'exchange' : 'agent')} />}
                  <span className="max-w-[14rem] truncate">{c.label}</span>
                </button>
              </li>
            ))}
          </ol>
        </nav>
      </div>

      {/* ---------------------------------------------------------- actions */}
      <div className="flex flex-wrap items-center gap-2">
        <form
          role="search"
          className="relative min-w-0 flex-1 basis-56"
          onSubmit={(e) => {
            e.preventDefault();
            setSearchQ(q.trim() ? q.trim().slice(0, 200) : null);
          }}
        >
          <label htmlFor={`${uid}-q`} className="sr-only">
            Search in {displayPath(path)}
          </label>
          <IconSearch className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-subtle" />
          <input
            id={`${uid}-q`}
            type="search"
            value={q}
            maxLength={200}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && q) {
                e.preventDefault();
                setQ('');
                setSearchQ(null);
              }
            }}
            placeholder={`Search names in ${path === ROOT_PATH ? rootLabel : baseName(path)}…`}
            className="h-9 w-full rounded-md border border-border bg-bg pr-3 pl-8 text-sm text-text placeholder:text-subtle focus:border-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 max-sm:h-11"
          />
        </form>
        <input
          ref={fileInput}
          type="file"
          multiple
          className="hidden"
          tabIndex={-1}
          aria-hidden
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = '';
            uploads.add(files, root, path);
          }}
        />
        <Button variant="primary" onClick={() => fileInput.current?.click()} className={touch}>
          <IconUpload /> Upload
        </Button>
        <Button onClick={() => setDialog({ kind: 'mkdir' })} className={touch}>
          <IconFolderPlus /> New folder
        </Button>
        <Button variant="ghost" onClick={refresh} aria-label="Refresh" title="Refresh" className={touch}>
          <IconRefresh />
          <span className={compact ? 'sr-only' : 'max-sm:sr-only'}>Refresh</span>
        </Button>
        <Button variant="ghost" onClick={() => setDialog({ kind: 'history' })} aria-label="Change history" title="Change history" className={touch}>
          <IconHistory />
          <span className={compact ? 'sr-only' : 'max-sm:sr-only'}>History</span>
        </Button>
      </div>

      <UploadPanel uploads={uploads} />

      {/* ---------------------------------------------------------- list / drop zone */}
      <div
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={`relative min-w-0 rounded-xl border bg-panel ${dragOver ? 'border-accent ring-2 ring-accent/40' : 'border-border'}`}
      >
        {dragOver && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-accent/10 p-4 text-center text-sm font-medium text-text">
            Drop files to upload them to {displayPath(path)}
          </div>
        )}
        {searching && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2 text-xs text-muted">
            <span>
              {search.data ? `${search.data.results.length}${search.data.truncated ? '+' : ''} result(s)` : 'Searching…'} for “{searchQ}” in {displayPath(path)}
              {search.data?.truncated ? ' — showing the first 300, refine the search' : ''}
            </span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setQ('');
                setSearchQ(null);
              }}
              className={touch}
            >
              <IconClose className="size-3.5" /> Clear search
            </Button>
          </div>
        )}
        {!searching && (
          <div className="hidden grid-cols-[minmax(0,1fr)_88px_148px_44px] items-center gap-2 border-b border-border px-3 py-1.5 sm:grid">
            {sortBtn('name', 'Name')}
            {sortBtn('size', 'Size', 'text-right justify-self-end')}
            {sortBtn('mtime', 'Modified')}
            <span className="sr-only">Actions</span>
          </div>
        )}
        {listError ? (
          <div className="p-3">
            <ErrorBanner
              error={listError}
              onRetry={searching ? search.reload : listing.reload}
              title={searching ? 'Search failed' : `Could not open ${displayPath(path)}`}
            />
            {!searching && path !== ROOT_PATH && (
              <Button size="sm" variant="ghost" onClick={() => go(ROOT_PATH)} className={`mt-2 ${touch}`}>
                Go to {rootLabel}
              </Button>
            )}
          </div>
        ) : loadingList ? (
          <div className="p-4">
            <Spinner label={searching ? 'Searching…' : 'Loading…'} />
          </div>
        ) : entries.length === 0 ? (
          <div className="p-3">
            {searching ? (
              <EmptyState title="Nothing found">No file or folder name contains “{searchQ}”. Hidden folders are not searched.</EmptyState>
            ) : (
              <EmptyState title="This folder is empty">Drop files here, or use Upload / New folder.</EmptyState>
            )}
          </div>
        ) : (
          <ul ref={listRef} aria-label={searching ? 'Search results' : `Contents of ${displayPath(path)}`} className={`divide-y divide-border/70 ${compact ? 'max-h-[28rem] overflow-y-auto' : ''}`}>
            {entries.map((e) => {
              const kind = fileKind(e);
              const meta = `${e.type === 'dir' ? 'Folder' : formatBytes(e.size)} · ${relativeTime(e.mtime)}`;
              return (
                <li
                  key={e.path}
                  className="grid grid-cols-[minmax(0,1fr)_44px] items-center gap-2 pr-1 pl-1 hover:bg-panel-2/60 sm:grid-cols-[minmax(0,1fr)_88px_148px_44px] sm:pl-1"
                  onContextMenu={(ev) => {
                    ev.preventDefault();
                    cancelLongPress();
                    openMenuAt(e, ev.clientX, ev.clientY, ev.currentTarget.querySelector<HTMLElement>('[data-file-row]'));
                  }}
                >
                  <button
                    type="button"
                    data-file-row
                    onClick={(ev) => rowClick(ev, e)}
                    onKeyDown={(ev) => rowKeyDown(ev, e)}
                    onPointerDown={(ev) => rowPointerDown(ev, e)}
                    onPointerMove={rowPointerMove}
                    onPointerUp={cancelLongPress}
                    onPointerCancel={cancelLongPress}
                    aria-label={`${e.name}, ${e.type === 'dir' ? 'folder' : e.type === 'symlink' ? 'symbolic link' : formatBytes(e.size)}`}
                    aria-describedby={`${uid}-help`}
                    className="flex min-h-12 min-w-0 items-center gap-3 rounded-md px-2 py-1.5 text-left select-none [-webkit-touch-callout:none] focus-visible:outline-2 focus-visible:outline-accent sm:min-h-10"
                  >
                    <KindIcon kind={kind} />
                    <span className="min-w-0 flex-1">
                      <span className={`block truncate text-sm ${e.type === 'dir' ? 'font-medium text-text' : 'text-text'}`}>{e.name}</span>
                      {searching && <span className="block truncate font-mono text-[11px] text-subtle">{displayPath(parentPath(e.path))}</span>}
                      <span className="block truncate text-[11px] text-muted sm:hidden">{meta}</span>
                    </span>
                  </button>
                  <span className="hidden text-right text-xs text-muted tabular-nums sm:block">{e.type === 'dir' ? '—' : formatBytes(e.size)}</span>
                  <span className="hidden truncate text-xs text-muted tabular-nums sm:block" title={formatTime(e.mtime)}>
                    {shortTime(e.mtime)}
                  </span>
                  <button
                    type="button"
                    aria-label={`Actions for ${e.name}`}
                    aria-haspopup="menu"
                    onClick={(ev) => openMenuFor(e, ev.currentTarget)}
                    className="flex size-11 items-center justify-center rounded-md text-muted hover:bg-panel-3 hover:text-text focus-visible:outline-2 focus-visible:outline-accent sm:size-9"
                  >
                    <IconMore />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <p id={`${uid}-help`} className="sr-only">
          Enter opens. Shift+F10 or the context menu key shows actions, F2 renames, Delete deletes, arrow keys move between items, Alt+Up goes to the parent folder.
        </p>
      </div>

      {/* ---------------------------------------------------------- footer */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
        {!searching && listing.data && <span>{listing.data.entries.length} item(s){listing.data.entries.length >= 2000 ? ' (first 2000 shown)' : ''}</span>}
        {usage?.key === usageKey && usage.data ? (
          <span>
            {usage.data.files} file(s) · {formatBytes(usage.data.bytes)} {path === ROOT_PATH ? `in ${rootLabel}` : 'in this folder'}
          </span>
        ) : usage?.key === usageKey && usage.loading ? (
          <Spinner className="size-3" label="Calculating size…" />
        ) : usage?.key === usageKey && usage.error ? (
          <span className="text-danger">Size unavailable.</span>
        ) : (
          <button type="button" onClick={calcUsage} className="min-h-8 text-accent-soft underline-offset-2 hover:underline max-sm:min-h-11">
            Calculate folder size
          </button>
        )}
        {rootInfo?.host_path && (
          <span className="min-w-0 truncate">
            On the Mac: <Mono className="text-[11px]">{rootInfo.host_path}</Mono>
          </span>
        )}
        {rootInfo?.guest_path && (
          <span className="min-w-0 truncate">
            In the VM: <Mono className="text-[11px]">{rootInfo.guest_path}</Mono>
          </span>
        )}
      </div>

      {/* ---------------------------------------------------------- menus & dialogs */}
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} title={menu.entry.name} items={menuItems(menu.entry)} onClose={() => setMenu(null)} returnFocus={menu.trigger} />
      )}
      <NameDialog
        open={dialog?.kind === 'mkdir'}
        title="New folder"
        label="Folder name"
        initial=""
        confirmLabel="Create folder"
        taken={names}
        onClose={() => setDialog(null)}
        onSubmit={async (name) => {
          await filesApi.mkdir(root, joinPath(path, name));
          toast.success('Folder created', displayPath(joinPath(path, name)));
          refresh();
        }}
      />
      <NameDialog
        open={dialog?.kind === 'rename'}
        title={dialog?.kind === 'rename' ? `Rename “${dialog.entry.name}”` : 'Rename'}
        label="New name"
        initial={dialog?.kind === 'rename' ? dialog.entry.name : ''}
        confirmLabel="Rename"
        taken={dialog?.kind === 'rename' && parentPath(dialog.entry.path) === path ? names : new Set()}
        onClose={() => setDialog(null)}
        onSubmit={async (name) => {
          if (dialog?.kind !== 'rename') return;
          const src = dialog.entry.path;
          await filesApi.rename(root, src, joinPath(parentPath(src), name));
          toast.success('Renamed', `${dialog.entry.name} → ${name}`);
          refresh();
        }}
      />
      {(dialog?.kind === 'copy' || dialog?.kind === 'move') && (
        <CopyMoveDialog
          mode={dialog.kind}
          root={root}
          rootLabel={rootLabel}
          entry={dialog.entry}
          startDir={parentPath(dialog.entry.path)}
          onDone={refresh}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'transfer' && (
        <TransferDialog roots={roots.data ?? []} srcRoot={root} entry={dialog.entry} preset={dialog.preset} onDone={() => undefined} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'preview' && (
        <PreviewDialog root={root} entry={dialog.entry} versioned={versioned} startMode={dialog.mode} onClose={() => setDialog(null)} onChanged={refresh} />
      )}
      {dialog?.kind === 'history' && <HistoryDialog root={root} rootLabel={rootLabel} onClose={() => setDialog(null)} />}
      <ConfirmDialog
        open={dialog?.kind === 'delete'}
        title={dialog?.kind === 'delete' ? `Delete “${dialog.entry.name}”?` : 'Delete?'}
        confirmLabel="Delete"
        busyText="Deleting…"
        onCancel={() => setDialog(null)}
        onConfirm={async () => {
          if (dialog?.kind !== 'delete') return;
          const e = dialog.entry;
          try {
            await filesApi.remove(root, e.path, e.type === 'dir' && recursive);
            toast.success('Deleted', displayPath(e.path));
            setDialog(null);
            refresh();
          } catch (err) {
            toast.error(err, e.type === 'dir' && !recursive ? 'Could not delete the folder (is it empty?)' : 'Could not delete');
          }
        }}
      >
        {dialog?.kind === 'delete' && (
          <div className="flex flex-col gap-3">
            <p>
              <Mono className="text-text">{displayPath(dialog.entry.path)}</Mono> in {rootLabel} is deleted permanently
              {versioned && dialog.entry.type === 'file' ? ' (stored previous versions stay in .nebula_versions)' : ''}. This cannot be undone.
            </p>
            {dialog.entry.type === 'dir' && (
              <Checkbox
                label="Also delete everything inside this folder"
                description="Without this, only an empty folder can be deleted."
                checked={recursive}
                onChange={setRecursive}
              />
            )}
          </div>
        )}
      </ConfirmDialog>
    </div>
  );
}

/** Icon + label for a root (used by FilesPage). */
export function RootLabel({ root }: { root: FileRoot }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <RootIcon type={root.type} className="size-4 shrink-0 text-muted" />
      <span className="truncate">{root.label}</span>
    </span>
  );
}
