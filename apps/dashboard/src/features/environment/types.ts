// Types for execution environments and host access (routes_v3.py "environments & host execution").
import type { Epoch } from '../../types';

export type EnvId = 'vm' | 'host';

/** Level that decided an agent's effective environment (most specific wins). */
export type EnvLevel = 'agent' | 'company' | 'project' | 'member' | 'assignment';

export interface EnvChainStep {
  level: EnvLevel | string;
  env: EnvId;
}

/** environments.resolve(): effective environment + the level that decided it. */
export interface EffectiveEnv {
  env: EnvId;
  root_id: string | null;
  source: EnvLevel | string;
  label: string;
  chain: EnvChainStep[];
}

export interface EnvDescription {
  id: EnvId;
  label: string;
  benefits: string[];
  limitations: string[];
  permissions: string[];
}

export interface GuiControl {
  available: boolean;
  accessibility: string;
  screen_recording: string;
  detail: string;
}

export interface HostResourcesInfo {
  memory_total_bytes: number;
  memory_available_bytes: number;
  memory_free_percent: number;
  memory_pressure: string;
  load_avg: number[];
  cpu_count: number | null;
  disk_total_bytes: number;
  disk_free_bytes: number;
  vm_resident_bytes: number;
  /** Real VM memory footprint (newer hosts); preferred over the RSS above. */
  vm_footprint_bytes?: number | null;
}

export interface EnvironmentsInfo {
  environments: EnvDescription[];
  host: {
    sandbox: boolean;
    running_commands: number;
    background_processes: number;
    roots: number;
    gui_control?: GuiControl;
    resources?: HostResourcesInfo;
  };
  vm: {
    state: string;
    cpu_count?: number;
    memory_mb?: number;
    active_streams?: number;
    detail?: string;
    message?: string;
    [k: string]: unknown;
  };
}

export type RootMode = 'read_write' | 'read_only';

export interface HostRoot {
  id: string;
  name: string;
  path: string;
  mode: RootMode | string;
  allow_network: boolean;
  /** [] = every detected developer tool. */
  allowed_tools: string[];
  enabled: boolean;
  created_by: string;
  created_at: Epoch;
  updated_at: Epoch;
  /** Only in GET /host/roots (the folder still exists on disk). */
  exists?: boolean;
}

export interface RootBody {
  path: string;
  name?: string | null;
  mode: RootMode;
  allow_network: boolean;
  allowed_tools: string[];
}

export interface RootPatch {
  name?: string;
  mode?: RootMode;
  allow_network?: boolean;
  allowed_tools?: string[];
  enabled?: boolean;
}

export interface HostTool {
  available: boolean;
  path: string | null;
  version: string | null;
  note?: string;
}

export interface HostToolsInfo {
  tools: Record<string, HostTool>;
  sandbox: boolean;
  gui_control: GuiControl;
}

export type HostCommandStatus = 'ok' | 'error' | 'denied' | 'timeout' | string;

export interface HostCommand {
  id: number;
  ts: Epoch;
  agent_id: string | null;
  task_id: string | null;
  root_id: string | null;
  tool: string;
  command: string | null;
  cwd: string | null;
  status: HostCommandStatus;
  exit_code: number | null;
  duration_ms: number | null;
  detail: string | null;
}

export interface BrowseDir {
  name: string;
  path: string;
  authorisable: boolean;
  reason: string | null;
  git: boolean;
  project_markers: string[];
}

export interface BrowseResult {
  path: string;
  parent: string | null;
  dirs: BrowseDir[];
}

/** GET /agents/{id}/environment */
export interface AgentEnvSummary {
  agent_id: string;
  effective: EffectiveEnv;
  root: HostRoot | null;
  tools: string[];
  skills_unavailable_here: string[];
  problems: string[];
  live_desktop: boolean;
}
