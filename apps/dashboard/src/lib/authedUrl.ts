// Authenticated binary URLs (task screenshots, attachment previews, file downloads) for <img src> and <a href>.
//
// With the Dashboard's cookie transport an /api/v1 URL works as is. With a Bearer transport (Dashboard pages inside the
// Telegram Mini App) the browser cannot attach the token to <img src> / <a href>, so the bytes are fetched with the
// transport and shown through an object URL, revoked when the component unmounts or the URL changes.
import { useEffect, useState, type MouseEvent } from 'react';
import { downloadBlob } from './format';
import { API_BASE, getTransport, requestBlob } from './http';

/** True when /api/v1 URLs can be used directly (cookie session). */
export const directUrls = (): boolean => getTransport().kind === 'cookie';

const relative = (url: string) => (url.startsWith(`${API_BASE}/`) ? url.slice(API_BASE.length) : url);

/** Fetches an /api/v1 URL through the current transport (errors as ApiError; step-up and 401 handled). */
export async function fetchAuthedBlob(url: string, signal?: AbortSignal): Promise<Blob> {
  return (await requestBlob(relative(url), { signal })).blob;
}

/**
 * `url` itself with a cookie session; otherwise an object URL of the fetched bytes (null while loading or after an
 * error: render a placeholder).
 */
export function useAuthedUrl(url: string | null): string | null {
  const direct = directUrls();
  const [obj, setObj] = useState<{ url: string; src: string } | null>(null);
  useEffect(() => {
    if (direct || !url) return;
    const ctl = new AbortController();
    let made: string | null = null;
    fetchAuthedBlob(url, ctl.signal).then(
      (blob) => {
        if (ctl.signal.aborted) return;
        made = URL.createObjectURL(blob);
        setObj({ url, src: made });
      },
      () => undefined, // shown as a placeholder; the step-up / session handling already happened in requestBlob
    );
    return () => {
      ctl.abort();
      if (made) URL.revokeObjectURL(made);
    };
  }, [direct, url]);
  if (direct) return url;
  return obj && obj.url === url ? obj.src : null;
}

/**
 * Props for a link to an authenticated file: the plain URL with a cookie session; otherwise a click downloads the
 * fetched bytes as `filename` (`onError` gets a failed download).
 */
export function authedLinkProps(url: string, filename: string, onError?: (e: unknown) => void): { href: string; onClick?: (e: MouseEvent<HTMLAnchorElement>) => void } {
  if (directUrls()) return { href: url };
  return {
    href: url,
    onClick: (e) => {
      e.preventDefault();
      fetchAuthedBlob(url).then((blob) => downloadBlob(blob, filename), (err: unknown) => onError?.(err));
    },
  };
}
