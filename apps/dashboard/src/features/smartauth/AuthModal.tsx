// The Dashboard's sign-in modal (own chunk): the shared <SmartAuthRequest> for one session. The detail is fetched once
// and refreshed on this session's auth events (and on vault lock changes, for "Wait for unlock"). The Dashboard on this
// Mac is local, so the host never asks for the remote PIN here; inside the Mini App's administration area the owner's
// one confirmation (V4.0) stands in for it. Closing the modal unmounts the form: every typed value
// is dropped. A late response never replaces a newer step (pickNewer).
import { useCallback, useEffect, useRef, useState } from 'react';
import { Modal } from '../../components/Modal';
import { IconKey } from '../../components/icons';
import { ErrorBanner, LoadingRows } from '../../components/ui';
import { useLiveRefresh } from '../../hooks/useEvents';
import { href } from '../../hooks/useHashRoute';
import { currentAuthClient, smartAuthApi } from './api';
import { SmartAuthRequest } from './core/SmartAuthRequest';
import { authEventSession, pickNewer, requestTitle } from './core/lib';
import type { AuthSession } from './core/types';

export function AuthModal({ sessionId, seed, onClose }: { sessionId: string; seed?: AuthSession | null; onClose: () => void }) {
  const [data, setData] = useState<AuthSession | null>(seed ?? null);
  const [error, setError] = useState<unknown>(null);
  const [client] = useState(currentAuthClient);
  const ctl = useRef<AbortController | null>(null);
  const load = useCallback(() => {
    ctl.current?.abort();
    const c = new AbortController();
    ctl.current = c;
    smartAuthApi.get(sessionId, c.signal).then(
      (s) => {
        if (c.signal.aborted) return;
        setData((prev) => pickNewer(prev, s));
        setError(null);
      },
      (e: unknown) => {
        if (c.signal.aborted || (e instanceof DOMException && e.name === 'AbortError')) return;
        setError(e);
      },
    );
  }, [sessionId]);
  useEffect(() => {
    load();
    return () => ctl.current?.abort();
  }, [load]);
  useLiveRefresh(load, (ev) => authEventSession(ev) === sessionId || ev.type === 'vault.status.changed', 250);

  const s = data;
  return (
    <Modal open title={s ? requestTitle(s) : 'Sign-in request'} onClose={onClose} size="md" icon={<IconKey className="size-5 text-warn" />}>
      {s ? (
        <SmartAuthRequest
          session={s}
          client={client}
          variant="dashboard"
          hideTitle
          liveDesktopHref={href(`/agents/${s.agent_id}/live`)}
          onSession={(next) => setData((prev) => pickNewer(prev, prev ? { ...prev, ...next } : next))}
          onReload={load}
          onClose={onClose}
        />
      ) : error ? (
        <ErrorBanner error={error} onRetry={load} title="Could not load the sign-in request" />
      ) : (
        <LoadingRows rows={3} label="Loading the sign-in request…" />
      )}
    </Modal>
  );
}
