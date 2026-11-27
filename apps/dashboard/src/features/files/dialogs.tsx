// File manager dialogs: name (new folder / rename), copy / move, transfer between roots, history.
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ApiError, errorMessage } from '../../api';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { Button, Checkbox, EmptyState, ErrorBanner, Field, Input, Mono, Select, Spinner } from '../../components/ui';
import { formatBytes, formatTime } from '../../lib/format';
import { filesApi } from './api';
import { IconChevron, IconFolder, IconUp } from './icons';
import { baseName, breadcrumbs, copyName, displayPath, isInside, joinPath, normalizePath, parentPath, ROOT_PATH, validateName } from './paths';
import type { FileEntry, FileEvent, FileRoot } from './types';

const touch = 'max-sm:min-h-11';

// ---------------------------------------------------------------- name dialog
export function NameDialog({
  open,
  title,
  label,
  initial,
  confirmLabel,
  taken,
  onSubmit,
  onClose,
}: {
  open: boolean;
  title: string;
  label: string;
  initial: string;
  confirmLabel: string;
  /** Names already used in the target folder. */
  taken: Set<string>;
  onSubmit: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setName(initial);
    setError(null);
    setBusy(false);
    const t = setTimeout(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      const dot = initial.lastIndexOf('.');
      el.setSelectionRange(0, dot > 0 ? dot : initial.length);
    }, 0);
    return () => clearTimeout(t);
  }, [open, initial]);
  const trimmed = name.trim();
  const problem = validateName(name) ?? (trimmed !== initial && taken.has(trimmed) ? `“${trimmed}” already exists here.` : null);
  const unchanged = trimmed === initial && initial !== '';
  const submit = async () => {
    if (problem || unchanged) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(trimmed);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      title={title}
      onClose={onClose}
      size="sm"
      dismissible={!busy}
      footer={
        <>
          <Button onClick={onClose} disabled={busy} className={touch}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} loading={busy} disabledReason={problem ?? (unchanged ? 'Enter a different name' : null)} className={touch}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label={label} htmlFor={id} error={error ?? (name !== initial ? problem : null)}>
          <Input ref={inputRef} id={id} value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" spellCheck={false} data-autofocus />
        </Field>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- folder picker
export function FolderPicker({
  root,
  rootLabel,
  value,
  onChange,
  exclude,
}: {
  root: string;
  rootLabel: string;
  value: string;
  onChange: (path: string) => void;
  /** A folder that cannot be chosen (moving a folder into itself). */
  exclude?: string;
}) {
  const [dirs, setDirs] = useState<FileEntry[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    const c = new AbortController();
    setDirs(null);
    setError(null);
    filesApi
      .list(root, value, c.signal)
      .then((r) => setDirs(r.entries.filter((e) => e.type === 'dir')))
      .catch((e: unknown) => {
        if (!c.signal.aborted) setError(e);
      });
    return () => c.abort();
  }, [root, value, nonce]);
  const crumbs = breadcrumbs(value, rootLabel);
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-bg/60 p-2">
      <nav aria-label="Destination folder" className="flex min-w-0 flex-wrap items-center gap-0.5 text-xs">
        {crumbs.map((c, i) => (
          <span key={c.path} className="flex min-w-0 items-center gap-0.5">
            {i > 0 && <IconChevron className="size-3 shrink-0 text-subtle" />}
            <button
              type="button"
              onClick={() => onChange(c.path)}
              aria-current={i === crumbs.length - 1 ? 'location' : undefined}
              className={`max-w-[12rem] truncate rounded px-1.5 py-1 hover:bg-panel-2 focus-visible:outline-2 focus-visible:outline-accent ${
                i === crumbs.length - 1 ? 'font-medium text-text' : 'text-muted'
              }`}
            >
              {c.label}
            </button>
          </span>
        ))}
      </nav>
      <div className="max-h-52 overflow-y-auto">
        {error ? (
          <ErrorBanner error={error} onRetry={() => setNonce((n) => n + 1)} title="Could not list folders" />
        ) : !dirs ? (
          <Spinner label="Loading folders…" />
        ) : (
          <ul className="flex flex-col">
            {value !== ROOT_PATH && (
              <li>
                <button
                  type="button"
                  onClick={() => onChange(parentPath(value))}
                  className="flex min-h-9 w-full items-center gap-2 rounded px-2 text-left text-sm text-muted hover:bg-panel-2 focus-visible:outline-2 focus-visible:outline-accent max-sm:min-h-11"
                >
                  <IconUp /> Parent folder
                </button>
              </li>
            )}
            {dirs.length === 0 && <li className="px-2 py-1.5 text-xs text-muted">No subfolders.</li>}
            {dirs.map((d) => {
              const blocked = exclude !== undefined && isInside(d.path, exclude);
              return (
                <li key={d.path}>
                  <button
                    type="button"
                    disabled={blocked}
                    onClick={() => onChange(d.path)}
                    title={blocked ? 'A folder cannot be moved into itself' : undefined}
                    className="flex min-h-9 w-full items-center gap-2 rounded px-2 text-left text-sm text-text hover:bg-panel-2 focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-45 max-sm:min-h-11"
                  >
                    <IconFolder className="size-4 shrink-0 text-accent-soft" />
                    <span className="truncate">{d.name}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- copy / move (same root)
export function CopyMoveDialog({
  mode,
  root,
  rootLabel,
  entry,
  startDir,
  onDone,
  onClose,
}: {
  mode: 'copy' | 'move';
  root: string;
  rootLabel: string;
  entry: FileEntry;
  startDir: string;
  onDone: (dest: string) => void;
  onClose: () => void;
}) {
  const id = useId();
  const toast = useToast();
  const src = normalizePath(entry.path);
  const srcDir = parentPath(src);
  const [folder, setFolder] = useState(startDir);
  const [name, setName] = useState(mode === 'copy' && startDir === srcDir ? copyName(entry.name, [entry.name]) : entry.name);
  const [nameTouched, setNameTouched] = useState(false);
  const [overwrite, setOverwrite] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (nameTouched) return;
    setName(mode === 'copy' && folder === srcDir ? copyName(entry.name, [entry.name]) : entry.name);
  }, [folder, mode, srcDir, entry.name, nameTouched]);
  useEffect(() => {
    setConflict(false);
    setOverwrite(false);
  }, [folder, name]);

  const dest = joinPath(folder, name.trim());
  const problem =
    validateName(name) ??
    (dest === src ? 'Choose another folder or name.' : null) ??
    (entry.type === 'dir' && isInside(folder, src) ? 'A folder cannot be placed inside itself.' : null);

  const submit = async () => {
    if (problem) return;
    setBusy(true);
    setError(null);
    try {
      const fn = mode === 'copy' ? filesApi.copy : filesApi.move;
      const r = await fn(root, src, dest, overwrite);
      toast.success(mode === 'copy' ? 'Copied' : 'Moved', `${displayPath(src)} → ${displayPath(r.dest ?? dest)}`);
      onDone(r.dest ?? dest);
      onClose();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setConflict(true);
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      title={`${mode === 'copy' ? 'Copy' : 'Move'} “${entry.name}”`}
      onClose={onClose}
      dismissible={!busy}
      footer={
        <>
          <Button onClick={onClose} disabled={busy} className={touch}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => void submit()}
            loading={busy}
            disabledReason={problem ?? (conflict && !overwrite ? 'Confirm replacing the existing item' : null)}
            className={touch}
          >
            {mode === 'copy' ? 'Copy here' : 'Move here'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <FolderPicker root={root} rootLabel={rootLabel} value={folder} onChange={setFolder} exclude={entry.type === 'dir' && mode === 'move' ? src : undefined} />
        <Field label="Name" htmlFor={id} error={problem && name.trim() ? problem : undefined}>
          <Input
            id={id}
            value={name}
            onChange={(e) => {
              setNameTouched(true);
              setName(e.target.value);
            }}
            spellCheck={false}
            autoComplete="off"
          />
        </Field>
        <p className="text-xs text-muted">
          Destination: <Mono>{displayPath(dest)}</Mono> in {rootLabel}
        </p>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        {conflict && (
          <Checkbox
            label="Replace the existing item"
            description={entry.type === 'dir' ? 'Folder contents are merged; files with the same name are replaced.' : 'The existing file is overwritten.'}
            checked={overwrite}
            onChange={setOverwrite}
          />
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- transfer between roots
export type TransferPreset = 'agent' | 'exchange' | null;

export function TransferDialog({
  roots,
  srcRoot,
  entry,
  preset,
  onDone,
  onClose,
}: {
  roots: FileRoot[];
  srcRoot: string;
  entry: FileEntry;
  preset: TransferPreset;
  onDone: () => void;
  onClose: () => void;
}) {
  const id = useId();
  const toast = useToast();
  const targets = useMemo(() => roots.filter((r) => r.id !== srcRoot), [roots, srcRoot]);
  const initialRoot =
    (preset === 'exchange' ? targets.find((r) => r.type === 'exchange') : preset === 'agent' ? targets.find((r) => r.type === 'agent') : null)?.id ??
    targets[0]?.id ??
    '';
  const [dstRoot, setDstRoot] = useState(initialRoot);
  const [folder, setFolder] = useState(ROOT_PATH);
  const [name, setName] = useState(entry.name);
  const [existing, setExisting] = useState<FileEntry | null | 'checking'>('checking');
  const [replace, setReplace] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dst = targets.find((r) => r.id === dstRoot);
  const dest = joinPath(folder, name.trim());
  const problem = !dst ? 'Choose a destination.' : validateName(name);

  useEffect(() => {
    setFolder(ROOT_PATH);
  }, [dstRoot]);

  useEffect(() => {
    setReplace(false);
    if (!dstRoot || validateName(name)) {
      setExisting(null);
      return;
    }
    setExisting('checking');
    const c = new AbortController();
    const t = setTimeout(() => {
      filesApi
        .stat(dstRoot, dest, c.signal)
        .then((st) => setExisting(st))
        .catch(() => {
          if (!c.signal.aborted) setExisting(null); // 404 (or unreachable): nothing to replace
        });
    }, 300);
    return () => {
      clearTimeout(t);
      c.abort();
    };
  }, [dstRoot, dest, name]);

  const exists = existing && existing !== 'checking' ? existing : null;
  const blocked = problem ?? (exists?.type === 'dir' ? 'A folder with this name exists there.' : null) ?? (exists && !replace ? 'Confirm replacing the existing file' : null);

  const submit = async () => {
    if (blocked || !dst) return;
    setBusy(true);
    setError(null);
    try {
      const r = await filesApi.transfer(srcRoot, normalizePath(entry.path), dstRoot, dest, Boolean(exists && replace));
      toast.success(`Copied to ${dst.label}`, `${displayPath(dest)} · ${formatBytes(r.size)}`);
      onDone();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const group = (t: string) => targets.filter((r) => r.type === t);
  return (
    <Modal
      open
      title={`Send “${entry.name}” to…`}
      onClose={onClose}
      dismissible={!busy}
      footer={
        <>
          <Button onClick={onClose} disabled={busy} className={touch}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} loading={busy} disabledReason={targets.length ? blocked : 'No other location exists'} className={touch}>
            Copy file
          </Button>
        </>
      }
    >
      {targets.length === 0 ? (
        <EmptyState title="No other location">Create an agent or a team with a shared folder first.</EmptyState>
      ) : (
        <div className="flex flex-col gap-3">
          <Field label="Destination" htmlFor={`${id}-root`}>
            <Select id={`${id}-root`} value={dstRoot} onChange={(e) => setDstRoot(e.target.value)}>
              {[
                ['agent', 'Agent workspaces'],
                ['team', 'Team folders'],
                ['exchange', 'Mac'],
              ].map(([t, l]) =>
                group(t).length ? (
                  <optgroup key={t} label={l}>
                    {group(t).map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.label}
                        {r.status ? ` (${r.status.toLowerCase()})` : ''}
                      </option>
                    ))}
                  </optgroup>
                ) : null,
              )}
            </Select>
          </Field>
          {dst && <FolderPicker key={dst.id} root={dst.id} rootLabel={dst.label} value={folder} onChange={setFolder} />}
          <Field label="File name" htmlFor={`${id}-name`} error={name.trim() ? (validateName(name) ?? undefined) : undefined}>
            <Input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} autoComplete="off" />
          </Field>
          <p className="text-xs text-muted">
            The file is copied (the original stays). Destination: <Mono>{displayPath(dest)}</Mono>
            {dst ? ` in ${dst.label}` : ''}. Max 200 MiB.
          </p>
          {existing === 'checking' && <Spinner className="size-3" label="Checking the destination…" />}
          {exists?.type === 'dir' && <p className="text-sm text-danger">A folder named “{baseName(dest)}” exists there — choose another name.</p>}
          {exists && exists.type !== 'dir' && (
            <Checkbox
              label={`Replace the existing “${baseName(dest)}”`}
              description={`${formatBytes(exists.size)}, modified ${formatTime(exists.mtime)}. Transfers overwrite without keeping a version.`}
              checked={replace}
              onChange={setReplace}
            />
          )}
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------- change history
const OP_LABEL: Record<string, string> = {
  write: 'wrote',
  mkdir: 'created folder',
  move: 'moved',
  copy: 'copied',
  rename: 'renamed',
  delete: 'deleted',
  transfer: 'sent',
};

export function HistoryDialog({ root, rootLabel, onClose }: { root: string; rootLabel: string; onClose: () => void }) {
  const [limit, setLimit] = useState(200);
  const [items, setItems] = useState<FileEvent[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    const c = new AbortController();
    setLoading(true);
    filesApi
      .history(root, limit, c.signal)
      .then((r) => {
        setItems(r);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!c.signal.aborted) setError(e);
      })
      .finally(() => {
        if (!c.signal.aborted) setLoading(false);
      });
    return () => c.abort();
  }, [root, limit, nonce]);
  return (
    <Modal
      open
      size="lg"
      title={`Change history · ${rootLabel}`}
      onClose={onClose}
      footer={
        <Button onClick={onClose} className={touch}>
          Close
        </Button>
      }
    >
      {error ? <ErrorBanner error={error} onRetry={() => setNonce((n) => n + 1)} title="Could not load the history" /> : null}
      {!items && loading ? (
        <Spinner label="Loading history…" />
      ) : items && items.length === 0 ? (
        <EmptyState title="No changes recorded">Uploads, edits, moves, deletions and transfers made through NEBULA appear here.</EmptyState>
      ) : (
        <>
          <ol className="flex flex-col divide-y divide-border">
            {(items ?? []).map((ev) => (
              <li key={ev.id} className="flex flex-col gap-0.5 py-2 text-sm">
                <p className="min-w-0 break-words text-text">
                  <span className="text-muted">{ev.actor}</span> {OP_LABEL[ev.op] ?? ev.op} <Mono className="text-text">{displayPath(ev.path)}</Mono>
                  {ev.dest && (
                    <>
                      {' '}
                      → <Mono className="text-text">{ev.op === 'transfer' ? ev.dest : displayPath(ev.dest)}</Mono>
                    </>
                  )}
                </p>
                <p className="text-xs text-subtle">
                  {formatTime(ev.ts)}
                  {ev.size !== null && ev.size !== undefined ? ` · ${formatBytes(ev.size)}` : ''}
                </p>
              </li>
            ))}
          </ol>
          {items && items.length >= limit && limit < 1000 && (
            <div className="mt-3">
              <Button size="sm" onClick={() => setLimit(1000)} loading={loading} className={touch}>
                Show more
              </Button>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
