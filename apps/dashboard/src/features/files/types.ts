// Shapes of the file manager API (routes_v2.py "Module 8: files", files_service.py, guest fsop.py).

export interface FileRoot {
  /** `agent:<id>`, `team:<id>` or `exchange` */
  id: string;
  type: 'agent' | 'team' | 'exchange' | string;
  label: string;
  agent_id?: string;
  team_id?: string;
  status?: string;
  guest_path?: string;
  host_path?: string;
}

export type EntryType = 'file' | 'dir' | 'symlink';

export interface FileEntry {
  name: string;
  /** Relative to the root; the root itself is "." */
  path: string;
  type: EntryType | string;
  size: number;
  mtime: number;
}

export interface ListResult {
  path: string;
  entries: FileEntry[];
}

export interface SearchResult {
  results: FileEntry[];
  truncated: boolean;
}

export interface UsageResult {
  path?: string;
  bytes: number;
  files: number;
}

export interface FileVersion {
  /** `<file name>.<unix ts>` inside `.nebula_versions/<parent>/` */
  name: string;
  size: number;
  mtime: number;
}

export type PreviewKind = 'text' | 'csv' | 'image' | 'pdf' | 'binary';

export interface FilePreview {
  path: string;
  kind: PreviewKind | string;
  size: number;
  mtime: number;
  truncated: boolean;
  text?: string;
  /** Present for image / pdf; null when the file is larger than the 8 MiB preview limit. */
  data_b64?: string | null;
}

export interface FileEvent {
  id: number;
  ts: number;
  actor: string;
  root: string;
  op: string;
  path: string;
  dest: string | null;
  size: number | null;
}

export interface WriteResult {
  path: string;
  size: number;
}

export interface MoveResult {
  path: string;
  dest: string;
}

export interface TransferResult {
  from: string;
  to: string;
  size: number;
}
