import { api } from '../../api';
import { IconTasks } from '../../components/icons';
import { Drawer } from '../../components/Modal';
import { TaskDetailPanel } from '../../components/TaskDetail';
import { TaskTable } from '../../components/TaskTable';
import { ButtonLink, EmptyState, ErrorBanner, LoadingRows } from '../../components/ui';
import { useApi } from '../../hooks/useApi';
import { isTaskLifecycleEvent, useLiveRefresh, useNebulaEvents } from '../../hooks/useEvents';
import { applyStepEvent } from '../../lib/taskRows';
import { href, navigate } from '../../hooks/useHashRoute';
import type { Agent } from '../../types';

export function TasksTab({ agent, selectedTask }: { agent: Agent; selectedTask: string | null }) {
  const tasks = useApi(() => api.agents.tasks(agent.id, 100), [agent.id]);
  useLiveRefresh(tasks.reload, (ev) => ev.agent_id === agent.id && isTaskLifecycleEvent(ev));
  useNebulaEvents((ev) => {
    if (ev.type === 'task.step' && ev.agent_id === agent.id) tasks.setData((xs) => applyStepEvent(xs, ev));
  });
  const select = (id: string | null) => navigate(`/agents/${agent.id}/tasks${id ? `?task=${id}` : ''}`, { replace: true });

  return (
    <div className="space-y-4">
      {tasks.error ? <ErrorBanner error={tasks.error} onRetry={tasks.reload} /> : null}
      {!tasks.data && tasks.loading ? (
        <div className="rounded-xl border border-border bg-panel p-5">
          <LoadingRows label="Loading tasks…" />
        </div>
      ) : tasks.data && tasks.data.length === 0 ? (
        <EmptyState icon={<IconTasks />} title="No tasks yet" action={<ButtonLink href={href(`/agents/${agent.id}/chat`)} variant="primary">Open chat</ButtonLink>}>
          Send a task from the Chat tab.
        </EmptyState>
      ) : (
        <TaskTable tasks={tasks.data ?? []} selectedId={selectedTask} onSelect={(id) => select(id)} />
      )}
      <Drawer open={selectedTask !== null} onClose={() => select(null)} title="Task details" width="lg">
        {selectedTask && <TaskDetailPanel key={selectedTask} taskId={selectedTask} variant="plain" />}
      </Drawer>
    </div>
  );
}
