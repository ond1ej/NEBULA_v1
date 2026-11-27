import { describe, expect, it } from 'vitest';
import { ACTION_TYPES, LOGIC_TYPES, REQUIRED, TRIGGER_TYPES } from './graph';
import { BLOCK_FIELDS, BLOCK_NOTES, checkParams, checkSchedule, defaultSpec, fromLocalInput, numberParam, toLocalInput } from './params';
import { slugify } from './WorkflowList';

const ALL = [...TRIGGER_TYPES, ...ACTION_TYPES, ...LOGIC_TYPES];

describe('block parameter spec', () => {
  it('has an editor and a description for every block type', () => {
    for (const t of ALL) {
      expect(BLOCK_FIELDS[t], t).toBeDefined();
      expect(BLOCK_NOTES[t], t).toBeTruthy();
    }
  });

  it('offers an input for every required parameter', () => {
    for (const [t, keys] of Object.entries(REQUIRED)) {
      const fieldKeys = BLOCK_FIELDS[t].map((f) => f.key);
      for (const k of keys) expect(fieldKeys, `${t}.${k}`).toContain(k);
    }
  });
});

describe('checkParams', () => {
  it('flags required, range and pattern problems', () => {
    expect(checkParams('action.run_agent', { agent_id: '', prompt: 'x', max_model_calls: 99 })).toEqual({
      agent_id: 'Required',
      max_model_calls: 'Maximum 50',
    });
    expect(checkParams('logic.delay', { seconds: -1 })).toEqual({ seconds: 'Minimum 0' });
    expect(checkParams('trigger.telegram_message', { command: 'Report!' })).toHaveProperty('command');
    expect(checkParams('trigger.telegram_message', { command: 'daily_report' })).toEqual({});
    expect(checkParams('logic.condition', { left: 'x', op: 'nope' })).toHaveProperty('op');
    expect(checkParams('logic.branch', { value: 'v', cases: ['a', 'a'] })).toEqual({ cases: 'Cases must be unique' });
    expect(checkParams('logic.branch', { value: 'v', cases: ['default'] })).toHaveProperty('cases');
    expect(checkParams('action.browser_task', { agent_id: 'a', url: 'example.com', instructions: 'x' })).toHaveProperty('url');
    expect(checkParams('action.browser_task', { agent_id: 'a', url: '{{trigger.url}}', instructions: 'x' })).toEqual({});
    expect(checkParams('action.generate_report', { template: 't', save_root: 'exchange' })).toHaveProperty('save_path');
  });
});

describe('schedules', () => {
  const now = Date.UTC(2026, 0, 1) ;
  it('validates each kind', () => {
    expect(checkSchedule({ kind: 'daily', spec: { time: '08:00' }, timezone: 'Europe/Prague' }, now)).toBeNull();
    expect(checkSchedule({ kind: 'daily', spec: { time: '25:00' }, timezone: 'UTC' }, now)).toMatch(/HH:MM/);
    expect(checkSchedule({ kind: 'weekly', spec: { time: '08:00', weekdays: [] }, timezone: 'UTC' }, now)).toMatch(/weekday/);
    expect(checkSchedule({ kind: 'monthly', spec: { time: '08:00', day: 32 }, timezone: 'UTC' }, now)).toMatch(/1–31/);
    expect(checkSchedule({ kind: 'interval', spec: { every_s: 30 }, timezone: 'UTC' }, now)).toMatch(/1 minute/);
    expect(checkSchedule({ kind: 'once', spec: { at: now / 1000 - 10 }, timezone: 'UTC' }, now)).toBeNull(); // already fired: allowed
    expect(checkSchedule({ kind: 'once', spec: { at: now / 1000 + 3600 }, timezone: 'UTC' }, now)).toBeNull();
    expect(checkSchedule({ kind: 'cron', spec: { cron: '0 8 * *' }, timezone: 'UTC' }, now)).toMatch(/5 fields/);
    expect(checkSchedule({ kind: 'cron', spec: { cron: '@daily' }, timezone: 'UTC' }, now)).toBeNull();
    expect(checkSchedule({ kind: 'daily', spec: { time: '08:00' }, timezone: '' }, now)).toMatch(/zone/);
    expect(checkSchedule({ kind: 'daily', spec: { time: '08:00' }, timezone: 'UTC', misfire_policy: 'later' }, now)).toMatch(/missed/);
  });

  it('default specs are valid for every kind', () => {
    for (const k of ['daily', 'weekly', 'monthly', 'interval', 'once', 'cron'])
      expect(checkSchedule({ kind: k, spec: defaultSpec(k, now), timezone: 'UTC' }, now), k).toBeNull();
  });

  it('round-trips datetime-local values', () => {
    const ts = fromLocalInput('2026-03-04T05:06');
    expect(ts).toBeTypeOf('number');
    expect(toLocalInput(ts!)).toBe('2026-03-04T05:06');
    expect(toLocalInput(0)).toBe('');
    expect(fromLocalInput('')).toBeUndefined();
  });
});

describe('helpers', () => {
  it('number inputs', () => {
    expect(numberParam('')).toBeUndefined();
    expect(numberParam(' 12 ')).toBe(12);
    expect(numberParam('abc')).toBeUndefined();
  });

  it('export file names', () => {
    expect(slugify('Denní report – Příliš žluťoučký')).toBe('denni-report-prilis-zlutoucky');
    expect(slugify('***')).toBe('workflow');
  });
});
