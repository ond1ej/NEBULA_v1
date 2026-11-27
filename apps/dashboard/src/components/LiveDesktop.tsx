// Live Desktop (spec §8), shared by the Dashboard and the Telegram Mini App. Exact behaviour:
//  * never auto-connects: the page shows a neutral placeholder + Connect until the user clicks;
//  * Connect -> POST /agents/{id}/live/connect -> {session_id, token, ws_path} -> noVNC over the host's
//    authorized WebSocket proxy, read-only and scaled to fit (Mini App: the URL also carries the Mini App session);
//  * the one-time token lives only in a local variable (never in Web Storage or React state);
//  * Disconnect / unmount / route change / long time in the background -> rfb.disconnect() + DELETE /live/sessions/{sid};
//  * Take Control acquires the exclusive lease and renews it every 60 s; Release returns it. The controller (you,
//    the agent or another viewer) is always shown and follows `live.control.changed` events;
//  * touch: tap = click, double tap = double click, long press = right click, long press + move = drag,
//    two-finger drag = scroll wheel, pinch = local zoom, one-finger drag = pan the zoomed view;
//    a hidden input forwards the phone keyboard while you hold control;
//  * connection quality = API round-trip latency + bytes/s + frame updates/s (measured in the browser).
import { useCallback, useEffect, useRef, useState, type CompositionEvent, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { api, errorMessage, getTransport, isApiError, type BlobResult } from '../api';
import { useNebulaEvents } from '../hooks/useEvents';
import { href } from '../hooks/useHashRoute';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { formatBytes, formatRate, shortId } from '../lib/format';
import type { Agent, ControlResult, LiveConnect, LiveDisconnectResult, LiveSessions, Task } from '../types';
import { adaptQuality, ADAPTIVE_START, loadQualityMode, saveQualityMode, vncQualityFor, type AdaptiveState, type LiveQualityMode } from './liveQuality';
import { ConfirmDialog, Modal } from './Modal';
import { StatusPill } from './StatusPill';
import { useToast } from './Toast';
import {
  IconCamera,
  IconDownload,
  IconEye,
  IconFit,
  IconFullscreen,
  IconHand,
  IconMonitor,
  IconPause,
  IconPlay,
  IconPower,
  IconSearch,
  IconStop,
  IconSun,
  IconX,
} from './icons';
import { Button, buttonClass, Mono, Spinner } from './ui';

export interface RFBLike extends EventTarget {
  viewOnly: boolean;
  scaleViewport: boolean;
  resizeSession: boolean;
  clipViewport: boolean;
  background: string;
  focusOnClick?: boolean;
  disconnect(): void;
  focus(options?: FocusOptions): void;
  sendKey?(keysym: number, code: string | null, down?: boolean): void;
  sendCtrlAltDel?(): void;
  /** JPEG quality 0-9 (noVNC default 6) and zlib compression 0-9 (default 2); settable while connected. */
  qualityLevel?: number;
  compressionLevel?: number;
}

export type RFBConstructor = new (
  target: HTMLElement,
  url: string,
  options?: { wsProtocols?: string[]; shared?: boolean },
) => RFBLike;

/** noVNC is loaded on demand (it is only needed after Connect). */
export async function loadRFB(): Promise<RFBConstructor> {
  const mod = await import('@novnc/novnc');
  return mod.default as unknown as RFBConstructor;
}

/** Everything the viewer needs from the host; the Mini App passes a Bearer-token implementation. */
export interface LiveDesktopClient {
  connect(agentId: string): Promise<LiveConnect>;
  disconnect(sessionId: string, keepalive?: boolean): Promise<LiveDisconnectResult>;
  control(sessionId: string, action: 'acquire' | 'renew' | 'release'): Promise<ControlResult>;
  sessions(): Promise<LiveSessions>;
  pauseTask(taskId: string): Promise<Task>;
  resumeTask(taskId: string): Promise<Task>;
  stopTask(taskId: string): Promise<Task>;
  wake(agentId: string): Promise<Agent>;
  pauseAgent(agentId: string): Promise<Agent>;
  resumeAgent(agentId: string): Promise<Agent>;
  screenshot(agentId: string): Promise<BlobResult>;
  wsUrl(wsPath: string, token: string): string;
  /** WebSocket subprotocols requested by noVNC (default ['binary']; the server must echo a requested one). */
  wsProtocols?: string[];
}

export function wsUrl(wsPath: string, token: string, loc: Pick<Location, 'protocol' | 'host'> = window.location): string {
  const proto = loc.protocol === 'https:' ? 'wss' : 'ws';
  let url = `${proto}://${loc.host}${wsPath}?token=${encodeURIComponent(token)}`;
  // a Bearer transport (Dashboard pages inside the Mini App) authenticates the WebSocket with its session token
  for (const [k, v] of Object.entries(getTransport().wsParams?.() ?? {})) url += `&${encodeURIComponent(k)}=${encodeURIComponent(v)}`;
  return url;
}

/** Dashboard implementation (cookie session + CSRF). */
export const dashboardLiveClient: LiveDesktopClient = {
  connect: (agentId) => api.live.connect(agentId),
  disconnect: (sid, keepalive = false) => api.live.disconnect(sid, keepalive),
  control: (sid, action) => api.live.control(sid, action),
  sessions: () => api.live.sessions(),
  pauseTask: (id) => api.tasks.pause(id, 'smart'),
  resumeTask: (id) => api.tasks.resume(id),
  stopTask: (id) => api.tasks.stop(id, 'cancel'),
  wake: (id) => api.agents.wake(id),
  pauseAgent: (id) => api.agents.pause(id),
  resumeAgent: (id) => api.agents.resume(id),
  screenshot: (id) => api.agents.screenshot(id),
  wsUrl: (p, t) => wsUrl(p, t),
  // the Mini App gateway does not echo a WebSocket subprotocol (see mini/screens/DesktopScreen.tsx)
  get wsProtocols() {
    return getTransport().kind === 'bearer' ? [] : ['binary'];
  },
};

export type LivePhase = 'idle' | 'connecting' | 'viewing' | 'disconnecting' | 'disconnected' | 'error';
export type ControlHolder = 'you' | 'agent' | 'other' | 'none';
export type LiveHaptic = 'impact' | 'heavy' | 'success' | 'error' | 'selection';

const NOT_RUNNING = new Set(['SLEEP', 'STOPPED', 'CREATING', 'DELETING', 'ERROR']);
const BUSY_TASK = new Set(['RECEIVED', 'QUEUED', 'PLANNING', 'EXECUTING', 'VERIFYING', 'PAUSING', 'WAITING_APPROVAL', 'WAITING_PROVIDER']);
const RENEW_MS = 60_000;
const STATS_MS = 2_000;
const HIDDEN_DISCONNECT_MS = 60_000;
const CONNECT_TIMEOUT_MS = 20_000;
const VM_DOWN = new Set(['restarting', 'stopping', 'stopped', 'failed', 'unresponsive', 'error', 'starting']);

export interface LiveQuality {
  latencyMs: number | null;
  bytesPerSec: number | null;
  totalBytes: number | null;
  updatesPerSec: number | null;
}

const NO_QUALITY: LiveQuality = { latencyMs: null, bytesPerSec: null, totalBytes: null, updatesPerSec: null };

/** Connection quality from the API round-trip (the stream itself runs over the same host connection). */
export function qualityLabel(q: Pick<LiveQuality, 'latencyMs'>): { label: 'Good' | 'Fair' | 'Poor' | 'Measuring'; tone: string } {
  if (q.latencyMs === null) return { label: 'Measuring', tone: 'bg-subtle' };
  if (q.latencyMs < 150) return { label: 'Good', tone: 'bg-success' };
  if (q.latencyMs < 400) return { label: 'Fair', tone: 'bg-warn' };
  return { label: 'Poor', tone: 'bg-danger' };
}

const LEFT_REASONS: Record<string, string> = {
  user: 'closed by a user',
  stream_closed: 'the desktop stream ended (the agent desktop or the VM may have restarted)',
  never_opened: 'the stream did not open within 30 s',
  viewer_gone: 'the viewer connection was lost',
};

/** Counts completed framebuffer updates via noVNC's display flip (feature-detected; private API). */
function instrumentFrames(rfb: RFBLike, onFrame: () => void): boolean {
  const display = (rfb as unknown as { _display?: { flip?: (fromQueue?: boolean) => unknown } })._display;
  if (!display || typeof display.flip !== 'function') return false;
  const orig = display.flip.bind(display);
  display.flip = (fromQueue?: boolean) => {
    if (!fromQueue) onFrame();
    return orig(fromQueue);
  };
  return true;
}

/** Counts bytes received on noVNC's WebSocket (feature-detected; private API). */
function instrumentSocket(rfb: RFBLike, onBytes: (n: number) => void): boolean {
  const ws = (rfb as unknown as { _sock?: { _websocket?: EventTarget | null } })._sock?._websocket;
  if (!ws || typeof ws.addEventListener !== 'function') return false;
  ws.addEventListener('message', (e) => {
    const d = (e as MessageEvent).data as unknown;
    onBytes(d instanceof ArrayBuffer ? d.byteLength : d instanceof Blob ? d.size : typeof d === 'string' ? d.length : 0);
  });
  return true;
}

// ---------------------------------------------------------------- keyboard (X11 keysyms)
const KEYSYMS: Record<string, number> = {
  Backspace: 0xff08,
  Tab: 0xff09,
  Enter: 0xff0d,
  Escape: 0xff1b,
  Delete: 0xffff,
  Home: 0xff50,
  ArrowLeft: 0xff51,
  ArrowUp: 0xff52,
  ArrowRight: 0xff53,
  ArrowDown: 0xff54,
  PageUp: 0xff55,
  PageDown: 0xff56,
  End: 0xff57,
  Insert: 0xff63,
  F1: 0xffbe,
  F2: 0xffbf,
  F3: 0xffc0,
  F4: 0xffc1,
  F5: 0xffc2,
  F6: 0xffc3,
  F7: 0xffc4,
  F8: 0xffc5,
  F9: 0xffc6,
  F10: 0xffc7,
  F11: 0xffc8,
  F12: 0xffc9,
};
const KS_CONTROL = 0xffe3;
const KS_ALT = 0xffe9;
const KS_SUPER = 0xffeb;

/** Keysym for one character: Latin-1 maps 1:1, everything else uses the Unicode keysym range. */
export function keysymForChar(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  if (cp === 10 || cp === 13) return KEYSYMS.Enter;
  if (cp === 9) return KEYSYMS.Tab;
  if ((cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff)) return cp;
  return 0x01000000 | cp;
}

// ---------------------------------------------------------------- touch gestures
interface Pt {
  x: number;
  y: number;
}
const TAP_SLOP = 10;
const LONG_PRESS_MS = 500;
const DOUBLE_TAP_MS = 350;
const DOUBLE_TAP_SLOP = 30;
const PINCH_SLOP = 24;
const SCROLL_GAIN = 2;
const MAX_ZOOM = 4;

type Gesture =
  | { kind: 'tap'; start: Pt; last: Pt }
  | { kind: 'pan'; last: Pt }
  | { kind: 'hold'; start: Pt }
  | { kind: 'drag'; last: Pt }
  | { kind: 'two'; mode: 'pinch' | 'scroll' | 'pan' | null; c0: Pt; d0: number; last: Pt; z0: Zoom; anchor: Pt }
  | { kind: 'ignore' };

interface Zoom {
  z: number;
  x: number;
  y: number;
}

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

function touchPoints(list: TouchList | ArrayLike<{ clientX: number; clientY: number }>): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < list.length; i += 1) {
    const t = list[i];
    if (t) out.push({ x: t.clientX, y: t.clientY });
  }
  return out;
}

export function clampZoom(zm: Zoom, w: number, h: number): Zoom {
  const z = Math.max(1, Math.min(MAX_ZOOM, zm.z));
  const minX = w - w * z;
  const minY = h - h * z;
  return { z, x: Math.min(0, Math.max(minX, zm.x)), y: Math.min(0, Math.max(minY, zm.y)) };
}

// ---------------------------------------------------------------- component
export interface LiveDesktopProps {
  agent: Agent;
  onAgentChanged?: () => void;
  rfbLoader?: () => Promise<RFBConstructor>;
  /** API used by the viewer (default: the Dashboard's cookie session). */
  client?: LiveDesktopClient;
  /** 'compact' = phone / Mini App layout (big touch controls under the stage). */
  variant?: 'full' | 'compact';
  statsIntervalMs?: number;
  /** Disconnect after the page has been hidden this long (saves bandwidth; the agent keeps running). */
  hiddenDisconnectMs?: number;
  /** Give up when the WebSocket does not open in time (a tunnel that does not forward WebSockets hangs forever). */
  connectTimeoutMs?: number;
  haptics?: (kind: LiveHaptic) => void;
  onControlChange?: (inControl: boolean) => void;
  onStreamingChange?: (streaming: boolean) => void;
  /**
   * Phone viewer (Mini App): lighter picture by default (quality 4), adaptive step down to quality 2 / compression 6 on a
   * slow link, and a "Quality: Auto / High" toggle. Without it noVNC keeps its defaults (quality 6 / compression 2).
   */
  adaptiveQuality?: boolean;
}

export function LiveDesktop({
  agent,
  onAgentChanged,
  rfbLoader = loadRFB,
  client = dashboardLiveClient,
  variant = 'full',
  statsIntervalMs = STATS_MS,
  hiddenDisconnectMs = HIDDEN_DISCONNECT_MS,
  connectTimeoutMs = CONNECT_TIMEOUT_MS,
  haptics,
  onControlChange,
  onStreamingChange,
  adaptiveQuality = false,
}: LiveDesktopProps) {
  const toast = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const clientRef = useRef(client);
  clientRef.current = client;
  const hapticRef = useRef(haptics);
  hapticRef.current = haptics;
  const buzz = (k: LiveHaptic) => hapticRef.current?.(k);
  const coarse = useMediaQuery('(pointer: coarse)');
  const compact = variant === 'compact';
  const touchUi = compact || coarse;

  const [phase, setPhase] = useState<LivePhase>('idle');
  const [reason, setReason] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [control, setControl] = useState(false);
  const [holder, setHolder] = useState<ControlHolder>(() =>
    (agent as Agent & { control_held_by_user?: boolean }).control_held_by_user ? 'other' : agent.current_task && BUSY_TASK.has(agent.current_task.state) ? 'agent' : 'none',
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [fit, setFit] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [pseudoFs, setPseudoFs] = useState(false);
  const [stats, setStats] = useState<LiveQuality>(NO_QUALITY);
  const [shot, setShot] = useState<{ url: string; name: string; capturedAt: string | null } | null>(null);
  const [zoomLevel, setZoomLevel] = useState(1);
  const [kbOpen, setKbOpen] = useState(false);
  const [vmNotice, setVmNotice] = useState<string | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const [qualityMode, setQualityModeState] = useState<LiveQualityMode>(() => (adaptiveQuality ? loadQualityMode() : 'high'));
  const [reduced, setReduced] = useState(false);
  const qualityModeRef = useRef(qualityMode);
  qualityModeRef.current = qualityMode;
  const adaptiveRef = useRef<AdaptiveState>(ADAPTIVE_START);

  const containerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const zoomLayerRef = useRef<HTMLDivElement>(null);
  const kbRef = useRef<HTMLInputElement>(null);
  const rfbRef = useRef<RFBLike | null>(null);
  const sessionRef = useRef<string | null>(null);
  const renewRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const connectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statsRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const framesRef = useRef(0);
  const framesSupported = useRef(false);
  const bytesRef = useRef(0);
  const bytesSupported = useRef(false);
  const fitRef = useRef(fit);
  fitRef.current = fit;
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const controlRef = useRef(control);
  controlRef.current = control;
  const kbOpenRef = useRef(kbOpen);
  kbOpenRef.current = kbOpen;
  const zoomRef = useRef<Zoom>({ z: 1, x: 0, y: 0 });
  const mounted = useRef(true);
  const leftReason = useRef<string | null>(null);
  const vmNoticeRef = useRef<string | null>(null);
  vmNoticeRef.current = vmNotice;
  const expiredRef = useRef(false);

  const stopConnectTimer = () => {
    if (connectTimerRef.current) clearTimeout(connectTimerRef.current);
    connectTimerRef.current = null;
  };
  const stopRenew = () => {
    if (renewRef.current) clearInterval(renewRef.current);
    renewRef.current = null;
  };
  const stopStats = () => {
    if (statsRef.current) clearInterval(statsRef.current);
    statsRef.current = null;
  };

  /** Pushes the picture quality to noVNC (phone viewer only; the Dashboard keeps noVNC's defaults). */
  const applyQuality = (rfb: RFBLike | null) => {
    if (!adaptiveQuality || !rfb) return;
    const q = vncQualityFor(qualityModeRef.current, adaptiveRef.current);
    try {
      rfb.qualityLevel = q.qualityLevel;
      rfb.compressionLevel = q.compressionLevel;
    } catch (e) {
      console.warn('NEBULA: could not change the stream quality', e);
    }
  };

  const setQualityMode = (mode: LiveQualityMode) => {
    qualityModeRef.current = mode;
    adaptiveRef.current = ADAPTIVE_START;
    setQualityModeState(mode);
    setReduced(false);
    saveQualityMode(mode);
    applyQuality(rfbRef.current);
  };

  /** Ends the server-side viewer session (token is single-use, so every reconnect needs a new one). */
  const endSession = useCallback(async (sid: string, opts: { keepalive?: boolean; quiet?: boolean } = {}) => {
    try {
      await clientRef.current.disconnect(sid, opts.keepalive ?? false);
      return true;
    } catch (e) {
      if (isApiError(e) && e.status === 401) return false; // session already gone with the login
      if (!opts.quiet) toastRef.current.error(e, 'Could not close the live session on the host');
      else console.warn('NEBULA: live session cleanup failed', e);
      return false;
    }
  }, []);

  // ------------------------------------------------------------ zoom (layout-based, so noVNC maps coordinates itself)
  const paintZoom = useCallback((zm: Zoom) => {
    zoomRef.current = zm;
    const el = zoomLayerRef.current;
    if (!el) return;
    el.style.width = `${zm.z * 100}%`;
    el.style.height = `${zm.z * 100}%`;
    el.style.transform = zm.z === 1 ? '' : `translate3d(${zm.x}px, ${zm.y}px, 0)`;
  }, []);

  const setZoom = useCallback(
    (zm: Zoom) => {
      const s = stageRef.current;
      const w = s?.clientWidth || 0;
      const h = s?.clientHeight || 0;
      const c = w && h ? clampZoom(zm, w, h) : { z: Math.max(1, Math.min(MAX_ZOOM, zm.z)), x: 0, y: 0 };
      paintZoom(c);
      setZoomLevel(c.z);
    },
    [paintZoom],
  );

  const zoomBy = (factor: number) => {
    const s = stageRef.current;
    const cur = zoomRef.current;
    const w = s?.clientWidth ?? 0;
    const h = s?.clientHeight ?? 0;
    const z = Math.max(1, Math.min(MAX_ZOOM, cur.z * factor));
    // keep the centre of the view fixed
    const cx = w / 2;
    const cy = h / 2;
    setZoom({ z, x: cx - ((cx - cur.x) / cur.z) * z, y: cy - ((cy - cur.y) / cur.z) * z });
    buzz('selection');
  };

  // ------------------------------------------------------------ stats / quality
  const startStats = (sid: string) => {
    stopStats();
    let prev: { bytes: number; frames: number; local: number; t: number } | null = null;
    let reported = false;
    const tick = async () => {
      const t0 = performance.now();
      try {
        const s = await clientRef.current.sessions();
        if (sessionRef.current !== sid) return;
        const latency = performance.now() - t0;
        const mine = s.active_streams.find((x) => x.session_id === sid);
        const now = performance.now();
        const frames = framesRef.current;
        const local = bytesRef.current;
        const serverBytes = mine?.bytes_out ?? null;
        if (prev) {
          const dt = (now - prev.t) / 1000;
          const bytesDelta = bytesSupported.current ? local - prev.local : serverBytes !== null ? serverBytes - prev.bytes : null;
          const bytesPerSec = dt > 0 && bytesDelta !== null ? Math.max(0, bytesDelta / dt) : null;
          setStats({
            latencyMs: latency,
            bytesPerSec,
            totalBytes: bytesSupported.current ? local : serverBytes,
            updatesPerSec: framesSupported.current && dt > 0 ? (frames - prev.frames) / dt : null,
          });
          if (adaptiveQuality && qualityModeRef.current === 'auto') {
            const was = adaptiveRef.current;
            const next = adaptQuality(was, { bytesPerSec, at: now });
            adaptiveRef.current = next;
            if (next.reduced !== was.reduced) {
              setReduced(next.reduced);
              applyQuality(rfbRef.current);
            }
          }
        } else {
          setStats((st) => ({ ...st, latencyMs: latency, totalBytes: bytesSupported.current ? local : serverBytes }));
        }
        prev = { bytes: serverBytes ?? prev?.bytes ?? 0, frames, local, t: now };
        reported = false;
      } catch (e) {
        if (isApiError(e) && e.status === 401) {
          expire();
          return;
        }
        if (!reported) {
          reported = true;
          toastRef.current.error(e, 'Live stream statistics unavailable');
        }
      }
    };
    void tick();
    statsRef.current = setInterval(() => void tick(), statsIntervalMs);
  };

  const teardownLocal = () => {
    stopConnectTimer();
    stopRenew();
    stopStats();
    setControl(false);
    setKbOpen(false);
    setStats(NO_QUALITY);
  };

  /** The login (dashboard session / Mini App session) ended: stop streaming locally. */
  const expire = () => {
    if (expiredRef.current) return;
    expiredRef.current = true;
    const rfb = rfbRef.current;
    rfbRef.current = null;
    sessionRef.current = null;
    teardownLocal();
    if (rfb) {
      try {
        rfb.disconnect();
      } catch (e) {
        console.warn('NEBULA: noVNC disconnect failed', e);
      }
    }
    if (!mounted.current) return;
    setSessionId(null);
    setPhase('disconnected');
    setReason('Your NEBULA session expired. Sign in again (in Telegram: reopen the Mini App), then reconnect.');
  };

  const connect = async () => {
    if (rfbRef.current || phase === 'connecting') return;
    setPhase('connecting');
    setReason(null);
    leftReason.current = null;
    expiredRef.current = false;
    let sid: string;
    let wsPath: string;
    let token: string;
    try {
      const s = await clientRef.current.connect(agent.id);
      sid = s.session_id;
      wsPath = s.ws_path;
      token = s.token;
    } catch (e) {
      buzz('error');
      toast.error(e, 'Could not start the live session');
      setPhase('error');
      setReason(errorMessage(e));
      return;
    }
    sessionRef.current = sid;
    setSessionId(sid);
    if (!mounted.current) {
      void endSession(sid, { keepalive: true, quiet: true });
      return;
    }
    let RFB: RFBConstructor;
    try {
      RFB = await rfbLoader();
    } catch (e) {
      toast.error(e, 'Could not load the VNC viewer');
      setPhase('error');
      setReason(`VNC viewer failed to load: ${errorMessage(e)}`);
      sessionRef.current = null;
      setSessionId(null);
      await endSession(sid, { quiet: true });
      return;
    }
    const target = containerRef.current;
    if (!target || !mounted.current || sessionRef.current !== sid) {
      void endSession(sid, { keepalive: true, quiet: true });
      return;
    }
    let rfb: RFBLike;
    try {
      rfb = new RFB(target, clientRef.current.wsUrl(wsPath, token), { wsProtocols: clientRef.current.wsProtocols ?? ['binary'], shared: true });
    } catch (e) {
      toast.error(e, 'Could not open the desktop stream');
      setPhase('error');
      setReason(errorMessage(e));
      sessionRef.current = null;
      setSessionId(null);
      await endSession(sid, { quiet: true });
      return;
    }
    rfb.viewOnly = true;
    rfb.scaleViewport = fitRef.current;
    rfb.resizeSession = false;
    rfb.background = '#000000';
    adaptiveRef.current = ADAPTIVE_START;
    setReduced(false);
    applyQuality(rfb);
    rfbRef.current = rfb;
    framesRef.current = 0;
    bytesRef.current = 0;
    framesSupported.current = instrumentFrames(rfb, () => {
      framesRef.current += 1;
    });
    bytesSupported.current = instrumentSocket(rfb, (n) => {
      bytesRef.current += n;
    });

    stopConnectTimer();
    connectTimerRef.current = setTimeout(() => {
      connectTimerRef.current = null;
      if (rfbRef.current !== rfb || phaseRef.current === 'viewing') return;
      // noVNC has no connect timeout: tear down ourselves so the page never hangs on "Connecting…"
      rfbRef.current = null;
      sessionRef.current = null;
      teardownLocal();
      try {
        rfb.disconnect();
      } catch (e) {
        console.warn('NEBULA: noVNC disconnect failed', e);
      }
      void endSession(sid, { quiet: true });
      if (!mounted.current) return;
      setSessionId(null);
      setPhase('error');
      buzz('error');
      setReason(
        `The desktop stream did not open within ${Math.round(connectTimeoutMs / 1000)} s. The VM desktop may be starting, or the HTTPS tunnel / proxy in front of NEBULA does not forward WebSockets. Try again in a moment.`,
      );
    }, connectTimeoutMs);

    rfb.addEventListener('connect', () => {
      if (rfbRef.current !== rfb) return;
      stopConnectTimer();
      setPhase('viewing');
      buzz('success');
      startStats(sid);
    });
    rfb.addEventListener('disconnect', (ev) => {
      if (rfbRef.current !== rfb) return; // user-initiated disconnect already handled
      const clean = Boolean((ev as CustomEvent<{ clean?: boolean }>).detail?.clean);
      rfbRef.current = null;
      teardownLocal();
      const ownSid = sessionRef.current;
      sessionRef.current = null;
      setSessionId(null);
      if (!mounted.current) return;
      const left = leftReason.current;
      const why = left ? ` (host reason: ${LEFT_REASONS[left] ?? left.replace(/_/g, ' ')})` : '';
      const offline = typeof navigator !== 'undefined' && navigator.onLine === false ? ' Your device is offline.' : '';
      const vm = vmNoticeRef.current ? ` ${vmNoticeRef.current}` : '';
      const base = clean
        ? `The host closed the desktop stream${why}.${offline}${vm}`
        : `The desktop stream was interrupted or rejected by the host${why}. The viewer token is single-use; reconnect to open a new session.${offline}${vm}`;
      setPhase('disconnected');
      setReason(base);
      buzz('error');
      if (!ownSid) return;
      // noVNC does not expose the WebSocket close reason; the host records it as the session state.
      void (async () => {
        let extra: string | null = null;
        try {
          const s = await clientRef.current.sessions();
          const row = s.sessions.find((x) => x.id === ownSid);
          if (row?.state === 'ERROR_RETRYABLE') {
            extra = 'The host could not open this agent’s desktop (VNC tunnel unavailable). Check that the VM and the agent desktop are running, then reconnect.';
          } else if (row && row.expires_at < Date.now() / 1000 && row.state !== 'DISCONNECTED') {
            extra = 'The viewer session expired; reconnect to open a new one.';
          }
        } catch (e) {
          if (isApiError(e) && e.status === 401) extra = 'Your NEBULA session expired. Sign in again (in Telegram: reopen the Mini App).';
          else console.warn('NEBULA: could not read live session state', e);
        }
        await endSession(ownSid, { quiet: true });
        if (extra && mounted.current) setReason(`${base} ${extra}`);
      })();
    });
    rfb.addEventListener('securityfailure', (ev) => {
      const d = (ev as CustomEvent<{ status?: number; reason?: string }>).detail;
      leftReason.current = d?.reason ? `VNC security failure: ${d.reason}` : 'VNC security failure';
    });
    rfb.addEventListener('credentialsrequired', () => {
      leftReason.current = 'the desktop asked for VNC credentials, which NEBULA does not use';
      rfb.disconnect();
    });
  };

  const disconnect = async (why?: string) => {
    const rfb = rfbRef.current;
    const sid = sessionRef.current;
    setPhase('disconnecting');
    rfbRef.current = null;
    sessionRef.current = null;
    teardownLocal();
    if (rfb) {
      try {
        rfb.disconnect();
      } catch (e) {
        console.warn('NEBULA: noVNC disconnect failed', e);
      }
    }
    let ok = true;
    if (sid) ok = await endSession(sid, { quiet: Boolean(why) });
    if (!mounted.current) return;
    setSessionId(null);
    if (why) {
      setPhase('disconnected');
      setReason(why);
      return;
    }
    setPhase('idle');
    setReason(null);
    if (ok) toast.success('Live stream disconnected', 'The agent and its task keep running.');
  };
  const disconnectRef = useRef(disconnect);
  disconnectRef.current = disconnect;

  const startRenew = (sid: string) => {
    stopRenew();
    renewRef.current = setInterval(async () => {
      try {
        await clientRef.current.control(sid, 'renew');
      } catch (e) {
        stopRenew();
        if (rfbRef.current) rfbRef.current.viewOnly = true;
        setControl(false);
        if (isApiError(e) && e.status === 401) {
          expire();
          return;
        }
        toastRef.current.error(e, 'Control lease lost — the view is read-only again');
      }
    }, RENEW_MS);
  };

  const takeControl = async () => {
    const sid = sessionRef.current;
    if (!sid) return;
    setBusy('control');
    try {
      await clientRef.current.control(sid, 'acquire');
      if (sessionRef.current !== sid) return;
      const rfb = rfbRef.current;
      if (rfb) {
        rfb.viewOnly = false;
        if (!touchUi) rfb.focus();
      }
      setControl(true);
      setHolder('you');
      buzz('heavy');
      toast.success('You have control', 'The agent waits until you release control.');
      startRenew(sid);
    } catch (e) {
      buzz('error');
      toast.error(e, 'Could not take control');
    } finally {
      setBusy(null);
    }
  };

  const releaseControl = async () => {
    const sid = sessionRef.current;
    stopRenew();
    if (rfbRef.current) rfbRef.current.viewOnly = true;
    setControl(false);
    setKbOpen(false);
    kbRef.current?.blur();
    setHolder(agent.current_task ? 'agent' : 'none');
    if (!sid) return;
    setBusy('release');
    buzz('impact');
    try {
      await clientRef.current.control(sid, 'release');
      toast.success('Control released', 'The agent resumes from its last checkpoint with a fresh screenshot.');
    } catch (e) {
      toast.error(e, 'Release failed (the lease expires on its own)');
    } finally {
      setBusy(null);
    }
  };

  const task = agent.current_task;
  const runAction = async (key: string, fn: () => Promise<unknown>, success: (r: unknown) => [string, string?], errorTitle: string) => {
    setBusy(key);
    buzz('impact');
    try {
      const r = await fn();
      const [title, msg] = success(r);
      toast.success(title, msg);
      buzz('success');
      onAgentChanged?.();
      return true;
    } catch (e) {
      buzz('error');
      toast.error(e, errorTitle);
      return false;
    } finally {
      setBusy(null);
    }
  };
  const pauseTask = () =>
    task && runAction('pause', () => clientRef.current.pauseTask(task.id), (t) => ['Pause requested', `Task ${shortId((t as Task).id)} is ${(t as Task).state}.`], 'Pause failed');
  const resumeTask = () =>
    task && runAction('resume', () => clientRef.current.resumeTask(task.id), (t) => ['Task resumed', `Task ${shortId((t as Task).id)} is ${(t as Task).state}.`], 'Resume failed');
  const stopTask = async () => {
    if (!task) return;
    const ok = await runAction('stop', () => clientRef.current.stopTask(task.id), (t) => ['Stop requested', `Task ${shortId((t as Task).id)} is ${(t as Task).state}.`], 'Stop failed');
    if (ok) setConfirmStop(false);
  };
  const wake = () => runAction('wake', () => clientRef.current.wake(agent.id), () => ['Agent desktop started'], 'Wake failed');
  const pauseAgent = () => runAction('agent-pause', () => clientRef.current.pauseAgent(agent.id), () => ['Agent paused', 'Its current task pauses at the next safe point.'], 'Pause agent failed');
  const resumeAgent = () => runAction('agent-resume', () => clientRef.current.resumeAgent(agent.id), () => ['Agent resumed'], 'Resume agent failed');

  const screenshot = async () => {
    setBusy('shot');
    try {
      const r = await clientRef.current.screenshot(agent.id);
      const url = URL.createObjectURL(r.blob);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      // The previous object URL (if any) is revoked by the effect below when `shot` changes.
      setShot({ url, name: `${agent.name.replace(/[^\w.-]+/g, '_')}-${stamp}.png`, capturedAt: r.headers.get('x-captured-at') });
      buzz('success');
    } catch (e) {
      buzz('error');
      toast.error(e, 'Screenshot failed');
    } finally {
      setBusy(null);
    }
  };

  const toggleFit = () => {
    const next = !fit;
    setFit(next);
    setZoom({ z: 1, x: 0, y: 0 });
    if (rfbRef.current) rfbRef.current.scaleViewport = next;
  };

  const toggleFullscreen = async () => {
    if (pseudoFs) {
      setPseudoFs(false);
      return;
    }
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
        return;
      }
      const stage = stageRef.current;
      if (stage && document.fullscreenEnabled && typeof stage.requestFullscreen === 'function') await stage.requestFullscreen();
      else setPseudoFs(true); // iPhone WebViews (Telegram) have no element fullscreen
    } catch {
      setPseudoFs(true);
    }
  };

  // ------------------------------------------------------------ phone keyboard
  const sendKeysym = (keysym: number, code: string | null = null) => {
    const rfb = rfbRef.current;
    if (!rfb?.sendKey || !controlRef.current) return;
    rfb.sendKey(keysym, code);
  };
  const sendCombo = (mods: number[], keysym: number) => {
    const rfb = rfbRef.current;
    if (!rfb?.sendKey || !controlRef.current) return;
    for (const m of mods) rfb.sendKey(m, null, true);
    rfb.sendKey(keysym, null);
    for (const m of [...mods].reverse()) rfb.sendKey(m, null, false);
  };
  const sendText = (text: string) => {
    for (const ch of Array.from(text)) sendKeysym(keysymForChar(ch));
  };
  const toggleKeyboard = () => {
    if (kbOpen) {
      kbRef.current?.blur();
      setKbOpen(false);
      return;
    }
    // focus() must run inside the tap for iOS to show the keyboard
    kbRef.current?.focus({ preventScroll: true });
    setKbOpen(true);
    buzz('selection');
  };
  const onKbKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    const special = KEYSYMS[e.key];
    const mods = [e.ctrlKey ? KS_CONTROL : 0, e.altKey ? KS_ALT : 0, e.metaKey ? KS_SUPER : 0].filter(Boolean);
    if (special !== undefined) {
      e.preventDefault();
      if (mods.length) sendCombo(mods, special);
      else sendKeysym(special, e.code || null);
      return;
    }
    if (e.key.length === 1 || Array.from(e.key).length === 1) {
      e.preventDefault();
      if (mods.length) sendCombo(mods, keysymForChar(e.key.toLowerCase()));
      else sendKeysym(keysymForChar(e.key), e.code || null);
    }
  };
  const onKbInput = (e: FormEvent<HTMLInputElement>) => {
    const ne = e.nativeEvent as InputEvent;
    if (ne.isComposing) return;
    const type = ne.inputType ?? 'insertText';
    if (type === 'deleteContentBackward') sendKeysym(KEYSYMS.Backspace);
    else if (type === 'insertLineBreak' || type === 'insertParagraph') sendKeysym(KEYSYMS.Enter);
    else if (ne.data) sendText(ne.data);
    e.currentTarget.value = '';
  };
  const onKbCompositionEnd = (e: CompositionEvent<HTMLInputElement>) => {
    if (e.data) sendText(e.data);
    e.currentTarget.value = '';
  };

  // ------------------------------------------------------------ effects
  useEffect(() => {
    const onFs = () => {
      const on = document.fullscreenElement === stageRef.current && stageRef.current !== null;
      setFullscreen(on);
      setZoom({ z: 1, x: 0, y: 0 });
    };
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, [setZoom]);

  useEffect(() => {
    if (!pseudoFs) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPseudoFs(false);
    };
    window.addEventListener('keydown', onKey);
    setZoom({ z: 1, x: 0, y: 0 });
    return () => {
      window.removeEventListener('keydown', onKey);
      setZoom({ z: 1, x: 0, y: 0 });
    };
  }, [pseudoFs, setZoom]);

  useEffect(() => {
    onControlChange?.(control);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [control]);

  const live = phase === 'viewing';
  useEffect(() => {
    onStreamingChange?.(live);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live]);

  // Host-side events for this agent / session (and the VM all desktops live in).
  useNebulaEvents((ev) => {
    if (ev.type === 'vm.state.changed') {
      const st = String(ev.payload.state ?? '');
      const streaming = rfbRef.current !== null || phaseRef.current === 'connecting';
      if (VM_DOWN.has(st) && streaming) {
        setVmNotice(`The Ubuntu VM is ${st.replace(/_/g, ' ')}; reconnect once it is running again.`);
      } else if (st === 'running' && vmNoticeRef.current) {
        setVmNotice(rfbRef.current ? null : 'The Ubuntu VM is running again — you can reconnect now.');
      }
      return;
    }
    if (ev.agent_id !== agent.id) return;
    if (ev.type === 'live.viewer.left' && ev.payload.live_session_id === sessionRef.current) {
      leftReason.current = String(ev.payload.reason ?? '');
    }
    if (ev.type === 'live.control.changed') {
      const h = String(ev.payload.holder ?? '');
      if (h === 'user') {
        setHolder(ev.payload.live_session_id && ev.payload.live_session_id === sessionRef.current ? 'you' : controlRef.current ? 'you' : 'other');
      } else if (h === 'agent') {
        setHolder('agent');
        if (controlRef.current) {
          stopRenew();
          if (rfbRef.current) rfbRef.current.viewOnly = true;
          setControl(false);
          setKbOpen(false);
          toast.info('Control returned to the agent', 'The view is read-only again.');
        }
      }
    }
    if (ev.type === 'task.started' && !controlRef.current) setHolder('agent');
    if ((ev.type === 'task.completed' || ev.type === 'task.failed' || ev.type === 'task.cancelled') && !controlRef.current) setHolder('none');
  });

  // Unmount / route change / tab close: stop streaming and end the viewer session.
  useEffect(() => {
    mounted.current = true;
    const onPageHide = () => {
      const sid = sessionRef.current;
      if (sid) void clientRef.current.disconnect(sid, true).catch((e) => console.warn('NEBULA: live cleanup on pagehide failed', e));
    };
    window.addEventListener('pagehide', onPageHide);
    return () => {
      mounted.current = false;
      window.removeEventListener('pagehide', onPageHide);
      if (renewRef.current) clearInterval(renewRef.current);
      if (statsRef.current) clearInterval(statsRef.current);
      if (connectTimerRef.current) clearTimeout(connectTimerRef.current);
      const rfb = rfbRef.current;
      rfbRef.current = null;
      if (rfb) {
        try {
          rfb.disconnect();
        } catch (e) {
          console.warn('NEBULA: noVNC disconnect failed', e);
        }
      }
      const sid = sessionRef.current;
      sessionRef.current = null;
      if (sid) {
        clientRef.current.disconnect(sid, true).catch((e) => {
          if (!(isApiError(e) && e.status === 401)) toastRef.current.error(e, 'Could not close the live session on the host');
        });
      }
    };
  }, []);

  // Long time in the background (app switched, phone locked, Mini App minimised): stop streaming.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const clear = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    const onVis = () => {
      if (document.visibilityState === 'hidden') {
        if (!rfbRef.current && !sessionRef.current) return;
        clear();
        timer = setTimeout(() => {
          timer = null;
          if (document.visibilityState !== 'hidden' || (!rfbRef.current && !sessionRef.current)) return;
          void disconnectRef.current(
            `Disconnected after ${Math.round(hiddenDisconnectMs / 1000)} s in the background to save bandwidth. The agent keeps working; reconnect to watch again.`,
          );
        }, hiddenDisconnectMs);
      } else clear();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clear();
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [hiddenDisconnectMs]);

  useEffect(
    () => () => {
      if (shot) URL.revokeObjectURL(shot.url);
    },
    [shot],
  );

  // Touch → mouse / zoom. Capture-phase listeners on the stage run before noVNC's own touch handler on its canvas,
  // so phone gestures are interpreted here; desktop mouse and wheel input still go to noVNC unchanged.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    let g: Gesture | null = null;
    let holdTimer: ReturnType<typeof setTimeout> | null = null;
    let lastTap: { p: Pt; t: number } | null = null;
    const clearHold = () => {
      if (holdTimer) clearTimeout(holdTimer);
      holdTimer = null;
    };
    const isUi = (t: EventTarget | null) => t instanceof Element && t.closest('[data-live-ui]') !== null;
    const active = () => rfbRef.current !== null && phaseRef.current === 'viewing';
    const canvas = () => containerRef.current?.querySelector('canvas') ?? null;
    const mouse = (type: 'mousedown' | 'mouseup' | 'mousemove', p: Pt, button: number, buttons: number) => {
      const c = canvas();
      if (!c) return;
      let target: Element = c;
      if (type === 'mouseup') {
        // noVNC captures the pointer after mousedown with a full-page proxy element; the release must reach it.
        const proxy = document.getElementById('noVNC_mouse_capture_elem');
        if (proxy && proxy.style.display !== 'none') target = proxy;
      }
      const rfb = rfbRef.current;
      const prevFocus = rfb?.focusOnClick;
      if (rfb && kbOpenRef.current) rfb.focusOnClick = false; // keep the phone keyboard open
      target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: p.x, clientY: p.y, button, buttons }));
      if (rfb && kbOpenRef.current) rfb.focusOnClick = prevFocus;
    };
    const click = (p: Pt, button: 0 | 2) => {
      mouse('mousemove', p, 0, 0);
      mouse('mousedown', p, button, button === 2 ? 2 : 1);
      mouse('mouseup', p, button, 0);
    };
    const wheel = (p: Pt, dx: number, dy: number) => {
      canvas()?.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: p.x, clientY: p.y, deltaX: dx, deltaY: dy, deltaMode: 0 }));
    };
    const stagePt = (p: Pt): Pt => {
      const r = stage.getBoundingClientRect();
      return { x: p.x - r.left, y: p.y - r.top };
    };
    const pan = (dx: number, dy: number) => {
      if (!fitRef.current) {
        const screen = containerRef.current?.firstElementChild as HTMLElement | null;
        if (screen) {
          screen.scrollLeft -= dx;
          screen.scrollTop -= dy;
        }
        return;
      }
      const z = zoomRef.current;
      if (z.z <= 1) return;
      const c = clampZoom({ z: z.z, x: z.x + dx, y: z.y + dy }, stage.clientWidth, stage.clientHeight);
      paintZoom(c);
    };
    const finishZoom = () => setZoomLevel(zoomRef.current.z);

    const onStart = (e: TouchEvent) => {
      if (!active() || isUi(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      const pts = touchPoints(e.touches);
      if (pts.length === 1) {
        if (g && g.kind !== 'tap') return;
        g = { kind: 'tap', start: pts[0], last: pts[0] };
        clearHold();
        if (controlRef.current) {
          holdTimer = setTimeout(() => {
            holdTimer = null;
            if (g?.kind === 'tap') {
              g = { kind: 'hold', start: g.start };
              hapticRef.current?.('heavy');
            }
          }, LONG_PRESS_MS);
        }
      } else if (pts.length === 2) {
        clearHold();
        if (g?.kind === 'drag') mouse('mouseup', g.last, 0, 0);
        const c = mid(pts[0], pts[1]);
        g = { kind: 'two', mode: null, c0: c, d0: Math.max(1, dist(pts[0], pts[1])), last: c, z0: { ...zoomRef.current }, anchor: stagePt(c) };
      } else {
        clearHold();
        if (g?.kind === 'drag') mouse('mouseup', g.last, 0, 0);
        g = { kind: 'ignore' };
      }
    };

    const onMove = (e: TouchEvent) => {
      if (!g || isUi(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      const pts = touchPoints(e.touches);
      if (g.kind === 'tap' && pts.length === 1) {
        const p = pts[0];
        if (dist(p, g.start) > TAP_SLOP) {
          clearHold();
          pan(p.x - g.last.x, p.y - g.last.y);
          g = { kind: 'pan', last: p };
        }
      } else if (g.kind === 'pan' && pts.length === 1) {
        const p = pts[0];
        pan(p.x - g.last.x, p.y - g.last.y);
        g.last = p;
      } else if (g.kind === 'hold' && pts.length === 1) {
        const p = pts[0];
        if (dist(p, g.start) > TAP_SLOP && controlRef.current) {
          mouse('mousemove', g.start, 0, 0);
          mouse('mousedown', g.start, 0, 1);
          mouse('mousemove', p, 0, 1);
          g = { kind: 'drag', last: p };
        }
      } else if (g.kind === 'drag' && pts.length === 1) {
        const p = pts[0];
        mouse('mousemove', p, 0, 1);
        g.last = p;
      } else if (g.kind === 'two' && pts.length >= 2) {
        const c = mid(pts[0], pts[1]);
        const d = Math.max(1, dist(pts[0], pts[1]));
        if (!g.mode) {
          if (Math.abs(d - g.d0) > PINCH_SLOP && fitRef.current) g.mode = 'pinch';
          else if (dist(c, g.c0) > TAP_SLOP) g.mode = controlRef.current ? 'scroll' : 'pan';
        }
        if (g.mode === 'pinch') {
          const z = Math.max(1, Math.min(MAX_ZOOM, g.z0.z * (d / g.d0)));
          // keep the content point that was under the fingers under the (moving) fingers
          const q = { x: (g.anchor.x - g.z0.x) / g.z0.z, y: (g.anchor.y - g.z0.y) / g.z0.z };
          const sp = stagePt(c);
          paintZoom(clampZoom({ z, x: sp.x - q.x * z, y: sp.y - q.y * z }, stage.clientWidth, stage.clientHeight));
        } else if (g.mode === 'scroll') {
          wheel(c, -(c.x - g.last.x) * SCROLL_GAIN, -(c.y - g.last.y) * SCROLL_GAIN);
        } else if (g.mode === 'pan') {
          pan(c.x - g.last.x, c.y - g.last.y);
        }
        g.last = c;
      }
    };

    const onEnd = (e: TouchEvent, cancelled: boolean) => {
      if (!g || isUi(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      const remaining = e.touches.length;
      if (g.kind === 'tap') {
        clearHold();
        if (!cancelled) {
          const now = Date.now();
          const p = g.start;
          const double = lastTap && now - lastTap.t < DOUBLE_TAP_MS && dist(p, lastTap.p) < DOUBLE_TAP_SLOP;
          if (controlRef.current) {
            // the second tap of a double tap lands exactly on the first, so the desktop sees a double click
            click(double && lastTap ? lastTap.p : p, 0);
          } else if (double && fitRef.current) {
            const cur = zoomRef.current;
            if (cur.z > 1) setZoom({ z: 1, x: 0, y: 0 });
            else {
              const sp = stagePt(p);
              setZoom({ z: 2.5, x: sp.x - sp.x * 2.5, y: sp.y - sp.y * 2.5 });
            }
            hapticRef.current?.('selection');
          }
          lastTap = double ? null : { p, t: now };
        }
      } else if (g.kind === 'hold') {
        if (!cancelled && controlRef.current) click(g.start, 2);
      } else if (g.kind === 'drag') {
        mouse('mouseup', g.last, 0, 0);
      } else if (g.kind === 'two' || g.kind === 'pan') {
        finishZoom();
      }
      if (remaining === 0) g = null;
      else if (g && g.kind !== 'ignore') g = { kind: 'ignore' };
    };
    const onEndEv = (e: TouchEvent) => onEnd(e, false);
    const onCancelEv = (e: TouchEvent) => onEnd(e, true);

    const opts: AddEventListenerOptions = { capture: true, passive: false };
    stage.addEventListener('touchstart', onStart, opts);
    stage.addEventListener('touchmove', onMove, opts);
    stage.addEventListener('touchend', onEndEv, opts);
    stage.addEventListener('touchcancel', onCancelEv, opts);
    return () => {
      clearHold();
      stage.removeEventListener('touchstart', onStart, opts);
      stage.removeEventListener('touchmove', onMove, opts);
      stage.removeEventListener('touchend', onEndEv, opts);
      stage.removeEventListener('touchcancel', onCancelEv, opts);
    };
  }, [paintZoom, setZoom]);

  // ------------------------------------------------------------ view
  const notRunning = NOT_RUNNING.has(agent.state);
  const connectReason = notRunning ? `Agent desktop is ${agent.state}${agent.state === 'SLEEP' ? '; wake it first' : ''}` : null;
  const needsSession = !live ? 'Connect first' : null;
  const taskPaused = task?.state === 'PAUSED' || task?.state === 'WAITING_PROVIDER';
  const agentPaused = agent.state === 'PAUSED';
  const [rw, rh] = (agent.desktop_resolution || '1280x800').split('x').map(Number);
  const aspect = rw > 0 && rh > 0 ? `${rw} / ${rh}` : '16 / 10';
  const phaseLabel: Record<LivePhase, string> = {
    idle: 'Not connected',
    connecting: 'Connecting…',
    viewing: 'Streaming',
    disconnecting: 'Disconnecting…',
    disconnected: 'Disconnected',
    error: 'Connection failed',
  };
  const phaseTone = phase === 'viewing' ? 'bg-success' : phase === 'connecting' || phase === 'disconnecting' ? 'bg-info animate-pulse-soft' : phase === 'error' || phase === 'disconnected' ? 'bg-warn' : 'bg-subtle';
  const effectiveHolder: ControlHolder = control ? 'you' : holder === 'you' ? 'none' : holder;
  const holderText: Record<ControlHolder, string> = { you: 'You', agent: 'Agent', other: 'Another viewer', none: 'Nobody (agent idle)' };
  const q = qualityLabel(stats);
  const anyFs = fullscreen || pseudoFs;
  const kbReason = !live ? 'Connect first' : !control ? 'Take control first' : null;

  const connectButton =
    live || phase === 'disconnecting' ? (
      <Button variant="secondary" size={compact ? 'md' : 'sm'} icon={<IconPower />} onClick={() => void disconnect()} loading={phase === 'disconnecting'} className={compact ? 'min-h-11 flex-1' : ''}>
        Disconnect
      </Button>
    ) : (
      <Button variant="primary" size={compact ? 'md' : 'sm'} icon={<IconPlay />} onClick={connect} loading={phase === 'connecting'} disabledReason={connectReason} className={compact ? 'min-h-11 flex-1' : ''}>
        {phase === 'disconnected' || phase === 'error' ? 'Reconnect' : 'Connect'}
      </Button>
    );
  const controlButton = control ? (
    <Button size={compact ? 'md' : 'sm'} variant="secondary" icon={<IconHand />} onClick={releaseControl} loading={busy === 'release'} className={`border-warn/40 text-warn ${compact ? 'min-h-11 flex-1' : ''}`}>
      Release Control
    </Button>
  ) : (
    <Button size={compact ? 'md' : 'sm'} variant={compact ? 'secondary' : 'ghost'} icon={<IconHand />} onClick={takeControl} loading={busy === 'control'} disabledReason={needsSession} className={compact ? 'min-h-11 flex-1' : ''}>
      Take Control
    </Button>
  );

  const statusRow = (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <h2 className="sr-only">Live desktop of {agent.name}</h2>
        <span className="inline-flex h-7 items-center gap-2 rounded-lg border border-border bg-panel px-2.5 text-xs text-text">
          <span aria-hidden className={`size-1.5 rounded-full ${phaseTone}`} />
          {phaseLabel[phase]}
        </span>
        {live && (
          <span
            data-testid="live-badge"
            className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-danger/40 bg-danger/[0.12] px-2.5 text-xs font-semibold tracking-wide text-danger"
          >
            <span aria-hidden className="size-1.5 animate-pulse-soft rounded-full bg-danger" />
            Live
          </span>
        )}
        {live &&
          (control ? (
            <span className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-warn/40 bg-warn/[0.1] px-2.5 text-xs font-medium text-warn">
              <IconHand className="size-3.5" />
              You have control
            </span>
          ) : (
            <span className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-border bg-panel px-2.5 text-xs text-muted">
              <IconEye className="size-3.5" />
              View only
            </span>
          ))}
        <span
          data-testid="live-controller"
          data-holder={effectiveHolder}
          className={`inline-flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-xs ${
            effectiveHolder === 'you' ? 'border-warn/40 text-warn' : effectiveHolder === 'other' ? 'border-danger/40 text-danger' : 'border-border text-muted'
          }`}
          aria-live="polite"
        >
          In control: <strong className="font-semibold">{holderText[effectiveHolder]}</strong>
        </span>
        {task ? (
          <span className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted">
            Task
            {compact ? (
              <span className="font-mono text-text">{shortId(task.id)}</span>
            ) : (
              <a className="rounded font-mono text-text underline decoration-subtle/60 underline-offset-2 focus-ring" href={href(`/agents/${agent.id}/tasks?task=${task.id}`)}>
                {shortId(task.id)}
              </a>
            )}
            <StatusPill state={task.state} />
          </span>
        ) : (
          <span className="text-xs text-subtle">No current task</span>
        )}
      </div>
      <div className="text-xs text-muted tabular-nums" aria-live="polite" data-testid="live-quality">
        {phase === 'viewing' ? (
          <span className="inline-flex flex-wrap items-center gap-x-1.5">
            <span className="sr-only">Connection: VIEWING · </span>
            <span className="inline-flex items-center gap-1.5" title="Connection quality (API round-trip to the host)">
              <span aria-hidden className={`size-1.5 rounded-full ${q.tone}`} />
              {q.label}
              {stats.latencyMs !== null && <> · {Math.round(stats.latencyMs)} ms</>}
            </span>
            <span>
              · {formatRate(stats.bytesPerSec)} · total {formatBytes(stats.totalBytes)}
              {stats.updatesPerSec !== null && <> · {stats.updatesPerSec.toFixed(1)} updates/s</>}
            </span>
          </span>
        ) : (
          <span className="sr-only">Connection: {phase.toUpperCase()}</span>
        )}
      </div>
      {adaptiveQuality && (
        <div className="flex items-center gap-2 text-xs text-muted" data-testid="live-quality-mode">
          <span id="live-quality-label">Quality</span>
          <div role="radiogroup" aria-labelledby="live-quality-label" className="inline-flex rounded-lg border border-border bg-panel p-0.5">
            {(['auto', 'high'] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={qualityMode === m}
                onClick={() => setQualityMode(m)}
                className={`${touchUi ? 'min-h-11 px-4' : 'min-h-8 px-3'} rounded-md font-medium focus-ring ${qualityMode === m ? 'bg-white/[0.08] text-text' : 'text-muted'}`}
              >
                {m === 'auto' ? 'Auto' : 'High'}
              </button>
            ))}
          </div>
          {qualityMode === 'auto' && reduced && phase === 'viewing' && <span className="text-warn">reduced for a slow connection</span>}
        </div>
      )}
    </div>
  );

  const fsOverlay = anyFs && (
    <div data-live-ui className="absolute top-2 right-2 z-20 flex gap-1.5" style={pseudoFs ? { top: 'calc(var(--mini-safe-top, 0px) + 0.5rem)', right: 'calc(var(--mini-safe-right, 0px) + 0.5rem)' } : undefined}>
      {live && touchUi && (
        <button type="button" onClick={toggleKeyboard} disabled={Boolean(kbReason)} aria-label={kbOpen ? 'Hide keyboard' : 'Show keyboard'} className="grid size-11 place-items-center rounded-xl bg-black/60 text-white backdrop-blur focus-ring disabled:opacity-40">
          <span aria-hidden className="text-sm font-semibold">⌨</span>
        </button>
      )}
      {live && (
        <button
          type="button"
          onClick={control ? releaseControl : takeControl}
          aria-label={control ? 'Release control of the desktop' : 'Take control of the desktop'}
          className={`grid size-11 place-items-center rounded-xl backdrop-blur focus-ring ${control ? 'bg-warn/80 text-black' : 'bg-black/60 text-white'}`}
        >
          <IconHand className="size-5" />
        </button>
      )}
      <button type="button" onClick={toggleFullscreen} aria-label="Exit fullscreen" className="grid size-11 place-items-center rounded-xl bg-black/60 text-white backdrop-blur focus-ring">
        <IconX className="size-5" />
      </button>
    </div>
  );

  const stage = (
    <div
      ref={stageRef}
      style={pseudoFs ? undefined : { aspectRatio: aspect }}
      data-pseudo-fullscreen={pseudoFs ? 'true' : undefined}
      className={`live-stage relative w-full touch-none overflow-hidden bg-black select-none [-webkit-touch-callout:none] ${
        pseudoFs ? 'fixed inset-0 z-[100] h-[var(--mini-vh,100dvh)] rounded-none border-0' : `rounded-xl border ${control ? 'border-warn/50 shadow-[0_0_0_1px_rgb(240_180_76/0.25)]' : 'border-border'}`
      }`}
      data-testid="live-stage"
    >
      <div ref={zoomLayerRef} className="absolute top-0 left-0 h-full w-full origin-top-left will-change-transform" data-testid="live-zoom-layer">
        {/* noVNC owns this element; React never renders children into it. */}
        <div ref={containerRef} className={`absolute inset-0 touch-none ${control ? 'cursor-default' : ''}`} data-testid="vnc-container" />
      </div>
      <input
        ref={kbRef}
        data-live-ui
        type="text"
        inputMode="text"
        aria-label="Type on the remote desktop"
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
        tabIndex={-1}
        className="pointer-events-none absolute bottom-0 left-0 h-px w-px opacity-0"
        onKeyDown={onKbKeyDown}
        onInput={onKbInput}
        onCompositionEnd={onKbCompositionEnd}
        onBlur={() => setKbOpen(false)}
        data-testid="live-keyboard-input"
      />
      {fsOverlay}
      {live && zoomLevel > 1 && (
        <div data-live-ui className="absolute bottom-2 left-2 z-20 flex items-center gap-1 rounded-xl bg-black/60 py-1 pr-1 pl-2.5 text-xs text-white backdrop-blur">
          <span className="tabular-nums">{zoomLevel.toFixed(1)}×</span>
          <button type="button" onClick={() => setZoom({ z: 1, x: 0, y: 0 })} className="min-h-9 rounded-lg px-2 font-medium focus-ring">
            Reset zoom
          </button>
        </div>
      )}
      {!live && (
        <div data-live-ui className="absolute inset-0 flex flex-col items-center justify-center gap-3 overflow-y-auto bg-[radial-gradient(ellipse_at_center,#111117_0%,#07070a_70%)] p-4 text-center sm:gap-4 sm:p-6">
          {phase === 'connecting' ? (
            <Spinner className="size-6" label="Opening authorized desktop stream…" />
          ) : phase === 'disconnecting' ? (
            <Spinner className="size-6" label="Closing stream…" />
          ) : (
            <>
              <span aria-hidden className="hidden size-12 place-items-center rounded-2xl border border-border bg-panel text-muted sm:grid">
                <IconMonitor className="size-6" />
              </span>
              <p className="text-sm font-medium text-white sm:text-base">Desktop stream is inactive</p>
              {reason && (
                <p className="max-w-lg text-xs text-warn sm:text-sm" role="alert">
                  {reason}
                </p>
              )}
              <p className={`max-w-md text-sm text-[#a1a1ab] ${compact ? 'hidden' : 'hidden sm:block'}`}>
                Nothing is streamed until you connect. The view starts read-only; use Take Control for exclusive input.
              </p>
              <div className="flex flex-wrap justify-center gap-2">
                <Button variant="primary" icon={<IconPlay />} onClick={connect} disabledReason={connectReason} className={compact ? 'min-h-11' : ''}>
                  {phase === 'disconnected' || phase === 'error' ? 'Reconnect' : 'Connect'}
                </Button>
                {agent.state === 'SLEEP' && compact && (
                  <Button variant="secondary" icon={<IconSun />} onClick={wake} loading={busy === 'wake'} className="min-h-11">
                    Wake agent
                  </Button>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );

  const extraKeys = kbOpen && control && (
    <div data-live-ui className="grid grid-cols-5 gap-1.5" role="group" aria-label="Special keys">
      {(
        [
          ['Esc', () => sendKeysym(KEYSYMS.Escape), 'Escape'],
          ['Tab', () => sendKeysym(KEYSYMS.Tab), 'Tab'],
          ['Ctrl+C', () => sendCombo([KS_CONTROL], 0x63), 'Control C (copy)'],
          ['Ctrl+V', () => sendCombo([KS_CONTROL], 0x76), 'Control V (paste)'],
          ['⌫', () => sendKeysym(KEYSYMS.Backspace), 'Backspace'],
          ['←', () => sendKeysym(KEYSYMS.ArrowLeft), 'Arrow left'],
          ['↑', () => sendKeysym(KEYSYMS.ArrowUp), 'Arrow up'],
          ['↓', () => sendKeysym(KEYSYMS.ArrowDown), 'Arrow down'],
          ['→', () => sendKeysym(KEYSYMS.ArrowRight), 'Arrow right'],
          ['C-A-Del', () => rfbRef.current?.sendCtrlAltDel?.(), 'Control Alt Delete'],
        ] as [string, () => void, string][]
      ).map(([label, fn, aria]) => (
        <button
          key={label}
          type="button"
          aria-label={aria}
          // keep focus (and the phone keyboard) in the hidden input
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            fn();
            hapticRef.current?.('selection');
          }}
          className="min-h-11 rounded-lg border border-border bg-panel-2 text-xs font-medium text-text active:bg-panel-3 focus-ring"
        >
          {label}
        </button>
      ))}
    </div>
  );

  const notices = (
    <>
      {busy === 'control' && (
        <p className="text-sm text-muted" role="status">
          Waiting for the agent to reach a safe point before handing over control (up to 60 s)…
        </p>
      )}
      {vmNotice && (
        <p className="rounded-lg border border-warn/30 bg-warn/[0.08] px-3 py-2 text-xs text-warn" role="status" data-testid="live-vm-notice">
          {vmNotice}
        </p>
      )}
    </>
  );

  const footer = (
    <p className="text-xs text-subtle">
      {sessionId ? (
        <>
          Viewer session <Mono>{shortId(sessionId)}</Mono> · {control ? 'input enabled (lease renewed every 60 s)' : 'read-only'} ·{' '}
        </>
      ) : null}
      Display {agent.display_id ?? '—'} · {agent.desktop_resolution} · {fit ? 'scaled to fit' : '1:1 pixels (scroll to pan)'}
      {touchUi && live && <> · tap = click, hold = right click, hold + move = drag, two fingers = scroll, pinch = zoom</>}
    </p>
  );

  const agentPauseButton = (size: 'sm' | 'md', cls = '') =>
    agentPaused ? (
      <Button size={size} variant="ghost" icon={<IconPlay />} onClick={resumeAgent} loading={busy === 'agent-resume'} className={cls}>
        Resume agent
      </Button>
    ) : (
      <Button size={size} variant="ghost" icon={<IconPause />} onClick={pauseAgent} loading={busy === 'agent-pause'} disabledReason={notRunning ? `Agent is ${agent.state}` : null} className={cls}>
        Pause agent
      </Button>
    );

  const modals = (
    <>
      <ConfirmDialog
        open={confirmStop}
        title="Stop the current task?"
        confirmLabel="Stop task"
        busyText="Stopping…"
        onConfirm={stopTask}
        onCancel={() => setConfirmStop(false)}
      >
        <p>
          The task <strong>{task ? shortId(task.id) : ''}</strong> is cancelled at the next safe point. The agent and its desktop keep running.
        </p>
      </ConfirmDialog>
      <Modal
        open={shot !== null}
        title="Desktop screenshot"
        onClose={() => setShot(null)}
        size="xl"
        footer={
          shot && (
            <>
              <a href={shot.url} download={shot.name} className={buttonClass('primary', 'md', compact ? 'min-h-11' : '')}>
                <IconDownload />
                Download PNG
              </a>
              <Button onClick={() => setShot(null)} className={compact ? 'min-h-11' : ''}>
                Close
              </Button>
            </>
          )
        }
      >
        {shot && (
          <figure>
            <img src={shot.url} alt={`Screenshot of ${agent.name}'s desktop`} className="w-full rounded-lg border border-border" />
            {shot.capturedAt && <figcaption className="mt-2 text-xs text-muted">Captured {new Date(Number(shot.capturedAt) * 1000).toLocaleString()}</figcaption>}
          </figure>
        )}
      </Modal>
    </>
  );

  if (compact) {
    const tile = (label: string, icon: ReactNode, onClick: () => void, opts: { loading?: boolean; reason?: string | null; pressed?: boolean; danger?: boolean } = {}) => (
      <Button
        size="md"
        variant={opts.danger ? 'danger' : 'secondary'}
        onClick={onClick}
        loading={opts.loading}
        disabledReason={opts.reason ?? null}
        aria-pressed={opts.pressed}
        className="min-h-14 w-full flex-col gap-0.5! px-1! text-[11px]! leading-tight whitespace-normal! [&>svg]:size-[18px]!"
        icon={icon}
      >
        {label}
      </Button>
    );
    return (
      <div className="space-y-3">
        {statusRow}
        {stage}
        {notices}
        <div className="space-y-2" role="toolbar" aria-label="Live desktop controls">
          <div className="flex gap-2">
            {connectButton}
            {controlButton}
          </div>
          {extraKeys}
          <div className="grid grid-cols-4 gap-2">
            {taskPaused
              ? tile('Resume', <IconPlay />, () => void resumeTask(), { loading: busy === 'resume', reason: !task ? 'No task is running' : null })
              : tile('Pause', <IconPause />, () => void pauseTask(), { loading: busy === 'pause', reason: !task ? 'No task is running' : null })}
            {tile('Stop task', <IconStop />, () => setConfirmStop(true), { reason: !task ? 'No task is running' : null, danger: Boolean(task) })}
            {tile('Screenshot', <IconCamera />, screenshot, { loading: busy === 'shot', reason: notRunning ? `Agent desktop is ${agent.state}` : null })}
            {tile(anyFs ? 'Exit fullscreen' : 'Fullscreen', <IconFullscreen />, () => void toggleFullscreen(), { pressed: anyFs })}
            {tile(kbOpen ? 'Hide keyboard' : 'Keyboard', <span aria-hidden className="text-base leading-none">⌨</span>, toggleKeyboard, { reason: kbReason, pressed: kbOpen })}
            {zoomLevel > 1
              ? tile('Reset zoom', <IconSearch />, () => setZoom({ z: 1, x: 0, y: 0 }))
              : tile('Zoom in', <IconSearch />, () => zoomBy(2), { reason: !live ? 'Connect first' : !fit ? 'Turn Fit on to zoom' : null })}
            {tile(fit ? 'Fit: on' : 'Fit: off (1:1)', <IconFit />, toggleFit, { pressed: fit })}
            {agent.state === 'SLEEP'
              ? tile('Wake agent', <IconSun />, () => void wake(), { loading: busy === 'wake' })
              : agentPaused
                ? tile('Resume agent', <IconPlay />, () => void resumeAgent(), { loading: busy === 'agent-resume' })
                : tile('Pause agent', <IconPause />, () => void pauseAgent(), { loading: busy === 'agent-pause', reason: notRunning ? `Agent is ${agent.state}` : null })}
          </div>
        </div>
        {footer}
        {modals}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {statusRow}

      <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-border bg-panel p-1.5 shadow-card" role="toolbar" aria-label="Live desktop controls">
        {connectButton}
        {controlButton}
        <span aria-hidden className="mx-0.5 hidden h-5 w-px bg-border sm:block" />
        <Button size="sm" variant="ghost" icon={<IconPause />} onClick={() => void pauseTask()} loading={busy === 'pause'} disabledReason={!task ? 'No task is running' : taskPaused ? 'Task is already paused' : null}>
          Pause
        </Button>
        <Button size="sm" variant="ghost" icon={<IconPlay />} onClick={() => void resumeTask()} loading={busy === 'resume'} disabledReason={!task ? 'No task is running' : !taskPaused ? 'Task is not paused' : null}>
          Resume
        </Button>
        <Button size="sm" variant="ghost" icon={<IconStop />} onClick={() => setConfirmStop(true)} disabledReason={!task ? 'No task is running' : null} className={task ? 'text-danger' : ''}>
          Stop task
        </Button>
        {agent.state !== 'SLEEP' && agentPauseButton('sm')}
        <span aria-hidden className="mx-0.5 hidden h-5 w-px bg-border sm:block" />
        <Button size="sm" variant="ghost" icon={<IconCamera />} onClick={screenshot} loading={busy === 'shot'} disabledReason={notRunning ? `Agent desktop is ${agent.state}` : null}>
          Screenshot
        </Button>
        <Button size="sm" variant="ghost" icon={<IconFit />} onClick={toggleFit} aria-pressed={fit}>
          {fit ? 'Fit: on' : 'Fit: off (1:1)'}
        </Button>
        <Button size="sm" variant="ghost" icon={<IconFullscreen />} onClick={() => void toggleFullscreen()} aria-pressed={anyFs}>
          {anyFs ? 'Exit fullscreen' : 'Fullscreen'}
        </Button>
        {touchUi && (
          <Button size="sm" variant="ghost" onClick={toggleKeyboard} disabledReason={kbReason} aria-pressed={kbOpen}>
            {kbOpen ? 'Hide keyboard' : 'Keyboard'}
          </Button>
        )}
        {zoomLevel > 1 && (
          <Button size="sm" variant="ghost" icon={<IconSearch />} onClick={() => setZoom({ z: 1, x: 0, y: 0 })}>
            Reset zoom
          </Button>
        )}
        {agent.state === 'SLEEP' && (
          <Button size="sm" variant="primary" icon={<IconSun />} onClick={() => void wake()} loading={busy === 'wake'} className="ml-auto">
            Wake agent
          </Button>
        )}
      </div>
      {extraKeys}
      {notices}
      {stage}
      {footer}
      {modals}
    </div>
  );
}
