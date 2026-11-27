import { describe, expect, it } from 'vitest';
import { ApiError } from '../../lib/http';
import {
  avatarError,
  CONNECTION_LOST,
  createBody,
  describeProblem,
  duplicateOf,
  formFromSettings,
  isRejection,
  OWNER_ONLY,
  sanitize,
  setCapability,
  setLevel,
  settingsPatch,
  validate,
  type AgentForm,
} from './form';
import type { AgentComposerSettings, CapabilityChoice } from './types';

const CAPS: CapabilityChoice[] = [
  { id: 'browser', label: 'Browser', description: '', default: true, requires_level: 'STANDARD' },
  { id: 'terminal', label: 'Terminal', description: '', default: false, requires_level: 'ADVANCED' },
];

const form = (over: Partial<AgentForm> = {}): AgentForm => ({
  name: '  Price   Scout ',
  description: '  Compares prices \n',
  avatar: null,
  providerId: 'p',
  modelId: 'm',
  instructions: '   ',
  capabilities: { browser: true, web_research: true, files: true, terminal: false, desktop: false, memory: true },
  extraSkills: ['b', 'a'],
  vaultAccess: 'none',
  level: 'STANDARD',
  resourceMode: 'ACTIVE',
  idleSleep: '',
  resolution: '1280x800',
  ...over,
});

const settings = (over: Partial<AgentComposerSettings> = {}): AgentComposerSettings =>
  ({
    agent: {} as AgentComposerSettings['agent'],
    name: 'Scout',
    description: '',
    avatar: null,
    provider_id: 'p',
    model_id: 'm',
    instructions: '',
    permission_level: 'STANDARD',
    capabilities: { browser: true, web_research: true, files: true, terminal: false, desktop: false, memory: true },
    extra_skills: [],
    vault_access: 'none',
    vault: { mode: 'NONE', grants: [] },
    environment: { env: 'vm', root_id: null, source: 'agent' },
    status: 'READY',
    resource_mode: 'ACTIVE',
    idle_sleep_minutes: 30,
    desktop_resolution: '1280x800',
    ready: true,
    ...over,
  }) as AgentComposerSettings;

describe('agent form', () => {
  it('builds the create body: normalised name, optional fields only when set, sorted skills', () => {
    expect(createBody(form({ avatar: { kind: 'initials', value: 'ps ' }, idleSleep: '15', instructions: ' Be brief. ' }))).toEqual({
      name: 'Price Scout',
      description: 'Compares prices',
      avatar: { kind: 'initials', value: 'PS' },
      provider_id: 'p',
      model_id: 'm',
      instructions: 'Be brief.',
      environment: 'vm',
      capabilities: { browser: true, web_research: true, files: true, terminal: false, desktop: false, memory: true },
      extra_skills: ['a', 'b'],
      vault_access: 'none',
      permission_level: 'STANDARD',
      resource_mode: 'ACTIVE',
      idle_sleep_minutes: 15,
      desktop_resolution: '1280x800',
    });
    const minimal = createBody(form({ description: '', extraSkills: [] }));
    expect(minimal).not.toHaveProperty('avatar');
    expect(minimal).not.toHaveProperty('instructions');
    expect(minimal).not.toHaveProperty('description');
    expect(minimal).not.toHaveProperty('idle_sleep_minutes');
  });

  it('PATCH diff: nothing for an untouched form; only changed fields; provider and model always together', () => {
    const s = settings();
    expect(settingsPatch(formFromSettings(s), s)).toEqual({});
    const f = { ...formFromSettings(s), modelId: 'm2', idleSleep: '', avatar: { kind: 'icon' as const, value: 'robot' } };
    f.capabilities = { ...f.capabilities, desktop: true };
    expect(settingsPatch(f, s)).toEqual({ provider_id: 'p', model_id: 'm2', idle_sleep_minutes: null, avatar: { kind: 'icon', value: 'robot' }, capabilities: { desktop: true } });
    // removing the avatar sends null
    const withAvatar = settings({ avatar: { kind: 'emoji', value: '🦊' } });
    expect(settingsPatch({ ...formFromSettings(withAvatar), avatar: null }, withAvatar)).toEqual({ avatar: null });
  });

  it('couples capabilities and the permission level', () => {
    const r = setCapability(form(), 'terminal', true, CAPS);
    expect(r.raisedTo).toBe('ADVANCED');
    expect(r.form.level).toBe('ADVANCED');
    const down = setLevel({ ...r.form, extraSkills: ['py', 'pdf'] }, 'STANDARD', CAPS, [
      { id: 'py', name: 'Python', requires_level: 'ADVANCED' } as { id: string; requires_level: string },
      { id: 'pdf', requires_level: 'STANDARD' },
    ]);
    expect(down.form.capabilities.terminal).toBe(false);
    expect(down.form.extraSkills).toEqual(['pdf']);
    expect(down.dropped).toEqual(['Terminal', 'Python']);
    // Read only allows no capability at all (the host refuses STANDARD tools there)
    expect(setLevel(form(), 'READ_ONLY', CAPS, []).form.capabilities.browser).toBe(false);
    expect(validate(form({ level: 'READ_ONLY' }), { nameMax: 64, descriptionMax: 1000, instructionsMax: 4000, idleMin: 0, idleMax: 1440 }, null, CAPS).capabilities).toBe(
      'Browser needs the Standard permission level',
    );
  });

  it('validates avatars like the host', () => {
    expect(avatarError({ kind: 'emoji', value: '🦊' })).toBeNull();
    expect(avatarError({ kind: 'emoji', value: '👨‍👩‍👧' })).toBeNull();
    expect(avatarError({ kind: 'emoji', value: '🛡️' })).toBeNull();
    expect(avatarError({ kind: 'emoji', value: 'ab' })).not.toBeNull();
    expect(avatarError({ kind: 'emoji', value: '1️⃣' })).not.toBeNull();
    expect(avatarError({ kind: 'initials', value: 'Q1' })).toBeNull();
    expect(avatarError({ kind: 'initials', value: 'ABC' })).not.toBeNull();
    expect(avatarError({ kind: 'icon', value: 'robot' }, ['robot'])).toBeNull();
    expect(avatarError({ kind: 'icon', value: 'nope' }, ['robot'])).not.toBeNull();
  });

  it('finds duplicates case-insensitively and validates idle sleep', () => {
    expect(duplicateOf('  researcher ', ['Researcher', 'Coder'])).toBe('Researcher');
    expect(duplicateOf('Research', ['Researcher'])).toBeNull();
    const lim = { nameMax: 64, descriptionMax: 1000, instructionsMax: 4000, idleMin: 0, idleMax: 1440 };
    expect(validate(form({ idleSleep: '2000' }), lim, null).idle_sleep).toBe('Whole minutes between 0 and 1440, or empty');
    expect(validate(form({ name: 'x'.repeat(65) }), lim, null).name).toBe('At most 64 characters');
    expect(validate(form({ name: 'Řešitel (CZ) v2.0' }), lim, null).name).toBeUndefined();
  });

  it('maps host errors to friendly messages and knows which ones are definitive', () => {
    const net = new ApiError(0, 'network_error', 'Cannot reach NEBULA');
    expect(describeProblem(net, { creating: true })).toEqual({ kind: 'network', message: CONNECTION_LOST });
    expect(isRejection(net)).toBe(false);
    const prov = new ApiError(502, 'provisioning_failed', 'desktop\u0000 did not start.', { agent_id: 'a9' });
    expect(describeProblem(prov, { creating: true })).toEqual({ kind: 'provisioning', message: 'desktop did not start', agentId: 'a9' });
    expect(isRejection(prov)).toBe(false);
    expect(describeProblem(new ApiError(503, 'upstream_unavailable', 'gateway timeout'), { creating: true }).kind).toBe('network');
    expect(describeProblem(new ApiError(403, 'agents_permission', 'no'))).toEqual({ kind: 'general', title: 'Not allowed', message: OWNER_ONLY });
    expect(describeProblem(new ApiError(409, 'duplicate_name', 'exists'), { name: 'Scout' })).toEqual({ kind: 'duplicate', name: 'Scout' });
    expect(isRejection(new ApiError(409, 'duplicate_name', 'exists'))).toBe(true);
    expect(describeProblem(new ApiError(422, 'invalid_avatar', 'emoji avatar: one emoji'))).toEqual({ kind: 'field', field: 'avatar', message: 'Emoji avatar: one emoji.' });
    expect(describeProblem(new ApiError(422, 'environment_local_only', 'native macOS execution can only be enabled on the Mac'))).toMatchObject({ kind: 'field', field: 'environment' });
    expect(describeProblem(new ApiError(422, 'unsupported_fields', "fields not accepted: ['linux_user']"))).toMatchObject({ kind: 'general', title: 'NEBULA did not accept these settings' });
    expect(sanitize('a\u0007b\n\nc')).toBe('a b c');
  });
});
