import { useState } from 'react';
import { IconCompanies, IconPlus } from '../../components/icons';
import { StatusPill } from '../../components/StatusPill';
import { Avatar, Field, Input, Select, Textarea } from '../../components/ui';
import type { Agent } from '../../types';
import { hasPermission, useMini } from '../context';
import { useActions, useQuery } from '../hooks';
import { mhref, navigate } from '../router';
import type { CompanySummary } from '../types';
import { Card, Clamp, Empty, QueryView, Screen, TapButton, tapLinkClass } from '../uiKit';
import { EnvBadge } from '../uiExtra';

export function CompaniesScreen() {
  const ctx = useMini();
  const q = useQuery<CompanySummary[]>('companies', (s) => ctx.api.companies.list(s), { refreshOn: (ev) => ev.type.startsWith('company.') });
  const canCreate = hasPermission(ctx, 'companies');
  return (
    <Screen
      title="AI Companies"
      subtitle={q.data ? `${q.data.length} compan${q.data.length === 1 ? 'y' : 'ies'}` : undefined}
      actions={
        canCreate ? (
          <a href={mhref('/companies/new')} className={tapLinkClass('primary', '!px-3')} aria-label="New company">
            <IconPlus /> New
          </a>
        ) : undefined
      }
    >
      <QueryView
        q={q}
        isEmpty={(d) => d.length === 0}
        empty={
          <Empty title="No AI companies yet" icon={<IconCompanies />} action={canCreate ? <a className={tapLinkClass('primary')} href={mhref('/companies/new')}>Create a company</a> : undefined}>
            A company is a team of agents with roles (CEO, developers, QA…) that runs projects for you.
          </Empty>
        }
      >
        {(list) => (
          <ul className="space-y-2.5">
            {list.map((c) => (
              <li key={c.id}>
                <a href={mhref(`/companies/${c.id}`)} className="block rounded-card bg-panel p-3.5 active:bg-panel-3 focus-ring">
                  <div className="flex items-start gap-3">
                    <Avatar name={c.name} id={c.id} size="lg" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-[15px] font-semibold text-text">{c.name}</span>
                      </div>
                      <Clamp lines={2} className="mt-0.5 text-[12.5px] text-muted">
                        {c.objective || c.description || c.industry || 'No objective set'}
                      </Clamp>
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        {c.active_runs > 0 ? <StatusPill state="RUNNING" label={`${c.active_runs} run${c.active_runs === 1 ? '' : 's'} active`} pulse /> : <StatusPill state={c.status} />}
                        <EnvBadge env={c.default_environment} />
                        <span className="text-[11.5px] text-subtle">
                          {c.member_count} employees · {c.project_count} projects
                        </span>
                      </div>
                    </div>
                  </div>
                </a>
              </li>
            ))}
          </ul>
        )}
      </QueryView>
    </Screen>
  );
}

/** Simple mobile form for POST /companies (roles and projects are refined later in the Dashboard). */
export function CompanyCreateScreen() {
  const ctx = useMini();
  const { api } = ctx;
  const { run, isPending } = useActions();
  const agents = useQuery<Agent[]>('agents', (s) => api.agents.list(s));
  const [name, setName] = useState('');
  const [industry, setIndustry] = useState('');
  const [objective, setObjective] = useState('');
  const [description, setDescription] = useState('');
  const [env, setEnv] = useState<'vm' | 'host'>('vm');
  const [ceo, setCeo] = useState('');
  const [touched, setTouched] = useState(false);
  const nameError = touched && !name.trim() ? 'A name is required' : name.length > 96 ? 'At most 96 characters' : null;

  if (!hasPermission(ctx, 'companies')) {
    return (
      <Screen title="New company">
        <Empty title="Not allowed">This Mini App session may not create companies.</Empty>
      </Screen>
    );
  }

  const submit = async () => {
    setTouched(true);
    if (!name.trim() || name.length > 96) return;
    const r = await run(
      'create',
      () =>
        api.companies.create({
          name: name.trim(),
          industry: industry.trim() || undefined,
          objective: objective.trim() || undefined,
          description: description.trim() || undefined,
          default_environment: env,
          members: ceo ? [{ agent_id: ceo, role_key: 'ceo' }] : [],
        }),
      { success: (c) => `${c.name} founded`, errorTitle: 'Could not create the company' },
    );
    if (r) navigate(`/companies/${r.id}`, { replace: true });
  };

  return (
    <Screen title="New company">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        noValidate
      >
        <Card className="space-y-4">
          <Field label="Name" htmlFor="co-name" error={nameError ?? undefined}>
            <Input id="co-name" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => setTouched(true)} maxLength={96} required aria-invalid={Boolean(nameError)} className="min-h-11" autoComplete="off" />
          </Field>
          <Field label="Industry" htmlFor="co-industry" hint="Optional, e.g. Software, Marketing">
            <Input id="co-industry" value={industry} onChange={(e) => setIndustry(e.target.value)} maxLength={96} className="min-h-11" />
          </Field>
          <Field label="Objective" htmlFor="co-objective" hint="What the company works towards">
            <Textarea id="co-objective" value={objective} onChange={(e) => setObjective(e.target.value)} rows={3} maxLength={4000} />
          </Field>
          <Field label="Description" htmlFor="co-desc">
            <Textarea id="co-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} maxLength={4000} />
          </Field>
          <Field label="Default environment" htmlFor="co-env" hint="Where employees work unless a project or member overrides it">
            <Select id="co-env" value={env} onChange={(e) => setEnv(e.target.value as 'vm' | 'host')} className="min-h-11">
              <option value="vm">Ubuntu VM (isolated, Live Desktop)</option>
              <option value="host">Mac mini (authorised project folders)</option>
            </Select>
          </Field>
          <Field label="CEO" htmlFor="co-ceo" hint="Optional. Each agent can belong to one company; add more employees in the Dashboard.">
            <Select id="co-ceo" value={ceo} onChange={(e) => setCeo(e.target.value)} className="min-h-11" disabled={!agents.data}>
              <option value="">No CEO yet</option>
              {(agents.data ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {a.model_id ? ` · ${a.model_id}` : ' · no model'}
                </option>
              ))}
            </Select>
          </Field>
        </Card>
        <TapButton type="submit" variant="primary" className="w-full" loading={isPending('create')} icon={<IconPlus />}>
          Create company
        </TapButton>
      </form>
    </Screen>
  );
}
