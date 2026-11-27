// Attachment upload with progress: multipart field `file` to POST /agents/{id}/attachments (the server sniffs the
// type, extracts text and transcribes audio when speech-to-text is configured). XMLHttpRequest, because fetch() has no
// upload progress; same Bearer / CSRF headers, {data} envelope and 401 handling as the Mini App client.
import { ApiError, buildUrl, parseError } from '../../lib/http';
import type { Envelope } from '../../types';
import type { MiniClient } from '../client';
import type { Attachment } from '../types';

export interface UploadOptions {
  onProgress?: (loaded: number, total: number) => void;
  signal?: AbortSignal;
}

export function uploadForm<T>(client: MiniClient, path: string, formData: FormData, opts: UploadOptions = {}): Promise<T> {
  if (typeof XMLHttpRequest === 'undefined') return client.request<T>(path, { method: 'POST', formData, signal: opts.signal });
  return new Promise<T>((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new DOMException('aborted', 'AbortError'));
      return;
    }
    const xhr = new XMLHttpRequest();
    xhr.open('POST', buildUrl(path));
    for (const [k, v] of Object.entries(client.headers('POST'))) xhr.setRequestHeader(k, v);
    xhr.withCredentials = client.mode !== 'telegram';
    if (opts.onProgress && xhr.upload) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) opts.onProgress?.(e.loaded, e.total);
      };
    }
    const onAbort = () => xhr.abort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const done = () => opts.signal?.removeEventListener('abort', onAbort);
    xhr.onabort = () => {
      done();
      reject(new DOMException('aborted', 'AbortError'));
    };
    xhr.onerror = () => {
      done();
      reject(new ApiError(0, 'network_error', 'Cannot reach NEBULA (upload interrupted)'));
    };
    xhr.onload = () => {
      done();
      const text = typeof xhr.responseText === 'string' ? xhr.responseText : '';
      if (xhr.status < 200 || xhr.status >= 300) {
        void parseError(new Response(text, { status: xhr.status >= 200 ? xhr.status : 500, headers: { 'Content-Type': 'application/json' } })).then((err) => {
          if (xhr.status === 401) client.invalidate(err);
          reject(err);
        });
        return;
      }
      try {
        const j = JSON.parse(text) as Envelope<T>;
        if (!j || typeof j !== 'object' || !('data' in j)) throw new Error('envelope');
        resolve(j.data);
      } catch {
        reject(new ApiError(xhr.status, 'bad_envelope', 'The upload response is missing the {data} envelope'));
      }
    };
    xhr.send(formData);
  });
}

export function uploadAttachment(client: MiniClient, agentId: string, file: File, opts: UploadOptions = {}): Promise<Attachment> {
  const fd = new FormData();
  fd.append('file', file, file.name);
  return uploadForm<Attachment>(client, `/agents/${encodeURIComponent(agentId)}/attachments`, fd, opts);
}

