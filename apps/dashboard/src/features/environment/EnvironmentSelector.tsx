// Execution Environment Selector for one agent (agent tab "Environment").
// Shows the effective environment and where it comes from, compares HOST COMPUTER vs VIRTUAL MACHINE, and switches
// the agent's own setting after confirmation. Company employees are read-only here: the company decides.
import { useEffect, useId, useState, type ReactNode } from 'react';
import { ApiError } from '../../api';
import { IconAlert, IconCheck, IconExternal, IconFiles, IconLock, IconShield, IconSkills, IconX } from '../../components/icons';
import { ConfirmDialog } from '../../components/Modal';
import { StatusPill } from '../../components/StatusPill';
import { useToast } from '../../components/Toast';
import {
  Badge,
  Button,
  ButtonLink,
  Card,
  ErrorBanner,
  Field,
  KeyValue,
  LoadingRows,
  Meter,
  Mono,
  Notice,
  Select,
  Skeleton,
  TextLink,
  usageTone,
} from '../../components/ui';
import { useApi } from '../../hooks/useApi';
import { useLiveRefresh } from '../../hooks/useEvents';
import { href } from '../../hooks/useHashRoute';
import { formatBytes } from '../../lib/format';
import { VM_MEMORY_LABEL, vmMemoryBytes } from '../../lib/vmMemory';
import type { Agent } from '../../types';
import { findCompanyOfAgent } from '../companies/api';
import { envApi, hostApi } from './api';
import { ENV_LONG, ENV_SHORT, EnvChain, EnvIcon, levelLabel } from './EnvBadge';
import type { AgentEnvSummary, EnvDescription, EnvId, EnvironmentsInfo, HostRoot } from './types';

export const CHOICE_TEXT: Record<EnvId, { title: string; text: string }> = {
  host: { title: 'HOST COMPUTER', text: 'Work directly on the Mac mini using approved native tools and selected project directories' },
  vm: { title: 'VIRTUAL MACHINE', text: 'Work inside an isolated Ubuntu environment' },
};

function usableRoots(roots: HostRoot[] | null): HostRoot[] {
  return (roots ?? []).filter((r) => r.enabled && r.exists !== false);
}

function ListBlock({ title, items, icon, tone }: { title: string; items: string[]; icon: ReactNode; tone: string }) {
  if (!items.length) return null;
  return (
    <div>
      <p className="mb-1.5 text-2xs font-medium tracking-wide text-subtle uppercase">{title}</p>
      <ul className="space-y-1.5">
        {items.map((t) => (
          <li key={t} className="flex gap-2 text-[13px] leading-5 text-muted">
            <span aria-hidden className={`mt-0.5 shrink-0 [&>svg]:size-3.5 ${tone}`}>
              {icon}
            </span>
            <span className="min-w-0">{t}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function HostUsage({ info }: { info: EnvironmentsInfo }) {
  const r = info.host.resources;
  const usedPct = r && r.memory_total_bytes ? (1 - r.memory_available_bytes / r.memory_total_bytes) * 100 : null;
  return (
    <div className="space-y-2.5">
      {r && usedPct !== null && (
        <div>
          <div className="mb-1 flex justify-between gap-2 text-xs">
            <span className="text-muted">Mac memory in use</span>
            <span className="text-text tabular-nums">
              {formatBytes(r.memory_total_bytes - r.memory_available_bytes)} / {formatBytes(r.memory_total_bytes)}
            </span>
          </div>
          <Meter value={usedPct} label="Mac memory in use" tone={usageTone(usedPct)} size="sm" />
        </div>
      )}
      <KeyValue
        className="text-xs"
        items={[
          ['Memory pressure', r ? <StatusPill state={r.memory_pressure} /> : '—'],
          ['Load (1 min)', r?.load_avg?.[0] !== undefined ? `${r.load_avg[0].toFixed(2)} on ${r.cpu_count ?? '?'} cores` : '—'],
          ['Host commands', `${info.host.running_commands} running · ${info.host.background_processes} background`],
          ['Authorised folders', String(info.host.roots)],
          ['macOS sandbox', info.host.sandbox ? <Badge tone="success">available</Badge> : <Badge tone="danger">unavailable</Badge>],
        ]}
      />
    </div>
  );
}

function VmUsage({ info }: { info: EnvironmentsInfo }) {
  const vm = info.vm;
  const mem = vmMemoryBytes(info.host.resources);
  return (
    <KeyValue
      className="text-xs"
      items={[
        ['VM state', <StatusPill key="s" state={vm.state} />],
        ['Allocated', vm.memory_mb ? `${formatBytes(vm.memory_mb * 1024 * 1024, 0)} RAM · ${vm.cpu_count ?? '?'} vCPU` : '—'],
        [VM_MEMORY_LABEL, mem ? formatBytes(mem) : '—'],
        ['Live Desktop viewers', String(vm.active_streams ?? 0)],
      ]}
    />
  );
}

function ChoiceCard({
  env,
  name,
  checked,
  active,
  disabled,
  onSelect,
  desc,
  info,
}: {
  env: EnvId;
  name: string;
  checked: boolean;
  active: boolean;
  disabled: boolean;
  onSelect: () => void;
  desc: EnvDescription | undefined;
  info: EnvironmentsInfo | null;
}) {
  const t = CHOICE_TEXT[env];
  const id = useId();
  return (
    <label
      htmlFor={id}
      className={`relative flex min-w-0 flex-col rounded-2xl border p-4 transition-colors sm:p-5 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent-soft ${
        disabled ? 'cursor-default' : 'cursor-pointer hover:border-border-hover'
      } ${checked ? 'border-accent/60 bg-accent/[0.07] shadow-[inset_0_0_0_1px_rgb(110_95_240/0.35)]' : 'border-border bg-panel'}`}
    >
      <input id={id} type="radio" name={name} value={env} checked={checked} disabled={disabled} onChange={onSelect} className="sr-only" />
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className={`grid size-11 shrink-0 place-items-center rounded-xl border ${
            env === 'host' ? 'border-accent/35 bg-accent/15 text-accent-soft' : 'border-[#8fd3e8]/25 bg-[#11262d] text-[#8fd3e8]'
          }`}
        >
          <EnvIcon env={env} className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13px] font-semibold tracking-[0.06em] text-text">{t.title}</span>
            {active && (
              <Badge tone="success" dot>
                Active now
              </Badge>
            )}
            {checked && !active && <Badge tone="accent">Selected · not applied</Badge>}
          </div>
          <p className="mt-0.5 text-xs text-subtle">{ENV_LONG[env]}</p>
          <p className="mt-1.5 text-sm text-muted">{t.text}</p>
        </div>
        <span
          aria-hidden
          className={`mt-1 grid size-5 shrink-0 place-items-center rounded-full border-2 ${checked ? 'border-accent-soft' : 'border-border-strong'}`}
        >
          {checked && <span className="size-2.5 rounded-full bg-accent-soft" />}
        </span>
      </div>
      {desc ? (
        <div className="mt-4 grid gap-4">
          <ListBlock title="Benefits" items={desc.benefits} icon={<IconCheck />} tone="text-success" />
          <ListBlock title="Limitations" items={desc.limitations} icon={<IconX />} tone="text-warn" />
          <ListBlock title="Permissions" items={desc.permissions} icon={<IconShield />} tone="text-info" />
        </div>
      ) : (
        <div className="mt-4 space-y-2">
          <Skeleton className="h-3 w-4/5" />
          <Skeleton className="h-3 w-3/5" />
        </div>
      )}
      <div className="mt-4 border-t border-border pt-3">
        <p className="mb-2 text-2xs font-medium tracking-wide text-subtle uppercase">Current resource usage</p>
        {info ? env === 'host' ? <HostUsage info={info} /> : <VmUsage info={info} /> : <Skeleton className="h-16 w-full" />}
      </div>
    </label>
  );
}

export function switchErrorView(err: unknown, agentId: string): ReactNode {
  if (!(err instanceof ApiError)) return <ErrorBanner error={err} title="Environment not switched" />;
  if (err.code === 'agent_busy')
    return (
      <Notice
        tone="warn"
        title="Agent is busy — environment not switched"
        action={
          <ButtonLink size="sm" href={href(`/agents/${agentId}/tasks`)}>
            Open the agent’s tasks
          </ButtonLink>
        }
      >
        {err.message}. Switching never interrupts running work: let the tasks finish, or stop them, then try again.
      </Notice>
    );
  if (err.code === 'environment_not_ready')
    return (
      <Notice tone="danger" title="Target environment is not ready — nothing was changed">
        <ul className="list-disc space-y-0.5 pl-4">
          {err.message.split('; ').map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      </Notice>
    );
  return <ErrorBanner error={err} title="Environment not switched" />;
}

export function EnvironmentSelector({ agent, onChanged }: { agent: Agent; onChanged?: () => void }) {
  const toast = useToast();
  const summary = useApi((s) => envApi.agent(agent.id, null, s), [agent.id]);
  const info = useApi((s) => envApi.info(s), []);
  const roots = useApi((s) => hostApi.roots(s), []);
  const inCompany = summary.data ? summary.data.effective.source !== 'agent' || summary.data.effective.chain[0]?.level === 'company' : false;
  const company = useApi((s) => (inCompany ? findCompanyOfAgent(agent.id, s) : Promise.resolve(null)), [agent.id, inCompany]);
  useLiveRefresh(
    () => {
      summary.reload();
      info.reload();
    },
    (ev) => (ev.type === 'environment.changed' && ev.agent_id === agent.id) || ev.type === 'company.updated',
    400,
  );

  const s: AgentEnvSummary | null = summary.data;
  const [choice, setChoice] = useState<EnvId | null>(null);
  const [rootId, setRootId] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [switchError, setSwitchError] = useState<unknown>(null);
  const rootSel = useId();
  const usable = usableRoots(roots.data);

  // follow the server state until the user picks something else
  useEffect(() => {
    if (!s) return;
    setChoice((c) => c ?? s.effective.env);
    setRootId((r) => r || s.effective.root_id || '');
  }, [s]);
  useEffect(() => {
    if (!rootId && usable.length === 1) setRootId(usable[0].id);
  }, [rootId, usable]);

  if (!s) {
    return summary.error ? (
      <ErrorBanner error={summary.error} onRetry={summary.reload} title="Could not load the execution environment" />
    ) : (
      <Card>
        <LoadingRows label="Loading execution environment…" />
      </Card>
    );
  }

  const eff = s.effective;
  const sel = choice ?? eff.env;
  const readOnly = inCompany;
  const sameRoot = sel === 'host' ? rootId === (eff.root_id ?? '') : true;
  const unchanged = sel === eff.env && sameRoot;
  const disabledReason = readOnly
    ? 'The company decides this agent’s environment'
    : unchanged
      ? 'Already active'
      : sel === 'host' && !rootId
        ? 'Choose an authorised project folder'
        : null;
  const descs = info.data?.environments ?? [];
  const chosenRoot = roots.data?.find((r) => r.id === rootId) ?? null;
  const actionLabel = sel !== eff.env ? `Switch to ${sel === 'host' ? 'Host computer' : 'Virtual machine'}` : 'Apply folder change';

  const doSwitch = async () => {
    setSwitchError(null);
    try {
      const r = await envApi.setAgent(agent.id, sel, sel === 'host' ? rootId : null);
      summary.setData(() => r);
      setChoice(r.effective.env);
      setRootId(r.effective.root_id ?? '');
      setConfirm(false);
      toast.success(`${agent.name} now works on ${ENV_SHORT[r.effective.env]}`);
      onChanged?.();
      info.reload();
    } catch (e) {
      setConfirm(false);
      setSwitchError(e);
    }
  };

  return (
    <div className="space-y-5">
      {/* ------------------------------------------------ effective environment */}
      <section
        aria-labelledby="env-current-title"
        className={`rounded-2xl border p-4 shadow-card sm:p-5 ${eff.env === 'host' ? 'border-accent/40 bg-accent/[0.05]' : 'border-[#8fd3e8]/25 bg-[#8fd3e8]/[0.04]'}`}
      >
        <div className="flex flex-wrap items-start gap-4">
          <span
            aria-hidden
            className={`grid size-12 shrink-0 place-items-center rounded-xl border ${
              eff.env === 'host' ? 'border-accent/35 bg-accent/15 text-accent-soft' : 'border-[#8fd3e8]/25 bg-[#11262d] text-[#8fd3e8]'
            }`}
          >
            <EnvIcon env={eff.env} className="size-6" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-2xs font-medium tracking-wide text-subtle uppercase">Current execution environment</p>
            <h2 id="env-current-title" className="mt-0.5 text-lg font-semibold text-text">
              {ENV_LONG[eff.env]}
            </h2>
            <p className="mt-0.5 text-sm text-muted">
              Decided by: <strong className="text-text">{levelLabel(eff.source)}</strong>
              {readOnly && company.data ? (
                <>
                  {' '}
                  of <TextLink href={href(`/companies/${company.data.id}`)}>{company.data.name}</TextLink>
                </>
              ) : null}
              {' · '}
              {s.live_desktop ? 'Live Desktop available' : 'No Live Desktop (native macOS execution)'}
            </p>
          </div>
          <Badge tone={s.problems.length ? 'danger' : 'success'} dot>
            {s.problems.length ? 'Not ready' : 'Ready'}
          </Badge>
        </div>
        <div className="mt-4 flex flex-col gap-3">
          <EnvChain chain={eff.chain} levels={eff.chain[0]?.level === 'company' ? ['company', 'project', 'member', 'assignment'] : undefined} />
          {eff.env === 'host' && (
            <p className="flex min-w-0 flex-wrap items-center gap-2 text-sm text-muted">
              <IconFiles className="size-4 shrink-0 text-subtle" />
              {s.root ? (
                <>
                  <span className="text-text">{s.root.name}</span>
                  <Mono className="break-all">{s.root.path}</Mono>
                  <Badge tone={s.root.mode === 'read_only' ? 'warn' : 'neutral'}>{s.root.mode === 'read_only' ? 'read-only' : 'read-write'}</Badge>
                  <Badge>{s.root.allow_network ? 'network on' : 'network off'}</Badge>
                </>
              ) : (
                <span className="text-warn">No authorised project folder selected</span>
              )}
            </p>
          )}
          {s.problems.length > 0 && (
            <Notice tone="danger" title="Tasks in this environment would fail right now">
              <ul className="list-disc space-y-0.5 pl-4">
                {s.problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </Notice>
          )}
        </div>
      </section>

      {readOnly && (
        <Notice
          tone="info"
          title="Managed by the company"
          action={
            company.data ? (
              <ButtonLink size="sm" href={href(`/companies/${company.data.id}/employees`)} icon={<IconExternal />}>
                Open {company.data.name} · Employees
              </ButtonLink>
            ) : (
              <ButtonLink size="sm" href={href('/companies')}>
                Open AI Companies
              </ButtonLink>
            )
          }
        >
          {agent.name} works for {company.data ? <strong>{company.data.name}</strong> : 'an AI company'}. Its environment follows the chain company → project → employee →
          project assignment, so it is read-only here. Change it in the company’s Employees tab or in the project settings.
        </Notice>
      )}

      {/* ------------------------------------------------ selector */}
      <Card
        title="Execution Environment Selector"
        subtitle="Where this agent’s tasks really run. Memory, chat history, skills and workspace files are kept when you switch."
        icon={<IconLock />}
      >
        {info.error ? (
          <div className="mb-4">
            <ErrorBanner error={info.error} onRetry={info.reload} title="Environment details unavailable" />
          </div>
        ) : null}
        <fieldset disabled={readOnly} className="min-w-0">
          <legend className="sr-only">Execution environment for {agent.name}</legend>
          <div className="grid gap-4 lg:grid-cols-2">
            {(['host', 'vm'] as const).map((env) => (
              <ChoiceCard
                key={env}
                env={env}
                name={`env-${agent.id}`}
                checked={sel === env}
                active={eff.env === env}
                disabled={readOnly}
                onSelect={() => {
                  setChoice(env);
                  setSwitchError(null);
                }}
                desc={descs.find((d) => d.id === env)}
                info={info.data}
              />
            ))}
          </div>
        </fieldset>

        {sel === 'host' && !readOnly && (
          <div className="mt-5 max-w-xl">
            {roots.error ? (
              <ErrorBanner error={roots.error} onRetry={roots.reload} title="Authorised folders unavailable" />
            ) : roots.data && usable.length === 0 ? (
              <Notice
                tone="warn"
                title="No authorised project folder"
                action={
                  <ButtonLink size="sm" href={href('/host')} variant="primary">
                    Authorise a folder in Host Access
                  </ButtonLink>
                }
              >
                Host agents only work inside folders you authorise. Nothing else on your Mac is reachable.
              </Notice>
            ) : (
              <Field
                htmlFor={rootSel}
                label="Project folder on the Mac"
                required
                hint={
                  chosenRoot ? (
                    <>
                      <span className="break-all">{chosenRoot.path}</span> · {chosenRoot.mode === 'read_only' ? 'read-only' : 'read-write'} ·{' '}
                      {chosenRoot.allow_network ? 'network on' : 'network off'} · <TextLink href={href('/host')}>Manage host access</TextLink>
                    </>
                  ) : (
                    <>
                      Only authorised folders are listed. <TextLink href={href('/host')}>Manage host access</TextLink>
                    </>
                  )
                }
              >
                <Select id={rootSel} value={rootId} onChange={(e) => setRootId(e.target.value)} disabled={!roots.data}>
                  <option value="">Choose a folder…</option>
                  {usable.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name} — {r.path}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </div>
        )}

        {switchError ? <div className="mt-5">{switchErrorView(switchError, agent.id)}</div> : null}

        {!readOnly && (
          <div className="mt-5 flex flex-wrap items-center justify-end gap-3 border-t border-border pt-4">
            {agent.current_task && (
              <p className="mr-auto flex items-center gap-1.5 text-xs text-warn">
                <IconAlert className="size-3.5" /> {agent.name} has an active task; the host refuses switching until it ends.
              </p>
            )}
            {!unchanged && (
              <Button
                variant="ghost"
                onClick={() => {
                  setChoice(eff.env);
                  setRootId(eff.root_id ?? '');
                  setSwitchError(null);
                }}
              >
                Reset
              </Button>
            )}
            <Button variant="primary" disabledReason={disabledReason} onClick={() => setConfirm(true)}>
              {actionLabel}
            </Button>
          </div>
        )}
      </Card>

      {/* ------------------------------------------------ tools */}
      <Card
        title={`Tools available on ${ENV_SHORT[eff.env]}`}
        subtitle="What the agent can call in its effective environment (filtered by permission level, skills and environment)."
        icon={<IconSkills />}
        actions={<Badge>{s.tools.length} tools</Badge>}
      >
        {s.skills_unavailable_here.length > 0 && (
          <div className="mb-4">
            <Notice tone="warn" title="Some enabled skills do not work here">
              {s.skills_unavailable_here.join(', ')} need a desktop or browser, which only exists on the Ubuntu VM. They stay enabled and work again on the VM.
            </Notice>
          </div>
        )}
        {s.tools.length === 0 ? (
          <p className="text-sm text-muted">No tools are available with the current permission level and skills.</p>
        ) : (
          <ul aria-label="Available tools" className="flex flex-wrap gap-1.5">
            {s.tools.map((t) => (
              <li key={t} className="rounded-md border border-border bg-panel-2 px-2 py-1 font-mono text-[11.5px] text-muted">
                {t}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <ConfirmDialog
        open={confirm}
        destructive={false}
        title={sel === eff.env ? 'Change the project folder?' : `Switch ${agent.name} to ${sel === 'host' ? 'the host computer' : 'the virtual machine'}?`}
        confirmLabel={actionLabel}
        busyText="Switching…"
        onCancel={() => setConfirm(false)}
        onConfirm={doSwitch}
      >
        <p>
          From <strong>{ENV_LONG[eff.env]}</strong> to <strong>{ENV_LONG[sel]}</strong>
          {sel === 'host' && chosenRoot ? (
            <>
              {' '}
              in <strong className="break-all">{chosenRoot.path}</strong>
            </>
          ) : null}
          .
        </p>
        <p>Memory, chat history, skills and workspace files are kept. New tasks use the new environment; the host refuses the switch while tasks are active.</p>
        {sel === 'host' ? (
          <p>On the Mac the agent only reaches the authorised folder through the macOS sandbox. Desktop, browser and Live Desktop are not available there.</p>
        ) : (
          <p>On the VM the agent works in its own Linux user with desktop and browser; it cannot touch your Mac’s files.</p>
        )}
      </ConfirmDialog>
    </div>
  );
}
