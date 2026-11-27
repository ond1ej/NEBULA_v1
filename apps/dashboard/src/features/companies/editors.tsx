// Shared form pieces for the company wizard, Employees tab, Settings tab and project form.
import { useEffect, useId, useState, type ReactNode } from 'react';
import { api } from '../../api';
import { IconCheck, IconPlus, IconTrash, IconX } from '../../components/icons';
import { isConnected, providerLabel } from '../../lib/providers';
import { useToast } from '../../components/Toast';
import { Avatar, Badge, Button, Checkbox, Field, IconButton, Input, Notice, Select, Skeleton, Textarea, TextLink } from '../../components/ui';
import { useApi } from '../../hooks/useApi';
import { href } from '../../hooks/useHashRoute';
import type { Agent, ModelInfo, Provider } from '../../types';
import { hostApi } from '../environment/api';
import { ENV_LONG, ENV_SHORT, EnvIcon } from '../environment/EnvBadge';
import type { EnvDescription, EnvId, HostRoot } from '../environment/types';
import { FolderPicker } from '../hostaccess/FolderPicker';
import type { MemberDraft, RoleDraft } from './lib';
import { newUid, roleKeyOf } from './lib';
import type { CatalogRole, OrgNode } from './types';

export const ENV_CHOICE_TEXT: Record<EnvId, { title: string; text: string }> = {
  host: { title: 'Host computer', text: 'Work directly on the Mac mini using approved native tools and selected project directories.' },
  vm: { title: 'Virtual machine', text: 'Work inside an isolated Ubuntu environment with desktop, browser and Live Desktop.' },
};

/** Two large radio cards: host computer vs virtual machine (with benefits/limitations from GET /environments). */
export function EnvironmentChoice({
  value,
  onChange,
  descriptions,
  label,
  disabled,
}: {
  value: EnvId;
  onChange: (v: EnvId) => void;
  descriptions: EnvDescription[] | null;
  label: string;
  disabled?: boolean;
}) {
  const name = useId();
  return (
    <fieldset className="min-w-0" disabled={disabled}>
      <legend className="sr-only">{label}</legend>
      <div className="grid gap-3 md:grid-cols-2">
        {(['host', 'vm'] as const).map((env) => {
          const checked = value === env;
          const d = descriptions?.find((x) => x.id === env);
          const id = `${name}-${env}`;
          return (
            <label
              key={env}
              htmlFor={id}
              className={`flex min-w-0 cursor-pointer flex-col rounded-xl border p-4 transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent-soft ${
                checked ? 'border-accent/60 bg-accent/[0.07]' : 'border-border bg-panel-2 hover:border-border-hover'
              }`}
            >
              <input id={id} type="radio" name={name} value={env} checked={checked} onChange={() => onChange(env)} className="sr-only" />
              <span className="flex items-start gap-3">
                <span
                  aria-hidden
                  className={`grid size-9 shrink-0 place-items-center rounded-lg border ${
                    env === 'host' ? 'border-accent/35 bg-accent/15 text-accent-soft' : 'border-[#8fd3e8]/25 bg-[#11262d] text-[#8fd3e8]'
                  }`}
                >
                  <EnvIcon env={env} className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-text">{ENV_CHOICE_TEXT[env].title}</span>
                  <span className="block text-xs text-subtle">{ENV_LONG[env]}</span>
                </span>
                <span aria-hidden className={`mt-1 grid size-4 shrink-0 place-items-center rounded-full border-2 ${checked ? 'border-accent-soft' : 'border-border-strong'}`}>
                  {checked && <span className="size-2 rounded-full bg-accent-soft" />}
                </span>
              </span>
              <span className="mt-2 block text-[13px] text-muted">{ENV_CHOICE_TEXT[env].text}</span>
              {d ? (
                <span className="mt-3 grid gap-1.5 text-xs">
                  {d.benefits.map((b) => (
                    <span key={b} className="flex gap-1.5 text-muted">
                      <IconCheck className="mt-0.5 size-3 shrink-0 text-success" />
                      {b}
                    </span>
                  ))}
                  {d.limitations.map((b) => (
                    <span key={b} className="flex gap-1.5 text-muted">
                      <IconX className="mt-0.5 size-3 shrink-0 text-warn" />
                      {b}
                    </span>
                  ))}
                </span>
              ) : descriptions === null ? (
                <span className="mt-3 block space-y-1.5">
                  <Skeleton className="h-3 w-4/5" />
                  <Skeleton className="h-3 w-3/5" />
                </span>
              ) : null}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

/** "Authorise a folder…" button with its own directory picker (loads detected tools on demand). */
export function AuthoriseFolderButton({ existing, onAdded, size = 'sm' }: { existing: HostRoot[]; onAdded: (r: HostRoot) => void; size?: 'sm' | 'md' }) {
  const [open, setOpen] = useState(false);
  const tools = useApi((s) => (open ? hostApi.tools(false, s) : Promise.resolve(null)), [open]);
  return (
    <>
      <Button size={size} icon={<IconPlus />} onClick={() => setOpen(true)}>
        Authorise a folder…
      </Button>
      <FolderPicker
        open={open}
        existing={existing}
        detected={tools.data?.tools ?? (tools.error ? {} : null)}
        onClose={() => setOpen(false)}
        onAdded={(r) => {
          setOpen(false);
          onAdded(r);
        }}
      />
    </>
  );
}

/** Select of authorised, enabled host folders (+ inline authorisation). */
export function RootSelect({
  id,
  label,
  value,
  onChange,
  roots,
  onRootAdded,
  error,
  hint,
  emptyLabel = 'Choose a folder…',
  required,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  roots: HostRoot[] | null;
  onRootAdded: (r: HostRoot) => void;
  error?: string;
  hint?: string;
  emptyLabel?: string;
  required?: boolean;
}) {
  const usable = (roots ?? []).filter((r) => (r.enabled && r.exists !== false) || r.id === value);
  const chosen = usable.find((r) => r.id === value);
  if (roots && usable.length === 0)
    return (
      <Notice tone={required ? 'warn' : 'info'} title="No authorised project folder yet" action={<AuthoriseFolderButton existing={roots} onAdded={(r) => { onRootAdded(r); onChange(r.id); }} />}>
        Host work only happens inside folders you authorise.{' '}
        <TextLink href={href('/host')}>Manage host access</TextLink>
        {error ? <span className="mt-1 block text-danger">{error}</span> : null}
      </Notice>
    );
  return (
    <Field
      htmlFor={id}
      label={label}
      required={required}
      error={error}
      hint={chosen ? `${chosen.path} · ${chosen.mode === 'read_only' ? 'read-only' : 'read-write'} · network ${chosen.allow_network ? 'on' : 'off'}` : hint}
      aside={roots ? <TextLink href={href('/host')}>Host access</TextLink> : undefined}
    >
      <div className="flex flex-wrap gap-2">
        <Select id={id} value={value} onChange={(e) => onChange(e.target.value)} disabled={!roots} aria-invalid={error ? true : undefined} className="min-w-0 flex-1 basis-56">
          <option value="">{emptyLabel}</option>
          {usable.map((r) => (
            <option key={r.id} value={r.id} disabled={!r.enabled}>
              {r.name} — {r.path}
              {!r.enabled ? ' (disabled)' : ''}
            </option>
          ))}
        </Select>
        {roots && (
          <AuthoriseFolderButton
            existing={roots}
            onAdded={(r) => {
              onRootAdded(r);
              onChange(r.id);
            }}
          />
        )}
      </div>
    </Field>
  );
}

/** Optional preferred provider + model (recorded on the company; employees keep their own configured model). */
export function ProviderPrefFields({
  providerId,
  modelId,
  onChange,
  error,
}: {
  providerId: string;
  modelId: string;
  onChange: (v: { providerId: string; modelId: string }) => void;
  error?: string;
}) {
  const ids = { p: useId(), m: useId() };
  const toast = useToast();
  const providers = useApi(() => api.providers.list(), []);
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  useEffect(() => {
    setModels(null);
    if (!providerId) return;
    let cancelled = false;
    api.providers
      .models(providerId)
      .then((m) => !cancelled && setModels(m))
      .catch((e: unknown) => {
        if (!cancelled) {
          setModels([]);
          toast.error(e, 'Models unavailable');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [providerId, toast]);
  const list: Provider[] = (providers.data ?? []).filter((p) => isConnected(p.state) || p.id === providerId);
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field htmlFor={ids.p} label="Preferred AI provider" hint="Optional. Recorded for the company; every employee still uses the model configured on its agent.">
        <Select id={ids.p} value={providerId} onChange={(e) => onChange({ providerId: e.target.value, modelId: '' })} disabled={!providers.data}>
          <option value="">No preference</option>
          {list.map((p) => (
            <option key={p.id} value={p.id}>
              {providerLabel(p)}
            </option>
          ))}
        </Select>
      </Field>
      <Field htmlFor={ids.m} label="Preferred model" error={error}>
        <Select id={ids.m} value={modelId} onChange={(e) => onChange({ providerId, modelId: e.target.value })} disabled={!providerId || !models} aria-invalid={error ? true : undefined}>
          <option value="">{!providerId ? 'Choose a provider first' : !models ? 'Loading models…' : 'Choose a model…'}</option>
          {(models ?? []).map((m) => (
            <option key={m.id} value={m.id}>
              {m.display_name || m.id}
            </option>
          ))}
          {modelId && models && !models.some((m) => m.id === modelId) && <option value={modelId}>{modelId}</option>}
        </Select>
      </Field>
    </div>
  );
}

// ---------------------------------------------------------------- roles
export function RolesEditor({
  catalog,
  roles,
  onChange,
  used,
  error,
}: {
  catalog: CatalogRole[] | null;
  roles: RoleDraft[];
  onChange: (r: RoleDraft[]) => void;
  /** Role keys held by employees (cannot be removed). */
  used: Set<string>;
  error?: string;
}) {
  const uid = useId();
  const has = (key: string) => roles.some((r) => !r.custom && r.key === key);
  const toggle = (c: CatalogRole, on: boolean) => {
    if (on) onChange([...roles, { ...c, custom: false }].sort((a, b) => a.stage - b.stage));
    else onChange(roles.filter((r) => r.custom || r.key !== c.key));
  };
  const custom = roles.map((r, i) => ({ r, i })).filter((x) => x.r.custom);
  const update = (i: number, patch: Partial<RoleDraft>) => onChange(roles.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-5">
      <section aria-labelledby={`${uid}-cat`}>
        <h3 id={`${uid}-cat`} className="text-sm font-semibold text-text">
          Role catalogue
        </h3>
        <p className="mt-0.5 mb-3 text-xs text-muted">Stages order the template plan: lower stages work first (research → design → build → QA/security → DevOps).</p>
        {!catalog ? (
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-16 w-full rounded-lg" />
            ))}
          </div>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3" aria-label="Catalogue roles">
            {catalog.map((c) => {
              const on = has(c.key);
              const locked = on && used.has(c.key);
              return (
                <li key={c.key} className={`rounded-lg border px-3 py-2.5 ${on ? 'border-accent/45 bg-accent/[0.06]' : 'border-border bg-panel-2'}`}>
                  <Checkbox
                    checked={on}
                    disabled={locked}
                    onChange={(v) => toggle(c, v)}
                    label={
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className="font-medium">{c.title}</span>
                        <Badge className="!h-[18px] !text-[10.5px]">stage {c.stage}</Badge>
                        {locked && <span className="text-2xs text-subtle">in use</span>}
                      </span>
                    }
                    description={<span className="line-clamp-2">{c.responsibilities}</span>}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <section aria-labelledby={`${uid}-custom`}>
        <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
          <div>
            <h3 id={`${uid}-custom`} className="text-sm font-semibold text-text">
              Custom roles
            </h3>
            <p className="mt-0.5 text-xs text-muted">Roles the catalogue does not cover, with their own responsibilities.</p>
          </div>
          <Button size="sm" icon={<IconPlus />} onClick={() => onChange([...roles, { key: '', title: '', responsibilities: '', stage: 50, custom: true }])}>
            Add custom role
          </Button>
        </div>
        {custom.length === 0 ? (
          <p className="text-xs text-subtle">No custom roles.</p>
        ) : (
          <ul className="space-y-3">
            {custom.map(({ r, i }) => {
              const key = roleKeyOf(r);
              const locked = Boolean(key) && used.has(key);
              return (
                <li key={i} className="rounded-xl border border-border bg-panel-2 p-3">
                  <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_7rem_auto] sm:items-end">
                    <Field htmlFor={`${uid}-t${i}`} label="Title" required aside={key ? <code className="text-2xs">{key}</code> : undefined}>
                      <Input id={`${uid}-t${i}`} value={r.title} maxLength={96} onChange={(e) => update(i, { title: e.target.value, key: locked ? key : '' })} placeholder="e.g. Content Writer" />
                    </Field>
                    <Field htmlFor={`${uid}-s${i}`} label="Stage">
                      <Input id={`${uid}-s${i}`} type="number" min={0} max={100} value={Number.isFinite(r.stage) ? r.stage : ''} onChange={(e) => update(i, { stage: e.target.value === '' ? NaN : Number(e.target.value) })} />
                    </Field>
                    <IconButton label={`Remove role ${r.title || 'custom role'}`} icon={<IconTrash />} disabledReason={locked ? 'An employee holds this role' : null} onClick={() => onChange(roles.filter((_, j) => j !== i))} />
                  </div>
                  <div className="mt-3">
                    <Field htmlFor={`${uid}-r${i}`} label="Responsibilities">
                      <Textarea id={`${uid}-r${i}`} rows={2} maxLength={2000} value={r.responsibilities} onChange={(e) => update(i, { responsibilities: e.target.value })} />
                    </Field>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- members / organisation
export function MembersEditor({
  agents,
  roles,
  members,
  onChange,
  errors,
  takenBy,
  companyId,
  defaultEnv,
  rowExtra,
}: {
  agents: Agent[] | null;
  roles: RoleDraft[];
  members: MemberDraft[];
  onChange: (m: MemberDraft[]) => void;
  errors: Record<string, string>;
  /** agent_id → company it already works for. */
  takenBy: Record<string, { id: string; name: string }>;
  companyId?: string;
  defaultEnv: EnvId;
  /** Extra read-only info under a row (effective environment, lifecycle…). */
  rowExtra?: (m: MemberDraft) => ReactNode;
}) {
  const uid = useId();
  const roleTitle = (k: string) => roles.find((r) => roleKeyOf(r) === k)?.title ?? k;
  const agentName = (id: string) => agents?.find((a) => a.id === id)?.name ?? id.slice(0, 8);
  const update = (u: string, patch: Partial<MemberDraft>) => onChange(members.map((m) => (m.uid === u ? { ...m, ...patch } : m)));
  const elsewhere = (id: string) => (takenBy[id] && takenBy[id].id !== companyId ? takenBy[id] : null);
  const free = (agents ?? []).filter((a) => !members.some((m) => m.agent_id === a.id) && !elsewhere(a.id) && a.state !== 'DELETING');
  const add = () => {
    const hasCeo = members.some((m) => m.role_key === 'ceo');
    const keys = roles.map(roleKeyOf).filter(Boolean);
    const role = !hasCeo && keys.includes('ceo') ? 'ceo' : (keys.find((k) => k !== 'ceo') ?? keys[0] ?? '');
    onChange([...members, { uid: newUid(), agent_id: free[0]?.id ?? '', role_key: role, title: '', reports_to: '', environment: '', instructions: '' }]);
  };
  return (
    <div className="space-y-3">
      {errors[''] && <Notice tone="danger">{errors['']}</Notice>}
      {members.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border-strong px-4 py-6 text-center text-sm text-muted">
          No employees yet. Assign existing agents to the company’s roles — an agent can work for only one company.
        </p>
      ) : (
        <ul className="space-y-3" aria-label="Employees">
          {members.map((m, idx) => {
            const err = errors[m.uid];
            const agent = agents?.find((a) => a.id === m.agent_id);
            const isCeo = m.role_key === 'ceo';
            return (
              <li key={m.uid} className={`rounded-xl border bg-panel-2 p-3 sm:p-4 ${err ? 'border-danger/50' : 'border-border'}`} aria-label={`Employee ${idx + 1}${agent ? `: ${agent.name}` : ''}`}>
                <div className="flex items-start gap-3">
                  <span className="mt-6 hidden sm:block">
                    <Avatar name={agent?.name ?? '?'} id={m.agent_id || m.uid} size="md" />
                  </span>
                  <div className="grid min-w-0 flex-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                    <Field htmlFor={`${uid}-a${m.uid}`} label="Agent" required>
                      <Select id={`${uid}-a${m.uid}`} value={m.agent_id} onChange={(e) => update(m.uid, { agent_id: e.target.value })} disabled={!agents} aria-invalid={err && !m.agent_id ? true : undefined}>
                        <option value="">Choose an agent…</option>
                        {(agents ?? []).map((a) => {
                          const other = elsewhere(a.id);
                          const dup = members.some((x) => x.uid !== m.uid && x.agent_id === a.id);
                          return (
                            <option key={a.id} value={a.id} disabled={(!!other || dup) && a.id !== m.agent_id}>
                              {a.name}
                              {other ? ` — works for ${other.name}` : dup ? ' — already an employee' : !a.model_id ? ' — no AI model' : ''}
                            </option>
                          );
                        })}
                      </Select>
                    </Field>
                    <Field htmlFor={`${uid}-r${m.uid}`} label="Role" required>
                      <Select id={`${uid}-r${m.uid}`} value={m.role_key} onChange={(e) => update(m.uid, { role_key: e.target.value, reports_to: e.target.value === 'ceo' ? '' : m.reports_to })}>
                        <option value="">Choose a role…</option>
                        {roles.map((r) => {
                          const k = roleKeyOf(r);
                          return k ? (
                            <option key={k} value={k}>
                              {r.title}
                            </option>
                          ) : null;
                        })}
                      </Select>
                    </Field>
                    <Field htmlFor={`${uid}-ti${m.uid}`} label="Job title" hint="Optional, shown in the org chart.">
                      <Input id={`${uid}-ti${m.uid}`} value={m.title} maxLength={96} onChange={(e) => update(m.uid, { title: e.target.value })} placeholder={m.role_key ? roleTitle(m.role_key) : ''} />
                    </Field>
                    <Field htmlFor={`${uid}-rt${m.uid}`} label="Reports to">
                      <Select id={`${uid}-rt${m.uid}`} value={m.reports_to} onChange={(e) => update(m.uid, { reports_to: e.target.value })}>
                        <option value="">{isCeo ? 'Nobody (top of the org)' : 'Default — the CEO'}</option>
                        {members
                          .filter((x) => x.uid !== m.uid && x.agent_id)
                          .map((x) => (
                            <option key={x.uid} value={x.agent_id}>
                              {agentName(x.agent_id)} ({roleTitle(x.role_key)})
                            </option>
                          ))}
                      </Select>
                    </Field>
                    <Field htmlFor={`${uid}-e${m.uid}`} label="Environment" hint="Overrides the company default for this employee.">
                      <Select id={`${uid}-e${m.uid}`} value={m.environment} onChange={(e) => update(m.uid, { environment: e.target.value as MemberDraft['environment'] })}>
                        <option value="">Inherit (company: {ENV_SHORT[defaultEnv]})</option>
                        <option value="vm">{ENV_SHORT.vm}</option>
                        <option value="host">{ENV_SHORT.host}</option>
                      </Select>
                    </Field>
                    <div className="flex items-end justify-end">
                      <Button variant="ghost" size="sm" icon={<IconTrash />} onClick={() => onChange(members.filter((x) => x.uid !== m.uid).map((x) => (x.reports_to === m.agent_id ? { ...x, reports_to: '' } : x)))}>
                        Remove
                      </Button>
                    </div>
                  </div>
                </div>
                <details className="mt-3 sm:ml-12">
                  <summary className="rounded text-xs text-muted hover:text-text focus-ring">Role instructions {m.instructions ? '(set)' : '(optional)'}</summary>
                  <div className="mt-2">
                    <label htmlFor={`${uid}-in${m.uid}`} className="sr-only">
                      Role instructions
                    </label>
                    <Textarea
                      id={`${uid}-in${m.uid}`}
                      rows={3}
                      maxLength={4000}
                      value={m.instructions}
                      onChange={(e) => update(m.uid, { instructions: e.target.value })}
                      placeholder="Extra guidance added to every work item of this employee"
                    />
                  </div>
                </details>
                {rowExtra && m.agent_id ? <div className="mt-3 sm:ml-12">{rowExtra(m)}</div> : null}
                {agent && !agent.model_id && <p className="mt-2 text-xs text-warn sm:ml-12">{agent.name} has no AI model configured — runs refuse to start until it has one.</p>}
                {err && (
                  <p role="alert" className="mt-2 text-xs text-danger sm:ml-12">
                    {err}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" icon={<IconPlus />} onClick={add} disabledReason={!agents ? 'Loading agents…' : free.length === 0 ? 'Every available agent is already assigned' : roles.length === 0 ? 'Choose roles first' : null}>
          Add employee
        </Button>
        {agents && agents.length === 0 && (
          <span className="text-xs text-muted">
            No agents yet. <TextLink href={href('/agents/new')}>Create an agent</TextLink> first.
          </span>
        )}
        {Object.keys(takenBy).some((id) => elsewhere(id)) && <span className="text-xs text-subtle">Agents that already work for another company are disabled (one company per agent).</span>}
      </div>
    </div>
  );
}

/** Org-chart preview of unsaved members (wizard review, Employees tab). */
export function draftOrgNodes(members: MemberDraft[], roles: RoleDraft[], agents: Agent[] | null, defaultEnv: EnvId): OrgNode[] {
  const ceo = members.find((m) => m.role_key === 'ceo' && m.agent_id)?.agent_id ?? null;
  return members
    .filter((m) => m.agent_id)
    .map((m) => {
      const a = agents?.find((x) => x.id === m.agent_id);
      const env: EnvId = m.environment || defaultEnv;
      const chain = [{ level: 'company', env: defaultEnv }, ...(m.environment ? [{ level: 'member', env: m.environment }] : [])];
      return {
        agent_id: m.agent_id,
        name: a?.name ?? m.agent_id.slice(0, 8),
        role_key: m.role_key,
        role: roles.find((r) => roleKeyOf(r) === m.role_key)?.title ?? m.role_key,
        title: m.title,
        reports_to: m.reports_to || (m.role_key !== 'ceo' ? ceo : null),
        model: a?.model_id ?? null,
        provider: a?.provider_id ?? null,
        status: a?.state ?? 'UNKNOWN',
        lifecycle: 'IDLE',
        environment: { env, root_id: null, source: m.environment ? 'member' : 'company', label: ENV_LONG[env], chain },
        current_item: null,
      };
    });
}
