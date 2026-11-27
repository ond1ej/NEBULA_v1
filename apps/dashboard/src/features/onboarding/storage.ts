// Per-browser memory of the first-run checklist: dismissed, and "Live Desktop was opened" (no API records that).
// Storage can be blocked (private window, embedded view): every access is guarded and the checklist still works.
const DISMISSED = 'nebula.onboarding.dismissed';
const LIVE_OPENED = 'nebula.onboarding.liveDesktop';

function get(key: string): boolean {
  try {
    return globalThis.localStorage?.getItem(key) === '1';
  } catch {
    return false;
  }
}

function set(key: string, on: boolean): void {
  try {
    if (on) globalThis.localStorage?.setItem(key, '1');
    else globalThis.localStorage?.removeItem(key);
  } catch {
    // not remembered
  }
}

export const readDismissed = (): boolean => get(DISMISSED);
export const writeDismissed = (v: boolean): void => set(DISMISSED, v);
export const readLiveOpened = (): boolean => get(LIVE_OPENED);
export const writeLiveOpened = (v: boolean): void => set(LIVE_OPENED, v);
