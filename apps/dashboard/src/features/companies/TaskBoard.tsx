// Task board of one company run: work items grouped by state, with role, agent, environment (+ source), attempts,
// dependencies, artifacts, cross-environment transfers, result and retry.
import { useState } from 'react';
import { IconArrowRight, IconExternal, IconFiles, IconLink, IconRefresh } from '../../components/icons';
import { BUSY_STATES, StatusPill } from '../../components/StatusPill';
import { Avatar, Badge, Button, Mono, TextLink } from '../../components/ui';
import { href } from '../../hooks/useHashRoute';
import { formatDuration } from '../../lib/format';
import { ENV_SHORT, EnvBadge, isEnv } from '../environment/EnvBadge';
import { groupWorkItems, ITEM_RETRYABLE } from './lib';
import type { Artifact, RunDetail, WorkItem } from './types';

const KIND_LABEL: Record<string, string> = { plan: 'CEO plan', summary: 'CEO report', review: 'review' };

export function ArtifactList({ artifacts }: { artifacts: Artifact[] }) {
  return (
    <ul className="space-y-1">
      {artifacts.map((a, i) => (
        <li key={`${a.type}-${a.value}-${i}`} className="flex min-w-0 items-start gap-1.5 text-xs">
          {a.type === 'url' ? <IconLink className="mt-0.5 size-3.5 shrink-0 text-subtle" /> : <IconFiles className="mt-0.5 size-3.5 shrink-0 text-subtle" />}
          {a.type === 'url' && /^https?:\/\//.test(a.value) ? (
            <TextLink href={a.value} target="_blank" rel="noreferrer noopener" className="min-w-0 break-all">
              {a.value}
            </TextLink>
          ) : (
            <Mono className="min-w-0 break-all text-text">{a.value}</Mono>
          )}
          {isEnv(a.environment) && <span className="shrink-0 text-2xs text-subtle">{ENV_SHORT[a.environment]}</span>}
        </li>
      ))}
    </ul>
  );
}

function ItemCard({
  it,
  items,
  roleTitle,
  onRetry,
  retrying,
}: {
  it: WorkItem;
  items: WorkItem[];
  roleTitle: (k: string) => string;
  onRetry?: (it: WorkItem) => void;
  retrying: boolean;
}) {
  const [open, setOpen] = useState(false);
  const deps = items.filter((d) => it.depends_on.includes(d.id));
  const waiting = deps.filter((d) => d.state !== 'COMPLETED');
  const dur = it.started_at ? ((it.finished_at ?? Date.now() / 1000) - it.started_at) : null;
  const long = (it.result_summary?.length ?? 0) > 220;
  return (
    <article aria-label={it.title} className="min-w-0 rounded-xl border border-border bg-panel p-3 shadow-card">
      <div className="flex items-start justify-between gap-2">
        <h4 className="min-w-0 text-[13px] leading-5 font-semibold break-words text-text">{it.title}</h4>
        <StatusPill state={it.state} pulse={BUSY_STATES.has(it.state)} className="shrink-0" />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {KIND_LABEL[it.kind] && <Badge tone="accent">{KIND_LABEL[it.kind]}</Badge>}
        <Badge>{roleTitle(it.role_key)}</Badge>
        {it.environment ? (
          <EnvBadge env={it.environment} source={it.env_source} showSource />
        ) : (
          <Badge title="The environment is resolved when the item starts">env decided at start</Badge>
        )}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
        {it.agent_id ? (
          <span className="flex min-w-0 items-center gap-1.5">
            <Avatar name={it.agent_name ?? '?'} id={it.agent_id} size="xs" />
            <TextLink href={href(`/agents/${it.agent_id}`)} className="truncate">
              {it.agent_name ?? it.agent_id.slice(0, 8)}
            </TextLink>
          </span>
        ) : (
          <span className="text-subtle">assigned at start</span>
        )}
        <span title="Attempts used / allowed">
          attempt {it.attempts}/{it.max_attempts}
        </span>
        {dur !== null && <span>{formatDuration(dur)}</span>}
      </div>
      {waiting.length > 0 && (it.state === 'PENDING' || it.state === 'READY') && (
        <p className="mt-2 text-xs text-subtle" title={waiting.map((d) => d.title).join('\n')}>
          Waits for {waiting.length === 1 ? `“${waiting[0].title}”` : `${waiting.length} items`}
        </p>
      )}
      {it.result_summary && (
        <div className="mt-2">
          <p className={`text-xs leading-5 break-words whitespace-pre-wrap ${it.state === 'FAILED' ? 'text-danger' : 'text-muted'} ${open ? '' : 'line-clamp-3'}`}>{it.result_summary}</p>
          {long && (
            <button type="button" className="mt-0.5 rounded text-2xs text-accent-soft hover:underline focus-ring" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
              {open ? 'Show less' : 'Show all'}
            </button>
          )}
        </div>
      )}
      {it.artifacts.length > 0 && (
        <div className="mt-2.5 border-t border-border/70 pt-2">
          <p className="mb-1 text-2xs font-medium tracking-wide text-subtle uppercase">Artifacts ({it.artifacts.length})</p>
          <ArtifactList artifacts={it.artifacts} />
        </div>
      )}
      {it.transfers.length > 0 && (
        <div className="mt-2.5 border-t border-border/70 pt-2">
          <p className="mb-1 text-2xs font-medium tracking-wide text-subtle uppercase">Transfers between environments</p>
          <ul className="space-y-1">
            {it.transfers.map((t, i) => (
              <li key={`${t.source}-${i}`} className="text-xs">
                <span className="flex flex-wrap items-center gap-1">
                  <Badge tone={t.ok ? 'success' : 'danger'}>{t.ok ? 'transferred' : 'failed'}</Badge>
                  {t.from_env && t.to_env && (
                    <span className="inline-flex items-center gap-1 text-muted">
                      {ENV_SHORT[t.from_env]} <IconArrowRight className="size-3" /> {ENV_SHORT[t.to_env]}
                    </span>
                  )}
                </span>
                <Mono className="mt-0.5 block break-all">{t.dest ?? t.source}</Mono>
                {t.error && <span className="block break-words text-danger">{t.error}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {(it.task_id || (onRetry && ITEM_RETRYABLE.has(it.state))) && (
        <div className="mt-2.5 flex flex-wrap items-center justify-end gap-2 border-t border-border/70 pt-2">
          {it.task_id && it.agent_id && (
            <TextLink href={href(`/agents/${it.agent_id}/tasks?task=${it.task_id}`)} className="mr-auto inline-flex items-center gap-1 text-xs">
              Open task <IconExternal className="size-3" />
            </TextLink>
          )}
          {onRetry && ITEM_RETRYABLE.has(it.state) && (
            <Button size="xs" icon={<IconRefresh />} loading={retrying} onClick={() => onRetry(it)} aria-label={`Retry ${it.title}`}>
              Retry
            </Button>
          )}
        </div>
      )}
    </article>
  );
}

export function TaskBoard({
  run,
  roleTitle,
  onRetry,
  retryingId,
}: {
  run: RunDetail;
  roleTitle: (k: string) => string;
  onRetry?: (it: WorkItem) => void;
  retryingId?: string | null;
}) {
  const groups = groupWorkItems(run.items);
  const visible = groups.filter((g) => g.items.length > 0 || g.id === 'queued' || g.id === 'running' || g.id === 'completed');
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-[repeat(auto-fit,minmax(15rem,1fr))]">
      {visible.map((g) => (
        <section key={g.id} aria-label={`${g.label} (${g.items.length})`} className="min-w-0 rounded-xl border border-border bg-panel-2/60 p-2.5">
          <header className="mb-2.5 flex items-center justify-between gap-2 px-1">
            <h3 className="flex items-center gap-2 text-[13px] font-semibold text-text">
              <span aria-hidden className={`size-2 rounded-full ${g.tone === 'success' ? 'bg-success' : g.tone === 'danger' ? 'bg-danger' : g.tone === 'accent' ? 'bg-accent-soft' : 'bg-subtle'}`} />
              {g.label}
            </h3>
            <span className="text-xs text-subtle tabular-nums">{g.items.length}</span>
          </header>
          {g.items.length === 0 ? (
            <p className="px-1 pb-1 text-xs text-subtle">Nothing here.</p>
          ) : (
            <div className="space-y-2.5">
              {g.items.map((it) => (
                <ItemCard key={it.id} it={it} items={run.items} roleTitle={roleTitle} onRetry={onRetry} retrying={retryingId === it.id} />
              ))}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}
