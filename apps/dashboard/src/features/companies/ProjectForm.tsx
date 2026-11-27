// Project create / edit drawer (POST /companies/{id}/projects, PATCH /projects/{id}).
import { useId, useState } from 'react';
import { IconPlus, IconTrash } from '../../components/icons';
import { Drawer } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { Avatar, Button, Checkbox, ErrorBanner, Field, IconButton, Input, Notice, SegmentedControl, Select, Textarea } from '../../components/ui';
import { ENV_SHORT } from '../environment/EnvBadge';
import type { EnvId, HostRoot } from '../environment/types';
import { projectsApi } from './api';
import { RootSelect } from './editors';
import type { CompanyDetail, ProjectBody, ProjectDetail, ProjectStatus } from './types';

interface MilestoneDraft {
  key: string;
  id?: string;
  title: string;
  due: string;
  done: boolean;
}

let mk = 0;
const nextKey = () => `ms${++mk}`;

export const PROJECT_STATUSES: ProjectStatus[] = ['PLANNING', 'ACTIVE', 'PAUSED', 'COMPLETED', 'ARCHIVED'];

export function ProjectForm({
  co,
  project,
  roots,
  onRootAdded,
  onClose,
  onSaved,
}: {
  co: CompanyDetail;
  project?: ProjectDetail | null;
  roots: HostRoot[] | null;
  onRootAdded: () => void;
  onClose: () => void;
  onSaved: (p: ProjectDetail) => void;
}) {
  const toast = useToast();
  const ids = { name: useId(), obj: useId(), desc: useId(), status: useId(), root: useId(), remote: useId(), branch: useId(), budget: useId(), ms: useId() };
  const editing = Boolean(project);
  const [name, setName] = useState(project?.name ?? '');
  const [objective, setObjective] = useState(project?.objective ?? '');
  const [description, setDescription] = useState(project?.description ?? '');
  const [status, setStatus] = useState<ProjectStatus>((project?.status as ProjectStatus) ?? 'ACTIVE');
  const [env, setEnv] = useState<'' | EnvId>(project?.environment ?? '');
  const [rootId, setRootId] = useState(project?.host_root_id ?? '');
  const [remote, setRemote] = useState(project?.git?.remote ?? '');
  const [branch, setBranch] = useState(project?.git?.branch ?? '');
  const [budget, setBudget] = useState(project?.budget?.max_model_calls_per_run ? String(project.budget.max_model_calls_per_run) : '');
  const [milestones, setMilestones] = useState<MilestoneDraft[]>(() => (project?.milestones ?? []).map((m) => ({ key: nextKey(), id: m.id, title: m.title, due: m.due ?? '', done: m.done })));
  const [assign, setAssign] = useState<Record<string, { on: boolean; env: '' | EnvId }>>(() => {
    const out: Record<string, { on: boolean; env: '' | EnvId }> = {};
    for (const m of co.members) {
      const pm = project?.members.find((x) => x.agent_id === m.agent_id);
      out[m.agent_id] = { on: project ? Boolean(pm) : true, env: pm?.environment ?? '' };
    }
    return out;
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [showErrors, setShowErrors] = useState(false);

  const effEnv: EnvId = env || co.default_environment;
  const anyHost = effEnv === 'host' || co.members.some((m) => assign[m.agent_id]?.on && (assign[m.agent_id].env === 'host' || m.environment === 'host'));
  const b = Number(budget);
  const errs: Record<string, string> = {};
  if (!name.trim()) errs.name = 'Give the project a name';
  else if (name.trim().length > 128) errs.name = 'At most 128 characters';
  if (budget.trim() && (!Number.isInteger(b) || b < 1 || b > 500)) errs.budget = 'A whole number from 1 to 500 (or empty for the company default)';
  if (milestones.some((m) => !m.title.trim())) errs.ms = 'Every milestone needs a title';
  if (anyHost && !rootId && !co.default_root_id) errs.root = 'Host work needs an authorised project folder (none is set on the company either)';
  const firstErr = Object.values(errs)[0] ?? null;
  const assignedCount = Object.values(assign).filter((a) => a.on).length;

  const save = async () => {
    if (firstErr) {
      setShowErrors(true);
      return;
    }
    const body: ProjectBody = {
      name: name.trim(),
      objective: objective.trim(),
      description: description.trim(),
      environment: env || null,
      host_root_id: rootId || null,
      git: { remote: remote.trim(), branch: branch.trim() },
      milestones: milestones.map((m) => ({ ...(m.id ? { id: m.id } : {}), title: m.title.trim(), due: m.due || null, done: m.done })),
      assign: co.members.filter((m) => assign[m.agent_id]?.on).map((m) => ({ agent_id: m.agent_id, environment: assign[m.agent_id].env || null })),
    };
    if (budget.trim()) body.budget = { max_model_calls_per_run: b };
    else if (editing && project?.budget?.max_model_calls_per_run) body.budget = {};
    if (editing) body.status = status;
    setSaving(true);
    setError(null);
    try {
      const p = editing && project ? await projectsApi.update(project.id, body) : await projectsApi.create(co.id, body);
      toast.success(editing ? 'Project saved' : `Project ${p.name} created`);
      onSaved(p);
    } catch (e) {
      setError(e);
    } finally {
      setSaving(false);
    }
  };

  const e = showErrors ? errs : {};
  return (
    <Drawer
      open
      width="lg"
      onClose={onClose}
      dismissible={!saving}
      title={editing ? `Edit ${project?.name}` : `New project at ${co.name}`}
      description="Objective, environment, repository, milestones, budget and who works on it."
      footer={
        <>
          <Button onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} onClick={() => void save()}>
            {editing ? 'Save project' : 'Create project'}
          </Button>
        </>
      }
    >
      <div className="space-y-6">
        {error ? <ErrorBanner error={error} title={editing ? 'Project not saved' : 'Project not created'} /> : null}
        {showErrors && firstErr && <Notice tone="danger">{firstErr}</Notice>}
        <section className="space-y-4">
          <Field htmlFor={ids.name} label="Project name" required error={e.name}>
            <Input id={ids.name} value={name} maxLength={128} onChange={(ev) => setName(ev.target.value)} aria-invalid={e.name ? true : undefined} data-autofocus />
          </Field>
          <Field htmlFor={ids.obj} label="Objective" hint="Pre-filled as the objective of new runs.">
            <Textarea id={ids.obj} rows={3} maxLength={4000} value={objective} onChange={(ev) => setObjective(ev.target.value)} />
          </Field>
          <Field htmlFor={ids.desc} label="Description">
            <Textarea id={ids.desc} rows={2} maxLength={4000} value={description} onChange={(ev) => setDescription(ev.target.value)} />
          </Field>
          {editing && (
            <Field htmlFor={ids.status} label="Status" hint="Paused, completed and archived projects refuse new runs.">
              <Select id={ids.status} value={status} onChange={(ev) => setStatus(ev.target.value as ProjectStatus)} className="sm:w-56">
                {PROJECT_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s.toLowerCase()}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </section>

        <section className="space-y-3">
          <h3 className="text-sm font-semibold text-text">Execution environment</h3>
          <SegmentedControl<'' | EnvId>
            label="Project environment"
            value={env}
            onChange={setEnv}
            options={[
              { value: '', label: `Company default (${ENV_SHORT[co.default_environment]})` },
              { value: 'vm', label: ENV_SHORT.vm },
              { value: 'host', label: ENV_SHORT.host },
            ]}
          />
          <p className="text-xs text-muted">Employee and assignment overrides below still win (company → project → employee → assignment).</p>
          <RootSelect
            id={ids.root}
            label="Host project folder"
            value={rootId}
            onChange={setRootId}
            roots={roots}
            onRootAdded={onRootAdded}
            error={e.root}
            required={anyHost && !co.default_root_id}
            emptyLabel={co.default_root_id ? 'Company default folder' : 'No Mac folder'}
            hint={anyHost ? 'Host employees work in this folder; files from VM colleagues are transferred to them.' : 'Optional: link a Mac folder (git status, files, host employees).'}
          />
        </section>

        <section className="space-y-3">
          <h3 className="text-sm font-semibold text-text">Git</h3>
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_12rem]">
            <Field htmlFor={ids.remote} label="Remote" hint="Recorded for the team; host repositories are detected live.">
              <Input id={ids.remote} value={remote} maxLength={300} onChange={(ev) => setRemote(ev.target.value)} placeholder="git@github.com:you/app.git" className="font-mono text-[13px]" />
            </Field>
            <Field htmlFor={ids.branch} label="Branch">
              <Input id={ids.branch} value={branch} maxLength={100} onChange={(ev) => setBranch(ev.target.value)} placeholder="main" className="font-mono text-[13px]" />
            </Field>
          </div>
        </section>

        <section className="space-y-3" aria-labelledby={ids.ms}>
          <div className="flex items-end justify-between gap-2">
            <h3 id={ids.ms} className="text-sm font-semibold text-text">
              Milestones
            </h3>
            <Button size="sm" icon={<IconPlus />} onClick={() => setMilestones((xs) => [...xs, { key: nextKey(), title: '', due: '', done: false }])} disabledReason={milestones.length >= 50 ? 'At most 50 milestones' : null}>
              Add milestone
            </Button>
          </div>
          {milestones.length === 0 ? (
            <p className="text-xs text-subtle">No milestones.</p>
          ) : (
            <ul className="space-y-2">
              {milestones.map((m, i) => (
                <li key={m.key} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 sm:grid-cols-[auto_minmax(0,1fr)_10rem_auto]">
                  <Checkbox label={<span className="sr-only">Milestone {i + 1} done</span>} checked={m.done} onChange={(v) => setMilestones((xs) => xs.map((x) => (x.key === m.key ? { ...x, done: v } : x)))} />
                  <Input aria-label={`Milestone ${i + 1} title`} value={m.title} maxLength={200} onChange={(ev) => setMilestones((xs) => xs.map((x) => (x.key === m.key ? { ...x, title: ev.target.value } : x)))} aria-invalid={showErrors && !m.title.trim() ? true : undefined} placeholder="e.g. MVP ready for TestFlight" />
                  <Input aria-label={`Milestone ${i + 1} due date`} type="date" value={m.due} onChange={(ev) => setMilestones((xs) => xs.map((x) => (x.key === m.key ? { ...x, due: ev.target.value } : x)))} className="col-span-2 col-start-2 row-start-2 sm:col-span-1 sm:col-start-auto sm:row-start-auto" />
                  <IconButton label={`Remove milestone ${i + 1}`} icon={<IconTrash />} onClick={() => setMilestones((xs) => xs.filter((x) => x.key !== m.key))} className="row-start-1 sm:row-start-auto" />
                </li>
              ))}
            </ul>
          )}
          {e.ms && <p className="text-xs text-danger">{e.ms}</p>}
        </section>

        <section className="space-y-3">
          <h3 className="text-sm font-semibold text-text">Budget</h3>
          <Field htmlFor={ids.budget} label="AI requests per run" error={e.budget} hint={`Empty = company default (${co.budget.max_model_calls_per_run}).`}>
            <Input id={ids.budget} type="number" min={1} max={500} value={budget} onChange={(ev) => setBudget(ev.target.value)} placeholder={String(co.budget.max_model_calls_per_run)} className="sm:w-48" />
          </Field>
        </section>

        <section className="space-y-3">
          <div>
            <h3 className="text-sm font-semibold text-text">Assigned employees</h3>
            <p className="mt-0.5 text-xs text-muted">
              {assignedCount} of {co.members.length} assigned. The template planner creates one work item per assigned employee; the CEO planner needs the CEO assigned.
            </p>
          </div>
          {co.members.length === 0 ? (
            <Notice tone="warn">The company has no employees yet — add them in the Employees tab.</Notice>
          ) : (
            <ul className="divide-y divide-border/70 rounded-xl border border-border">
              {co.members.map((m) => {
                const a = assign[m.agent_id] ?? { on: false, env: '' as const };
                const inherited = m.environment ? `employee: ${ENV_SHORT[m.environment]}` : `project: ${ENV_SHORT[effEnv]}`;
                return (
                  <li key={m.agent_id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                    <Checkbox
                      checked={a.on}
                      onChange={(v) => setAssign((x) => ({ ...x, [m.agent_id]: { ...a, on: v } }))}
                      label={
                        <span className="flex items-center gap-2">
                          <Avatar name={m.agent_name} id={m.agent_id} size="xs" />
                          <span className="font-medium">{m.agent_name}</span>
                          <span className="text-xs text-muted">{m.role_title}</span>
                        </span>
                      }
                    />
                    <Select
                      aria-label={`Environment for ${m.agent_name} on this project`}
                      value={a.env}
                      disabled={!a.on}
                      onChange={(ev) => setAssign((x) => ({ ...x, [m.agent_id]: { ...a, env: ev.target.value as '' | EnvId } }))}
                      className="ml-auto !h-8 !w-auto min-w-[11rem] text-[13px]"
                    >
                      <option value="">Inherit ({inherited})</option>
                      <option value="vm">{ENV_SHORT.vm}</option>
                      <option value="host">{ENV_SHORT.host}</option>
                    </Select>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </Drawer>
  );
}
