import { useRef, useState } from 'react';
import { IconDownload, IconFiles, IconPlus, IconUpload } from '../../components/icons';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { Badge, Field, Input, Spinner } from '../../components/ui';
import type { FileEntry, FilePreview, FileRoot } from '../../features/files/types';
import { downloadBlob, formatBytes, relativeTime } from '../../lib/format';
import { hasPermission, useMini } from '../context';
import { useActions, useQuery } from '../hooks';
import { mhref } from '../router';
import { Empty, ErrorState, List, QueryView, Row, Screen, Section, TapButton } from '../uiKit';

// ---------------------------------------------------------------- path helpers (paths are relative to the root; '.' is the root)
export function joinPath(dir: string, name: string): string {
  const d = dir === '.' || dir === '' ? '' : dir.replace(/\/+$/, '');
  return d ? `${d}/${name}` : name;
}

export function parentOf(path: string): string {
  if (path === '.' || !path.includes('/')) return '.';
  return path.slice(0, path.lastIndexOf('/')) || '.';
}

const ext = (name: string) => (name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '');
const IMAGE_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };

function FolderGlyph() {
  return (
    <span aria-hidden className="grid size-9 place-items-center rounded-lg border border-accent/30 bg-accent/10 text-accent-soft">
      <IconFiles className="size-4" />
    </span>
  );
}

function FileGlyph({ name }: { name: string }) {
  const e = ext(name);
  return (
    <span aria-hidden className="grid size-9 place-items-center rounded-lg border border-border bg-panel-2 font-mono text-[10px] font-semibold text-muted uppercase">
      {(e || 'file').slice(0, 4)}
    </span>
  );
}

// ---------------------------------------------------------------- browser
export function FileBrowser({ root, rootLabel, path, hrefFor }: { root: string; rootLabel: string; path: string; hrefFor: (path: string) => string }) {
  const ctx = useMini();
  const { api } = ctx;
  const toast = useToast();
  const { run, isPending } = useActions();
  const canWrite = hasPermission(ctx, 'files');
  const q = useQuery(`files:${root}:${path}`, (s) => api.files.list(root, path, s), { refreshOn: (ev) => ev.type === 'file.created' });
  const [preview, setPreview] = useState<FileEntry | null>(null);
  const [mkdirOpen, setMkdirOpen] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const crumbs = path === '.' ? [] : path.split('/');
  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    for (const f of Array.from(files)) {
      setUploading(f.name);
      const r = await run(`up:${f.name}`, () => api.files.upload(root, joinPath(path, f.name), f), { success: `Uploaded ${f.name}` });
      if (r === undefined) break;
    }
    setUploading(null);
    if (input.current) input.current.value = '';
    q.reload();
  };

  return (
    <div>
      <nav aria-label="Folder path" className="-mx-4 mb-3 overflow-x-auto px-4 scrollbar-none">
        <ol className="flex w-max items-center gap-1 text-[13px]">
          <li>
            <a href={hrefFor('.')} className="inline-flex min-h-11 items-center rounded-lg px-2 font-medium text-accent-soft focus-ring" aria-current={path === '.' ? 'page' : undefined}>
              {rootLabel}
            </a>
          </li>
          {crumbs.map((c, i) => {
            const p = crumbs.slice(0, i + 1).join('/');
            const last = i === crumbs.length - 1;
            return (
              <li key={p} className="flex items-center gap-1">
                <span aria-hidden className="text-subtle">/</span>
                {last ? (
                  <span className="px-1 text-text" aria-current="page">
                    {c}
                  </span>
                ) : (
                  <a href={hrefFor(p)} className="inline-flex min-h-11 items-center rounded-lg px-1 text-accent-soft focus-ring">
                    {c}
                  </a>
                )}
              </li>
            );
          })}
        </ol>
      </nav>
      {canWrite && (
        <div className="mb-3 grid grid-cols-2 gap-2">
          <TapButton icon={<IconUpload />} loading={uploading !== null} onClick={() => input.current?.click()}>
            {uploading ? 'Uploading…' : 'Upload'}
          </TapButton>
          <TapButton icon={<IconPlus />} onClick={() => setMkdirOpen(true)}>
            New folder
          </TapButton>
          <input ref={input} type="file" multiple className="sr-only" aria-label="Choose files to upload" tabIndex={-1} onChange={(e) => void upload(e.target.files)} />
        </div>
      )}
      <QueryView q={q} isEmpty={(d) => d.entries.length === 0} empty={<Empty title="This folder is empty" icon={<IconFiles />} />}>
        {(d) => {
          const entries = [...d.entries].filter((e) => e.name !== '.nebula_versions').sort((a, b) => Number(b.type === 'dir') - Number(a.type === 'dir') || a.name.localeCompare(b.name));
          return (
            <List>
              {entries.map((e) =>
                e.type === 'dir' ? (
                  <Row key={e.path} href={hrefFor(e.path)} leading={<FolderGlyph />} title={e.name} subtitle={`Folder · ${relativeTime(e.mtime)}`} />
                ) : (
                  <Row key={e.path} onClick={() => setPreview(e)} leading={<FileGlyph name={e.name} />} title={e.name} subtitle={`${formatBytes(e.size)} · ${relativeTime(e.mtime)}`} />
                ),
              )}
            </List>
          );
        }}
      </QueryView>
      {preview && <PreviewSheet root={root} entry={preview} onClose={() => setPreview(null)} />}
      {mkdirOpen && (
        <MkdirSheet
          busy={isPending('mkdir')}
          onClose={() => setMkdirOpen(false)}
          onCreate={async (name) => {
            if (!/^[^/\\]{1,255}$/.test(name) || name === '.' || name === '..') {
              toast.error(new Error('Use a folder name without slashes'), 'Invalid name');
              return;
            }
            const r = await run('mkdir', () => api.files.mkdir(root, joinPath(path, name)), { success: `Folder ${name} created` });
            if (r !== undefined) {
              setMkdirOpen(false);
              q.reload();
            }
          }}
        />
      )}
    </div>
  );
}

function MkdirSheet({ onClose, onCreate, busy }: { onClose: () => void; onCreate: (name: string) => void; busy: boolean }) {
  const [name, setName] = useState('');
  return (
    <Modal
      open
      title="New folder"
      onClose={onClose}
      size="sm"
      footer={
        <>
          <TapButton onClick={onClose}>Cancel</TapButton>
          <TapButton variant="primary" loading={busy} disabledReason={name.trim() ? null : 'Enter a name'} onClick={() => onCreate(name.trim())}>
            Create
          </TapButton>
        </>
      }
    >
      <Field label="Folder name" htmlFor="mini-mkdir">
        <Input id="mini-mkdir" value={name} onChange={(e) => setName(e.target.value)} autoFocus autoCapitalize="off" autoCorrect="off" className="min-h-11" />
      </Field>
    </Modal>
  );
}

function PreviewSheet({ root, entry, onClose }: { root: string; entry: FileEntry; onClose: () => void }) {
  const { api } = useMini();
  const { run, isPending } = useActions();
  const q = useQuery<FilePreview>(`preview:${root}:${entry.path}:${entry.mtime}`, (s) => api.files.preview(root, entry.path, s));
  const download = async () => {
    const r = await run('dl', () => api.files.download(root, entry.path), { success: `Downloaded ${entry.name}` });
    if (r) downloadBlob(r.blob, r.filename ?? entry.name);
  };
  const p = q.data;
  return (
    <Modal
      open
      title={entry.name}
      description={`${formatBytes(entry.size)} · ${relativeTime(entry.mtime)}`}
      onClose={onClose}
      size="lg"
      footer={
        <TapButton variant="primary" icon={<IconDownload />} loading={isPending('dl')} onClick={download}>
          Download
        </TapButton>
      }
    >
      {q.error ? (
        <ErrorState error={q.error} onRetry={q.reload} />
      ) : !p ? (
        <div className="grid min-h-32 place-items-center">
          <Spinner label="Loading preview…" />
        </div>
      ) : p.kind === 'image' && p.data_b64 ? (
        <img src={`data:${IMAGE_MIME[ext(entry.name)] ?? 'image/png'};base64,${p.data_b64}`} alt={entry.name} className="w-full rounded-lg border border-border" />
      ) : (p.kind === 'text' || p.kind === 'csv') && p.text !== undefined ? (
        <>
          {p.truncated && (
            <Badge tone="warn" className="mb-2">
              Preview truncated
            </Badge>
          )}
          <pre className="max-h-[55dvh] overflow-auto rounded-lg border border-border bg-input p-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-text [overflow-wrap:anywhere]">{p.text}</pre>
        </>
      ) : (
        <p className="text-sm text-muted">No inline preview for this file type{p.kind === 'pdf' ? ' (PDF)' : ''}. Download it to open it on this device.</p>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------- screen
export function FilesScreen({ query }: { query: URLSearchParams }) {
  const { api } = useMini();
  const root = query.get('root');
  const path = query.get('path') || '.';
  const roots = useQuery<FileRoot[]>('files:roots', (s) => api.files.roots(s));
  const current = roots.data?.find((r) => r.id === root);
  const hrefFor = (p: string) => mhref(`/files?root=${encodeURIComponent(root ?? '')}${p && p !== '.' ? `&path=${encodeURIComponent(p)}` : ''}`);

  if (!root) {
    return (
      <Screen title="Files">
        <QueryView q={roots} isEmpty={(d) => d.length === 0} empty={<Empty title="No file roots">Agents and teams get a workspace when they are created.</Empty>}>
          {(d) => {
            const groups: [string, FileRoot[]][] = [
              ['Agent workspaces', d.filter((r) => r.type === 'agent')],
              ['Team folders', d.filter((r) => r.type === 'team')],
              ['Shared', d.filter((r) => r.type !== 'agent' && r.type !== 'team')],
            ];
            return groups
              .filter(([, rs]) => rs.length > 0)
              .map(([title, rs]) => (
                <Section key={title} title={title}>
                  <List>
                    {rs.map((r) => (
                      <Row
                        key={r.id}
                        href={mhref(`/files?root=${encodeURIComponent(r.id)}`)}
                        leading={<FolderGlyph />}
                        title={r.label}
                        subtitle={r.status ? r.status : r.type}
                      />
                    ))}
                  </List>
                </Section>
              ));
          }}
        </QueryView>
      </Screen>
    );
  }
  return (
    <Screen title={current?.label ?? 'Files'} subtitle={path === '.' ? 'Root folder' : path}>
      <FileBrowser root={root} rootLabel={current?.label ?? root} path={path} hrefFor={hrefFor} />
    </Screen>
  );
}
