// Pure path helpers. Paths are relative to a root and use "/" separators; the root itself is ".".
// The server rejects "..", NUL and symlinks (files_service._confine_host, guest fsop.confine).
import type { FileEntry } from './types';

export const ROOT_PATH = '.';
export const VERSIONS_DIR = '.nebula_versions';

export function normalizePath(p: string | null | undefined): string {
  const parts = String(p ?? '')
    .split('/')
    .filter((s) => s !== '' && s !== '.');
  return parts.length ? parts.join('/') : ROOT_PATH;
}

export function joinPath(dir: string, name: string): string {
  const d = normalizePath(dir);
  const n = normalizePath(name);
  if (n === ROOT_PATH) return d;
  return d === ROOT_PATH ? n : `${d}/${n}`;
}

export function parentPath(p: string): string {
  const n = normalizePath(p);
  if (n === ROOT_PATH) return ROOT_PATH;
  const i = n.lastIndexOf('/');
  return i < 0 ? ROOT_PATH : n.slice(0, i);
}

export function baseName(p: string): string {
  const n = normalizePath(p);
  if (n === ROOT_PATH) return '';
  return n.slice(n.lastIndexOf('/') + 1);
}

export interface Crumb {
  label: string;
  path: string;
}

export function breadcrumbs(p: string, rootLabel: string): Crumb[] {
  const n = normalizePath(p);
  const out: Crumb[] = [{ label: rootLabel, path: ROOT_PATH }];
  if (n === ROOT_PATH) return out;
  const parts = n.split('/');
  parts.forEach((part, i) => out.push({ label: part, path: parts.slice(0, i + 1).join('/') }));
  return out;
}

/** "/" for the root, "/a/b" otherwise (display only). */
export function displayPath(p: string): string {
  const n = normalizePath(p);
  return n === ROOT_PATH ? '/' : `/${n}`;
}

export function extOf(name: string): string {
  const b = name.slice(name.lastIndexOf('/') + 1);
  const i = b.lastIndexOf('.');
  return i <= 0 ? '' : b.slice(i + 1).toLowerCase();
}

/** Problems with a new file / folder name, or null. */
export function validateName(name: string): string | null {
  const n = name.trim();
  if (!n) return 'Enter a name.';
  if (n === '.' || n === '..') return '“.” and “..” are not allowed.';
  if (n.includes('/')) return 'A name cannot contain “/”.';
  if (n.includes('\0')) return 'A name cannot contain NUL.';
  if (n === VERSIONS_DIR) return `“${VERSIONS_DIR}” is reserved for file versions.`;
  if (new TextEncoder().encode(n).length > 255) return 'The name is too long (max 255 bytes).';
  return null;
}

/** "report.txt" -> "report copy.txt", "report copy 2.txt", … (first name not in `taken`). */
export function copyName(name: string, taken: Iterable<string>): string {
  const set = new Set(taken);
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const suffix = dot > 0 ? name.slice(dot) : '';
  for (let i = 1; ; i += 1) {
    const candidate = `${stem} copy${i > 1 ? ` ${i}` : ''}${suffix}`;
    if (!set.has(candidate)) return candidate;
  }
}

/** True when `path` is `dir` or inside it (a folder cannot be moved into itself). */
export function isInside(path: string, dir: string): boolean {
  const p = normalizePath(path);
  const d = normalizePath(dir);
  if (d === ROOT_PATH) return true;
  return p === d || p.startsWith(`${d}/`);
}

/** Path of a stored version: guest fsop keeps `<root>/.nebula_versions/<parent>/<name>.<ts>`. */
export function versionPath(filePath: string, versionName: string): string {
  return joinPath(joinPath(VERSIONS_DIR, parentPath(filePath)), versionName);
}

/** Unix timestamp encoded in a version name (`report.txt.1731700000`), or null. */
export function versionTimestamp(versionName: string): number | null {
  const m = /\.(\d{9,11})$/.exec(versionName);
  return m ? Number(m[1]) : null;
}

export type FileKind = 'folder' | 'symlink' | 'image' | 'pdf' | 'table' | 'code' | 'text' | 'archive' | 'audio' | 'video' | 'file';

const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'heic', 'avif']);
const TABLE = new Set(['csv', 'tsv', 'xls', 'xlsx', 'ods']);
const CODE = new Set([
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'sh', 'bash',
  'zsh', 'fish', 'ps1', 'sql', 'html', 'htm', 'css', 'scss', 'json', 'yaml', 'yml', 'toml', 'xml', 'ini', 'cfg', 'conf', 'env',
  'dockerfile', 'makefile', 'lua', 'swift', 'r', 'pl',
]);
const TEXT = new Set(['txt', 'md', 'markdown', 'log', 'rst', 'rtf', 'tex', 'srt', 'vtt']);
const ARCHIVE = new Set(['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'zst', 'deb', 'dmg', 'iso']);
const AUDIO = new Set(['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'opus']);
const VIDEO = new Set(['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v']);

export function fileKind(e: Pick<FileEntry, 'name' | 'type'>): FileKind {
  if (e.type === 'dir') return 'folder';
  if (e.type === 'symlink') return 'symlink';
  const x = extOf(e.name);
  if (IMAGE.has(x)) return 'image';
  if (x === 'pdf') return 'pdf';
  if (TABLE.has(x)) return 'table';
  if (CODE.has(x)) return 'code';
  if (TEXT.has(x) || (!x && /^(readme|license|makefile|dockerfile)$/i.test(e.name))) return 'text';
  if (ARCHIVE.has(x)) return 'archive';
  if (AUDIO.has(x)) return 'audio';
  if (VIDEO.has(x)) return 'video';
  return 'file';
}

/** Files the editor can open directly (the preview decides for unknown types). */
export function isTextLike(e: Pick<FileEntry, 'name' | 'type'>): boolean {
  const k = fileKind(e);
  return k === 'text' || k === 'code' || (k === 'table' && ['csv', 'tsv'].includes(extOf(e.name)));
}

export function mimeFor(name: string, kind: string): string {
  const x = extOf(name);
  if (kind === 'pdf') return 'application/pdf';
  if (x === 'jpg' || x === 'jpeg') return 'image/jpeg';
  if (x === 'png' || x === 'gif' || x === 'webp') return `image/${x}`;
  return 'application/octet-stream';
}

export type SortKey = 'name' | 'size' | 'mtime';

/** Folders first, then by key (name: natural, case-insensitive). */
export function sortEntries(entries: FileEntry[], key: SortKey, dir: 'asc' | 'desc'): FileEntry[] {
  const mul = dir === 'asc' ? 1 : -1;
  const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  return [...entries].sort((a, b) => {
    const da = a.type === 'dir' ? 0 : 1;
    const db = b.type === 'dir' ? 0 : 1;
    if (da !== db) return da - db;
    let c = 0;
    if (key === 'size') c = a.size - b.size;
    else if (key === 'mtime') c = a.mtime - b.mtime;
    if (c === 0) c = coll.compare(a.name, b.name);
    return c * mul;
  });
}

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}
