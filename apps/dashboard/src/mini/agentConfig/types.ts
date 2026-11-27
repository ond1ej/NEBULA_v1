// Types of the V3.2.2 agent composer endpoints (GET /miniapp/agent-options, …/models, POST /miniapp/agents,
// GET/PATCH /miniapp/agents/{id}/settings). AgentComposerSettings / AgentComposerPatch live in ../../types (shared
// with the Dashboard card).
import type { AgentAvatar, AgentAvatarKind, AgentCapabilityId, AgentLevel, VaultAccess } from '../../types';

export type { AgentAvatar, AgentAvatarKind, AgentCapabilityId, AgentLevel, VaultAccess };
export type { AgentComposerPatch, AgentComposerSettings } from '../../types';

export interface ProviderChoice {
  id: string;
  name: string;
  state: string;
  connected: boolean;
  reason: string | null;
}

export interface EnvironmentChoice {
  id: 'vm' | 'host';
  label: string;
  available: boolean;
  default: boolean;
  description: string;
  reason?: string;
  authorised_folders?: number;
}

export interface CapabilityChoice {
  id: AgentCapabilityId;
  label: string;
  description: string;
  default: boolean;
  requires_level: AgentLevel;
}

export interface ExtraSkillChoice {
  id: string;
  name: string;
  description: string;
  kind: string;
  requires_level: AgentLevel | string;
}

export interface AgentOptions {
  providers: ProviderChoice[];
  environments: EnvironmentChoice[];
  capabilities: CapabilityChoice[];
  memory: { default: boolean; description: string };
  extra_skills: ExtraSkillChoice[];
  levels: { id: AgentLevel; description: string }[];
  default_level: AgentLevel;
  vault: { options: { id: VaultAccess; label: string; description: string; default?: boolean }[]; granted_note: string };
  approvals: { sensitive_actions_need_approval: boolean; always: string[]; note: string };
  advanced: {
    resource_modes: ('ACTIVE' | 'SLEEP')[];
    resolutions: string[];
    default_resolution: string;
    idle_sleep_minutes: { min: number; max: number; default: null };
    not_here: string;
  };
  avatar: { kinds: AgentAvatarKind[]; icons: string[] };
  name_rules: { max: number; pattern: string };
  existing_names: string[];
  default_instructions: string;
  limits: { instructions_max: number; description_max: number };
}

export interface ModelChoice {
  id: string;
  name: string;
  supports_tools: boolean;
  supports_images: boolean;
  context_tokens: number | null;
}

export interface CreateAgentBody {
  name: string;
  description?: string;
  avatar?: AgentAvatar | null;
  provider_id: string;
  model_id: string;
  instructions?: string;
  environment: 'vm';
  capabilities?: Partial<Record<AgentCapabilityId | 'memory', boolean>>;
  extra_skills?: string[];
  vault_access?: VaultAccess;
  permission_level?: AgentLevel;
  resource_mode?: 'ACTIVE' | 'SLEEP';
  idle_sleep_minutes?: number | null;
  desktop_resolution?: string;
  allow_duplicate_name?: boolean;
}
