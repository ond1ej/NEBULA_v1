import { useId, useMemo } from 'react';
import { api } from '../api';
import { IconRefresh, IconTasks } from '../components/icons';
import { Drawer } from '../components/Modal';
import { TaskDetailPanel } from '../components/TaskDetail';
import { TaskTable } from '../components/TaskTable';
import { Button, EmptyState, ErrorBanner, LoadingRows, PageHeader, SegmentedControl, Select } from '../components/ui';
import { useApi } from '../hooks/useApi';
import { isTaskLifecycleEvent, useLiveRefresh, useNebulaEvents } from '../hooks/useEvents';
import { applyStepEvent } from '../lib/taskRows';
import { navigate } from '../hooks/useHashRoute';
import { TERMINAL_TASK_STATES } from '../types';

export const TASK_STATE_FILTERS = [
  'RECEIVED',
  'QUEUED',
  'PLANNING',
  'EXECUTING',
  'VERIFYING',
  'WAITING_APPROVAL',
  'WAITING_PROVIDER',
  'WAITING_CONTROL',
  'PAUSING',
  'PAUSED',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
];

type Group = 'all' | 'open' | 'done';

export function TasksPage({ query }: { query: URLSearchParams }) {
  const id = useId();
  const state = query.get('state') ?? '';
  const group = (query.get('group') as Group | null) ?? 'all';
  const selected = query.get('task');
  const tasks = useApi(() => api.tasks.list(state || undefined, 300), [state]);
  useLiveRefresh(tasks.reload, isTaskLifecycleEvent, 500);
  useNebulaEvents((ev) => {
    if (ev.type === 'task.step') tasks.setData((xs) => applyStepEvent(xs, ev));
  });

  const go = (next: { state?: string; task?: string | null; group?: Group }) => {
    const qs = new URLSearchParams();
    const st = next.state !== undefined ? next.state : state;
    const tk = next.task !== undefined ? next.task : selected;
    const gr = next.group !== undefined ? next.group : group;
    if (st) qs.set('state', st);
    if (gr !== 'all' && !st) qs.set('group', gr);
    if (tk) qs.set('task', tk);
    const s = qs.toString();
    navigate(`/tasks${s ? `?${s}` : ''}`, { replace: true });
  };

  const rows = useMemo(() => {
    const all = tasks.data ?? [];
    if (state || group === 'all') return all;
    return all.filter((t) => (group === 'done' ? TERMINAL_TASK_STATES.includes(t.state) : !TERMINAL_TASK_STATES.includes(t.state)));
  }, [tasks.data, state, group]);

  return (
    <>
      <PageHeader title="Tasks" description="Queue, progress, results, failure reasons and run logs across all agents." />
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
        <SegmentedControl<Group>
          label="Task group"
          value={state ? 'all' : group}
          onChange={(g) => go({ group: g, state: '', task: null })}
          options={[
            { value: 'all', label: 'All' },
            { value: 'open', label: 'Open' },
            { value: 'done', label: 'Finished' },
          ]}
        />
        <div className="flex items-center gap-2">
          <label htmlFor={id} className="shrink-0 text-xs text-muted">
            State
          </label>
          <Select id={id} value={state} onChange={(e) => go({ state: e.target.value, task: null })} className="w-full sm:w-52">
            <option value="">Any state</option>
            {TASK_STATE_FILTERS.map((s) => (
              <option key={s} value={s}>
                {s.replace(/_/g, ' ')}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex items-center gap-3 sm:ml-auto">
          {tasks.data && <p className="text-sm text-muted tabular-nums">{rows.length} task(s)</p>}
          <Button size="sm" icon={<IconRefresh />} onClick={tasks.reload} loading={tasks.loading && !!tasks.data}>
            Refresh
          </Button>
        </div>
      </div>
      {tasks.error ? (
        <div className="mb-4">
          <ErrorBanner error={tasks.error} onRetry={tasks.reload} />
        </div>
      ) : null}
      {!tasks.data && tasks.loading ? (
        <div className="rounded-xl border border-border bg-panel p-5">
          <LoadingRows rows={6} label="Loading tasks…" />
        </div>
      ) : tasks.data && rows.length === 0 ? (
        <EmptyState icon={<IconTasks />} title={state ? `No ${state.replace(/_/g, ' ').toLowerCase()} tasks` : 'No tasks here'}>
          Tasks are created from an agent’s Chat tab, Telegram, team runs, schedules and workflows.
        </EmptyState>
      ) : (
        <TaskTable tasks={rows} selectedId={selected} onSelect={(t) => go({ task: t })} showAgent />
      )}
      <Drawer open={selected !== null} onClose={() => go({ task: null })} title="Task details" width="lg">
        {selected && <TaskDetailPanel key={selected} taskId={selected} variant="plain" />}
      </Drawer>
    </>
  );
}
