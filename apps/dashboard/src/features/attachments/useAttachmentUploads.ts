// Composer state for attachments: uploads start immediately (with progress), finished ones are sent as attachment_ids.
import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from '../../api';
import { formatBytes } from '../../lib/format';
import { attachmentsApi, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_TASK, type Attachment } from './api';

export type PendingStatus = 'uploading' | 'done' | 'error';

export interface PendingAttachment {
  key: number;
  name: string;
  size: number;
  mime: string;
  status: PendingStatus;
  loaded: number;
  attachment: Attachment | null;
  error: string | null;
}

let seq = 1;

/** Gives pasted screenshots (always "image.png") a recognisable unique name. */
export function namePasted(f: File): File {
  if (f.name && f.name !== 'image.png' && f.name !== 'image.jpeg') return f;
  const ext = (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
  try {
    return new File([f], `pasted-${stamp}.${ext}`, { type: f.type });
  } catch {
    return f;
  }
}

export function useAttachmentUploads(agentId: string) {
  const [items, setItems] = useState<PendingAttachment[]>([]);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const ctls = useRef(new Map<number, AbortController>());
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const map = ctls.current;
    return () => {
      mounted.current = false;
      for (const c of map.values()) c.abort();
      map.clear();
    };
  }, []);

  const patch = useCallback((key: number, p: Partial<PendingAttachment>) => {
    if (!mounted.current) return;
    setItems((xs) => xs.map((x) => (x.key === key ? { ...x, ...p } : x)));
  }, []);

  const start = useCallback(
    (key: number, file: File) => {
      const c = new AbortController();
      ctls.current.set(key, c);
      attachmentsApi
        .upload(agentId, file, { signal: c.signal, onProgress: (loaded) => patch(key, { loaded }) })
        .then((att) => patch(key, { status: 'done', attachment: att, loaded: file.size, error: null }))
        .catch((e: unknown) => {
          if (e instanceof DOMException && e.name === 'AbortError') return;
          patch(key, { status: 'error', error: errorMessage(e) });
        })
        .finally(() => ctls.current.delete(key));
    },
    [agentId, patch],
  );

  const add = useCallback(
    (files: File[]) => {
      if (files.length === 0) return;
      let room = MAX_ATTACHMENTS_PER_TASK - itemsRef.current.filter((x) => x.status !== 'error').length;
      const next: { item: PendingAttachment; file: File | null }[] = files.map((f) => {
        const error =
          f.size > MAX_ATTACHMENT_BYTES
            ? `Larger than ${formatBytes(MAX_ATTACHMENT_BYTES, 0)} (the upload limit).`
            : f.size === 0
              ? 'The file is empty.'
              : room <= 0
                ? `At most ${MAX_ATTACHMENTS_PER_TASK} attachments per task.`
                : null;
        if (!error) room -= 1;
        return {
          item: { key: seq++, name: f.name || 'file', size: f.size, mime: f.type, status: error ? 'error' : 'uploading', loaded: 0, attachment: null, error },
          file: error ? null : f,
        };
      });
      itemsRef.current = [...itemsRef.current, ...next.map((n) => n.item)];
      setItems((xs) => [...xs, ...next.map((n) => n.item)]);
      for (const { item, file } of next) if (file) start(item.key, file);
    },
    [start],
  );

  /** Removes a chip: cancels a running upload, deletes an uploaded (not yet sent) attachment on the host. */
  const remove = useCallback(
    (key: number) => {
      const it = items.find((x) => x.key === key);
      ctls.current.get(key)?.abort();
      setItems((xs) => xs.filter((x) => x.key !== key));
      if (it?.attachment && !it.attachment.task_id) void attachmentsApi.remove(it.attachment.id).catch(() => undefined);
    },
    [items],
  );

  /** After the task was created: the attachments now belong to it, so just forget the chips. */
  const clear = useCallback(() => setItems([]), []);

  const ready = items.filter((x) => x.status === 'done' && x.attachment).map((x) => x.attachment as Attachment);
  const uploading = items.some((x) => x.status === 'uploading');
  return { items, add, remove, clear, ready, readyIds: ready.map((a) => a.id), uploading };
}
