// Task lifecycle for live cards — mirrors packages/telegram-gateway/nebula_telegram/cards.py (LIFECYCLE / lifecycle /
// render) so a task looks the same in the Dashboard, in Telegram and in the Mini App.
import type { Task, TaskResult } from '../../types';

export type Lifecycle = 'QUEUED' | 'PREPARING' | 'RUNNING' | 'WAITING_FOR_APPROVAL' | 'PAUSED' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

export const LIFECYCLE: Record<string, Lifecycle> = {
  RECEIVED: 'QUEUED',
  QUEUED: 'QUEUED',
  PLANNING: 'RUNNING',
  EXECUTING: 'RUNNING',
  VERIFYING: 'RUNNING',
  PAUSING: 'RUNNING',
  WAITING_CONTROL: 'RUNNING',
  WAITING_PROVIDER: 'RUNNING',
  WAITING_APPROVAL: 'WAITING_FOR_APPROVAL',
  PAUSED: 'PAUSED',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
};

export const LIFECYCLE_LABEL: Record<Lifecycle, string> = {
  QUEUED: 'Queued',
  PREPARING: 'Preparing',
  RUNNING: 'Running',
  WAITING_FOR_APPROVAL: 'Waiting for approval',
  PAUSED: 'Paused',
  COMPLETED: 'Completed',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
};

export const TERMINAL_LIFECYCLES: Lifecycle[] = ['COMPLETED', 'FAILED', 'CANCELLED'];

/** A task row as returned by GET /tasks, /agents/{id}/tasks or /tasks/{id} (V3 adds `execution`). */
export interface LiveTask extends Pick<Task, 'id' | 'agent_id' | 'prompt' | 'state' | 'current_step' | 'max_steps'> {
  agent_name?: string | null;
  execution?: { env?: string | null; root_id?: string | null } | null;
  result?: TaskResult | null;
  failure_reason?: string | null;
  started_at?: number | null;
  finished_at?: number | null;
  created_at?: number;
  updated_at?: number;
  source_channel?: string;
}

export interface StepInfo {
  tool_type: string;
  result_status: string;
}

export function lifecycle(task: Pick<LiveTask, 'state' | 'current_step'>): Lifecycle {
  const st = LIFECYCLE[task.state] ?? (task.state as Lifecycle);
  if (st === 'RUNNING' && task.state === 'PLANNING' && !task.current_step) return 'PREPARING';
  return st;
}

export function envOf(task: Pick<LiveTask, 'execution'>): 'vm' | 'host' {
  return task.execution?.env === 'host' ? 'host' : 'vm';
}

export const ENV_LABEL = { vm: 'Ubuntu VM', host: 'Mac mini' } as const;

/** "Current step" (running) or "Result" (finished) line, like the Telegram card. */
export function currentStep(task: LiveTask, step: StepInfo | null, note?: string | null): string {
  const st = lifecycle(task);
  if (TERMINAL_LIFECYCLES.includes(st)) return (task.result?.summary || task.failure_reason || st.toLowerCase()).slice(0, 300);
  if (st === 'WAITING_FOR_APPROVAL') return 'waiting for your approval';
  if (st === 'PREPARING') return 'preparing the environment';
  if (task.state === 'WAITING_PROVIDER') return note || 'waiting for the AI provider (quota or outage); retries automatically';
  if (task.state === 'WAITING_CONTROL') return 'waiting: a viewer holds desktop control';
  if (task.state === 'PAUSING') return 'pausing after the current step';
  if (note) return note;
  if (step) return `${step.tool_type} (${step.result_status})`;
  if (st === 'QUEUED') return 'waiting in queue';
  if (st === 'PAUSED') return 'paused';
  return 'thinking';
}

export type CardAction = 'pause' | 'resume' | 'stop' | 'retry' | 'desktop' | 'details' | 'approval';

/** Which controls a card offers per lifecycle state (cards.py render(), plus Pause for queued tasks). */
export function actionsFor(task: LiveTask): CardAction[] {
  const st = lifecycle(task);
  const env = envOf(task);
  switch (st) {
    case 'RUNNING':
    case 'PREPARING':
      return task.state === 'PAUSING' ? (env === 'vm' ? ['stop', 'desktop', 'details'] : ['stop', 'details']) : env === 'vm' ? ['pause', 'stop', 'desktop', 'details'] : ['pause', 'stop', 'details'];
    case 'WAITING_FOR_APPROVAL':
      return ['approval', 'stop', 'details'];
    case 'PAUSED':
      return ['resume', 'stop', 'details'];
    case 'QUEUED':
      return ['pause', 'stop', 'details'];
    case 'COMPLETED':
      return ['details'];
    case 'FAILED':
    case 'CANCELLED':
      return ['retry', 'details'];
    default:
      return ['details'];
  }
}
