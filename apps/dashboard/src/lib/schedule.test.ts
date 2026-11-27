import { describe, expect, it } from 'vitest';
import { describeSchedule, describeWeekdays, intervalToSeconds, secondsToInterval } from './schedule';

describe('schedule descriptions', () => {
  it('describes every kind in plain words', () => {
    expect(describeSchedule('daily', { time: '07:15' }, 'UTC')).toBe('Every day at 07:15');
    expect(describeSchedule('weekly', { time: '08:30', weekdays: [1, 2, 3, 4, 5] }, 'UTC')).toBe('Every weekday at 08:30');
    expect(describeSchedule('weekly', { time: '10:00', weekdays: [1, 3] }, 'UTC')).toBe('Every Mon, Wed at 10:00');
    expect(describeSchedule('monthly', { time: '06:00', day: 15 }, 'UTC')).toBe('Monthly on day 15 at 06:00');
    expect(describeSchedule('interval', { every_s: 7200 }, 'UTC')).toBe('Every 2 hours');
    expect(describeSchedule('cron', { cron: '*/5 * * * *' }, 'UTC')).toBe('Cron */5 * * * *');
    expect(describeSchedule('once', { at: Date.UTC(2026, 11, 24, 18) / 1000 }, 'UTC')).toMatch(/^Once · /);
  });

  it('maps intervals to the largest whole unit', () => {
    expect(secondsToInterval(86400 * 2)).toEqual({ n: 2, unit: 'days' });
    expect(secondsToInterval(5400)).toEqual({ n: 90, unit: 'minutes' });
    expect(intervalToSeconds(3, 'hours')).toBe(10800);
  });

  it('summarises weekday sets', () => {
    expect(describeWeekdays([0, 1, 2, 3, 4, 5, 6])).toBe('every day');
    expect(describeWeekdays([6, 0])).toBe('weekends');
  });
});
