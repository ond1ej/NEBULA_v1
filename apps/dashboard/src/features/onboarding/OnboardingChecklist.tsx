// First-run checklist on the Command Center: connect an AI provider -> create the first agent -> run a harmless sample
// task -> open Live Desktop -> (optional) remote access. Every step deep-links to the page that already does it and
// its done state comes from the existing APIs: the overview the Command Center already loads (providers, agents, their
// last activity, results) and, once the required steps are done, GET /remote. The checklist adds no request to the
// Command Center's first load. Dismissible.
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { IconAgents, IconCheckCircle, IconMonitor, IconProviders, IconRemote, IconTasks, IconX } from '../../components/icons';
import { Badge, ButtonLink, Card, IconButton } from '../../components/ui';
import { useLiveRefresh } from '../../hooks/useEvents';
import { href } from '../../hooks/useHashRoute';
import { isConnected } from '../../lib/providers';
import type { OverviewData } from '../../types';
import { remoteApi } from '../remote/api';
import { SAMPLE_TASK_PARAM } from './sample';
import { readLiveOpened, writeLiveOpened } from './storage';

interface Step {
  id: 'provider' | 'agent' | 'task' | 'live' | 'remote';
  title: string;
  body: string;
  icon: ReactNode;
  done: boolean;
  optional?: boolean;
  /** Route of the existing page, or null while an earlier step is missing. */
  to: string | null;
  cta: string;
  blocked?: string;
  onOpen?: () => void;
}

/** Is remote access set up? Only asked once the required steps are done (the step is optional), then kept current by events. */
function useRemoteDone(active: boolean): boolean {
  const [done, setDone] = useState(false);
  const load = useCallback(() => {
    remoteApi
      .status()
      .then((s) => setDone(Boolean(s.enabled && (s.public_mini_url || s.tunnel_running || s.tunnel === 'custom'))))
      .catch(() => undefined); // unknown stays "not done"
  }, []);
  useEffect(() => {
    if (active) load();
  }, [active, load]);
  useLiveRefresh(
    () => {
      if (active) load();
    },
    (e) => e.type === 'remote.state.changed',
    1000,
  );
  return done;
}

export function OnboardingChecklist({ overview, onDismiss }: { overview: OverviewData; onDismiss: () => void }) {
  const [liveOpened, setLiveOpened] = useState(readLiveOpened);

  const firstAgent = overview.agents[0];
  const providerDone = overview.providers.some((p) => isConnected(p.state));
  const agentDone = overview.agents.length > 0;
  // a task has run when any agent was ever active, or a result / running task is listed
  const taskDone = overview.agents.some((a) => a.last_active_at !== null) || overview.recent_results.length > 0 || overview.running_tasks.length > 0;
  const requiredDone = providerDone && agentDone && taskDone && liveOpened;
  const remoteDone = useRemoteDone(requiredDone);

  const steps: Step[] = [
    {
      id: 'provider',
      title: 'Connect an AI provider',
      body: 'Run a local model with Ollama (free), paste an API key, or sign in with ChatGPT. Claude and Gemini subscriptions are not supported.',
      icon: <IconProviders />,
      done: providerDone,
      to: '/providers',
      cta: 'Choose a provider',
    },
    {
      id: 'agent',
      title: 'Create your first agent',
      body: 'The defaults are the safe ones: Standard permissions and its own desktop inside the Ubuntu VM. You approve anything sensitive.',
      icon: <IconAgents />,
      done: agentDone,
      to: '/agents/new?first=1',
      cta: 'Create the agent',
    },
    {
      id: 'task',
      title: 'Run a harmless sample task',
      body: 'Asks the agent to open example.com and read its heading. Nothing is typed, saved or sent anywhere.',
      icon: <IconTasks />,
      done: taskDone,
      to: firstAgent ? `/agents/${firstAgent.id}/chat?${SAMPLE_TASK_PARAM}=1` : null,
      cta: 'Open the sample task',
      blocked: 'Create an agent first',
    },
    {
      id: 'live',
      title: 'Watch it in Live Desktop',
      body: 'See the agent’s browser as it works, and take over or hand back control whenever you want.',
      icon: <IconMonitor />,
      done: liveOpened,
      to: firstAgent ? `/agents/${firstAgent.id}/live` : null,
      cta: 'Open Live Desktop',
      blocked: 'Create an agent first',
      onOpen: () => {
        writeLiveOpened(true);
        setLiveOpened(true);
      },
    },
    {
      id: 'remote',
      title: 'Reach NEBULA from your phone',
      body: 'Optional. Private access over your tailnet with Tailscale Serve (recommended), or a public address for the Telegram Mini App.',
      icon: <IconRemote />,
      done: remoteDone,
      optional: true,
      to: '/remote',
      cta: 'Set up remote access',
    },
  ];

  const required = steps.filter((s) => !s.optional);
  const doneCount = required.filter((s) => s.done).length;
  const allDone = doneCount === required.length;
  const next = steps.find((s) => !s.done && !s.optional && s.to);

  return (
    <Card
      className="mb-5"
      title={allDone ? 'You are all set' : 'Get started with NEBULA'}
      subtitle={allDone ? 'Everything required is done. The remote access step is optional.' : `${doneCount} of ${required.length} steps done`}
      icon={<IconCheckCircle />}
      actions={<IconButton label="Dismiss the setup checklist" icon={<IconX />} onClick={onDismiss} />}
      padded={false}
    >
      <ol aria-label="Setup checklist" className="divide-y divide-border/60">
        {steps.map((s, i) => (
          <li key={s.id} data-testid={`onboarding-${s.id}`} data-done={s.done ? 'true' : 'false'} className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center sm:px-5">
            <div className="flex min-w-0 flex-1 items-start gap-3">
              <span
                aria-hidden
                className={`mt-0.5 grid size-6 shrink-0 place-items-center rounded-full border text-xs font-semibold ${s.done ? 'border-success/40 bg-success/15 text-success' : 'border-border-strong text-muted'}`}
              >
                {s.done ? <IconCheckCircle className="size-4" /> : i + 1}
              </span>
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-text">
                  {s.title}
                  {s.optional && <Badge>Optional</Badge>}
                  {s.done && <Badge tone="success">Done</Badge>}
                </p>
                <p className="mt-0.5 text-xs leading-5 text-muted">{s.body}</p>
              </div>
            </div>
            {s.to ? (
              <ButtonLink size="sm" variant={!s.done && next?.id === s.id ? 'primary' : 'secondary'} href={href(s.to)} onClick={s.onOpen} className="shrink-0 self-start sm:self-center">
                {s.done ? 'Open' : s.cta}
              </ButtonLink>
            ) : (
              <span className="shrink-0 self-start text-xs text-subtle sm:self-center">{s.blocked}</span>
            )}
          </li>
        ))}
      </ol>
    </Card>
  );
}
