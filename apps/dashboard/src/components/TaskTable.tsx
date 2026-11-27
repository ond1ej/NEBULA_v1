import { formatTime, relativeTime, shortId } from '../lib/format';
import type { Task } from '../types';
import { StatusPill } from './StatusPill';
import { isTerminal } from './TaskDetail';
import { DataTable, Mono, type Column } from './ui';

/** Task list used by the agent Tasks tab and the global Tasks page (cards on phones). */
export function TaskTable({
  tasks,
  selectedId,
  onSelect,
  showAgent = false,
}: {
  tasks: Task[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  showAgent?: boolean;
}) {
  const columns: Column<Task>[] = [
    {
      key: 'state',
      header: 'State',
      mobile: 'aside',
      className: 'w-[150px]',
      cell: (t) => (
        <div>
          <StatusPill state={t.state} pulse={!isTerminal(t.state)} />
          <div className="mt-1 hidden md:block">
            <Mono className="text-[10px] text-subtle">{shortId(t.id)}</Mono>
          </div>
        </div>
      ),
    },
    ...(showAgent
      ? [
          {
            key: 'agent',
            header: 'Agent',
            mobile: 'subtitle' as const,
            className: 'whitespace-nowrap',
            cell: (t: Task) => <span className="text-text">{t.agent_name ?? shortId(t.agent_id)}</span>,
          },
        ]
      : []),
    {
      key: 'prompt',
      header: 'Prompt',
      mobile: 'title',
      className: 'max-w-[380px]',
      cell: (t) => (
        <div className="min-w-0">
          <p className="line-clamp-2 text-text">{t.prompt}</p>
          <p className="mt-0.5 text-xs text-subtle">
            via {t.source_channel}
            {t.retry_count ? ` · retry #${t.retry_count}` : ''}
          </p>
        </div>
      ),
    },
    {
      key: 'progress',
      header: 'Progress',
      className: 'whitespace-nowrap',
      cell: (t) => (
        <span className="text-muted tabular-nums">
          step {t.current_step} / {t.max_steps}
          <span className="block text-xs text-subtle">{t.tool_calls_done} tool calls</span>
        </span>
      ),
    },
    {
      key: 'result',
      header: 'Result / failure',
      className: 'max-w-[300px]',
      cell: (t) =>
        t.failure_reason ? (
          <p className={`line-clamp-2 text-xs ${t.state === 'FAILED' ? 'text-danger' : 'text-warn'}`}>{t.failure_reason}</p>
        ) : t.result?.summary ? (
          <p className="line-clamp-2 text-xs text-muted">{t.result.summary}</p>
        ) : (
          <span className="text-xs text-subtle">—</span>
        ),
    },
    {
      key: 'created',
      header: 'Created',
      className: 'whitespace-nowrap',
      cell: (t) => (
        <span className="text-xs text-muted" title={formatTime(t.created_at)}>
          {relativeTime(t.created_at)}
        </span>
      ),
    },
  ];
  return (
    <DataTable
      label="Tasks"
      columns={columns}
      rows={tasks}
      rowKey={(t) => t.id}
      onRowClick={(t) => onSelect(t.id)}
      rowLabel={(t) => `Open task ${shortId(t.id)}`}
      selectedKey={selectedId}
      minWidth={760}
    />
  );
}
