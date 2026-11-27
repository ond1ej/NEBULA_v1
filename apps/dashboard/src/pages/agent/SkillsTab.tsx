import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api';
import { IconSkills } from '../../components/icons';
import { Badge, Button, ButtonLink, EmptyState, ErrorBanner, LoadingRows, Notice, Switch } from '../../components/ui';
import { useAction, useApi } from '../../hooks/useApi';
import { useLiveRefresh } from '../../hooks/useEvents';
import { href } from '../../hooks/useHashRoute';
import type { Agent, AgentSkill } from '../../types';

export const LEVEL_ORDER = ['READ_ONLY', 'STANDARD', 'ADVANCED'];

export function levelAllows(agentLevel: string, required: string | undefined): boolean {
  if (!required) return true;
  const a = LEVEL_ORDER.indexOf(agentLevel);
  const r = LEVEL_ORDER.indexOf(required);
  if (r < 0) return true;
  return a >= r;
}

export function toolCount(s: AgentSkill): number {
  return Array.isArray(s.manifest?.tools) ? s.manifest.tools.length : 0;
}

export function SkillsTab({ agent }: { agent: Agent }) {
  const skills = useApi(() => api.skills.forAgent(agent.id), [agent.id]);
  const { run, isPending } = useAction();
  const [sel, setSel] = useState<Set<string> | null>(null);
  useLiveRefresh(skills.reload, (e) => e.type === 'skill.changed', 500);

  useEffect(() => {
    if (skills.data) setSel(new Set(skills.data.filter((s) => s.assigned).map((s) => s.id)));
  }, [skills.data]);

  const list = skills.data ?? [];
  const initial = useMemo(() => new Set(list.filter((s) => s.assigned).map((s) => s.id)), [list]);
  const dirty = sel !== null && (sel.size !== initial.size || [...sel].some((id) => !initial.has(id)));
  const explicit = list.some((s) => s.explicit);

  const save = async () => {
    if (!sel) return;
    const r = await run('save', () => api.skills.assign(agent.id, [...sel]), { success: 'Skill assignment saved', errorTitle: 'Assignment not saved' });
    if (r) skills.setData(() => r);
  };

  if (skills.error && !skills.data) return <ErrorBanner error={skills.error} onRetry={skills.reload} />;
  if (!skills.data || !sel)
    return (
      <div className="rounded-xl border border-border bg-panel p-5">
        <LoadingRows label="Loading skills…" />
      </div>
    );
  if (list.length === 0)
    return (
      <EmptyState icon={<IconSkills />} title="No skills installed" action={<ButtonLink href={href('/skills')}>Open the skill catalog</ButtonLink>}>
        Built-in skills appear here once the host has registered them.
      </EmptyState>
    );

  const groups = [
    { title: 'Built-in skills', items: list.filter((s) => s.kind === 'builtin') },
    { title: 'Plugins', items: list.filter((s) => s.kind !== 'builtin') },
  ].filter((g) => g.items.length > 0);

  return (
    <div className="space-y-5">
      <Notice tone="info">
        {explicit
          ? `${agent.name} uses an explicit skill selection. Unselected skills’ tools are not offered to the model.`
          : `${agent.name} has no explicit selection yet, so every built-in skill is available. Saving creates an explicit selection.`}{' '}
        Permission level <strong>{agent.permission_level}</strong> still limits which tools can run, and sensitive actions keep asking for approval.
      </Notice>
      {groups.map((g) => (
        <section key={g.title}>
          <h3 className="mb-2.5 text-2xs font-semibold tracking-wider text-subtle uppercase">{g.title}</h3>
          <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-panel shadow-card">
            {g.items.map((s) => {
              const required = s.manifest?.permissions?.min_level;
              const allowed = levelAllows(agent.permission_level, required);
              const on = sel.has(s.id);
              return (
                <li key={s.id} className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-start sm:px-5">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-text">{s.name}</span>
                      <Badge tone={s.kind === 'builtin' ? 'neutral' : 'accent'}>{s.kind === 'builtin' ? 'Built-in' : 'Plugin'}</Badge>
                      <span className="font-mono text-2xs text-subtle">v{s.version}</span>
                      {required && <Badge tone={allowed ? 'neutral' : 'warn'}>needs {required.replace('_', ' ').toLowerCase()}</Badge>}
                      {!s.enabled && <Badge tone="danger">Disabled globally</Badge>}
                    </div>
                    <p className="mt-1 text-[13px] text-muted">{s.description}</p>
                    <p className="mt-1 text-2xs text-subtle">
                      {toolCount(s)} tool{toolCount(s) === 1 ? '' : 's'} · used {s.usage_count}× · {s.assigned_agents} agent(s)
                    </p>
                    {on && !allowed && <p className="mt-1 text-xs text-warn">This agent’s level ({agent.permission_level}) is below the skill’s requirement, so its tools stay unavailable.</p>}
                  </div>
                  <Switch
                    hideLabel
                    label={`Assign ${s.name} to ${agent.name}`}
                    checked={on}
                    disabled={!s.enabled}
                    onChange={(v) =>
                      setSel((cur) => {
                        const n = new Set(cur ?? []);
                        if (v) n.add(s.id);
                        else n.delete(s.id);
                        return n;
                      })
                    }
                  />
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      <div className="sticky bottom-[calc(env(safe-area-inset-bottom)+80px)] z-10 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-elevated/95 p-3 shadow-pop backdrop-blur md:bottom-4">
        <p className="mr-auto text-sm text-muted">
          {sel.size} of {list.length} skills selected{dirty ? ' · unsaved changes' : ''}
        </p>
        <Button onClick={() => setSel(new Set(initial))} disabled={!dirty || isPending('save')}>
          Discard
        </Button>
        <Button variant="primary" onClick={save} loading={isPending('save')} disabledReason={!dirty ? 'No changes' : null}>
          Save assignment
        </Button>
      </div>
    </div>
  );
}
