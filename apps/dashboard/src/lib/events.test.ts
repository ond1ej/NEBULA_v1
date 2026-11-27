import { describe, expect, it } from 'vitest';
import { describeEvent } from './events';

const ev = (type: string, payload: Record<string, unknown> = {}, agent_id: string | null = null, task_id: string | null = null) => ({ type, payload, agent_id, task_id });

describe('describeEvent', () => {
  it('links team runs and schedules to their pages', () => {
    const v = describeEvent(ev('team.run.started', { team: 'Squad', team_id: 'tm1', run_id: 'r1', prompt: 'Brief' }));
    expect(v.title).toBe('Team Squad started a run');
    expect(v.link).toBe('#/teams/tm1/runs/r1');
    const s = describeEvent(ev('schedule.run.finished', { name: 'Morning', schedule_id: 'sc1', state: 'FAILED', detail: 'boom' }));
    expect(s.tone).toBe('danger');
    expect(s.link).toBe('#/schedules/sc1');
    expect(s.detail).toBe('boom');
  });

  it('uses agent names and task links for task events', () => {
    const v = describeEvent(ev('task.failed', { reason: 'quota' }, 'a1', 't1'), (id) => (id === 'a1' ? 'Researcher' : undefined));
    expect(v.title).toBe('Task failed on Researcher');
    expect(v.link).toBe('#/agents/a1/tasks?task=t1');
  });

  it('marks critical resource alerts and owner approvals', () => {
    expect(describeEvent(ev('resource.alert', { level: 'critical', message: 'low disk' })).tone).toBe('danger');
    expect(describeEvent(ev('owner.approval.requested', { summary: 'Run it?' })).detail).toBe('Run it?');
  });
});
