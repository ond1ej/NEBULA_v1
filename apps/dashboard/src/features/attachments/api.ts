// Multimodal attachments (routes_v3.py "multimodal attachments" + attachments.py): multipart upload with progress
// (XMLHttpRequest), listing per agent/task, derived previews, deletion and task creation with attachment_ids.
import { buildUrl, request } from '../../api';
import type { Epoch, Task } from '../../types';
import { xhrUpload } from '../files/api';

const enc = encodeURIComponent;

/** attachments.MAX_BYTES["web"] */
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_TASK = 20;

export type AttachmentKind = 'image' | 'pdf' | 'docx' | 'text' | 'csv' | 'json' | 'zip' | 'code' | 'audio' | 'voice' | 'video' | 'other' | string;
export type AttachmentStatus = 'RECEIVED' | 'PROCESSED' | 'FAILED' | 'REJECTED' | string;

export interface VisionInfo {
  used: boolean | null;
  note?: string;
  model?: string;
  at?: Epoch;
}

export interface Transcript {
  ok: boolean;
  text?: string;
  error?: string;
  backend?: string;
  language?: string | null;
}

export interface MediaInfo {
  duration_s?: number;
  format?: string | null;
  bit_rate?: number | null;
  video?: { codec?: string | null; width?: number | null; height?: number | null; fps?: number | null } | null;
  audio?: { codec?: string | null; channels?: number | null; sample_rate?: string | number | null } | null;
}

export interface Extracted {
  width?: number | null;
  height?: number | null;
  model_image?: string;
  vision?: VisionInfo;
  pages?: number;
  chars?: number;
  excerpt?: string;
  text_file?: string;
  table?: { rows: number; columns: string[]; column_count: number };
  json?: { valid: boolean; type?: string; keys?: string[]; length?: number; error?: string };
  archive?: { entries: number; total_bytes?: number; unsafe_entries?: string[]; listing?: string[]; text_files?: { path: string; excerpt: string }[] };
  media?: MediaInfo;
  media_error?: string;
  transcript?: Transcript;
  frames?: { t: number; file: string }[];
  note?: string;
  [k: string]: unknown;
}

export interface Attachment {
  id: string;
  source: string;
  agent_id: string | null;
  task_id: string | null;
  conversation?: string | null;
  kind: AttachmentKind;
  mime: string;
  name: string;
  size: number;
  sha256?: string;
  status: AttachmentStatus;
  extracted: Extracted | null;
  workspace_path?: string | null;
  error: string | null;
  created_at: Epoch;
  expires_at?: Epoch | null;
}

export interface UploadOptions {
  onProgress?: (loaded: number, total: number) => void;
  signal?: AbortSignal;
}

/** POST /agents/{id}/attachments (multipart field `file`). The host validates, processes and returns the attachment. */
export function uploadAttachment(agentId: string, file: File, opts: UploadOptions = {}): Promise<Attachment> {
  const form = new FormData();
  form.append('file', file, file.name);
  return xhrUpload<Attachment>(buildUrl(`/agents/${enc(agentId)}/attachments`), form, opts);
}

export const attachmentsApi = {
  upload: uploadAttachment,
  list: (agentId: string, taskId?: string, signal?: AbortSignal) => request<Attachment[]>(`/agents/${enc(agentId)}/attachments`, { query: { task_id: taskId }, signal }),
  get: (id: string) => request<Attachment>(`/attachments/${enc(id)}`),
  remove: (id: string) => request<{ deleted: string }>(`/attachments/${enc(id)}`, { method: 'DELETE' }),
  createTask: (agentId: string, prompt: string, attachmentIds: string[], idempotencyKey: string) =>
    request<Task>(`/agents/${enc(agentId)}/tasks`, { method: 'POST', body: { prompt, attachment_ids: attachmentIds }, idempotencyKey }),
};

/** Original file, or a derived preview (`derived/model.jpg`, `derived/frames/frame-00.jpg`). */
export function contentUrl(id: string, derived?: string | null): string {
  return buildUrl(`/attachments/${enc(id)}/content`, { derived: derived ?? undefined });
}

export function thumbnailPath(a: Pick<Attachment, 'kind' | 'extracted'>): string | null {
  const ex = a.extracted ?? {};
  if (a.kind === 'image' && typeof ex.model_image === 'string') return ex.model_image;
  if (a.kind === 'video' && ex.frames && ex.frames.length > 0) return ex.frames[0].file;
  return null;
}

function dur(s: number | undefined | null): string | null {
  if (s == null || !Number.isFinite(s) || s <= 0) return null;
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  return m ? `${m}:${String(r).padStart(2, '0')} min` : `${r} s`;
}

/** Short human summary of what was extracted (pages, chars, duration, frames, entries, …). */
export function extractionSummary(a: Pick<Attachment, 'kind' | 'extracted' | 'status' | 'error'>): string {
  if (a.status === 'FAILED' || a.status === 'REJECTED') return a.error ? `Processing failed: ${a.error}` : 'Processing failed';
  if (a.status === 'RECEIVED') return 'Processing…';
  const ex = a.extracted ?? {};
  const parts: string[] = [];
  switch (a.kind) {
    case 'image':
      if (ex.width && ex.height) parts.push(`${ex.width}×${ex.height}`);
      break;
    case 'pdf':
      if (ex.pages != null) parts.push(`${ex.pages} page${ex.pages === 1 ? '' : 's'}`);
      if (ex.chars != null) parts.push(`${ex.chars.toLocaleString()} chars`);
      break;
    case 'csv':
      if (ex.table) parts.push(`~${ex.table.rows.toLocaleString()} rows`, `${ex.table.column_count} columns`);
      else if (ex.chars != null) parts.push(`${ex.chars.toLocaleString()} chars`);
      break;
    case 'json':
      if (ex.json && !ex.json.valid) parts.push('invalid JSON');
      else if (ex.json?.type === 'array' && ex.json.length != null) parts.push(`array of ${ex.json.length}`);
      else if (ex.json?.type === 'object' && ex.json.keys) parts.push(`object, ${ex.json.keys.length} keys`);
      if (ex.chars != null) parts.push(`${ex.chars.toLocaleString()} chars`);
      break;
    case 'zip':
      if (ex.archive) {
        parts.push(`${ex.archive.entries} entries`);
        if (ex.archive.unsafe_entries && ex.archive.unsafe_entries.length) parts.push(`${ex.archive.unsafe_entries.length} unsafe ignored`);
      }
      break;
    case 'audio':
    case 'voice': {
      const d = dur(ex.media?.duration_s);
      if (d) parts.push(d);
      if (ex.transcript) parts.push(ex.transcript.ok ? 'transcribed' : 'no transcript');
      break;
    }
    case 'video': {
      const d = dur(ex.media?.duration_s);
      if (d) parts.push(d);
      const v = ex.media?.video;
      if (v?.width && v?.height) parts.push(`${v.width}×${v.height}`);
      if (ex.frames) parts.push(`${ex.frames.length} frame${ex.frames.length === 1 ? '' : 's'}`);
      if (ex.transcript) parts.push(ex.transcript.ok ? 'transcribed' : 'no transcript');
      break;
    }
    default:
      if (ex.chars != null) parts.push(`${ex.chars.toLocaleString()} chars`);
      else if (ex.note) parts.push(ex.note);
  }
  return parts.join(' · ') || 'Ready';
}

/** Honest vision state for images / video frames: only claims "seen" when the host recorded it. */
export function visionState(a: Pick<Attachment, 'kind' | 'extracted'>): { tone: 'success' | 'warn' | 'neutral'; text: string } | null {
  if (a.kind !== 'image' && a.kind !== 'video') return null;
  const v = a.extracted?.vision;
  if (!v) return null;
  if (v.used === true) return { tone: 'success', text: `Seen by the model${v.model ? ` (${v.model})` : ''}` };
  if (v.used === false) return { tone: 'warn', text: v.note || 'The agent’s model cannot see images — not analysed' };
  return { tone: 'neutral', text: v.note || 'Analysed when the task runs (if the model supports images)' };
}
