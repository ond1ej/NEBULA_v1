// Start a project run: objective, planner (template | ceo, explained), AI-request budget.
import { useId, useState } from 'react';
import { IconPlay } from '../../components/icons';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { Button, ErrorBanner, Field, Input, Notice, SegmentedControl, Textarea } from '../../components/ui';
import { projectsApi } from './api';
import { PLANNER_TEXT, RUN_ACTIVE } from './lib';
import type { CompanyDetail, Planner, ProjectDetail, RunDetail } from './types';

/** Why a run cannot start right now (null = it can). Mirrors the host's checks in CompanyManager.start_run. */
export function runBlocker(co: CompanyDetail, p: ProjectDetail): string | null {
  if (co.status !== 'ACTIVE') return `The company is ${String(co.status).toLowerCase()}`;
  if (['ARCHIVED', 'COMPLETED', 'PAUSED'].includes(p.status)) return `The project is ${p.status.toLowerCase()}`;
  if (p.runs.some((r) => r.state === 'PLANNING' || r.state === 'RUNNING' || r.state === 'AWAITING_APPROVAL')) return 'This project already has an active run';
  if (p.members.length === 0) return 'Assign at least one employee to the project';
  const total = co.budget.max_model_calls_total;
  if (total && co.stats.model_calls_used >= total) return `The company AI budget of ${total} requests is used up`;
  return null;
}

export function StartRunDialog({ co, project, onClose, onStarted }: { co: CompanyDetail; project: ProjectDetail; onClose: () => void; onStarted: (r: RunDetail) => void }) {
  const ids = { obj: useId(), budget: useId() };
  const toast = useToast();
  const [objective, setObjective] = useState(project.objective || co.objective || '');
  const [planner, setPlanner] = useState<Planner>('template');
  const [budget, setBudget] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const assigned = new Set(project.members.map((m) => m.agent_id));
  const hasCeo = project.members.some((m) => m.role_key === 'ceo');
  const noModel = co.members.filter((m) => assigned.has(m.agent_id) && (!m.model_id || !m.provider_id)).map((m) => m.agent_name);
  const defBudget = project.budget?.max_model_calls_per_run ?? co.budget.max_model_calls_per_run;
  const b = Number(budget);
  const invalid =
    runBlocker(co, project) ??
    (!objective.trim()
      ? 'Describe the objective'
      : budget.trim() && (!Number.isInteger(b) || b < 1 || b > 500)
        ? 'Budget: 1–500 AI requests'
        : planner === 'ceo' && !hasCeo
          ? 'The CEO planner needs a CEO assigned to the project'
          : noModel.length
            ? `${noModel.join(', ')} ${noModel.length === 1 ? 'has' : 'have'} no AI model`
            : null);
  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await projectsApi.startRun(project.id, { objective: objective.trim(), planner, max_model_calls: budget.trim() ? b : null });
      toast.success('Run started', planner === 'ceo' ? 'The CEO is planning the work.' : `${r.items.length} work item(s) planned.`);
      onStarted(r);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const activeRun = project.runs.find((r) => RUN_ACTIVE.has(r.state));
  return (
    <Modal
      open
      onClose={onClose}
      dismissible={!busy}
      size="lg"
      title={`Start a run · ${project.name}`}
      description={`${project.members.length} assigned employee(s) at ${co.name}.`}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" icon={<IconPlay />} loading={busy} disabledReason={invalid} onClick={() => void start()}>
            Start run
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {activeRun && <Notice tone="warn">A run is already {activeRun.state.toLowerCase().replace('_', ' ')} for this project.</Notice>}
        <Field htmlFor={ids.obj} label="Objective" required>
          <Textarea id={ids.obj} rows={4} maxLength={8000} value={objective} onChange={(e) => setObjective(e.target.value)} placeholder="What should the company deliver in this run?" data-autofocus />
        </Field>
        <div className="space-y-2">
          <p className="text-[13px] font-medium text-text">Planner</p>
          <SegmentedControl<Planner>
            label="Planner"
            value={planner}
            onChange={setPlanner}
            options={[
              { value: 'template', label: 'Template plan' },
              { value: 'ceo', label: 'CEO plans', disabled: !hasCeo, title: hasCeo ? undefined : 'Needs a CEO assigned to the project' },
            ]}
          />
          <p className="text-xs leading-5 text-muted">{PLANNER_TEXT[planner]}</p>
          {planner === 'ceo' && co.approval_policy.plan_approval && <p className="text-xs text-warn">Company policy: you approve the CEO’s plan before any work starts.</p>}
        </div>
        <Field htmlFor={ids.budget} label="AI-request budget for this run" hint={`1–500. Empty = project/company default (${defBudget}).`}>
          <Input id={ids.budget} type="number" min={1} max={500} value={budget} onChange={(e) => setBudget(e.target.value)} placeholder={String(defBudget)} className="sm:w-48" />
        </Field>
        <p className="text-xs text-subtle">Every work item is a normal agent task in the employee’s effective environment; sensitive actions still ask for approval.</p>
        {error ? <ErrorBanner error={error} title="Run not started" /> : null}
      </div>
    </Modal>
  );
}
