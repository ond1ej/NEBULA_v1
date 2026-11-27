// Route: #/workflows (list), #/workflows/new, #/workflows/<id>[?run=<run id>] (editor / run view).
import { useHashRoute } from '../../hooks/useHashRoute';
import { WorkflowEditor } from './WorkflowEditor';
import { WorkflowList } from './WorkflowList';

export function WorkflowsPage() {
  const route = useHashRoute();
  const id = route.segments[0] === 'workflows' ? route.segments[1] : undefined;
  if (!id) return <WorkflowList />;
  return <WorkflowEditor key={id} workflowId={id} runId={route.query.get('run')} />;
}
