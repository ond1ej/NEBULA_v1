import { ApiError, api } from '../api';
import { IconChat, IconEnvironment, IconFiles, IconMemory, IconMonitor, IconMoon, IconPause, IconPlay, IconSettings, IconShield, IconSkills, IconSun, IconTasks, IconVoice } from '../components/icons';
import { LazyBoundary, PanelSkeleton } from '../components/LazyBoundary';
import { BUSY_STATES, StatusPill } from '../components/StatusPill';
import { agentAvatarOf, Avatar, Badge, Button, ButtonLink, EmptyState, ErrorBanner, Mono, Notice, PageHeader, Skeleton, Tabs } from '../components/ui';
import { useAction, useApi } from '../hooks/useApi';
import { isTaskLifecycleEvent, useLiveRefresh } from '../hooks/useEvents';
import { href } from '../hooks/useHashRoute';
import { lazyNamed } from '../lib/lazy';
import type { Agent } from '../types';
import { ChatTab } from './agent/ChatTab';
import { TasksTab } from './agent/TasksTab';
import { SAMPLE_TASK, SAMPLE_TASK_PARAM } from '../features/onboarding/sample';

// Chat (the default tab) and Tasks ship with the page; the other tabs are loaded when opened.
const LiveDesktop = lazyNamed(() => import('../components/LiveDesktop'), 'LiveDesktop');
const FileManager = lazyNamed(() => import('../features/files/FileManager'), 'FileManager');
const EnvironmentTab = lazyNamed(() => import('./agent/EnvironmentTab'), 'EnvironmentTab');
const MemoryTab = lazyNamed(() => import('./agent/MemoryTab'), 'MemoryTab');
const SettingsTab = lazyNamed(() => import('./agent/SettingsTab'), 'SettingsTab');
const SkillsTab = lazyNamed(() => import('./agent/SkillsTab'), 'SkillsTab');
const VoiceTab = lazyNamed(() => import('./agent/VoiceTab'), 'VoiceTab');
const SecurityTab = lazyNamed(() => import('../features/vault/AgentVaultSection'), 'AgentVaultSection');

export const AGENT_TABS = [
  { id: 'chat', label: 'Chat', icon: <IconChat /> },
  { id: 'live', label: 'Live Desktop', icon: <IconMonitor /> },
  { id: 'tasks', label: 'Tasks', icon: <IconTasks /> },
  { id: 'memory', label: 'Memory', icon: <IconMemory /> },
  { id: 'files', label: 'Files', icon: <IconFiles /> },
  { id: 'skills', label: 'Skills', icon: <IconSkills /> },
  { id: 'environment', label: 'Environment', icon: <IconEnvironment /> },
  { id: 'voice', label: 'Voice', icon: <IconVoice /> },
  { id: 'security', label: 'Security', icon: <IconShield /> },
  { id: 'settings', label: 'Settings', icon: <IconSettings /> },
] as const;
export type AgentTab = (typeof AGENT_TABS)[number]['id'];

function AgentQuickActions({ agent, onChanged }: { agent: Agent; onChanged: () => void }) {
  const { run, isPending } = useAction();
  const busy = agent.state === 'CREATING' || agent.state === 'DELETING' ? `Agent is ${agent.state}` : null;
  const act = async (key: string, fn: () => Promise<Agent>, msg: string) => {
    const r = await run(key, fn, { success: msg });
    if (r) onChanged();
  };
  const sleeping = agent.state === 'SLEEP' || agent.state === 'STOPPED';
  return (
    <>
      {agent.state === 'PAUSED' ? (
        <Button size="sm" icon={<IconPlay />} loading={isPending('resume')} onClick={() => act('resume', () => api.agents.resume(agent.id), `${agent.name} resumed`)}>
          Resume agent
        </Button>
      ) : (
        <Button size="sm" icon={<IconPause />} loading={isPending('pause')} disabledReason={busy} onClick={() => act('pause', () => api.agents.pause(agent.id), `${agent.name} paused`)}>
          Pause agent
        </Button>
      )}
      {sleeping ? (
        <Button size="sm" icon={<IconSun />} loading={isPending('wake')} disabledReason={busy} onClick={() => act('wake', () => api.agents.wake(agent.id), `${agent.name} is awake`)}>
          Wake
        </Button>
      ) : (
        <Button
          size="sm"
          icon={<IconMoon />}
          loading={isPending('sleep')}
          disabledReason={busy ?? (agent.state === 'ACTIVE' ? 'Pause or stop the running task first' : null)}
          onClick={() => act('sleep', () => api.agents.sleep(agent.id), `${agent.name} is sleeping`)}
        >
          Sleep
        </Button>
      )}
    </>
  );
}

export function AgentDetailPage({ agentId, tab, query }: { agentId: string; tab: string; query: URLSearchParams }) {
  const agent = useApi(() => api.agents.get(agentId), [agentId]);
  useLiveRefresh(
    agent.reload,
    (ev) =>
      ev.agent_id === agentId &&
      (ev.type.startsWith('agent.') || ev.type.startsWith('live.') || isTaskLifecycleEvent(ev)),
    400,
  );
  const active: AgentTab = (AGENT_TABS.find((t) => t.id === tab)?.id ?? 'chat') as AgentTab;
  const a = agent.data;

  if (!a) {
    if (agent.error instanceof ApiError && agent.error.status === 404) {
      return (
        <EmptyState title="Agent not found" action={<ButtonLink href={href('/agents')}>Back to agents</ButtonLink>}>
          It may have been deleted.
        </EmptyState>
      );
    }
    return agent.error ? (
      <ErrorBanner error={agent.error} onRetry={agent.reload} />
    ) : (
      <div className="space-y-4" role="status" aria-label="Loading agent…">
        <div className="flex items-center gap-3">
          <Skeleton className="size-11 rounded-xl" />
          <div className="space-y-2">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-3 w-72" />
          </div>
        </div>
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-72 w-full rounded-xl" />
      </div>
    );
  }

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Agents', href: href('/agents') }, { label: a.name }]}
        icon={<Avatar name={a.name} id={a.id} size="lg" avatar={agentAvatarOf(a)} />}
        title={a.name}
        meta={
          <>
            <StatusPill state={a.state} pulse={BUSY_STATES.has(a.state)} />
            <Badge>{a.permission_level.replace('_', ' ').toLowerCase()}</Badge>
            <Mono>{a.linux_user ?? '—'}</Mono>
            <Mono className="text-subtle">display {a.display_id ?? '—'}</Mono>
            <span className="text-xs text-muted">{a.model_id ?? 'no model configured'}</span>
          </>
        }
        description={a.description || undefined}
        actions={<AgentQuickActions agent={a} onChanged={agent.reload} />}
      />
      {agent.error ? (
        <div className="mb-4">
          <ErrorBanner error={agent.error} onRetry={agent.reload} title="Refresh failed" />
        </div>
      ) : null}
      {a.state === 'ERROR' && a.last_error && (
        <div className="mb-4">
          <Notice tone="danger" title="Agent error">
            {a.last_error}
          </Notice>
        </div>
      )}
      <Tabs label="Agent sections" tabs={[...AGENT_TABS]} active={active} hrefFor={(id) => href(`/agents/${a.id}/${id}`)} />
      <LazyBoundary
        resetKey={active}
        compact
        fallback={<PanelSkeleton label={`Loading ${AGENT_TABS.find((t) => t.id === active)?.label ?? 'tab'}…`} className={active === 'live' ? 'aspect-[16/10] h-auto' : 'h-72'} />}
      >
        {active === 'chat' && <ChatTab agent={a} initialPrompt={query.get(SAMPLE_TASK_PARAM) === '1' ? SAMPLE_TASK : undefined} />}
        {active === 'tasks' && <TasksTab agent={a} selectedTask={query.get('task')} />}
        {active === 'live' && <LiveDesktop agent={a} onAgentChanged={agent.reload} />}
        {active === 'memory' && <MemoryTab agent={a} onAgentChanged={agent.reload} />}
        {active === 'files' && <FileManager root={`agent:${a.id}`} />}
        {active === 'skills' && <SkillsTab agent={a} />}
        {active === 'environment' && <EnvironmentTab agent={a} onChanged={agent.reload} />}
        {active === 'voice' && <VoiceTab agent={a} />}
        {active === 'security' && <SecurityTab key={a.id} agent={a} />}
        {active === 'settings' && <SettingsTab key={a.id} agent={a} onChanged={agent.reload} />}
      </LazyBoundary>
    </>
  );
}
