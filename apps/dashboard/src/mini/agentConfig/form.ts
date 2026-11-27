// Agent creator / settings form: state, client-side validation (the host validates everything again), the POST body,
// the PATCH diff (only changed fields) and the mapping of host error codes to friendly inline messages.
import { isApiError } from '../../lib/http';
import type {
  AgentAvatar,
  AgentCapabilityId,
  AgentComposerPatch,
  AgentComposerSettings,
  AgentLevel,
  AgentOptions,
  CapabilityChoice,
  CreateAgentBody,
  ModelChoice,
  VaultAccess,
} from './types';

export type CapKey = AgentCapabilityId | 'memory';

export interface AgentForm {
  name: string;
  description: string;
  /** null: initials from the name (nothing stored). */
  avatar: AgentAvatar | null;
  providerId: string;
  modelId: string;
  instructions: string;
  capabilities: Record<CapKey, boolean>;
  extraSkills: string[];
  vaultAccess: VaultAccess;
  level: AgentLevel;
  resourceMode: 'ACTIVE' | 'SLEEP';
  /** Minutes as typed ('' = never). */
  idleSleep: string;
  resolution: string;
}

export const LEVELS: AgentLevel[] = ['READ_ONLY', 'STANDARD', 'ADVANCED'];
export const LEVEL_LABEL: Record<string, string> = { READ_ONLY: 'Read only', STANDARD: 'Standard', ADVANCED: 'Advanced', HOST_CONTROL: 'Host control' };
export const CAP_KEYS: AgentCapabilityId[] = ['browser', 'web_research', 'files', 'terminal', 'desktop'];

/** Rank of a level; anything unknown (e.g. HOST_CONTROL) ranks above every choosable level. */
export function levelRank(level: string | null | undefined): number {
  const i = LEVELS.indexOf(level as AgentLevel);
  return i >= 0 ? i : 99;
}

export const levelAllows = (level: string, required: string | null | undefined) => levelRank(required ?? 'STANDARD') <= levelRank(level);

export const levelLabel = (level: string | null | undefined) => LEVEL_LABEL[level ?? ''] ?? (level ?? '').toLowerCase().replace(/_/g, ' ');

// ---------------------------------------------------------------- initial state
export function initialCreateForm(o: AgentOptions): AgentForm {
  const caps = {} as Record<CapKey, boolean>;
  for (const k of CAP_KEYS) caps[k] = false;
  for (const c of o.capabilities) caps[c.id] = Boolean(c.default);
  caps.memory = o.memory?.default !== false;
  const level = LEVELS.includes(o.default_level) ? o.default_level : 'STANDARD';
  // a default that the default level does not allow (never shipped by the host) starts off
  for (const c of o.capabilities) if (caps[c.id] && !levelAllows(level, c.requires_level)) caps[c.id] = false;
  return {
    name: '',
    description: '',
    avatar: null,
    providerId: '',
    modelId: '',
    instructions: '',
    capabilities: caps,
    extraSkills: [],
    vaultAccess: o.vault.options.find((v) => v.default)?.id ?? 'none',
    level,
    resourceMode: 'ACTIVE',
    idleSleep: '',
    resolution: o.advanced.default_resolution || o.advanced.resolutions[0] || '1280x800',
  };
}

export function formFromSettings(s: AgentComposerSettings): AgentForm {
  const caps = {} as Record<CapKey, boolean>;
  for (const k of CAP_KEYS) caps[k] = Boolean(s.capabilities?.[k]);
  caps.memory = s.capabilities?.memory !== false;
  return {
    name: s.name ?? '',
    description: s.description ?? '',
    avatar: s.avatar ?? null,
    providerId: s.provider_id ?? '',
    modelId: s.model_id ?? '',
    instructions: s.instructions ?? '',
    capabilities: caps,
    extraSkills: [...(s.extra_skills ?? [])].sort(),
    vaultAccess: s.vault_access === 'ask' ? 'ask' : 'none',
    level: (LEVELS.includes(s.permission_level as AgentLevel) ? s.permission_level : 'STANDARD') as AgentLevel,
    resourceMode: s.resource_mode === 'SLEEP' ? 'SLEEP' : 'ACTIVE',
    idleSleep: s.idle_sleep_minutes === null || s.idle_sleep_minutes === undefined ? '' : String(s.idle_sleep_minutes),
    resolution: s.desktop_resolution ?? '',
  };
}

// ---------------------------------------------------------------- level / capability coupling
/**
 * Switching a capability on raises the permission level to what it needs (Terminal → Advanced); returns the new form
 * and whether the level changed.
 */
export function setCapability(f: AgentForm, cap: CapKey, on: boolean, choices: CapabilityChoice[]): { form: AgentForm; raisedTo: AgentLevel | null } {
  const next: AgentForm = { ...f, capabilities: { ...f.capabilities, [cap]: on } };
  const need = choices.find((c) => c.id === cap)?.requires_level;
  if (on && need && !levelAllows(f.level, need) && LEVELS.includes(need)) {
    return { form: { ...next, level: need }, raisedTo: need };
  }
  return { form: next, raisedTo: null };
}

/** Lowering the level switches off what it no longer allows (capabilities and extra skills). */
export function setLevel(f: AgentForm, level: AgentLevel, choices: CapabilityChoice[], skills: { id: string; requires_level: string }[]): { form: AgentForm; dropped: string[] } {
  const caps = { ...f.capabilities };
  const dropped: string[] = [];
  for (const c of choices) {
    if (caps[c.id] && !levelAllows(level, c.requires_level)) {
      caps[c.id] = false;
      dropped.push(c.label);
    }
  }
  const extra = f.extraSkills.filter((id) => {
    const s = skills.find((x) => x.id === id);
    const keep = !s || levelAllows(level, s.requires_level);
    if (!keep && s) dropped.push((s as { name?: string }).name ?? s.id);
    return keep;
  });
  return { form: { ...f, level, capabilities: caps, extraSkills: extra }, dropped };
}

// ---------------------------------------------------------------- validation
export type FieldKey = 'name' | 'description' | 'avatar' | 'provider' | 'model' | 'instructions' | 'environment' | 'capabilities' | 'extra_skills' | 'vault' | 'level' | 'idle_sleep';

export const FIELD_LABEL: Record<FieldKey, string> = {
  name: 'Name',
  description: 'Description',
  avatar: 'Avatar',
  provider: 'AI provider',
  model: 'Model',
  instructions: 'System instructions',
  environment: 'Execution environment',
  capabilities: 'Capabilities',
  extra_skills: 'Extra skills',
  vault: 'Password Vault access',
  level: 'Permission level',
  idle_sleep: 'Idle sleep',
};

export type FormErrors = Partial<Record<FieldKey, string>>;

/** Letters, digits, spaces and . - _ ( ) — the host's agent name rule (NAME_RE). */
const NAME_CHARS = /^[\p{L}\p{M}\p{N}_ .\-()]+$/u;
const INITIALS = /^[\p{L}\p{N}]{1,2}$/u;
const EMOJI_CHAR = /^(?:‍|[^\p{L}\p{N}\p{C}\p{Z}])$/u;

export const normalizeName = (v: string) => v.replace(/\s+/g, ' ').trim();

/** An existing agent with this name (case-insensitive), as it is spelled there. */
export function duplicateOf(name: string, existing: string[]): string | null {
  const n = normalizeName(name).toLowerCase();
  if (!n) return null;
  return existing.find((x) => x.trim().toLowerCase() === n) ?? null;
}

export function avatarError(a: AgentAvatar | null, icons?: string[]): string | null {
  if (!a) return null;
  if (a.kind === 'initials') return INITIALS.test(a.value.trim()) ? null : 'Initials: one or two letters or digits';
  if (a.kind === 'icon') return a.value && (!icons || icons.includes(a.value)) ? null : 'Choose one of the icons';
  const chars = [...a.value.trim()];
  if (!chars.length) return 'Type or pick an emoji';
  if (chars.length > 8 || !chars.every((ch) => EMOJI_CHAR.test(ch))) return 'Use a single emoji (no letters or digits)';
  return null;
}

export function parseIdle(v: string): number | null | 'invalid' {
  const t = v.trim();
  if (!t) return null;
  if (!/^\d+$/.test(t)) return 'invalid';
  return Number(t);
}

export interface Limits {
  nameMax: number;
  descriptionMax: number;
  instructionsMax: number;
  idleMin: number;
  idleMax: number;
  icons?: string[];
}

export function limitsOf(o: AgentOptions | null | undefined): Limits {
  return {
    nameMax: o?.name_rules?.max ?? 64,
    descriptionMax: o?.limits?.description_max ?? 1000,
    instructionsMax: o?.limits?.instructions_max ?? 4000,
    idleMin: o?.advanced?.idle_sleep_minutes?.min ?? 0,
    idleMax: o?.advanced?.idle_sleep_minutes?.max ?? 1440,
    icons: o?.avatar?.icons,
  };
}

export function validate(f: AgentForm, lim: Limits, models: ModelChoice[] | null, choices: CapabilityChoice[] = []): FormErrors {
  const e: FormErrors = {};
  const name = normalizeName(f.name);
  if (!name) e.name = 'Enter a name';
  else if ([...name].length > lim.nameMax) e.name = `At most ${lim.nameMax} characters`;
  else if (!NAME_CHARS.test(name)) e.name = 'Use letters, digits, spaces and . - _ ( ) only';
  if ([...f.description.trim()].length > lim.descriptionMax) e.description = `At most ${lim.descriptionMax} characters`;
  const av = avatarError(f.avatar, lim.icons);
  if (av) e.avatar = av;
  if (!f.providerId) e.provider = 'Choose an AI provider';
  if (!f.modelId) e.model = 'Choose a model';
  else if (models) {
    const m = models.find((x) => x.id === f.modelId);
    if (m && !m.supports_tools) e.model = 'This model cannot use tools';
  }
  if ([...f.instructions.trim()].length > lim.instructionsMax) e.instructions = `At most ${lim.instructionsMax} characters`;
  const idle = parseIdle(f.idleSleep);
  if (idle === 'invalid' || (idle !== null && (idle < lim.idleMin || idle > lim.idleMax))) e.idle_sleep = `Whole minutes between ${lim.idleMin} and ${lim.idleMax}, or empty`;
  const tooHigh = choices.find((c) => f.capabilities[c.id] && !levelAllows(f.level, c.requires_level));
  if (tooHigh) e.capabilities = `${tooHigh.label} needs the ${levelLabel(tooHigh.requires_level)} permission level`;
  return e;
}

// ---------------------------------------------------------------- request bodies
export function createBody(f: AgentForm): CreateAgentBody {
  const body: CreateAgentBody = {
    name: normalizeName(f.name),
    provider_id: f.providerId,
    model_id: f.modelId,
    environment: 'vm',
    capabilities: { ...f.capabilities },
    extra_skills: [...f.extraSkills].sort(),
    vault_access: f.vaultAccess,
    permission_level: f.level,
    resource_mode: f.resourceMode,
    desktop_resolution: f.resolution,
  };
  const description = f.description.trim();
  if (description) body.description = description;
  if (f.avatar) body.avatar = { kind: f.avatar.kind, value: f.avatar.kind === 'initials' ? f.avatar.value.trim().toUpperCase() : f.avatar.value.trim() };
  const instructions = f.instructions.trim();
  if (instructions) body.instructions = instructions;
  const idle = parseIdle(f.idleSleep);
  if (typeof idle === 'number') body.idle_sleep_minutes = idle;
  return body;
}

const sameAvatar = (a: AgentAvatar | null | undefined, b: AgentAvatar | null | undefined) => (a?.kind ?? null) === (b?.kind ?? null) && (a?.value ?? null) === (b?.value ?? null);

/** Only what changed against the loaded settings (provider + model always together). */
export function settingsPatch(f: AgentForm, s: AgentComposerSettings): AgentComposerPatch {
  const p: AgentComposerPatch = {};
  const name = normalizeName(f.name);
  if (name !== s.name) p.name = name;
  if (f.description.trim() !== (s.description ?? '').trim()) p.description = f.description.trim();
  const avatar = f.avatar ? { kind: f.avatar.kind, value: f.avatar.kind === 'initials' ? f.avatar.value.trim().toUpperCase() : f.avatar.value.trim() } : null;
  if (!sameAvatar(avatar, s.avatar)) p.avatar = avatar;
  if (f.providerId !== (s.provider_id ?? '') || f.modelId !== (s.model_id ?? '')) {
    p.provider_id = f.providerId;
    p.model_id = f.modelId;
  }
  if (f.instructions.trim() !== (s.instructions ?? '').trim()) p.instructions = f.instructions.trim();
  const caps: Partial<Record<CapKey, boolean>> = {};
  for (const k of [...CAP_KEYS, 'memory'] as CapKey[]) {
    const was = k === 'memory' ? s.capabilities?.memory !== false : Boolean(s.capabilities?.[k]);
    if (f.capabilities[k] !== was) caps[k] = f.capabilities[k];
  }
  if (Object.keys(caps).length) p.capabilities = caps;
  const extra = [...f.extraSkills].sort();
  if (extra.join('\n') !== [...(s.extra_skills ?? [])].sort().join('\n')) p.extra_skills = extra;
  if (f.vaultAccess !== s.vault_access) p.vault_access = f.vaultAccess;
  if (f.level !== s.permission_level) p.permission_level = f.level;
  const idle = parseIdle(f.idleSleep);
  const idleNow = typeof idle === 'number' ? idle : null;
  if (idle !== 'invalid' && idleNow !== (s.idle_sleep_minutes ?? null)) p.idle_sleep_minutes = idleNow;
  return p;
}

// ---------------------------------------------------------------- inline errors
/** The part of the form a host field error is about: the error shows until that part changes. */
export function fieldSlice(f: AgentForm, field: FieldKey): string {
  switch (field) {
    case 'name':
      return f.name;
    case 'description':
      return f.description;
    case 'avatar':
      return JSON.stringify(f.avatar);
    case 'provider':
    case 'model':
      return `${f.providerId}|${f.modelId}`;
    case 'instructions':
      return f.instructions;
    case 'capabilities':
    case 'level':
    case 'extra_skills':
      return JSON.stringify([f.capabilities, f.level, f.extraSkills]);
    case 'vault':
      return f.vaultAccess;
    case 'idle_sleep':
      return f.idleSleep;
    default:
      return '';
  }
}

export interface FieldProblem {
  field: FieldKey;
  message: string;
  at: string;
}

/** Client errors (after the first submit) and host field errors that still apply. */
export function visibleErrors(f: AgentForm, client: FormErrors, attempted: boolean, server: FieldProblem | null): FormErrors {
  const e: FormErrors = attempted ? { ...client } : {};
  if (server && fieldSlice(f, server.field) === server.at) e[server.field] = server.message;
  return e;
}

// ---------------------------------------------------------------- host errors → friendly messages
export type Problem =
  | { kind: 'field'; field: FieldKey; message: string }
  | { kind: 'duplicate'; name: string }
  /** Outcome unknown (offline, timeout, 5xx): a retry reuses the Idempotency-Key. */
  | { kind: 'network'; message: string }
  | { kind: 'provisioning'; message: string; agentId: string | null }
  | { kind: 'general'; title: string; message: string };

/** Control characters out, one line, bounded: host messages are shown verbatim. */
export function sanitize(msg: unknown, max = 300): string {
  const s = String(msg ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const sentence = (msg: string) => {
  const s = sanitize(msg).replace(/[.\s]+$/, '');
  return s ? `${s.charAt(0).toUpperCase()}${s.slice(1)}.` : '';
};

export const CONNECTION_LOST = 'Connection lost — check whether the agent was created before retrying.';
export const OWNER_ONLY = 'Creating and changing agents needs the NEBULA owner account.';

const FIELD_CODES: Record<string, FieldKey> = {
  invalid_name: 'name',
  description_too_long: 'description',
  invalid_avatar: 'avatar',
  provider_disconnected: 'provider',
  provider_unsupported: 'provider',
  invalid_provider: 'provider',
  model_required: 'model',
  model_unavailable: 'model',
  model_without_tools: 'model',
  models_unavailable: 'model',
  instructions_too_long: 'instructions',
  invalid_instructions: 'instructions',
  environment_local_only: 'environment',
  capability_requires_level: 'capabilities',
  invalid_capability: 'capabilities',
  invalid_vault_access: 'vault',
  invalid_permission_level: 'level',
  invalid_idle_sleep: 'idle_sleep',
};

export function describeProblem(e: unknown, opts: { name?: string; creating?: boolean; capabilityLabel?: (id: string) => string } = {}): Problem {
  const unknownOutcome = (detail?: string) => ({
    kind: 'network' as const,
    message: opts.creating ? (detail ? `NEBULA did not confirm the agent (${detail}) — check whether the agent was created before retrying.` : CONNECTION_LOST) : detail ? `NEBULA did not answer (${detail}). Try again.` : 'Connection lost. Check your connection and try again.',
  });
  if (e instanceof DOMException && (e.name === 'AbortError' || e.name === 'TimeoutError')) return unknownOutcome();
  if (!isApiError(e)) return { kind: 'general', title: 'Something went wrong', message: sentence(e instanceof Error ? e.message : String(e)) };
  if (e.status === 0) return unknownOutcome();
  const d = e.details ?? {};
  switch (e.code) {
    case 'duplicate_name':
      return { kind: 'duplicate', name: opts.name ?? '' };
    case 'provisioning_failed':
      return { kind: 'provisioning', message: sanitize(e.message).replace(/[.\s]+$/, ''), agentId: typeof d.agent_id === 'string' ? d.agent_id : null };
    case 'capability_requires_level': {
      const cap = typeof d.capability === 'string' ? (opts.capabilityLabel?.(d.capability) ?? d.capability) : 'This capability';
      const lvl = typeof d.requires_level === 'string' ? levelLabel(d.requires_level) : 'a higher';
      return { kind: 'field', field: 'capabilities', message: `${cap} needs the ${lvl} permission level.` };
    }
    case 'model_without_tools':
      return { kind: 'field', field: 'model', message: 'This model cannot use tools, so it cannot work as an agent. Choose another model.' };
    case 'model_unavailable':
      return { kind: 'field', field: 'model', message: `${sentence(e.message)} Choose another model.` };
    case 'unsupported_capability':
    case 'unsupported_skill':
    case 'unsupported_fields':
      return { kind: 'general', title: 'NEBULA did not accept these settings', message: `${sentence(e.message)} Reload the Mini App and try again.` };
    case 'rate_limited': {
      const s = typeof d.retry_after === 'number' ? d.retry_after : null;
      const wait = s === null ? 'in a few minutes' : s < 90 ? `in about ${Math.max(1, Math.round(s))} seconds` : `in about ${Math.ceil(s / 60)} minutes`;
      return { kind: 'general', title: 'Too many agents created recently', message: `Try again ${wait}.` };
    }
    case 'agents_permission':
      return { kind: 'general', title: 'Not allowed', message: OWNER_ONLY };
    case 'agent_not_editable':
      return { kind: 'general', title: 'The agent cannot be changed right now', message: 'It is being created or deleted. Try again in a moment.' };
    case 'idempotency_key_required':
      return { kind: 'general', title: 'Could not create the agent', message: 'Reload the Mini App and try again.' };
    default:
  }
  const field = FIELD_CODES[e.code];
  if (field) return { kind: 'field', field, message: sentence(e.message) };
  if (e.status === 403) return { kind: 'general', title: 'Not allowed', message: OWNER_ONLY };
  if (e.status >= 500) return unknownOutcome(sanitize(e.message, 160));
  return { kind: 'general', title: opts.creating ? 'Could not create the agent' : 'Could not save the settings', message: sentence(e.message) };
}

/** A definitive rejection (4xx): nothing was created, so the next, changed submission gets a new Idempotency-Key. */
export function isRejection(e: unknown): boolean {
  return isApiError(e) && e.status >= 400 && e.status < 500 && e.status !== 408;
}
