// Text-to-speech preview: POST /voice/tts/preview -> audio blob -> object URL -> <audio>. Shared by the global
// Voice page and the per-agent Voice tab.
import { useCallback, useEffect, useRef, useState } from 'react';
import { IconPlay } from '../../components/icons';
import { useToast } from '../../components/Toast';
import { Button } from '../../components/ui';
import { voiceApi, type PreviewBody } from './api';

export interface PreviewState {
  url: string;
  voice: string | null;
  provider: string | null;
  duration: number | null;
}

function toUrl(blob: Blob): string {
  return typeof URL.createObjectURL === 'function' ? URL.createObjectURL(blob) : '';
}

function revoke(url: string | undefined) {
  if (url && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url);
}

export function useVoicePreview() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PreviewState | null>(null);
  const ctl = useRef<AbortController | null>(null);
  const urlRef = useRef<string | undefined>(undefined);

  useEffect(
    () => () => {
      ctl.current?.abort();
      revoke(urlRef.current);
    },
    [],
  );

  const play = useCallback(
    async (body: PreviewBody) => {
      ctl.current?.abort();
      const c = new AbortController();
      ctl.current = c;
      setBusy(true);
      try {
        const r = await voiceApi.preview(body, c.signal);
        if (c.signal.aborted) return;
        revoke(urlRef.current);
        const url = toUrl(r.blob);
        urlRef.current = url;
        setResult({ url, voice: r.voice, provider: r.provider, duration: r.duration });
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        toast.error(e, 'Preview failed');
      } finally {
        if (ctl.current === c) setBusy(false);
      }
    },
    [toast],
  );

  return { play, busy, result };
}

export function PreviewButton({ onClick, busy, disabledReason, label = 'Preview voice' }: { onClick: () => void; busy: boolean; disabledReason?: string | null; label?: string }) {
  return (
    <Button icon={<IconPlay />} onClick={onClick} loading={busy} disabledReason={disabledReason ?? null}>
      {label}
    </Button>
  );
}

export function PreviewPlayer({ result }: { result: PreviewState | null }) {
  if (!result) return null;
  return (
    <div className="mt-3 rounded-xl border border-border bg-panel-2/50 p-3" data-testid="voice-preview">
      {result.url ? (
        <audio key={result.url} src={result.url} controls autoPlay className="w-full max-w-full" aria-label="Voice preview" />
      ) : (
        <p className="text-sm text-muted">Audio received, but this browser cannot create a playable URL.</p>
      )}
      <p className="mt-2 text-xs text-muted">
        Voice <span className="text-text">{result.voice ?? 'default'}</span>
        {result.provider && <> · {result.provider}</>}
        {result.duration != null && <> · {result.duration.toFixed(1)} s</>}
      </p>
    </div>
  );
}
