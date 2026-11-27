// Typed, feature-detected access to Telegram.WebApp (https://core.telegram.org/bots/webapps).
// Everything here is a no-op outside Telegram, so the Mini App also runs in a normal mobile browser.
// Only documented WebApp APIs are used. Colours: see theme.ts (NEBULA keeps its own palette).

export interface TgInsets {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface TgThemeParams {
  bg_color?: string;
  text_color?: string;
  hint_color?: string;
  link_color?: string;
  button_color?: string;
  button_text_color?: string;
  secondary_bg_color?: string;
  header_bg_color?: string;
  bottom_bar_bg_color?: string;
  accent_text_color?: string;
  section_bg_color?: string;
  section_header_text_color?: string;
  section_separator_color?: string;
  subtitle_text_color?: string;
  destructive_text_color?: string;
}

interface TgButton {
  isVisible?: boolean;
  show(): void;
  hide(): void;
  onClick(cb: () => void): void;
  offClick(cb: () => void): void;
}

/** Telegram.WebApp.BiometricManager (Bot API 7.2+). The token it stores never leaves the device's secure storage. */
export interface TgBiometricManager {
  isInited: boolean;
  isBiometricAvailable: boolean;
  biometricType?: 'finger' | 'face' | 'unknown';
  isAccessRequested?: boolean;
  isAccessGranted: boolean;
  isBiometricTokenSaved: boolean;
  deviceId?: string;
  init(callback?: () => void): unknown;
  requestAccess(params: { reason?: string }, callback?: (granted: boolean) => void): unknown;
  authenticate(params: { reason?: string }, callback?: (authenticated: boolean, token?: string) => void): unknown;
  updateBiometricToken(token: string, callback?: (updated: boolean) => void): unknown;
  openSettings?(): unknown;
}

export interface TgWebApp {
  initData: string;
  initDataUnsafe?: { user?: { id: number; first_name?: string; username?: string }; start_param?: string };
  version?: string;
  platform?: string;
  colorScheme?: 'light' | 'dark';
  themeParams?: TgThemeParams;
  isExpanded?: boolean;
  viewportHeight?: number;
  viewportStableHeight?: number;
  safeAreaInset?: TgInsets;
  contentSafeAreaInset?: TgInsets;
  isFullscreen?: boolean;
  BackButton?: TgButton;
  BiometricManager?: TgBiometricManager;
  HapticFeedback?: {
    impactOccurred(style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft'): void;
    notificationOccurred(type: 'error' | 'success' | 'warning'): void;
    selectionChanged(): void;
  };
  ready?(): void;
  expand?(): void;
  close?(): void;
  isVersionAtLeast?(version: string): boolean;
  setHeaderColor?(color: string): void;
  setBackgroundColor?(color: string): void;
  setBottomBarColor?(color: string): void;
  enableClosingConfirmation?(): void;
  disableClosingConfirmation?(): void;
  enableVerticalSwipes?(): void;
  disableVerticalSwipes?(): void;
  onEvent?(event: string, cb: () => void): void;
  offEvent?(event: string, cb: () => void): void;
  openLink?(url: string): void;
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TgWebApp };
  }
}

export function getWebApp(): TgWebApp | null {
  if (typeof window === 'undefined') return null;
  return window.Telegram?.WebApp ?? null;
}

/** True only when launched by Telegram (the bridge script also loads in normal browsers, with empty initData). */
export function isInTelegram(wa: TgWebApp | null = getWebApp()): boolean {
  return Boolean(wa && typeof wa.initData === 'string' && wa.initData.length > 0);
}

export function supports(wa: TgWebApp | null, version: string): boolean {
  if (!wa || typeof wa.isVersionAtLeast !== 'function') return false;
  try {
    return wa.isVersionAtLeast(version);
  } catch {
    return false;
  }
}

function call(fn: (() => void) | undefined): void {
  if (!fn) return;
  try {
    fn();
  } catch (e) {
    console.warn('NEBULA: Telegram WebApp call failed', e);
  }
}

// ---------------------------------------------------------------- viewport & safe areas
/**
 * Publishes --mini-vh (stable visible height), --mini-vh-live (current height: shrinks with the Android keyboard)
 * and --mini-tg-inset-* so the layout respects notches, Telegram's header and fullscreen mode. Outside Telegram the
 * CSS falls back to 100dvh and env(safe-area-inset-*).
 */
export function applyViewport(wa: TgWebApp | null, root: HTMLElement = document.documentElement): void {
  const inTg = isInTelegram(wa);
  const stable = inTg ? wa?.viewportStableHeight : undefined;
  if (stable && stable > 0) root.style.setProperty('--mini-vh', `${stable}px`);
  else root.style.removeProperty('--mini-vh');
  const live = inTg ? wa?.viewportHeight : undefined;
  if (live && live > 0) root.style.setProperty('--mini-vh-live', `${live}px`);
  else root.style.removeProperty('--mini-vh-live');
  const safe = inTg ? wa?.safeAreaInset : undefined;
  const content = inTg ? wa?.contentSafeAreaInset : undefined;
  for (const side of ['top', 'bottom', 'left', 'right'] as const) {
    const px = (safe?.[side] ?? 0) + (content?.[side] ?? 0);
    root.style.setProperty(`--mini-tg-inset-${side}`, `${px}px`);
  }
}

/** Current visible height (Telegram viewportHeight, else the visual viewport / window). */
export function liveViewportHeight(wa: TgWebApp | null = getWebApp()): number {
  const vv = typeof window !== 'undefined' ? window.visualViewport : null;
  const candidates = [vv?.height, window.innerHeight, isInTelegram(wa) ? wa?.viewportHeight : undefined].filter(
    (n): n is number => typeof n === 'number' && n > 0,
  );
  return candidates.length ? Math.min(...candidates) : 0;
}

export type Haptic = 'impact' | 'heavy' | 'success' | 'error' | 'warning' | 'selection';

export function haptic(kind: Haptic, wa: TgWebApp | null = getWebApp()): void {
  const h = isInTelegram(wa) && supports(wa, '6.1') ? wa?.HapticFeedback : undefined;
  if (!h) return;
  try {
    if (kind === 'impact') h.impactOccurred('light');
    else if (kind === 'heavy') h.impactOccurred('medium');
    else if (kind === 'selection') h.selectionChanged();
    else h.notificationOccurred(kind);
  } catch {
    // haptics are best effort
  }
}

/** One-time setup when the Mini App boots: ready(), expand(), viewport / safe areas and their change events. */
export function initTelegram(wa: TgWebApp | null = getWebApp()): () => void {
  applyViewport(wa);
  if (!isInTelegram(wa) || !wa) return () => {};
  call(() => wa.ready?.());
  if (wa.isExpanded !== true) call(() => wa.expand?.());
  const onViewport = () => applyViewport(wa);
  const events: [string, () => void][] = [
    ['viewportChanged', onViewport],
    ['safeAreaChanged', onViewport],
    ['contentSafeAreaChanged', onViewport],
    ['fullscreenChanged', onViewport],
  ];
  for (const [e, cb] of events) call(() => wa.onEvent?.(e, cb));
  return () => {
    for (const [e, cb] of events) call(() => wa.offEvent?.(e, cb));
  };
}

/** Telegram's native BackButton; returns a cleanup. Hidden when `onBack` is null. */
export function bindBackButton(onBack: (() => void) | null, wa: TgWebApp | null = getWebApp()): () => void {
  const b = isInTelegram(wa) && supports(wa, '6.1') ? wa?.BackButton : undefined;
  if (!b) return () => {};
  if (!onBack) {
    call(() => b.hide());
    return () => {};
  }
  const cb = () => onBack();
  call(() => b.onClick(cb));
  call(() => b.show());
  return () => {
    call(() => b.offClick(cb));
  };
}

export function setClosingConfirmation(on: boolean, wa: TgWebApp | null = getWebApp()): void {
  if (!isInTelegram(wa) || !supports(wa, '6.2')) return;
  call(() => (on ? wa?.enableClosingConfirmation?.() : wa?.disableClosingConfirmation?.()));
}

/** Vertical swipes minimise the Mini App; gestures on the Live Desktop / chat scroller must not trigger that. */
export function setVerticalSwipes(on: boolean, wa: TgWebApp | null = getWebApp()): void {
  if (!isInTelegram(wa) || !supports(wa, '7.7')) return;
  call(() => (on ? wa?.enableVerticalSwipes?.() : wa?.disableVerticalSwipes?.()));
}

/** Opens an external link (Telegram's in-app browser when available, else a new tab). Only http(s). */
export function openExternal(url: string, wa: TgWebApp | null = getWebApp()): void {
  if (!/^https?:\/\//i.test(url)) return;
  if (isInTelegram(wa) && wa?.openLink) {
    call(() => wa.openLink?.(url));
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}
