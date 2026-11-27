// Settings tab: company fields and policies (PATCH /companies/{id}) and deletion with confirmation.
import { useId, useState } from 'react';
import { IconSettings, IconTrash } from '../../components/icons';
import { ConfirmDialog } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { Button, Card, Checkbox, ErrorBanner, Field, Input, Notice, SegmentedControl, Switch, Textarea } from '../../components/ui';
import { useApi } from '../../hooks/useApi';
import { navigate } from '../../hooks/useHashRoute';
import { envApi } from '../environment/api';
import type { EnvId, HostRoot } from '../environment/types';
import { companiesApi } from './api';
import { EnvironmentChoice, ProviderPrefFields, RootSelect } from './editors';
import type { CompanyDetail, CompanyPatch, CompanyStatus } from './types';

export function CompanySettings({
  co,
  roots,
  onRootAdded,
  onSaved,
}: {
  co: CompanyDetail;
  roots: HostRoot[] | null;
  onRootAdded: () => void;
  onSaved: (c: CompanyDetail) => void;
}) {
  const toast = useToast();
  const ids = { name: useId(), desc: useId(), obj: useId(), ind: useId(), root: useId(), per: useId(), total: useId(), confirm: useId() };
  const envInfo = useApi((s) => envApi.info(s), []);
  const [name, setName] = useState(co.name);
  const [description, setDescription] = useState(co.description);
  const [objective, setObjective] = useState(co.objective);
  const [industry, setIndustry] = useState(co.industry);
  const [status, setStatus] = useState<CompanyStatus>((co.status as CompanyStatus) ?? 'ACTIVE');
  const [env, setEnv] = useState<EnvId>(co.default_environment);
  const [rootId, setRootId] = useState(co.default_root_id ?? '');
  const [providerId, setProviderId] = useState(co.provider_prefs?.provider_id ?? '');
  const [modelId, setModelId] = useState(co.provider_prefs?.model_id ?? '');
  const [parallel, setParallel] = useState(String(co.resource_policy?.max_parallel ?? 2));
  const [perRun, setPerRun] = useState(String(co.budget?.max_model_calls_per_run ?? 30));
  const [total, setTotal] = useState(co.budget?.max_model_calls_total ? String(co.budget.max_model_calls_total) : '');
  const [planApproval, setPlanApproval] = useState(Boolean(co.approval_policy?.plan_approval));
  const [ceoReview, setCeoReview] = useState(co.approval_policy?.ceo_review ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [deleting, setDeleting] = useState(false);
  const [confirmName, setConfirmName] = useState('');
  const [deleteFiles, setDeleteFiles] = useState(false);

  const per = Number(perRun);
  const tot = Number(total);
  const errs: Record<string, string> = {};
  if (!name.trim()) errs.name = 'Name is required';
  if (env === 'host' && !rootId) errs.root = 'Choose an authorised project folder for host work';
  if (!Number.isInteger(per) || per < 1 || per > 500) errs.perRun = 'A whole number from 1 to 500';
  if (total.trim() && (!Number.isInteger(tot) || tot < 1)) errs.total = 'A whole number of at least 1 (or empty)';
  if (providerId && !modelId) errs.model = 'Choose a model for the preferred provider';

  const body: CompanyPatch = {
    name: name.trim(),
    description: description.trim(),
    objective: objective.trim(),
    industry: industry.trim(),
    status,
    default_environment: env,
    provider_prefs: providerId ? { provider_id: providerId, model_id: modelId || null } : {},
    resource_policy: { max_parallel: Number(parallel) },
    budget: { max_model_calls_per_run: per, max_model_calls_total: total.trim() ? tot : null },
    approval_policy: { plan_approval: planApproval, ceo_review: ceoReview },
  };
  // The host ignores a null default_root_id (it cannot be cleared), so only send a chosen folder.
  if (rootId) body.default_root_id = rootId;
  const initial = JSON.stringify({
    name: co.name,
    description: co.description,
    objective: co.objective,
    industry: co.industry,
    status: co.status,
    default_environment: co.default_environment,
    provider_prefs: co.provider_prefs?.provider_id ? { provider_id: co.provider_prefs.provider_id, model_id: co.provider_prefs.model_id || null } : {},
    resource_policy: { max_parallel: co.resource_policy?.max_parallel ?? 2 },
    budget: { max_model_calls_per_run: co.budget?.max_model_calls_per_run ?? 30, max_model_calls_total: co.budget?.max_model_calls_total ?? null },
    approval_policy: { plan_approval: Boolean(co.approval_policy?.plan_approval), ceo_review: co.approval_policy?.ceo_review ?? true },
    ...(co.default_root_id ? { default_root_id: co.default_root_id } : {}),
  });
  const dirty = JSON.stringify(body) !== initial;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const c = await companiesApi.update(co.id, body);
      toast.success('Company settings saved');
      onSaved(c);
    } catch (e) {
      setError(e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      <Card
        title="Company settings"
        icon={<IconSettings />}
        footer={
          <>
            {dirty && <span className="mr-auto text-xs text-warn">Unsaved changes</span>}
            <Button variant="primary" loading={saving} disabledReason={!dirty ? 'No changes' : Object.values(errs)[0] ?? null} onClick={() => void save()}>
              Save settings
            </Button>
          </>
        }
      >
        <div className="max-w-3xl space-y-6">
          {error ? <ErrorBanner error={error} title="Settings not saved" /> : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field htmlFor={ids.name} label="Name" required error={errs.name}>
              <Input id={ids.name} value={name} maxLength={96} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field htmlFor={ids.ind} label="Industry">
              <Input id={ids.ind} value={industry} maxLength={96} onChange={(e) => setIndustry(e.target.value)} />
            </Field>
          </div>
          <Field htmlFor={ids.obj} label="Objective">
            <Textarea id={ids.obj} rows={3} maxLength={4000} value={objective} onChange={(e) => setObjective(e.target.value)} />
          </Field>
          <Field htmlFor={ids.desc} label="Description">
            <Textarea id={ids.desc} rows={3} maxLength={4000} value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <div className="space-y-1.5">
            <p className="text-[13px] font-medium text-text">Status</p>
            <SegmentedControl<CompanyStatus>
              label="Company status"
              value={status}
              onChange={setStatus}
              options={[
                { value: 'ACTIVE', label: 'Active' },
                { value: 'PAUSED', label: 'Paused' },
                { value: 'ARCHIVED', label: 'Archived' },
              ]}
            />
            <p className="text-xs text-muted">Paused and archived companies refuse new runs; running work is not interrupted.</p>
          </div>
          <section className="space-y-3">
            <h3 className="text-sm font-semibold text-text">Default execution environment</h3>
            <EnvironmentChoice label="Default execution environment" value={env} onChange={setEnv} descriptions={envInfo.data?.environments ?? (envInfo.error ? [] : null)} />
            {(env === 'host' || rootId) && (
              <div className="max-w-2xl">
                <RootSelect
                  id={ids.root}
                  label="Default host project folder"
                  required={env === 'host'}
                  value={rootId}
                  onChange={setRootId}
                  roots={roots}
                  onRootAdded={onRootAdded}
                  error={errs.root}
                  hint="Used by host employees unless a project names its own folder."
                />
              </div>
            )}
          </section>
          <section className="space-y-3">
            <h3 className="text-sm font-semibold text-text">AI provider preference</h3>
            <ProviderPrefFields
              providerId={providerId}
              modelId={modelId}
              onChange={(v) => {
                setProviderId(v.providerId);
                setModelId(v.modelId);
              }}
              error={errs.model}
            />
          </section>
          <section className="space-y-2">
            <h3 className="text-sm font-semibold text-text">Resource policy</h3>
            <SegmentedControl label="Maximum parallel work items" value={parallel} onChange={setParallel} options={['1', '2', '3', '4'].map((v) => ({ value: v, label: `${v} at a time` }))} />
            <p className="text-xs text-muted">How many employees may work at the same time; the rest waits.</p>
          </section>
          <section className="grid gap-3 sm:grid-cols-2">
            <Field htmlFor={ids.per} label="AI requests per run" required error={errs.perRun}>
              <Input id={ids.per} type="number" min={1} max={500} value={perRun} onChange={(e) => setPerRun(e.target.value)} />
            </Field>
            <Field htmlFor={ids.total} label="Total AI requests" error={errs.total} hint={`Used so far: ${co.stats.model_calls_used}. Empty = no limit.`}>
              <Input id={ids.total} type="number" min={1} value={total} onChange={(e) => setTotal(e.target.value)} placeholder="No limit" />
            </Field>
          </section>
          <section className="space-y-3">
            <h3 className="text-sm font-semibold text-text">Approval policy</h3>
            <Switch checked={planApproval} onChange={setPlanApproval} label="I approve the CEO’s plan" description="CEO-planned runs wait for your approval before work starts." />
            <Switch checked={ceoReview} onChange={setCeoReview} label="CEO final review" description="The CEO reviews all results and writes the final report." />
          </section>
        </div>
      </Card>

      <Card title="Danger zone" className="border-danger/30">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-xl text-sm text-muted">
            Deleting removes the company, its roles, projects, runs, activity and knowledge. The agents themselves are kept and become free to join another company.
          </p>
          <Button variant="danger" icon={<IconTrash />} onClick={() => setDeleting(true)} disabledReason={co.stats.runs_active ? 'Cancel the active runs first' : null}>
            Delete company…
          </Button>
        </div>
      </Card>

      <ConfirmDialog
        open={deleting}
        title={`Delete ${co.name}?`}
        confirmLabel={deleteFiles ? 'Delete company and files' : 'Delete company'}
        busyText="Deleting…"
        confirmDisabled={confirmName.trim() !== co.name ? 'Type the company name to confirm' : null}
        onCancel={() => {
          setDeleting(false);
          setConfirmName('');
        }}
        onConfirm={async () => {
          try {
            await companiesApi.remove(co.id, deleteFiles);
            toast.success(`${co.name} deleted`);
            setDeleting(false);
            navigate('/companies');
          } catch (e) {
            toast.error(e, 'Company not deleted');
          }
        }}
      >
        <p>
          This removes <strong>{co.name}</strong> with {co.projects.length} project(s) and its whole history. This cannot be undone.
        </p>
        <Notice tone="info">Host project folders are never touched.</Notice>
        <Checkbox
          label="Also delete the shared company folder in the VM"
          description="Files in the company folder are removed permanently. Otherwise they stay in the VM."
          checked={deleteFiles}
          onChange={setDeleteFiles}
        />
        <Field htmlFor={ids.confirm} label={`Type “${co.name}” to confirm`}>
          <Input id={ids.confirm} value={confirmName} onChange={(e) => setConfirmName(e.target.value)} autoComplete="off" />
        </Field>
      </ConfirmDialog>
    </div>
  );
}
