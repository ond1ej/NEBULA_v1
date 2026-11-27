// Human-readable descriptions of host events (Command Center feed, notifications).
import type { Tone } from '../components/tone';
import { href } from '../hooks/useHashRoute';
import { stageLabel } from './taskStages';
import { VAULT_OP_LABEL } from '../features/vault/lib';
import type { NebulaEvent } from '../types';

export interface EventView {
  title: string;
  detail?: string;
  tone: Tone;
  link?: string;
  group: 'agent' | 'task' | 'team' | 'schedule' | 'workflow' | 'approval' | 'resource' | 'system' | 'provider' | 'file' | 'memory' | 'skill' | 'live' | 'telegram' | 'company';
}

type Ev = Pick<NebulaEvent, 'type' | 'agent_id' | 'task_id' | 'payload'>;

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : typeof v === 'number' ? String(v) : undefined);

export function describeEvent(ev: Ev, agentName: (id: string) => string | undefined = () => undefined): EventView {
  const p = ev.payload ?? {};
  const agent = ev.agent_id ? (agentName(ev.agent_id) ?? 'an agent') : undefined;
  const taskLink = ev.agent_id && ev.task_id ? href(`/agents/${ev.agent_id}/tasks?task=${ev.task_id}`) : undefined;
  const reason = str(p.reason) ?? str(p.detail);
  switch (ev.type) {
    case 'agent.created':
      return { title: `Agent ${agent ?? str(p.name) ?? ''} created`.replace(/\s+/g, ' '), tone: 'success', group: 'agent', link: ev.agent_id ? href(`/agents/${ev.agent_id}`) : undefined };
    case 'agent.deleted':
      return { title: `Agent ${str(p.name) ?? agent ?? ''} deleted`.replace(/\s+/g, ' '), tone: 'neutral', group: 'agent' };
    case 'agent.state.changed': {
      const st = str(p.state) ?? str(p.status);
      return { title: `${agent ?? 'Agent'} is ${st ? st.toLowerCase() : 'updated'}`, detail: reason, tone: st === 'ERROR' ? 'danger' : 'neutral', group: 'agent', link: ev.agent_id ? href(`/agents/${ev.agent_id}`) : undefined };
    }
    case 'task.queued':
      return { title: `Task queued for ${agent ?? 'an agent'}`, detail: str(p.prompt), tone: 'info', group: 'task', link: taskLink };
    case 'task.started':
      return { title: `${agent ?? 'Agent'} started a task`, tone: 'accent', group: 'task', link: taskLink };
    case 'task.completed':
      return { title: `${agent ?? 'Agent'} completed a task`, detail: str((p.result as Record<string, unknown> | undefined)?.summary), tone: 'success', group: 'task', link: taskLink };
    case 'task.failed':
      return { title: `Task failed on ${agent ?? 'an agent'}`, detail: reason, tone: 'danger', group: 'task', link: taskLink };
    case 'task.cancelled':
      return { title: `Task cancelled on ${agent ?? 'an agent'}`, detail: reason, tone: 'neutral', group: 'task', link: taskLink };
    case 'task.paused':
      return { title: `Task paused on ${agent ?? 'an agent'}`, tone: 'warn', group: 'task', link: taskLink };
    case 'task.resumed':
      return { title: `Task resumed on ${agent ?? 'an agent'}`, tone: 'info', group: 'task', link: taskLink };
    case 'task.step':
      return { title: `${agent ?? 'Agent'} · ${str(p.tool) ?? str(p.kind) ?? 'step'}`, detail: str(p.summary) ?? reason, tone: 'neutral', group: 'task', link: taskLink };
    case 'task.stage':
      return { title: `${agent ?? 'Agent'} · ${stageLabel({ stage: str(p.stage) ?? '', detail: str(p.detail) ?? null })}`, tone: 'neutral', group: 'task', link: taskLink };
    case 'task.message':
      return { title: `${agent ?? 'Agent'} wrote a message`, detail: str(p.text), tone: 'neutral', group: 'task', link: taskLink };
    case 'task.approval.requested':
      return { title: `${agent ?? 'An agent'} asks for approval`, detail: str(p.action_summary) ?? str(p.tool), tone: 'warn', group: 'approval', link: taskLink };
    case 'task.approval.resolved':
      return { title: `Approval ${str(p.decision) ?? 'resolved'}`, tone: p.decision === 'approved' ? 'success' : 'neutral', group: 'approval', link: taskLink };
    case 'team.run.started':
      return { title: `Team ${str(p.team) ?? ''} started a run`.replace(/\s+/g, ' '), detail: str(p.prompt), tone: 'accent', group: 'team', link: teamRunLink(p) };
    case 'team.run.completed':
      return { title: `Team ${str(p.team) ?? ''} finished a run`.replace(/\s+/g, ' '), tone: 'success', group: 'team', link: teamRunLink(p) };
    case 'team.run.failed':
      return { title: `Team ${str(p.team) ?? ''} run ${str(p.state)?.toLowerCase() ?? 'failed'}`.replace(/\s+/g, ' '), tone: p.state === 'CANCELLED' ? 'neutral' : 'danger', group: 'team', link: teamRunLink(p) };
    case 'team.subtask.changed':
      return { title: `Team subtask ${str(p.state)?.toLowerCase() ?? 'updated'}`, tone: p.state === 'FAILED' ? 'danger' : p.state === 'COMPLETED' ? 'success' : 'neutral', group: 'team' };
    case 'schedule.run.started':
      return { title: `Schedule “${str(p.name) ?? ''}” started`, tone: 'accent', group: 'schedule', link: p.schedule_id ? href(`/schedules/${String(p.schedule_id)}`) : undefined };
    case 'schedule.run.finished': {
      const st = str(p.state) ?? 'finished';
      return {
        title: `Schedule “${str(p.name) ?? ''}” ${st.toLowerCase().replace(/_/g, ' ')}`,
        detail: str(p.detail),
        tone: st === 'COMPLETED' ? 'success' : st === 'FAILED' ? 'danger' : st === 'AWAITING_CONFIRMATION' ? 'warn' : 'neutral',
        group: 'schedule',
        link: p.schedule_id ? href(`/schedules/${String(p.schedule_id)}`) : undefined,
      };
    }
    case 'workflow.run.started':
      return { title: `Workflow ${str(p.name) ?? str(p.workflow) ?? ''} started`.replace(/\s+/g, ' '), tone: 'accent', group: 'workflow', link: href('/workflows') };
    case 'workflow.step':
      return { title: `Workflow step ${str(p.node_id) ?? ''} ${str(p.state)?.toLowerCase() ?? ''}`.trim(), tone: p.state === 'FAILED' ? 'danger' : 'neutral', group: 'workflow', link: href('/workflows') };
    case 'workflow.run.finished':
      return { title: `Workflow ${str(p.name) ?? ''} ${str(p.state)?.toLowerCase() ?? 'finished'}`.replace(/\s+/g, ' '), detail: str(p.error) ?? str(p.summary), tone: p.state === 'COMPLETED' ? 'success' : 'danger', group: 'workflow', link: href('/workflows') };
    case 'owner.approval.requested':
      return { title: 'Your approval is needed', detail: str(p.summary), tone: 'warn', group: 'approval' };
    case 'owner.approval.resolved':
      return { title: `Owner approval ${str(p.decision) ?? 'resolved'}`, tone: p.decision === 'approved' ? 'success' : 'neutral', group: 'approval' };
    case 'resource.pressure.changed': {
      const to = str(p.to) ?? 'changed';
      const free = typeof p.free_percent === 'number' ? `${Math.round(p.free_percent)}% memory free` : undefined;
      const swap = typeof p.swap_used_mb === 'number' ? `swap ${Math.round(p.swap_used_mb)} MB` : undefined;
      return {
        title: `Memory pressure ${str(p.from) ? `${str(p.from)} → ` : ''}${to}`,
        detail: [free, swap].filter(Boolean).join(' · ') || undefined,
        tone: /critical/i.test(to) ? 'danger' : /warn/i.test(to) ? 'warn' : 'success',
        group: 'resource',
        link: href('/resources'),
      };
    }
    case 'resource.alert':
      return { title: str(p.message) ?? 'Resource alert', tone: p.level === 'critical' ? 'danger' : 'warn', group: 'resource', link: href('/resources') };
    case 'file.created':
      return { title: `File created${str(p.path) ? `: ${str(p.path)}` : ''}`, tone: 'neutral', group: 'file', link: href('/files') };
    case 'memory.changed':
      return { title: `Memory ${str(p.op) ?? 'changed'}${agent ? ` · ${agent}` : ''}`, tone: 'neutral', group: 'memory', link: ev.agent_id ? href(`/agents/${ev.agent_id}/memory`) : undefined };
    case 'company.run.started':
      return { title: `${str(p.company) ?? 'Company'} · ${str(p.project) ?? ''}: run started`.replace(/\s+/g, ' '), detail: str(p.objective), tone: 'accent', group: 'company', link: p.company_id ? href(`/companies/${String(p.company_id)}`) : href('/companies') };
    case 'company.run.finished':
      return { title: `${str(p.company) ?? 'Company'} · ${str(p.project) ?? ''}: run ${str(p.state)?.toLowerCase() ?? 'finished'}`.replace(/\s+/g, ' '), tone: p.state === 'COMPLETED' ? 'success' : 'danger', group: 'company', link: p.company_id ? href(`/companies/${String(p.company_id)}`) : href('/companies') };
    case 'company.activity':
      return { title: str(p.content) ?? 'Company activity', tone: p.kind === 'failure' ? 'danger' : 'neutral', group: 'company', link: p.company_id ? href(`/companies/${String(p.company_id)}`) : undefined };
    case 'company.item.changed':
      return { title: `Work item ${str(p.state)?.toLowerCase() ?? 'updated'}`, tone: p.state === 'FAILED' ? 'danger' : 'neutral', group: 'company', link: p.company_id ? href(`/companies/${String(p.company_id)}`) : undefined };
    case 'company.created':
    case 'company.updated':
      return { title: `Company ${str(p.name) ?? ''} ${ev.type === 'company.created' ? 'created' : 'updated'}`.replace(/\s+/g, ' '), tone: 'neutral', group: 'company', link: href('/companies') };
    case 'environment.changed':
      return { title: `${agent ?? 'Agent'} now works on ${p.to === 'host' ? 'the Mac (native)' : 'the Ubuntu VM'}`, tone: 'accent', group: 'agent', link: ev.agent_id ? href(`/agents/${ev.agent_id}/environment`) : undefined };
    case 'bot.state.changed':
      return { title: `Agent bot ${str(p.status)?.toLowerCase() ?? str(p.pairing) ?? 'updated'}`, tone: p.status === 'REVOKED' || p.status === 'ERROR' ? 'danger' : 'neutral', group: 'telegram', link: href('/bots') };
    case 'attachment.processed':
      return { title: `Attachment ${str(p.kind) ?? ''} ${p.status === 'FAILED' ? 'failed' : 'processed'}`.replace(/\s+/g, ' '), detail: str(p.error), tone: p.status === 'FAILED' ? 'warn' : 'neutral', group: 'file' };
    case 'remote.state.changed':
      return { title: `Remote access ${p.enabled ? 'enabled' : 'disabled'}`, tone: 'neutral', group: 'system', link: href('/remote') };
    case 'skill.changed':
      return { title: `Skill ${str(p.skill_id) ?? ''} updated`.replace(/\s+/g, ' '), tone: 'neutral', group: 'skill', link: href('/skills') };
    case 'vm.state.changed':
      return { title: `VM ${str(p.state) ?? 'state changed'}`, tone: p.state === 'running' ? 'success' : p.state === 'error' ? 'danger' : 'neutral', group: 'system', link: href('/system') };
    case 'provider.state.changed':
      return { title: `${str(p.provider_id) ?? 'Provider'}: ${str(p.state) ?? 'changed'}`, tone: String(p.state ?? '').startsWith('Connected') ? 'success' : 'warn', group: 'provider', link: href('/providers') };
    case 'provider.quota':
      return { title: `Quota reached on ${str(p.provider_id) ?? 'a provider'}`, detail: str(p.detail), tone: 'warn', group: 'provider', link: href('/providers') };
    case 'telegram.paired':
      return { title: 'Telegram account paired', tone: 'success', group: 'telegram', link: href('/telegram') };
    case 'telegram.pairing.pending':
      return { title: 'Telegram pairing request waiting', tone: 'warn', group: 'telegram', link: href('/telegram') };
    case 'live.viewer.joined':
      return { title: `Viewer connected to ${agent ?? 'a desktop'}`, tone: 'neutral', group: 'live' };
    case 'live.viewer.left':
      return { title: `Viewer left ${agent ?? 'a desktop'}`, tone: 'neutral', group: 'live' };
    case 'live.control.changed':
      return { title: `Desktop control: ${str(p.holder) ?? 'changed'}${agent ? ` · ${agent}` : ''}`, tone: 'warn', group: 'live' };
    case 'install.progress':
      return { title: `Maintenance: ${str(p.state) ?? str(p.step) ?? 'progress'}`, tone: 'info', group: 'system', link: href('/system') };
    case 'vault.status.changed':
      return {
        title: p.exists === false ? 'Password Vault removed' : `Password Vault ${p.locked ? 'locked' : 'unlocked'}`,
        detail: typeof p.entry_count === 'number' ? `${p.entry_count} credential${p.entry_count === 1 ? '' : 's'}` : undefined,
        tone: p.locked ? 'neutral' : 'accent',
        group: 'system',
        link: href('/vault'),
      };
    case 'vault.access':
      if (p.actor_type !== undefined && p.actor_type !== 'agent') {
        // owner / system operations (unlock, reveal, export, settings, …)
        const op = str(p.operation) ?? 'activity';
        return {
          title: `Password Vault: ${(VAULT_OP_LABEL[op] ?? op).toLowerCase()}${p.outcome === 'ok' ? '' : ` (${str(p.outcome) ?? 'failed'})`}`,
          detail: str(p.reason_code),
          tone: p.outcome === 'ok' ? 'neutral' : 'warn',
          group: 'system',
          link: href('/vault?tab=history'),
        };
      }
      return {
        title: `${agent ?? 'An agent'} ${p.outcome === 'ok' ? 'signed in with a vault credential' : p.outcome === 'denied' ? 'was denied a vault credential' : 'could not sign in with a vault credential'}`,
        detail: [str(p.destination_origin), str(p.reason_code)].filter(Boolean).join(' · ') || undefined,
        tone: p.outcome === 'ok' ? 'success' : p.outcome === 'denied' ? 'warn' : 'danger',
        group: 'system',
        link: href('/vault?tab=history'),
      };
    case 'auth.request':
      return {
        title: `${str(p.agent_name) ?? agent ?? 'An agent'} needs you to sign in to ${str(p.site) ?? 'a website'}`,
        detail: str(p.origin),
        tone: 'warn',
        group: 'approval',
        link: href('/approvals'),
      };
    case 'auth.session.updated': {
      const st = str(p.state) ?? '';
      const site = str(p.site) ?? 'a website';
      const who = str(p.agent_name) ?? agent ?? 'Agent';
      const title =
        st === 'AUTHENTICATED'
          ? `${who} signed in to ${site}`
          : st === 'FAILED'
            ? `Sign-in to ${site} failed`
            : st === 'CANCELLED'
              ? `Sign-in to ${site} cancelled`
              : st === 'EXPIRED'
                ? `Sign-in request for ${site} expired`
                : `${who} · sign-in to ${site}: ${st.toLowerCase().replace(/_/g, ' ') || 'updated'}`;
      return {
        title,
        detail: str(p.error_code),
        tone: st === 'AUTHENTICATED' ? 'success' : st === 'FAILED' ? 'danger' : st.startsWith('WAITING_FOR') ? 'warn' : 'neutral',
        group: 'approval',
        link: href('/vault?tab=signins'),
      };
    }
    case 'system.health':
      return { title: `System health: ${str(p.status) ?? 'update'}`, tone: p.status === 'ok' ? 'success' : 'warn', group: 'system', link: href('/system') };
    default:
      return { title: ev.type, tone: 'neutral', group: 'system' };
  }
}

function teamRunLink(p: Record<string, unknown>): string | undefined {
  return p.team_id && p.run_id ? href(`/teams/${String(p.team_id)}/runs/${String(p.run_id)}`) : undefined;
}

/** Events that are noise in an activity feed (high-frequency step/message traffic). */
export const FEED_NOISE = new Set(['task.step', 'task.stage', 'task.message', 'live.viewer.joined', 'live.viewer.left', 'install.progress', 'workflow.step', 'team.subtask.changed']);
