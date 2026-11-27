import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { TeamSubtask } from '../types';
import { CollabGraph, layoutGraph } from './CollabGraph';

const sub = (id: string, extra: Partial<TeamSubtask> = {}): TeamSubtask => ({
  id,
  run_id: 'r',
  parent_subtask_id: null,
  agent_id: `agent-${id}`,
  agent_name: `Agent ${id}`,
  role: `role ${id}`,
  title: `title ${id}`,
  prompt: '',
  depends_on: [],
  state: 'PENDING',
  task_id: null,
  attempts: 0,
  max_attempts: 2,
  depth: 0,
  result_summary: null,
  artifacts: [],
  created_at: Number(id.replace(/\D/g, '')) || 0,
  updated_at: 0,
  ...extra,
});

describe('layoutGraph', () => {
  it('places a sequential pipeline on consecutive levels', () => {
    const g = layoutGraph([sub('s1'), sub('s2', { depends_on: ['s1'] }), sub('s3', { depends_on: ['s2'] })]);
    expect(g.levels).toBe(3);
    expect(g.nodes.map((n) => n.level)).toEqual([0, 1, 2]);
    expect(g.edges).toEqual([
      { from: 's1', to: 's2', kind: 'dependency' },
      { from: 's2', to: 's3', kind: 'dependency' },
    ]);
  });

  it('puts parallel workers on one level and the aggregating lead after them; delegations become edges', () => {
    const g = layoutGraph([
      sub('w1'),
      sub('w2'),
      sub('l3', { parent_subtask_id: 'aggregate', depends_on: ['w1', 'w2'] }),
      sub('d4', { parent_subtask_id: 'w1', depth: 1 }),
    ]);
    const lv = Object.fromEntries(g.nodes.map((n) => [n.id, n.level]));
    expect(lv).toEqual({ w1: 0, w2: 0, l3: 1, d4: 1 });
    expect(g.edges).toContainEqual({ from: 'w1', to: 'd4', kind: 'delegation' });
    // "lead" / "aggregate" markers are not subtask ids and never produce edges
    expect(g.edges.filter((e) => e.kind === 'delegation')).toHaveLength(1);
  });
});

describe('CollabGraph', () => {
  it('renders accessible nodes that can be selected by keyboard', async () => {
    const onSelect = vi.fn();
    render(<CollabGraph subtasks={[sub('s1', { state: 'COMPLETED' }), sub('s2', { depends_on: ['s1'], state: 'RUNNING' })]} selected={null} onSelect={onSelect} />);
    const node = screen.getByRole('button', { name: 'title s2 by Agent s2: running' });
    node.focus();
    await userEvent.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledWith('s2');
  });
});
