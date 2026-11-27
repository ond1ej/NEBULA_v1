// Downloads go through fetch for files up to 50 MiB so host errors are shown instead of saving an error page;
// larger files stream through a plain link (the browser shows its own error UI then). A link cannot carry the Mini
// App's Bearer token, so with that transport every download is fetched.
import { getTransport, requestBlob } from '../../api';
import { downloadBlob } from '../../lib/format';
import { filesApi } from './api';

export const FETCH_DOWNLOAD_LIMIT = 50 * 1024 * 1024;

export async function downloadFile(root: string, path: string, name: string, size: number): Promise<void> {
  if (size > FETCH_DOWNLOAD_LIMIT && getTransport().kind === 'cookie') {
    const a = document.createElement('a');
    a.href = filesApi.downloadUrl(root, path);
    a.download = name;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    return;
  }
  const r = await requestBlob('/files/download', { query: { root, path } });
  downloadBlob(r.blob, name);
}
