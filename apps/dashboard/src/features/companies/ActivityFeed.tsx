// Company activity feed / project timeline (company_activity rows, newest first).
import { IconActivity } from '../../components/icons';
import { Badge, EmptyState, StatusDot, TextLink } from '../../components/ui';
import { href } from '../../hooks/useHashRoute';
import { formatTime, relativeTime } from '../../lib/format';
import { ENV_SHORT, isEnv } from '../environment/EnvBadge';
import { ACTIVITY_TONE } from './lib';
import type { Activity } from './types';

export function ActivityFeed({
  items,
  companyId,
  agentName,
  projectName,
  showProject = true,
  emptyText = 'Nothing has happened yet.',
}: {
  items: Activity[];
  companyId: string;
  agentName: (id: string) => string | null;
  projectName?: (id: string) => string | null;
  showProject?: boolean;
  emptyText?: string;
}) {
  if (items.length === 0)
    return (
      <EmptyState compact icon={<IconActivity />} title="No activity yet">
        {emptyText}
      </EmptyState>
    );
  return (
    <ol aria-label="Activity" className="relative space-y-0">
      {items.map((a, i) => {
        const tone = ACTIVITY_TONE[a.kind] ?? 'neutral';
        const env = a.payload && typeof a.payload === 'object' ? (a.payload as { environment?: unknown }).environment : undefined;
        const agent = a.agent_id ? agentName(a.agent_id) : null;
        const project = showProject && a.project_id && projectName ? projectName(a.project_id) : null;
        return (
          <li key={a.id} className="relative flex gap-3 pb-4 last:pb-0">
            {i < items.length - 1 && <span aria-hidden className="absolute top-4 bottom-0 left-[3.5px] w-px bg-border" />}
            <StatusDot tone={tone} label={a.kind} className="mt-1.5" />
            <div className="min-w-0 flex-1">
              <p className="text-sm break-words text-text">{a.content}</p>
              <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-subtle">
                <Badge tone={tone}>{a.kind}</Badge>
                {agent && <TextLink href={href(`/agents/${a.agent_id}`)}>{agent}</TextLink>}
                {project && a.project_id && <TextLink href={href(`/companies/${companyId}/projects/${a.project_id}`)}>{project}</TextLink>}
                {isEnv(env) && <span>{ENV_SHORT[env]}</span>}
                {a.run_id && (
                  <TextLink href={href(`/companies/${companyId}/runs/${a.run_id}`)} className="font-mono">
                    run {a.run_id.slice(0, 8)}
                  </TextLink>
                )}
                <time title={formatTime(a.ts)}>{relativeTime(a.ts)}</time>
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
