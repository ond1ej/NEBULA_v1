import { TONE_BADGE, TONE_DOT, type Tone } from './tone';

export type { Tone };

const TONE_BY_STATE: Record<string, Tone> = {
  // agents
  CREATING: 'info',
  READY: 'success',
  ACTIVE: 'accent',
  IDLE: 'neutral',
  SLEEP: 'neutral',
  PAUSED: 'warn',
  STOPPED: 'neutral',
  ERROR: 'danger',
  DELETING: 'warn',
  // tasks
  RECEIVED: 'info',
  QUEUED: 'info',
  PLANNING: 'accent',
  EXECUTING: 'accent',
  VERIFYING: 'accent',
  PAUSING: 'warn',
  WAITING_APPROVAL: 'warn',
  WAITING_PROVIDER: 'warn',
  WAITING_CONTROL: 'warn',
  COMPLETED: 'success',
  FAILED: 'danger',
  CANCELLED: 'neutral',
  // jobs / runs (teams, schedules, workflows)
  RUNNING: 'info',
  SUCCEEDED: 'success',
  PENDING: 'neutral',
  SKIPPED: 'neutral',
  WAITING: 'warn',
  AWAITING_CONFIRMATION: 'warn',
  UNKNOWN: 'neutral',
  // providers (spec §6.1 exact labels)
  'Not Connected': 'neutral',
  Connect: 'info',
  'Connected (Subscription)': 'success',
  'Connected (API Billing)': 'success',
  'Connected (Local)': 'success',
  'Quota Reached': 'warn',
  'Re-auth Required': 'danger',
  'Unsupported on this version': 'neutral',
  Error: 'danger',
  // vm / guest / health
  running: 'success',
  starting: 'info',
  stopping: 'warn',
  stopped: 'neutral',
  not_created: 'neutral',
  error: 'danger',
  unresponsive: 'danger',
  ok: 'success',
  degraded: 'warn',
  unavailable: 'danger',
  vm_not_running: 'neutral',
  normal: 'success',
  warning: 'warn',
  critical: 'danger',
  // preflight
  pass: 'success',
  warn: 'warn',
  fail: 'danger',
  // telegram / approvals
  pending: 'warn',
  approved: 'success',
  revoked: 'neutral',
  denied: 'danger',
  expired: 'neutral',
  // live sessions
  CONNECTING: 'info',
  VIEWING: 'success',
  DISCONNECTING: 'warn',
  DISCONNECTED: 'neutral',
  ERROR_RETRYABLE: 'danger',
  // step results
  done: 'success',
  failed: 'danger',
  success: 'success',
};

export function toneFor(state: string | null | undefined): Tone {
  if (!state) return 'neutral';
  if (TONE_BY_STATE[state]) return TONE_BY_STATE[state];
  if (state.startsWith('Connected')) return 'success';
  return 'neutral';
}

/** States that mean "work in progress" (the dot breathes). */
export const BUSY_STATES = new Set(['ACTIVE', 'CREATING', 'PLANNING', 'EXECUTING', 'VERIFYING', 'RUNNING', 'CONNECTING', 'PAUSING', 'starting']);

export function StatusPill({
  state,
  tone,
  label,
  className = '',
  pulse = false,
}: {
  state: string | null | undefined;
  tone?: Tone;
  label?: string;
  className?: string;
  pulse?: boolean;
}) {
  const t = tone ?? toneFor(state);
  const text = label ?? (state ? state.replace(/_/g, ' ') : 'unknown');
  return (
    <span
      className={`inline-flex h-[22px] max-w-full items-center gap-1.5 rounded-full px-2 text-[11.5px] leading-none font-medium whitespace-nowrap ring-1 ring-inset ${TONE_BADGE[t]} ${className}`}
      data-tone={t}
    >
      <span aria-hidden className={`inline-block size-1.5 shrink-0 rounded-full ${TONE_DOT[t]} ${pulse ? 'animate-pulse-soft' : ''}`} />
      <span className="truncate">{text}</span>
    </span>
  );
}
