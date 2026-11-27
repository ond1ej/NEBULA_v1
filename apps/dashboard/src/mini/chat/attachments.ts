// Client-side checks that mirror the host's attachment intake (nebula_host/attachments.py + media.py): at most
// 50 MB per file through the web channel, executables and installers rejected. The server still re-checks everything.
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;

const BLOCKED_EXT = new Set([
  'exe', 'dll', 'msi', 'scr', 'com', 'bat', 'cmd', 'pif', 'app', 'dmg', 'pkg', 'jar', 'apk', 'ipa', 'deb', 'rpm', 'vbs', 'ps1', 'lnk', 'command', 'workflow',
]);
const BLOCKED_MIME = new Set([
  'application/x-msdownload',
  'application/x-msdos-program',
  'application/x-apple-diskimage',
  'application/vnd.android.package-archive',
  'application/x-executable',
  'application/x-mach-binary',
  'application/vnd.microsoft.portable-executable',
]);

export const extOf = (name: string) => (name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '');

/** null when the file may be uploaded, otherwise the reason shown on its chip. */
export function validateFile(f: { name: string; size: number; type: string }): string | null {
  if (f.size <= 0) return 'The file is empty';
  if (f.size > MAX_ATTACHMENT_BYTES) return 'Larger than 50 MB';
  if (BLOCKED_EXT.has(extOf(f.name)) || BLOCKED_MIME.has((f.type || '').toLowerCase())) return 'Executables and installers are not accepted';
  return null;
}

export type FileKind = 'image' | 'video' | 'audio' | 'file';

export function kindOf(name: string, mime: string | null | undefined, serverKind?: string | null): FileKind {
  const k = (serverKind ?? '').toLowerCase();
  if (/^voice\.(ogg|webm|m4a|mp4)$/i.test(name)) return 'audio'; // recorded in the composer (WebM / MP4 may be sniffed as video)
  if (k === 'image') return 'image';
  if (k === 'audio' || k === 'voice') return 'audio';
  if (k === 'video') return 'video';
  const m = (mime ?? '').toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('audio/')) return 'audio';
  if (m.startsWith('video/')) return 'video';
  const e = extOf(name);
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic'].includes(e)) return 'image';
  if (['ogg', 'oga', 'mp3', 'wav', 'm4a', 'flac', 'opus'].includes(e)) return 'audio';
  if (['mp4', 'mov', 'webm', 'mkv'].includes(e)) return 'video';
  return 'file';
}

/** Short type label for a chip ("PDF", "Image", "Voice"). */
export function typeLabel(name: string, mime: string | null | undefined, voice = false): string {
  if (voice) return 'Voice';
  const k = kindOf(name, mime);
  if (k === 'image') return 'Image';
  if (k === 'video') return 'Video';
  if (k === 'audio') return 'Audio';
  const e = extOf(name);
  return e ? e.toUpperCase().slice(0, 5) : 'File';
}
