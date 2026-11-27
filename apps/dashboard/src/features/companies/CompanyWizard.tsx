// Company creation wizard (#/companies/new): basics → environment → policies → roles → organisation → review.
import { useEffect, useId, useMemo, useState } from 'react';
import { ApiError, api } from '../../api';
import { IconArrowLeft, IconArrowRight, IconCheck, IconCompanies } from '../../components/icons';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, ErrorBanner, Field, Input, KeyValue, Notice, PageHeader, SegmentedControl, Switch, Textarea } from '../../components/ui';
import { useApi } from '../../hooks/useApi';
import { href, navigate } from '../../hooks/useHashRoute';
import { envApi, hostApi } from '../environment/api';
import { EnvBadge, ENV_LONG } from '../environment/EnvBadge';
import { agentCompanyMap, companiesApi } from './api';
import { draftOrgNodes, EnvironmentChoice, MembersEditor, ProviderPrefFields, RolesEditor, RootSelect } from './editors';
import { buildCompanyBody, emptyDraft, roleKeyOf, validateDraft, type CompanyDraft, type WizardStep } from './lib';
import { OrgChart } from './OrgChart';

export const WIZARD_STEPS: { id: WizardStep; label: string; text: string }[] = [
  { id: 'basics', label: 'Basics', text: 'Name, mission and industry' },
  { id: 'environment', label: 'Environment', text: 'Where employees work by default' },
  { id: 'policies', label: 'Policies', text: 'AI provider, resources, budget, approvals' },
  { id: 'roles', label: 'Roles', text: 'Positions in the company' },
  { id: 'organisation', label: 'Organisation', text: 'Agents, reporting lines, environments' },
  { id: 'review', label: 'Review', text: 'Check and found the company' },
];

export function CompanyWizard() {
  const toast = useToast();
  const ids = { name: useId(), desc: useId(), obj: useId(), ind: useId(), root: useId(), per: useId(), total: useId() };
  const catalog = useApi((s) => companiesApi.roles(s), []);
  const envInfo = useApi((s) => envApi.info(s), []);
  const roots = useApi((s) => hostApi.roots(s), []);
  const agents = useApi(() => api.agents.list(), []);
  const taken = useApi((s) => agentCompanyMap(s), []);
  const [d, setD] = useState<CompanyDraft>(() => emptyDraft());
  const [step, setStep] = useState<WizardStep>('basics');
  const [touched, setTouched] = useState<Set<WizardStep>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<{ step: WizardStep; error: unknown } | null>(null);
  const [rolesInit, setRolesInit] = useState(false);

  useEffect(() => {
    if (catalog.data && !rolesInit) {
      setRolesInit(true);
      setD((x) => (x.roles.length ? x : { ...x, roles: emptyDraft(catalog.data ?? []).roles }));
    }
  }, [catalog.data, rolesInit]);

  const set = (patch: Partial<CompanyDraft>) => setD((x) => ({ ...x, ...patch }));
  const errors = validateDraft(d);
  const stepErr = (s: WizardStep) => (touched.has(s) ? (errors[s] ?? {}) : {});
  const e = stepErr(step);
  const idx = WIZARD_STEPS.findIndex((s) => s.id === step);
  const used = useMemo(() => new Set(d.members.map((m) => m.role_key).filter(Boolean)), [d.members]);
  const preview = draftOrgNodes(d.members, d.roles, agents.data, d.default_environment);

  const go = (s: WizardStep) => {
    setStep(s);
    window.scrollTo?.(0, 0);
  };
  const next = () => {
    if (errors[step]) {
      setTouched((t) => new Set(t).add(step));
      return;
    }
    go(WIZARD_STEPS[Math.min(idx + 1, WIZARD_STEPS.length - 1)].id);
  };
  const create = async () => {
    const bad = WIZARD_STEPS.filter((s) => errors[s.id]).map((s) => s.id);
    if (bad.length) {
      setTouched(new Set([...touched, ...bad]));
      go(bad[0]);
      return;
    }
    setSubmitting(true);
    setServerError(null);
    try {
      const co = await companiesApi.create(buildCompanyBody(d));
      toast.success(`${co.name} founded`, `${co.members.length} employee(s)`);
      navigate(`/companies/${co.id}`);
    } catch (err) {
      const target: WizardStep =
        err instanceof ApiError && err.code === 'agent_in_other_company'
          ? 'organisation'
          : err instanceof ApiError && err.code === 'exists'
            ? 'basics'
            : err instanceof ApiError && /role/i.test(err.message)
              ? 'roles'
              : err instanceof ApiError && /member|reports_to|agent/i.test(err.message)
                ? 'organisation'
                : err instanceof ApiError && /root|folder/i.test(err.message)
                  ? 'environment'
                  : 'review';
      setServerError({ step: target, error: err });
      go(target);
    } finally {
      setSubmitting(false);
    }
  };

  const chosenRoot = roots.data?.find((r) => r.id === d.default_root_id);
  const ceo = d.members.find((m) => m.role_key === 'ceo');

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'AI Companies', href: href('/companies') }, { label: 'New company' }]}
        icon={
          <span aria-hidden className="grid size-10 place-items-center rounded-xl border border-accent/35 bg-accent/15 text-accent-soft">
            <IconCompanies className="size-5" />
          </span>
        }
        title="Found a company"
        description="An organisation of your agents with roles, reporting lines, execution environments, budgets and approval rules."
      />
      <div className="grid gap-5 lg:grid-cols-[230px_minmax(0,1fr)] lg:gap-6">
        <nav aria-label="Wizard steps" className="-mx-4 overflow-x-auto px-4 scrollbar-none lg:mx-0 lg:px-0">
          <ol className="flex w-max gap-1.5 lg:w-auto lg:flex-col">
            {WIZARD_STEPS.map((s, i) => {
              const on = s.id === step;
              const hasErr = touched.has(s.id) && errors[s.id];
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => go(s.id)}
                    aria-current={on ? 'step' : undefined}
                    className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors focus-ring ${on ? 'bg-panel-3 text-text' : 'text-muted hover:bg-white/[0.03] hover:text-text'}`}
                  >
                    <span
                      aria-hidden
                      className={`grid size-6 shrink-0 place-items-center rounded-full text-[11px] font-semibold ${
                        hasErr ? 'bg-danger/15 text-danger' : on ? 'bg-accent text-white' : i < idx ? 'bg-success/15 text-success' : 'bg-panel-3 text-subtle'
                      }`}
                    >
                      {hasErr ? '!' : i < idx ? <IconCheck className="size-3" /> : i + 1}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[13px] font-medium whitespace-nowrap">{s.label}</span>
                      <span className="hidden text-2xs text-subtle lg:block">{s.text}</span>
                    </span>
                    {hasErr && <span className="sr-only">(has errors)</span>}
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>

        <Card
          title={`${idx + 1}. ${WIZARD_STEPS[idx].label}`}
          subtitle={WIZARD_STEPS[idx].text}
          footer={
            <>
              {idx > 0 && (
                <Button icon={<IconArrowLeft />} onClick={() => go(WIZARD_STEPS[idx - 1].id)} disabled={submitting} className="mr-auto">
                  Back
                </Button>
              )}
              {step !== 'review' ? (
                <Button variant="primary" iconRight={<IconArrowRight />} onClick={next}>
                  Next
                </Button>
              ) : (
                <Button variant="primary" icon={<IconCompanies />} loading={submitting} onClick={() => void create()}>
                  Create company
                </Button>
              )}
            </>
          }
        >
          {serverError && serverError.step === step ? (
            <div className="mb-5">
              <ErrorBanner
                error={serverError.error}
                title={serverError.error instanceof ApiError && serverError.error.code === 'agent_in_other_company' ? 'An agent already works for another company' : 'The company was not created'}
              />
            </div>
          ) : null}

          {step === 'basics' && (
            <div className="grid max-w-2xl gap-4">
              <Field htmlFor={ids.name} label="Company name" required error={e.name}>
                <Input id={ids.name} value={d.name} maxLength={96} onChange={(ev) => set({ name: ev.target.value })} aria-invalid={e.name ? true : undefined} placeholder="e.g. Nebula Labs" data-autofocus />
              </Field>
              <Field htmlFor={ids.desc} label="Description">
                <Textarea id={ids.desc} rows={3} maxLength={4000} value={d.description} onChange={(ev) => set({ description: ev.target.value })} placeholder="What the company does" />
              </Field>
              <Field htmlFor={ids.obj} label="Objective" hint="The mission every employee sees in each work item.">
                <Textarea id={ids.obj} rows={3} maxLength={4000} value={d.objective} onChange={(ev) => set({ objective: ev.target.value })} placeholder="e.g. Build and ship a polished iOS habit tracker" />
              </Field>
              <Field htmlFor={ids.ind} label="Industry" error={e.industry}>
                <Input id={ids.ind} value={d.industry} maxLength={96} onChange={(ev) => set({ industry: ev.target.value })} placeholder="e.g. Software, Marketing, Research" />
              </Field>
            </div>
          )}

          {step === 'environment' && (
            <div className="space-y-5">
              <p className="text-sm text-muted">
                The default for every employee. Projects, employees and project assignments can override it (company → project → employee → assignment; the most specific wins).
              </p>
              <EnvironmentChoice label="Default execution environment" value={d.default_environment} onChange={(v) => set({ default_environment: v })} descriptions={envInfo.data?.environments ?? (envInfo.error ? [] : null)} />
              {d.default_environment === 'host' && (
                <div className="max-w-2xl">
                  <RootSelect
                    id={ids.root}
                    label="Authorised project folder"
                    required
                    value={d.default_root_id}
                    onChange={(v) => set({ default_root_id: v })}
                    roots={roots.data}
                    onRootAdded={(r) => roots.setData((xs) => [...(xs ?? []), { ...r, exists: true }])}
                    error={e.root}
                    hint="Host employees work inside this folder unless a project names its own."
                  />
                </div>
              )}
            </div>
          )}

          {step === 'policies' && (
            <div className="max-w-2xl space-y-6">
              <section className="space-y-3">
                <h3 className="text-sm font-semibold text-text">AI provider preference</h3>
                <ProviderPrefFields providerId={d.provider_id} modelId={d.model_id} onChange={(v) => set({ provider_id: v.providerId, model_id: v.modelId })} error={e.model} />
              </section>
              <section className="space-y-2">
                <h3 className="text-sm font-semibold text-text">Resource policy</h3>
                <p id="wiz-parallel-hint" className="text-xs text-muted">
                  How many employees may work at the same time. Agents on the VM share its 4 GB RAM; extra work waits its turn.
                </p>
                <SegmentedControl
                  label="Maximum parallel work items"
                  value={String(d.max_parallel)}
                  onChange={(v) => set({ max_parallel: Number(v) })}
                  options={['1', '2', '3', '4'].map((v) => ({ value: v, label: `${v} at a time` }))}
                />
                {e.parallel && <p className="text-xs text-danger">{e.parallel}</p>}
              </section>
              <section className="space-y-3">
                <h3 className="text-sm font-semibold text-text">Budget</h3>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field htmlFor={ids.per} label="AI requests per run" required error={e.perRun} hint="1–500. Each run stops starting work once used up.">
                    <Input id={ids.per} type="number" min={1} max={500} value={d.budget_per_run} onChange={(ev) => set({ budget_per_run: ev.target.value })} aria-invalid={e.perRun ? true : undefined} />
                  </Field>
                  <Field htmlFor={ids.total} label="Total AI requests (optional)" error={e.total} hint="Across all runs. Empty = no total limit.">
                    <Input id={ids.total} type="number" min={1} value={d.budget_total} onChange={(ev) => set({ budget_total: ev.target.value })} aria-invalid={e.total ? true : undefined} placeholder="No limit" />
                  </Field>
                </div>
              </section>
              <section className="space-y-3">
                <h3 className="text-sm font-semibold text-text">Approval policy</h3>
                <Switch
                  checked={d.plan_approval}
                  onChange={(v) => set({ plan_approval: v })}
                  label="I approve the CEO’s plan"
                  description="With the CEO planner, the work items wait for your approval before anything starts."
                />
                <Switch
                  checked={d.ceo_review}
                  onChange={(v) => set({ ceo_review: v })}
                  label="CEO final review"
                  description="The CEO reviews all results and writes the final report (one extra work item per run)."
                />
                <p className="text-xs text-subtle">Publishing, messages, payments, deletes and system changes always ask for your approval.</p>
              </section>
            </div>
          )}

          {step === 'roles' && <RolesEditor catalog={catalog.data} roles={d.roles} onChange={(roles) => set({ roles })} used={used} error={e.roles} />}

          {step === 'organisation' && (
            <div className="space-y-6">
              {!d.roles.some((r) => roleKeyOf(r) === 'ceo') && (
                <Notice tone="info">Without a CEO role the company uses template planning only and has no final review.</Notice>
              )}
              <MembersEditor
                agents={agents.data}
                roles={d.roles}
                members={d.members}
                onChange={(members) => set({ members })}
                errors={e}
                takenBy={taken.data ?? {}}
                defaultEnv={d.default_environment}
              />
              {preview.length > 0 && (
                <section aria-labelledby="wiz-org">
                  <h3 id="wiz-org" className="mb-3 text-sm font-semibold text-text">
                    Preview
                  </h3>
                  <OrgChart nodes={preview} label="Organisation preview" />
                </section>
              )}
            </div>
          )}

          {step === 'review' && (
            <div className="space-y-6">
              <KeyValue
                items={[
                  ['Name', d.name.trim() || <span className="text-danger">missing</span>],
                  ['Objective', d.objective.trim() || '—'],
                  ['Industry', d.industry.trim() || '—'],
                  [
                    'Default environment',
                    <span key="env" className="flex flex-wrap items-center gap-2">
                      <EnvBadge env={d.default_environment} />
                      {d.default_environment === 'host' && <span className="text-xs break-all text-muted">{chosenRoot ? chosenRoot.path : 'no folder chosen'}</span>}
                    </span>,
                  ],
                  ['AI preference', d.provider_id ? `${d.provider_id} · ${d.model_id || 'no model'}` : 'none (each employee uses its own model)'],
                  ['Parallel work', `${d.max_parallel} at a time`],
                  ['Budget', `${d.budget_per_run || '?'} AI requests per run${d.budget_total.trim() ? ` · ${d.budget_total} in total` : ' · no total limit'}`],
                  ['Approvals', [d.plan_approval ? 'you approve CEO plans' : 'CEO plans start automatically', d.ceo_review ? 'CEO final review' : 'no CEO review'].join(' · ')],
                  ['Roles', <span key="roles" className="flex flex-wrap gap-1">{d.roles.map((r) => <Badge key={roleKeyOf(r) || r.title}>{r.title || 'untitled'}</Badge>)}</span>],
                  ['Employees', `${d.members.length}${ceo ? '' : ' · no CEO'}`],
                ]}
              />
              {WIZARD_STEPS.some((s) => errors[s.id]) && (
                <Notice tone="warn" title="Some steps need attention">
                  {WIZARD_STEPS.filter((s) => errors[s.id])
                    .map((s) => s.label)
                    .join(', ')}{' '}
                  — “Create company” takes you there.
                </Notice>
              )}
              {preview.length > 0 ? (
                <section aria-labelledby="wiz-org-review">
                  <h3 id="wiz-org-review" className="mb-3 text-sm font-semibold text-text">
                    Organisation
                  </h3>
                  <OrgChart nodes={preview} label="Organisation preview" />
                </section>
              ) : (
                <Notice tone="info">No employees yet — you can add them later in the Employees tab, but runs need at least one.</Notice>
              )}
              <p className="text-xs text-subtle">
                A shared company folder is created in the VM ({ENV_LONG.vm}). Host employees only reach their authorised folder.
              </p>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
