// Typed client for the file manager endpoints. Uploads use XMLHttpRequest for progress events.
import { ApiError, buildUrl, getTransport, isStepUpError, request } from '../../api';
import type {
  FileEntry,
  FileEvent,
  FilePreview,
  FileRoot,
  FileVersion,
  ListResult,
  MoveResult,
  SearchResult,
  TransferResult,
  UsageResult,
  WriteResult,
} from './types';

export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

export const filesApi = {
  roots: (signal?: AbortSignal) => request<FileRoot[]>('/files/roots', { signal }),
  list: (root: string, path: string, signal?: AbortSignal) => request<ListResult>('/files/list', { query: { root, path }, signal }),
  stat: (root: string, path: string, signal?: AbortSignal) => request<FileEntry>('/files/stat', { query: { root, path }, signal }),
  search: (root: string, q: string, path: string, signal?: AbortSignal) =>
    request<SearchResult>('/files/search', { query: { root, q, path }, signal }),
  usage: (root: string, path: string, signal?: AbortSignal) => request<UsageResult>('/files/usage', { query: { root, path }, signal }),
  versions: (root: string, path: string, signal?: AbortSignal) =>
    request<{ versions: FileVersion[] }>('/files/versions', { query: { root, path }, signal }),
  preview: (root: string, path: string, signal?: AbortSignal) => request<FilePreview>('/files/preview', { query: { root, path }, signal }),
  history: (root: string | undefined, limit = 200, signal?: AbortSignal) =>
    request<FileEvent[]>('/files/history', { query: { root, limit }, signal }),
  downloadUrl: (root: string, path: string) => buildUrl('/files/download', { root, path }),
  mkdir: (root: string, path: string) => request<{ path: string }>('/files/mkdir', { method: 'POST', body: { root, path } }),
  rename: (root: string, path: string, dest: string, overwrite = false) =>
    request<MoveResult>('/files/rename', { method: 'POST', body: { root, path, dest, overwrite } }),
  move: (root: string, path: string, dest: string, overwrite = false) =>
    request<MoveResult>('/files/move', { method: 'POST', body: { root, path, dest, overwrite } }),
  copy: (root: string, path: string, dest: string, overwrite = false) =>
    request<MoveResult>('/files/copy', { method: 'POST', body: { root, path, dest, overwrite } }),
  remove: (root: string, path: string, recursive: boolean) =>
    request<{ deleted: string }>('/files', { method: 'DELETE', query: { root, path, recursive, confirm: true } }),
  saveText: (root: string, path: string, content: string) =>
    request<WriteResult>('/files/text', { method: 'PUT', body: { root, path, content } }),
  transfer: (src_root: string, src_path: string, dst_root: string, dst_path: string, overwrite = false) =>
    request<TransferResult>('/files/transfer', { method: 'POST', body: { src_root, src_path, dst_root, dst_path, overwrite } }),
};

/** Builds an ApiError from a raw XHR response using the host's {error:{code,message}} envelope. */
export function xhrError(status: number, body: string, requestId: string | null): ApiError {
  try {
    const j = JSON.parse(body) as { error?: { code?: unknown; message?: unknown; details?: unknown }; request_id?: string };
    if (j && j.error && typeof j.error === 'object') {
      const code = typeof j.error.code === 'string' ? j.error.code : `http_${status}`;
      const message = typeof j.error.message === 'string' && j.error.message ? j.error.message : `HTTP ${status}`;
      const details = (j.error.details && typeof j.error.details === 'object' ? j.error.details : {}) as Record<string, unknown>;
      return new ApiError(status, code, message, details, j.request_id ?? requestId);
    }
  } catch {
    // not JSON
  }
  return new ApiError(status, `http_${status}`, body.trim().slice(0, 300) || `HTTP ${status}`, {}, requestId);
}

export interface UploadOptions {
  overwrite?: boolean;
  onProgress?: (loaded: number, total: number) => void;
  signal?: AbortSignal;
}

export interface XhrUploadOptions {
  onProgress?: (loaded: number, total: number) => void;
  signal?: AbortSignal;
  /** Omitted for FormData (the browser sets the multipart boundary). */
  contentType?: string;
}

/**
 * POST with upload progress (XMLHttpRequest) through the current transport (cookie + CSRF, or the Mini App's Bearer
 * token): {data} envelope, host error envelope, one retry after a step-up confirmation, 401 handling.
 */
export function xhrUpload<T>(url: string, body: XMLHttpRequestBodyInit, opts: XhrUploadOptions = {}): Promise<T> {
  const t = getTransport();
  const once = () =>
    new Promise<T>((resolve, reject) => {
      if (opts.signal?.aborted) {
        reject(new DOMException('Upload cancelled', 'AbortError'));
        return;
      }
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url);
      xhr.withCredentials = t.credentials !== 'omit';
      xhr.setRequestHeader('Accept', 'application/json');
      if (opts.contentType) xhr.setRequestHeader('Content-Type', opts.contentType);
      for (const [k, v] of Object.entries(t.headers('POST'))) xhr.setRequestHeader(k, v);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) opts.onProgress?.(e.loaded, e.total);
      };
      const onAbort = () => xhr.abort();
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      const done = () => opts.signal?.removeEventListener('abort', onAbort);
      xhr.onload = () => {
        done();
        const rid = xhr.getResponseHeader('x-request-id');
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const j = JSON.parse(xhr.responseText) as { data?: T };
            if (j && typeof j === 'object' && j.data) resolve(j.data);
            else reject(new ApiError(xhr.status, 'bad_envelope', 'The host response is missing the {data} envelope', {}, rid));
          } catch {
            reject(new ApiError(xhr.status, 'bad_response', 'The host returned a response that is not JSON', {}, rid));
          }
        } else reject(xhrError(xhr.status, xhr.responseText, rid));
      };
      xhr.onerror = () => {
        done();
        reject(new ApiError(0, 'network_error', 'Upload failed: cannot reach the NEBULA host service'));
      };
      xhr.onabort = () => {
        done();
        reject(new DOMException('Upload cancelled', 'AbortError'));
      };
      xhr.send(body);
    });
  const sentAt = Date.now();
  return once().catch(async (e: unknown) => {
    let err = e;
    if (t.onStepUp && isStepUpError(err) && (await t.onStepUp(err, sentAt))) {
      try {
        return await once();
      } catch (again) {
        err = again;
      }
    }
    if (err instanceof ApiError && err.status === 401) t.onUnauthorized?.(err);
    throw err;
  });
}

/** POST /files/upload with the raw file as body (the host streams it into the root). */
export function uploadFile(root: string, path: string, file: Blob, opts: UploadOptions = {}): Promise<WriteResult> {
  return xhrUpload<WriteResult>(buildUrl('/files/upload', { root, path, overwrite: opts.overwrite ? true : undefined }), file, {
    onProgress: opts.onProgress,
    signal: opts.signal,
    contentType: 'application/octet-stream',
  });
}
