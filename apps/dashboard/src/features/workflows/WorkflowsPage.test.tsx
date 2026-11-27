import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setCsrfToken } from '../../api';
import { ToastProvider } from '../../components/Toast';
import { installFetch, ok } from '../../test/fetchMock';
import type { Catalog, Workflow, WorkflowListItem } from './types';
import { WorkflowsPage } from './WorkflowsPage';

const catalog: Catalog = {
  schema_version: 1,
  limits: { max_nodes: 60, max_loop: 50, max_depth: 3 },
  blocks: [
    { type: 'trigger.manual', group: 'Triggers', label: 'Manual', params: {} },
    { type: 'action.run_agent', group: 'Actions', label: 'Run Agent', params: { agent_id: '', prompt: '', max_model_calls: 15 } },
    { type: 'logic.condition', group: 'Logic', label: 'Condition', params: { left: '{{last.state}}', op: 'equals', right: 'COMPLETED' } },
  ],
};

const wf: Workflow = {
  id: 'w1',
  name: 'Daily digest',
  description: 'Summarise the day',
  version: 3,
  enabled: true,
  trigger_types: ['trigger.manual'],
  max_runs_per_hour: 20,
  created_at: 1,
  updated_at: 1,
  definition: {
    schema_version: 1,
    nodes: [
      { id: 'manual_1', type: 'trigger.manual', label: 'Manual', params: {}, position: { x: 0, y: 0 } },
      { id: 'run_agent_1', type: 'action.run_agent', label: 'Summarise', params: { agent_id: 'a1', prompt: 'hi' }, position: { x: 300, y: 0 } },
    ],
    edges: [{ id: 'manual_1-out-run_agent_1', source: 'manual_1', target: 'run_agent_1', handle: 'out' }],
  },
};

const listItem: WorkflowListItem = { ...wf, last_run: { id: 'r1', state: 'COMPLETED', created_at: 1 } };

function renderPage() {
  return render(
    <ToastProvider>
      <WorkflowsPage />
    </ToastProvider>,
  );
}

beforeEach(() => setCsrfToken('csrf'));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  setCsrfToken(null);
  window.location.hash = '';
});

describe('WorkflowsPage list', () => {
  it('lists workflows and deletes only after confirmation (confirm=true)', async () => {
    window.location.hash = '#/workflows';
    const user = userEvent.setup();
    const { calls } = installFetch({
      'GET /api/v1/workflows': () => ok([listItem]),
      'DELETE /api/v1/workflows/w1': () => ok({ deleted: 'w1' }),
    });
    renderPage();
    expect(await screen.findByText('Daily digest')).toBeInTheDocument();
    expect(screen.getByText('COMPLETED')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Delete Daily digest' }));
    const dialog = await screen.findByRole('dialog');
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Delete workflow' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true));
    const del = calls.find((c) => c.method === 'DELETE')!;
    expect(del.url).toContain('confirm=true');
    expect(del.headers['x-csrf-token']).toBe('csrf');
    await waitFor(() => expect(screen.queryByText('Daily digest')).not.toBeInTheDocument());
  });

  it('toggles enabled with PATCH {enabled}', async () => {
    window.location.hash = '#/workflows';
    const user = userEvent.setup();
    const { calls } = installFetch({
      'GET /api/v1/workflows': () => ok([listItem]),
      'PATCH /api/v1/workflows/w1': () => ok({ ...wf, enabled: false }),
    });
    renderPage();
    const sw = await screen.findByRole('switch', { name: 'Disable Daily digest' });
    expect(sw).toHaveAttribute('aria-checked', 'true');
    await user.click(sw);
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ enabled: false }));
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Enable Daily digest' })).toHaveAttribute('aria-checked', 'false'));
  });
});

describe('WorkflowsPage editor', () => {
  function editorRoutes(extra: Record<string, Parameters<typeof installFetch>[0][string]> = {}) {
    return installFetch({
      'GET /api/v1/workflows/catalog': () => ok(catalog),
      'GET /api/v1/workflows/w1': () => ok(wf),
      'GET /api/v1/agents': () => ok([{ id: 'a1', name: 'Ada', state: 'READY' }]),
      'GET /api/v1/teams': () => ok([]),
      'GET /api/v1/files/roots': () => ok([{ id: 'exchange', type: 'exchange', label: 'Mac exchange folder' }]),
      'GET /api/v1/workflow-runs': () => ok([]),
      'POST /api/v1/workflows/validate': () => ok({ valid: true }),
      ...extra,
    });
  }

  it('renders the graph, adds a block from the palette, deletes it with the Delete key and saves', async () => {
    window.location.hash = '#/workflows/w1';
    const { calls } = editorRoutes({ 'PATCH /api/v1/workflows/w1': (c) => ok({ ...wf, version: 4, definition: (c.body as { definition: Workflow['definition'] }).definition }) });
    renderPage();
    expect(await screen.findByRole('button', { name: /^Summarise/ })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Valid')).toBeInTheDocument(), { timeout: 3000 });
    expect(calls.find((c) => c.path === '/api/v1/workflows/validate')?.body).toMatchObject({ definition: { schema_version: 1 } });

    // add a Condition block by tapping it in the palette
    fireEvent.click(await screen.findByRole('button', { name: 'Add Condition block' }));
    const added = await screen.findByRole('button', { name: /^Condition/, pressed: true });
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();

    // Delete key removes the selected block
    added.focus();
    fireEvent.keyDown(added, { key: 'Delete' });
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Condition/, pressed: true })).not.toBeInTheDocument());

    // rename + save -> PATCH without a definition (the graph is unchanged)
    fireEvent.change(screen.getByLabelText('Workflow name'), { target: { value: 'Daily digest v2' } });
    fireEvent.click(screen.getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ name: 'Daily digest v2', description: 'Summarise the day' });
  });

  it('shows the server validation error and marks the block', async () => {
    window.location.hash = '#/workflows/w1';
    editorRoutes({
      'POST /api/v1/workflows/validate': () => ok({ valid: false, error: "node run_agent_1 (action.run_agent): 'agent_id' is required" }),
    });
    renderPage();
    expect(await screen.findByRole('alert', {}, { timeout: 3000 })).toHaveTextContent("'agent_id' is required");
    expect(screen.getByRole('button', { name: /^Summarise.*has an error/ })).toBeInTheDocument();
  });

  it('run view shows per-block state from the run', async () => {
    window.location.hash = '#/workflows/w1?run=r1';
    editorRoutes({
      'GET /api/v1/workflow-runs/r1': () =>
        ok({
          id: 'r1',
          workflow_id: 'w1',
          workflow_version: 3,
          state: 'FAILED',
          trigger: 'manual',
          trigger_payload: {},
          context: {},
          origin_depth: 0,
          error: 'block(s) failed: run_agent_1',
          created_at: 1,
          updated_at: 2,
          finished_at: 5,
          workflow_name: 'Daily digest',
          definition: wf.definition,
          steps: [
            { id: 's1', run_id: 'r1', node_id: 'manual_1', node_type: 'trigger.manual', state: 'COMPLETED', attempt: 1, output: { _handle: 'out' }, ref: null, error: null, started_at: 1, finished_at: 1 },
            { id: 's2', run_id: 'r1', node_id: 'run_agent_1', node_type: 'action.run_agent', state: 'FAILED', attempt: 1, output: null, ref: { task_id: 't9' }, error: 'agent task FAILED: quota', started_at: 2, finished_at: 5 },
          ],
        }),
    });
    renderPage();
    expect(await screen.findByRole('button', { name: /^Summarise.*state failed/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Manual.*state completed/ })).toBeInTheDocument();
    expect(screen.getAllByText('agent task FAILED: quota').length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: /Open task/ })).toHaveAttribute('href', '#/tasks?task=t9');
    await act(async () => undefined);
  });
});
