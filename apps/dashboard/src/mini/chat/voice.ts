// Voice messages: MediaRecorder where the WebView allows it. Telegram WebViews (and the Mini App gateway's
// Permissions-Policy) may block the microphone — then the mic button explains why, and text chat is unaffected.
import { useCallback, useEffect, useRef, useState } from 'react';

export type VoiceSupport = { ok: true; mime: string; ext: 'ogg' | 'webm' | 'm4a' } | { ok: false; reason: string };

const CANDIDATES: [string, 'ogg' | 'webm' | 'm4a'][] = [
  ['audio/ogg;codecs=opus', 'ogg'],
  ['audio/webm;codecs=opus', 'webm'],
  ['audio/webm', 'webm'],
  ['audio/mp4', 'm4a'],
  ['audio/aac', 'm4a'],
];

type PolicyDoc = Document & { permissionsPolicy?: { allowsFeature?(f: string): boolean }; featurePolicy?: { allowsFeature?(f: string): boolean } };

/** Can this view record a voice message, and in which container? */
export function voiceSupport(): VoiceSupport {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
    return { ok: false, reason: 'This view has no microphone access. You can still type your message.' };
  }
  const MR = (globalThis as { MediaRecorder?: typeof MediaRecorder }).MediaRecorder;
  if (typeof MR === 'undefined') return { ok: false, reason: 'Audio recording is not supported in this Telegram version. You can still type your message.' };
  const policy = (document as PolicyDoc).permissionsPolicy ?? (document as PolicyDoc).featurePolicy;
  try {
    if (policy?.allowsFeature && !policy.allowsFeature('microphone')) {
      return { ok: false, reason: 'The microphone is blocked for the Mini App on this NEBULA. You can still type your message.' };
    }
  } catch {
    // older engines: let getUserMedia decide
  }
  if (typeof MR.isTypeSupported !== 'function') return { ok: true, mime: '', ext: 'webm' };
  for (const [mime, ext] of CANDIDATES) {
    try {
      if (MR.isTypeSupported(mime)) return { ok: true, mime, ext };
    } catch {
      // keep looking
    }
  }
  return { ok: false, reason: 'No supported audio format for recording here. You can still type your message.' };
}

const BASE_MIME: Record<'ogg' | 'webm' | 'm4a', string> = { ogg: 'audio/ogg', webm: 'audio/webm', m4a: 'audio/mp4' };
const MAX_MS = 10 * 60_000;

export type RecorderState = 'idle' | 'requesting' | 'recording';

function micError(e: unknown): string {
  const name = e instanceof DOMException ? e.name : e instanceof Error ? e.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Microphone access was denied. Allow it in Telegram / system settings, or type your message.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No microphone was found on this device.';
  if (name === 'NotReadableError') return 'The microphone is in use by another app.';
  return 'Recording could not start. You can still type your message.';
}

/** start / stop (→ File voice.ogg|webm|m4a) / cancel with a live duration. */
export function useRecorder(support: VoiceSupport) {
  const [state, setState] = useState<RecorderState>('idle');
  const [elapsedMs, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const startedAt = useRef(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoStop = useRef<(() => void) | null>(null);

  const cleanup = useCallback(() => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    rec.current = null;
    chunks.current = [];
    setState('idle');
    setElapsed(0);
  }, []);

  useEffect(() => () => {
    if (rec.current && rec.current.state !== 'inactive') {
      rec.current.ondataavailable = null;
      rec.current.onstop = null;
      try {
        rec.current.stop();
      } catch {
        // already stopped
      }
    }
    cleanup();
  }, [cleanup]);

  const start = useCallback(async () => {
    if (!support.ok || state !== 'idle') return;
    setError(null);
    setState('requesting');
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.current = s;
      const r = support.mime ? new MediaRecorder(s, { mimeType: support.mime }) : new MediaRecorder(s);
      rec.current = r;
      chunks.current = [];
      r.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunks.current.push(e.data);
      };
      r.start(250);
      startedAt.current = Date.now();
      setElapsed(0);
      setState('recording');
      timer.current = setInterval(() => {
        const ms = Date.now() - startedAt.current;
        setElapsed(ms);
        if (ms >= MAX_MS) autoStop.current?.();
      }, 200);
    } catch (e) {
      cleanup();
      setError(micError(e));
    }
  }, [support, state, cleanup]);

  const stop = useCallback(
    () =>
      new Promise<{ file: File; durationMs: number } | null>((resolve) => {
        const r = rec.current;
        if (!r || !support.ok) {
          cleanup();
          resolve(null);
          return;
        }
        const durationMs = Date.now() - startedAt.current;
        r.onstop = () => {
          const type = (r.mimeType || support.mime || BASE_MIME[support.ext]).split(';')[0];
          const blob = new Blob(chunks.current, { type });
          cleanup();
          resolve(blob.size > 0 ? { file: new File([blob], `voice.${support.ext}`, { type }), durationMs } : null);
        };
        try {
          r.stop();
        } catch {
          cleanup();
          resolve(null);
        }
      }),
    [support, cleanup],
  );

  const cancel = useCallback(() => {
    const r = rec.current;
    if (r) {
      r.ondataavailable = null;
      r.onstop = null;
      try {
        r.stop();
      } catch {
        // already stopped
      }
    }
    cleanup();
  }, [cleanup]);

  return { state, elapsedMs, error, setError, start, stop, cancel, autoStop };
}

export function formatClock(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
