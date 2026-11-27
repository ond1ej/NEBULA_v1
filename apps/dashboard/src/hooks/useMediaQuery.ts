import { useSyncExternalStore } from 'react';

function query(q: string): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
  return window.matchMedia(q);
}

/** Live media query (false where matchMedia is unavailable, e.g. jsdom). */
export function useMediaQuery(q: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = query(q);
      if (!m) return () => {};
      m.addEventListener?.('change', cb);
      return () => m.removeEventListener?.('change', cb);
    },
    () => query(q)?.matches ?? false,
    () => false,
  );
}

/** Phone layout (< 768 px): tables become cards, dialogs become sheets. */
export function useIsMobile(): boolean {
  return useMediaQuery('(max-width: 767.98px)');
}

export function usePrefersReducedMotion(): boolean {
  return useMediaQuery('(prefers-reduced-motion: reduce)');
}
