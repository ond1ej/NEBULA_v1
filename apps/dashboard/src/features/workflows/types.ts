// Shapes of the workflow API (apps/host-api/nebula_host/workflows.py + api/routes_v2.py "Module 6").
// Kept local to this feature so the module does not depend on the shared types.ts.

export type Epoch = number;
export type Params = Record<string, unknown>;

export interface Position {
  x: number;
  y: number;
}

export interface WfNode {
  id: string;
  type: string;
  label?: string;
  params: Params;
  position?: Position;
}

export interface WfEdge {
  id?: string;
  source: string;
  target: string;
  handle?: string;
}

export interface WfDefinition {
  schema_version: 1;
  nodes: WfNode[];
  edges: WfEdge[];
}

export type BlockGroup = 'Triggers' | 'Actions' | 'Logic';

export interface CatalogBlock {
  type: string;
  group: BlockGroup | string;
  label: string;
  params: Params;
}

export interface Catalog {
  blocks: CatalogBlock[];
  schema_version: number;
  limits: { max_nodes: number; max_loop: number; max_depth: number };
}

export interface RunRef {
  id: string;
  state: RunState | string;
  created_at: Epoch;
}

export interface Workflow {
  id: string;
  name: string;
  description: string;
  version: number;
  definition: WfDefinition;
  enabled: boolean;
  trigger_types: string[];
  max_runs_per_hour: number;
  created_at: Epoch;
  updated_at: Epoch;
}

export interface WorkflowListItem extends Workflow {
  last_run: RunRef | null;
}

export type RunState = 'RUNNING' | 'WAITING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
export type StepState = 'RUNNING' | 'WAITING' | 'COMPLETED' | 'FAILED' | 'SKIPPED' | 'UNKNOWN' | 'CANCELLED';

export interface RunSummary {
  id: string;
  workflow_id: string;
  state: RunState | string;
  trigger: string;
  created_at: Epoch;
  finished_at: Epoch | null;
  error: string | null;
  workflow_version: number;
}

export interface WorkflowStep {
  id: string;
  run_id: string;
  /** `<node id>` or `<node id>#<iteration>` for blocks inside a loop body. */
  node_id: string;
  node_type: string;
  state: StepState | string;
  attempt: number;
  output: unknown;
  ref: Record<string, unknown> | null;
  error: string | null;
  started_at: Epoch;
  finished_at: Epoch | null;
}

export interface WorkflowRun extends RunSummary {
  definition: WfDefinition;
  trigger_payload: Record<string, unknown> | null;
  context: Record<string, unknown> | null;
  origin_depth: number;
  updated_at: Epoch;
  steps: WorkflowStep[];
  workflow_name: string | null;
}

export interface ValidateResult {
  valid: boolean;
  error?: string;
}

export interface WorkflowExport {
  nebula_workflow: 1;
  name: string;
  description: string;
  definition: WfDefinition;
  exported_at: Epoch;
  version: number;
}

export interface SaveBody {
  name: string;
  description: string;
  definition: WfDefinition;
  enabled?: boolean;
}

/** Minimal views of other resources used by the parameter pickers. */
export interface AgentOption {
  id: string;
  name: string;
  state?: string;
}

export interface TeamOption {
  id: string;
  name: string;
}

export interface RootOption {
  id: string;
  type: string;
  label: string;
}

export interface OwnerApproval {
  id: string;
  kind: string;
  ref: Record<string, unknown>;
  summary: string;
  preview: Record<string, unknown> | null;
  decision: string | null;
  created_at: Epoch;
  expires_at: Epoch;
}
