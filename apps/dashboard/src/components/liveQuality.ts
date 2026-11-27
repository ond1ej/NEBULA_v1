// noVNC picture quality for the Live Desktop.
//
// Measured on the VM (1280x800, Tight encoding through the NEBULA WebSocket), one full frame:
//   quality 9 / compression 2  ≈ 723 KB
//   quality 6 / compression 2  ≈ 237 KB   (noVNC default; the Dashboard keeps it)
//   quality 4 / compression 2  ≈ 164 KB   (Mini App default: a phone shows the desktop at ~375 px)
//   quality 2 / compression 6  ≈ 138 KB   (Mini App on a slow connection)
//
// "Auto" in the Mini App starts at 4/2 and steps down to 2/6 when the measured stream throughput stays below
// ~300 KB/s for a few seconds, and back up when it recovers. Throughput is demand-limited (a still screen sends
// almost nothing), so near-idle samples are no evidence either way and only reset the timers.

export interface VncQuality {
  qualityLevel: number;
  compressionLevel: number;
}

export type LiveQualityMode = 'auto' | 'high';

export const VNC_HIGH: VncQuality = { qualityLevel: 6, compressionLevel: 2 };
export const VNC_MOBILE: VncQuality = { qualityLevel: 4, compressionLevel: 2 };
export const VNC_LOW: VncQuality = { qualityLevel: 2, compressionLevel: 6 };

export interface AdaptiveConfig {
  /** Below this the link counts as slow (bytes/s). */
  slowBytesPerSec: number;
  /** Below this the stream counts as idle: the screen barely changes, so the rate says nothing about the link. */
  idleBytesPerSec: number;
  /** How long the stream must stay slow before quality drops (ms). */
  downAfterMs: number;
  /** How long it must stay fast again before quality goes back up (ms, longer: no flapping). */
  upAfterMs: number;
}

export const ADAPTIVE_DEFAULTS: AdaptiveConfig = {
  slowBytesPerSec: 300_000,
  idleBytesPerSec: 8_000,
  downAfterMs: 4_000,
  upAfterMs: 8_000,
};

export interface AdaptiveState {
  /** Quality is currently stepped down to VNC_LOW. */
  reduced: boolean;
  /** Start (ms) of the current streak of samples that argue for switching; null = no streak. */
  since: number | null;
}

export const ADAPTIVE_START: AdaptiveState = { reduced: false, since: null };

/** One stats sample in; the (possibly) new adaptive state out. Pure: unit tested. */
export function adaptQuality(state: AdaptiveState, sample: { bytesPerSec: number | null; at: number }, cfg: AdaptiveConfig = ADAPTIVE_DEFAULTS): AdaptiveState {
  const bps = sample.bytesPerSec;
  if (bps === null || !Number.isFinite(bps) || bps < cfg.idleBytesPerSec) return state.since === null ? state : { ...state, since: null };
  const slow = bps < cfg.slowBytesPerSec;
  const argueForSwitch = state.reduced ? !slow : slow;
  if (!argueForSwitch) return state.since === null ? state : { ...state, since: null };
  const since = state.since ?? sample.at;
  if (sample.at - since >= (state.reduced ? cfg.upAfterMs : cfg.downAfterMs)) return { reduced: !state.reduced, since: null };
  return since === state.since ? state : { ...state, since };
}

export function vncQualityFor(mode: LiveQualityMode, state: AdaptiveState): VncQuality {
  if (mode === 'high') return VNC_HIGH;
  return state.reduced ? VNC_LOW : VNC_MOBILE;
}

const STORAGE_KEY = 'nebula.live.quality';

/** Per-device preference (convenience only: falls back to Auto when storage is unavailable). */
export function loadQualityMode(): LiveQualityMode {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'high' ? 'high' : 'auto';
  } catch {
    return 'auto';
  }
}

export function saveQualityMode(mode: LiveQualityMode): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // private mode / blocked storage: the choice lasts for this view only
  }
}
