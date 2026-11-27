import { describe, expect, it } from 'vitest';
import { describeEvent } from '../../lib/events';

const ev = (type: string, payload: Record<string, unknown>, agent_id: string | null = null) => ({ type, agent_id, task_id: null, payload });

describe('vault events in the activity feed', () => {
  it('describes owner operations and agent sign-ins differently (vault.access with actor_type)', () => {
    const owner = describeEvent(ev('vault.access', { operation: 'reveal.password', outcome: 'ok', reason_code: null, actor_type: 'owner' }));
    expect(owner.title).toBe('Password Vault: password revealed');
    expect(owner.link).toBe('#/vault?tab=history');

    const denied = describeEvent(ev('vault.access', { operation: 'use.sign_in', outcome: 'denied', reason_code: 'origin_not_allowed', destination_origin: 'https://x.example', actor_type: 'agent' }, 'a1'), () => 'Researcher');
    expect(denied.title).toBe('Researcher was denied a vault credential');
    expect(denied.detail).toBe('https://x.example · origin_not_allowed');
    expect(denied.tone).toBe('warn');

    // Hosts without actor_type only sent agent events.
    expect(describeEvent(ev('vault.access', { operation: 'use.sign_in', outcome: 'ok' }, 'a1'), () => 'Researcher').title).toBe('Researcher signed in with a vault credential');
  });

  it('describes lock / unlock', () => {
    expect(describeEvent(ev('vault.status.changed', { exists: true, locked: true, entry_count: 3 })).title).toBe('Password Vault locked');
    expect(describeEvent(ev('vault.status.changed', { exists: true, locked: false, entry_count: 1 })).detail).toBe('1 credential');
  });
});
