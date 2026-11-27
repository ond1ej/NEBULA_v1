import { useState } from 'react';
import { IconBell } from '../../components/icons';
import type { Tone } from '../../components/tone';
import { TONE_DOT } from '../../components/tone';
import { formatTime, relativeTime } from '../../lib/format';
import { useMini } from '../context';
import { useQuery, useTick } from '../hooks';
import { mhref } from '../router';
import type { MiniNotification } from '../types';
import { Clamp, Empty, QueryView, Screen, TapButton } from '../uiKit';

interface View {
  title: string;
  detail?: string;
  tone: Tone;
  link?: string;
}

/** Notification → title, tone and the Mini App screen it opens. */
export function describeNotification(n: MiniNotification): View {
  const p = n.payload ?? {};
  const who = n.agent_name ?? 'An agent';
  const task = n.task_id ? mhref(`/tasks/${n.task_id}`) : undefined;
  switch (n.type) {
    case 'task.completed':
      return { title: `${who} completed a task`, detail: p.summary, tone: 'success', link: task };
    case 'task.failed':
      return { title: `Task failed on ${who}`, detail: p.reason, tone: 'danger', link: task };
    case 'task.approval.requested':
      return { title: `${who} asks for approval`, detail: p.tool, tone: 'warn', link: mhref('/approvals') };
    case 'owner.approval.requested':
      return { title: 'Your approval is needed', detail: p.summary ?? p.kind, tone: 'warn', link: mhref('/approvals') };
    case 'auth.request':
      return {
        title: `${p.agent_name ?? who} needs you to sign in to ${p.site ?? 'a website'}`,
        tone: 'warn',
        link: p.session_id && /^as_[0-9a-f]+$/.test(p.session_id) ? mhref(`/auth/${p.session_id}`) : mhref('/activity'),
      };
    case 'company.run.started':
      return { title: `${p.company ?? 'Company'} started a run`, detail: p.project, tone: 'info', link: p.run_id ? mhref(`/company-runs/${p.run_id}`) : undefined };
    case 'company.run.finished':
      return {
        title: `${p.company ?? 'Company'} run ${(p.state ?? 'finished').toLowerCase()}`,
        detail: p.summary ?? p.project,
        tone: p.state === 'COMPLETED' ? 'success' : p.state === 'FAILED' ? 'danger' : 'neutral',
        link: p.run_id ? mhref(`/company-runs/${p.run_id}`) : undefined,
      };
    case 'team.run.completed':
      return { title: 'Team run finished', detail: p.summary, tone: 'success' };
    case 'team.run.failed':
      return { title: 'Team run failed', detail: p.reason, tone: 'danger' };
    case 'schedule.run.finished':
      return { title: `Schedule ${(p.state ?? 'finished').toLowerCase().replace(/_/g, ' ')}`, detail: p.reason ?? p.summary, tone: p.state === 'FAILED' ? 'danger' : 'neutral' };
    case 'workflow.run.finished':
      return { title: `Workflow ${(p.state ?? 'finished').toLowerCase()}`, detail: p.reason ?? p.summary, tone: p.state === 'COMPLETED' ? 'success' : 'danger', link: mhref('/workflows') };
    case 'resource.alert':
      return { title: p.message ?? 'Resource alert', tone: p.level === 'critical' ? 'danger' : 'warn' };
    case 'vm.state.changed':
      return { title: `Ubuntu VM ${(p.state ?? p.status ?? 'changed').replace(/_/g, ' ')}`, detail: p.reason, tone: p.state === 'running' ? 'success' : 'warn' };
    case 'bot.state.changed':
      return { title: 'Telegram bot status changed', detail: p.status ?? p.state, tone: 'neutral' };
    case 'attachment.processed':
      return { title: `Attachment ${p.status ?? 'processed'}`, detail: p.kind, tone: p.status === 'failed' ? 'danger' : 'neutral' };
    default:
      return { title: n.type.replace(/\./g, ' '), detail: p.summary ?? p.reason, tone: 'neutral' };
  }
}

export function NotificationsScreen() {
  const { api } = useMini();
  useTick(30_000);
  const [older, setOlder] = useState<MiniNotification[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [end, setEnd] = useState(false);
  const q = useQuery<MiniNotification[]>('notifications', (s) => api.notifications(undefined, s), {
    refreshOn: (ev) =>
      ['task.completed', 'task.failed', 'task.approval.requested', 'owner.approval.requested', 'resource.alert', 'vm.state.changed', 'auth.request'].includes(ev.type) ||
      ev.type.startsWith('company.run') ||
      ev.type.endsWith('run.finished'),
  });
  const all = [...(q.data ?? []), ...older.filter((o) => !(q.data ?? []).some((n) => n.id === o.id))];
  const more = async () => {
    const last = all[all.length - 1];
    if (!last) return;
    setLoadingMore(true);
    try {
      const page = await api.notifications(last.sequence);
      setOlder((xs) => [...xs, ...page]);
      if (page.length < 50) setEnd(true);
    } catch {
      setEnd(false);
    } finally {
      setLoadingMore(false);
    }
  };
  return (
    <Screen title="Notifications">
      <QueryView q={q} isEmpty={(d) => d.length === 0} empty={<Empty title="No notifications" icon={<IconBell />}>Finished tasks, failures, approvals and alerts show up here.</Empty>}>
        {() => (
          <>
            <ol className="overflow-hidden rounded-card bg-panel">
              {all.map((n) => {
                const v = describeNotification(n);
                const body = (
                  <>
                    <span aria-hidden className={`mt-1.5 size-2 shrink-0 rounded-full ${TONE_DOT[v.tone]}`} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[14px] leading-5 font-medium text-text">{v.title}</span>
                      {v.detail && <Clamp lines={2} className="mt-0.5 text-[12.5px] text-muted">{v.detail}</Clamp>}
                      <span className="mt-0.5 block text-[11px] text-subtle" title={formatTime(n.timestamp)}>
                        {relativeTime(n.timestamp)}
                      </span>
                    </span>
                  </>
                );
                return (
                  <li key={n.id} className="border-b border-border last:border-b-0">
                    {v.link ? (
                      <a href={v.link} className="flex min-h-14 gap-3 px-3.5 py-3 active:bg-panel-3 focus-ring">
                        {body}
                      </a>
                    ) : (
                      <div className="flex min-h-14 gap-3 px-3.5 py-3">{body}</div>
                    )}
                  </li>
                );
              })}
            </ol>
            {!end && all.length >= 50 && (
              <TapButton className="mt-3 w-full" loading={loadingMore} onClick={more}>
                Load older
              </TapButton>
            )}
          </>
        )}
      </QueryView>
    </Screen>
  );
}
