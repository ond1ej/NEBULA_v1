// Live Desktop of one agent (opened from the chat's options or a Telegram deep link). The shared viewer streams only
// after Connect, offers Take / Release Control (exclusive), pause / resume, the Auto / High quality toggle and
// disconnects when this screen closes (unmount → DELETE /live/sessions/{id}).
import { useEffect, useMemo } from 'react';
import { LazyBoundary } from '../../components/LazyBoundary';
import type { LiveDesktopClient } from '../../components/LiveDesktop';
import { isTaskLifecycleEvent } from '../../hooks/useEvents';
import { lazyNamed } from '../../lib/lazy';
import type { AgentDetail } from '../../types';
import { hasPermission, useMini } from '../context';
import { useQuery } from '../hooks';
import { IcChats } from '../icons';
import { goBack, mhref } from '../router';
import { haptic, setClosingConfirmation, setVerticalSwipes } from '../telegram';
import type { AgentEnvironment } from '../types';
import { agentStatus, ErrorState, IconLink, Screen, SkeletonList, StatusDot } from '../uiKit';
import { Notice } from '../uiExtra';

// The viewer (and noVNC after Connect) loads only when this screen opens.
const LiveDesktop = lazyNamed(() => import('../../components/LiveDesktop'), 'LiveDesktop');

export function DesktopScreen({ agentId }: { agentId: string }) {
  const ctx = useMini();
  const { api, client, inTelegram } = ctx;
  const agent = useQuery<AgentDetail>(`agent:${agentId}`, (s) => api.agents.get(agentId, s), {
    refreshOn: (ev) => ev.agent_id === agentId && (ev.type.startsWith('agent.') || isTaskLifecycleEvent(ev) || ev.type === 'environment.changed'),
  });
  const env = useQuery<AgentEnvironment>(`agent-env:${agentId}`, (s) => api.agents.environment(agentId, s), {
    refreshOn: (ev) => ev.agent_id === agentId && ev.type === 'environment.changed',
  });
  const liveClient = useMemo<LiveDesktopClient>(
    () => ({
      connect: (id) => api.live.connect(id),
      disconnect: (sid, keepalive) => api.live.disconnect(sid, keepalive),
      control: (sid, action) => api.live.control(sid, action),
      sessions: () => api.live.sessions(),
      pauseTask: (id) => api.tasks.pause(id),
      resumeTask: (id) => api.tasks.resume(id),
      stopTask: (id) => api.tasks.stop(id),
      wake: (id) => api.agents.wake(id),
      pauseAgent: (id) => api.agents.pause(id),
      resumeAgent: (id) => api.agents.resume(id),
      screenshot: (id) => api.agents.screenshot(id),
      wsUrl: (path, token) => client.wsUrl(path, token),
      // The Mini App gateway accepts the WebSocket without echoing a subprotocol; browsers abort a handshake that
      // requested one and got none, so through the gateway noVNC must not request 'binary' (it does not need it).
      wsProtocols: client.mode === 'telegram' ? [] : ['binary'],
    }),
    [api, client],
  );

  // Gestures on the desktop must not minimise the Mini App; leaving while in control asks first.
  useEffect(() => {
    setVerticalSwipes(false);
    return () => {
      setVerticalSwipes(true);
      setClosingConfirmation(false);
    };
  }, []);

  const a = agent.data;
  const st = agentStatus(a?.state);
  const chat = mhref(`/agents/${agentId}`);
  return (
    <Screen
      title={a ? a.name : 'Live Desktop'}
      subtitle={
        a ? (
          <span className="inline-flex items-center gap-1.5">
            <StatusDot tone={st.tone} pulse={st.busy} /> Live Desktop · {st.label}
          </span>
        ) : undefined
      }
      back={false}
      leading={!inTelegram ? <IconLink label="Back to chat" href={chat} onClick={(e) => (e.preventDefault(), goBack(chat.slice(1)))} icon={<IcChats />} /> : undefined}
      actions={inTelegram ? <IconLink label="Back to chat" href={chat} icon={<IcChats />} /> : undefined}
    >
      {!hasPermission(ctx, 'desktop') ? (
        <Notice tone="warning" title="Live Desktop is not allowed">
          This Mini App session does not have the desktop permission.
        </Notice>
      ) : agent.error && !a ? (
        <ErrorState error={agent.error} onRetry={agent.reload} />
      ) : env.data && !env.data.live_desktop ? (
        <Notice tone="info" title="No Live Desktop on the Mac mini">
          {a?.name ?? 'This agent'} runs on the <strong>Mac mini</strong> (host execution: terminal, files, git and dev tools only). Live Desktop and Take Control
          are available for agents running in the <strong>Ubuntu VM</strong>.
        </Notice>
      ) : !a || (!env.data && env.loading) ? (
        <SkeletonList rows={2} avatar={false} />
      ) : (
        <LazyBoundary compact fallback={<SkeletonList rows={2} label="Loading the desktop viewer…" avatar={false} />}>
          <LiveDesktop
            agent={a}
            client={liveClient}
            variant="compact"
            statsIntervalMs={5_000}
            adaptiveQuality
            haptics={(k) => haptic(k)}
            onAgentChanged={agent.reload}
            onControlChange={(on) => setClosingConfirmation(on)}
          />
        </LazyBoundary>
      )}
    </Screen>
  );
}
