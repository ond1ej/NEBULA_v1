// Appearance of the Mini App: System / Dark / Light (Settings → Appearance), stored in localStorage
// `nebula.mini.theme`. "System" follows Telegram's colorScheme (+ themeChanged) inside Telegram and
// prefers-color-scheme in a normal browser. NEBULA keeps its own palette (mini.css tokens under
// :root / :root[data-theme='light']); Telegram's header / background / bottom bar are tinted to match.
import { useSyncExternalStore } from 'react';
import { getWebApp, isInTelegram, supports, type TgWebApp } from './telegram';

export type ThemeMode = 'system' | 'dark' | 'light';
export type Scheme = 'dark' | 'light';

export const THEME_KEY = 'nebula.mini.theme';

/** Background colours of the two palettes (must match --nb-bg in mini.css). */
export const SCHEME_BG: Record<Scheme, string> = { dark: '#101114', light: '#F7F8FA' };
/** Surface colours (tab bar / bottom bar). */
export const SCHEME_SURFACE: Record<Scheme, string> = { dark: '#191B20', light: '#FFFFFF' };

const MODES: ThemeMode[] = ['system', 'dark', 'light'];

function readStored(): ThemeMode {
  try {
    const v = window.localStorage.getItem(THEME_KEY);
    return MODES.includes(v as ThemeMode) ? (v as ThemeMode) : 'system';
  } catch {
    return 'system';
  }
}

let mode: ThemeMode | null = null;
const listeners = new Set<() => void>();

export function getThemeMode(): ThemeMode {
  if (mode === null) mode = readStored();
  return mode;
}

function systemPrefersLight(): boolean {
  try {
    return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: light)').matches;
  } catch {
    return false;
  }
}

/** The palette a mode resolves to right now. */
export function resolveScheme(m: ThemeMode = getThemeMode(), wa: TgWebApp | null = getWebApp()): Scheme {
  if (m === 'dark' || m === 'light') return m;
  if (isInTelegram(wa) && (wa?.colorScheme === 'light' || wa?.colorScheme === 'dark')) return wa.colorScheme;
  return systemPrefersLight() ? 'light' : 'dark';
}

function call(fn: () => void): void {
  try {
    fn();
  } catch {
    // Telegram chrome colours are cosmetic
  }
}

/** Applies the resolved palette to <html> (data-theme, color-scheme, theme-color) and Telegram's chrome. */
export function applyTheme(wa: TgWebApp | null = getWebApp(), root: HTMLElement = document.documentElement): Scheme {
  const scheme = resolveScheme(getThemeMode(), wa);
  root.dataset.theme = scheme;
  root.classList.toggle('dark', scheme === 'dark');
  root.style.colorScheme = scheme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', SCHEME_BG[scheme]);
  if (isInTelegram(wa) && wa) {
    if (supports(wa, '6.1')) {
      call(() => wa.setHeaderColor?.(SCHEME_BG[scheme]));
      call(() => wa.setBackgroundColor?.(SCHEME_BG[scheme]));
    }
    if (supports(wa, '7.10')) call(() => wa.setBottomBarColor?.(SCHEME_SURFACE[scheme]));
  }
  return scheme;
}

export function setThemeMode(next: ThemeMode, wa: TgWebApp | null = getWebApp()): void {
  mode = next;
  try {
    if (next === 'system') window.localStorage.removeItem(THEME_KEY);
    else window.localStorage.setItem(THEME_KEY, next);
  } catch {
    // private mode: the choice lasts for this session
  }
  applyTheme(wa);
  for (const l of [...listeners]) l();
}

/** Applies the theme now and follows Telegram themeChanged / prefers-color-scheme while mode = system. */
export function initTheme(wa: TgWebApp | null = getWebApp()): () => void {
  mode = readStored();
  applyTheme(wa);
  const onChange = () => {
    if (getThemeMode() === 'system') {
      applyTheme(wa);
      for (const l of [...listeners]) l();
    }
  };
  let mq: MediaQueryList | null = null;
  try {
    mq = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: light)') : null;
  } catch {
    mq = null;
  }
  mq?.addEventListener?.('change', onChange);
  if (isInTelegram(wa)) call(() => wa?.onEvent?.('themeChanged', onChange));
  return () => {
    mq?.removeEventListener?.('change', onChange);
    if (isInTelegram(wa)) call(() => wa?.offEvent?.('themeChanged', onChange));
  };
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** [mode, resolved scheme] for the Appearance screen. */
export function useTheme(): { mode: ThemeMode; scheme: Scheme } {
  const snap = useSyncExternalStore(
    subscribe,
    () => `${getThemeMode()}|${document.documentElement.dataset.theme ?? 'dark'}`,
    () => 'system|dark',
  );
  const [m, s] = snap.split('|');
  return { mode: m as ThemeMode, scheme: s as Scheme };
}
