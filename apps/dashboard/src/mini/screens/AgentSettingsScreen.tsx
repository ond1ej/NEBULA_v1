// Agent settings (V3.2.2, #/agents/<id>/settings). The main bot's owner (`agents` permission) edits name, description,
// avatar, provider + model, instructions, capabilities, extra skills, permission level, vault access and idle sleep;
// Save sends only what changed (PATCH /miniapp/agents/{id}/settings). Everything else is shown read-only: status (with
// Pause / Resume), the Password Vault grants (Revoke only — grants are created on the Mac), the execution environment
// (set on the Mac) and deletion (only on the Mac). Other sessions see a read-only summary built from GET /agents/{id}.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useToast } from '../../components/Toast';
import { IconKey, IconSkills, IconTrash } from '../../components/icons';
import type { AgentDetail } from '../../types';
import type { AgentVoice } from '../types';
import { composerApi, OPTIONS_KEY, settingsKey } from '../agentConfig/api';
import {
  describeProblem,
  fieldSlice,
  formFromSettings,
  levelLabel,
  limitsOf,
  OWNER_ONLY,
  settingsPatch,
  validate,
  visibleErrors,
  type AgentForm,
  type FieldProblem,
  type FormErrors,
  type Problem,
} from '../agentConfig/form';
import { AdvancedSection, AiSection, CapabilitiesSection, IdentitySection, SecuritySection, useModels } from '../agentConfig/sections';
import type { AgentComposerSettings, AgentOptions } from '../agentConfig/types';
import { useBackOverlay } from '../backStack';
import { hasPermission, isAdmin, useMini } from '../context';
import { setQueryData, useActions, useQuery } from '../hooks';
import { IcBack } from '../icons';
import { goBack, mhref, parentPath, useMiniRoute } from '../router';
import { haptic, setClosingConfirmation } from '../telegram';
import { agentAvatar, agentStatus, Avatar, Btn, Card, ErrorState, Glyph, IconBtn, List, Pill, Row, Screen, Section, SkeletonList, StatusDot } from '../uiKit';
import { ConfirmSheet, EnvBadge, envLabel, KV, Notice } from '../uiExtra';

/** Execution environment from the agent's config (the settings endpoint reports it directly). */
const envOf = (a: { config?: unknown }): 'vm' | 'host' => ((a.config as { execution?: { env?: string } } | undefined)?.execution?.env === 'host' ? 'host' : 'vm');

export function AgentSettingsScreen({ agentId }: { agentId: string }) {
  const ctx = useMini();
  return hasPermission(ctx, 'agents') ? <EditableSettings agentId={agentId} /> : <ReadOnlySettings agentId={agentId} />;
}

const MODE_LABEL: Record<string, string> = { NONE: 'No access', SELECTED: 'Selected credentials', MANAGED: 'Managed by tags' };
const POLICY_LABEL: Record<string, string> = { always: 'Ask every time', once_per_task: 'Ask once per task', never: 'No approval' };

// ---------------------------------------------------------------- shared blocks
function StatusBlock({ id, name, state, avatar, env, onChanged }: { id: string; name: string; state: string; avatar: ReturnType<typeof agentAvatar>; env: 'vm' | 'host'; onChanged: () => void }) {
  const ctx = useMini();
  const { api } = ctx;
  const { run, isPending } = useActions();
  const st = agentStatus(state);
  const canCommand = hasPermission(ctx, 'commands');
  const sleeping = state === 'SLEEP' || state === 'STOPPED';
  const act = async (key: string, fn: () => Promise<unknown>, success: string) => {
    if ((await run(key, fn, { success })) !== undefined) onChanged();
  };
  return (
    <div className="mb-6 flex flex-col items-center text-center" data-testid="agent-status">
      <Avatar name={name} id={id} size="lg" avatar={avatar} />
      <p className="mt-2 text-title font-semibold text-text">{name}</p>
      <p className="mt-2 flex flex-wrap items-center justify-center gap-1.5">
        <Pill tone={st.tone}>
          <StatusDot tone={st.tone} pulse={st.busy} /> {st.label}
        </Pill>
        <EnvBadge env={env} />
      </p>
      <div className="mt-3 flex flex-wrap justify-center gap-2">
        {sleeping ? (
          <Btn size="sm" variant="tinted" loading={isPending('wake')} disabledReason={canCommand ? null : 'This session may not control agents'} onClick={() => void act('wake', () => api.agents.wake(id), `${name} is waking up`)}>
            Wake
          </Btn>
        ) : state === 'PAUSED' ? (
          <Btn size="sm" variant="tinted" loading={isPending('resume')} disabledReason={canCommand ? null : 'This session may not control agents'} onClick={() => void act('resume', () => api.agents.resume(id), `${name} resumed`)}>
            Resume
          </Btn>
        ) : (
          <Btn size="sm" variant="tinted" loading={isPending('pause')} disabledReason={canCommand ? null : 'This session may not control agents'} onClick={() => void act('pause', () => api.agents.pause(id), `${name} paused`)}>
            Pause
          </Btn>
        )}
        <a href={mhref(`/agents/${id}`)} className="inline-flex min-h-9 items-center rounded-lg px-3 text-footnote font-semibold text-accent-soft focus-ring">
          Open chat
        </a>
      </div>
    </div>
  );
}

function EnvironmentBlock({ env, agentId }: { env: 'vm' | 'host'; agentId: string }) {
  const admin = isAdmin(useMini());
  return (
    <Section
      title="Execution environment"
      footer={
        admin ? (
          <a className="text-accent-soft underline" href={mhref(`/admin/agents/${agentId}/environment`)}>
            Change the environment in Administration
          </a>
        ) : (
          'Switching between the Ubuntu VM and native macOS execution is only possible on your Mac (Dashboard → agent → Environment).'
        )
      }
    >
      <Card>
        <div className="flex items-center gap-2">
          <EnvBadge env={env} />
          <span className="text-subhead text-text">{envLabel(env)}</span>
        </div>
        <p className="mt-1 text-footnote text-muted">
          {env === 'host' ? 'Runs natively in a project folder you authorised — set on the Mac.' : 'Its own isolated Linux user, desktop and browser in the VM.'}
        </p>
      </Card>
    </Section>
  );
}

const REPLY_MODES: Record<string, string> = {
  text: 'Text only',
  voice: 'Voice only',
  text_voice: 'Text and voice',
  auto: 'Automatic (voice when you send voice)',
};

function VoiceBlock({ agentId }: { agentId: string }) {
  const ctx = useMini();
  const { api } = ctx;
  const voice = useQuery<AgentVoice>(`voice:${agentId}`, (s) => api.agents.voice(agentId, s));
  const v = voice.data;
  return (
    <Section
      title="Voice replies"
      footer={
        isAdmin(ctx) ? (
          <a className="text-accent-soft underline" href={mhref(`/admin/agents/${agentId}/voice`)}>
            Change voice settings in Administration
          </a>
        ) : (
          'Voice settings are changed on your Mac.'
        )
      }
    >
      <Card>
        {v ? (
          <KV
            items={[
              ['Reply mode', REPLY_MODES[v.reply_mode] ?? v.reply_mode],
              ['Voice', `${v.provider}${v.voice ? ` · ${v.voice}` : ''}`],
              ['Language', v.language],
            ]}
          />
        ) : voice.error ? (
          <p className="text-subhead text-muted">Not available.</p>
        ) : (
          <SkeletonList rows={1} avatar={false} />
        )}
      </Card>
    </Section>
  );
}

function DeleteBlock({ agentId }: { agentId: string }) {
  if (isAdmin(useMini())) {
    // the owner deletes from the agent's settings page of the administration area (export first, confirmation)
    return (
      <Section footer="Deleting removes the agent's desktop, files and memory. You can export its workspace first.">
        <List>
          <Row href={mhref(`/admin/agents/${agentId}/settings`)} leading={<Glyph tone="danger"><IconTrash /></Glyph>} title="Delete agent" subtitle="In Administration" destructive />
        </List>
      </Section>
    );
  }
  return (
    <Section footer="Deleting removes the agent's desktop, files and memory. It is only available in the NEBULA Dashboard on your Mac.">
      <List>
        <Row leading={<Glyph tone="danger"><IconTrash /></Glyph>} title="Delete agent" subtitle="Only on your Mac" destructive disabled />
      </List>
    </Section>
  );
}

/** Back that asks before discarding unsaved changes (Telegram BackButton and the in-app arrow). */
function useGuardedBack(dirty: boolean, discard: () => void) {
  const route = useMiniRoute();
  const parent = parentPath(route);
  const [asking, setAsking] = useState(false);
  useBackOverlay(dirty && !asking, () => setAsking(true));
  useBackOverlay(asking, () => setAsking(false));
  useEffect(() => setClosingConfirmation(dirty), [dirty]);
  useEffect(() => () => setClosingConfirmation(false), []);
  const back = useCallback(() => (dirty ? setAsking(true) : goBack(parent)), [dirty, parent]);
  const confirm = (
    <ConfirmSheet
      open={asking}
      title="Discard your changes?"
      confirmLabel="Discard"
      tone="danger"
      onCancel={() => setAsking(false)}
      onConfirm={() => {
        setAsking(false);
        discard();
        goBack(parent);
      }}
    >
      The changes you made to this agent are not saved.
    </ConfirmSheet>
  );
  return { back, confirm };
}

// ---------------------------------------------------------------- editable (agents permission)
function EditableSettings({ agentId }: { agentId: string }) {
  const ctx = useMini();
  const { inTelegram } = ctx;
  const toast = useToast();
  const capi = useMemo(() => composerApi(ctx.client), [ctx.client]);
  const sq = useQuery<AgentComposerSettings>(settingsKey(agentId), (s) => capi.settings(agentId, s), {
    refreshOn: (ev) => ev.agent_id === agentId && (ev.type.startsWith('agent.') || ev.type.startsWith('vault.')),
  });
  const opts = useQuery<AgentOptions>(OPTIONS_KEY, (s) => capi.options(s));
  const models = useModels((pid, s) => capi.models(pid, s));
  const { run, isPending } = useActions();

  // the form edits a snapshot (`base`); refreshes while editing never overwrite what the owner typed
  const [base, setBase] = useState<AgentComposerSettings | null>(null);
  const [form, setForm] = useState<AgentForm | null>(null);
  const s = sq.data;
  const dirtyPatch = form && base ? settingsPatch(form, base) : {};
  const dirty = Object.keys(dirtyPatch).length > 0;
  useEffect(() => {
    if (!s) return;
    if (!base || !dirty) {
      setBase(s);
      setForm(formFromSettings(s));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s]);

  const [attempted, setAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [fieldProblem, setFieldProblem] = useState<FieldProblem | null>(null);
  const [dup, setDup] = useState<string | null>(null);
  const [revoke, setRevoke] = useState<AgentComposerSettings['vault']['grants'][number] | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const update = useCallback((fn: (f: AgentForm) => AgentForm) => setForm((f) => (f ? fn(f) : f)), []);
  const reset = () => {
    if (base) setForm(formFromSettings(base));
    setAttempted(false);
    setProblem(null);
    setFieldProblem(null);
  };
  const { back, confirm } = useGuardedBack(dirty, reset);
  useBackOverlay(dup !== null, () => setDup(null));

  const options = opts.data;
  const lim = limitsOf(options);
  const modelsNow = form?.providerId ? (models.get(form.providerId)?.models ?? null) : null;
  const clientErrors: FormErrors = form && options ? validate(form, lim, modelsNow, options.capabilities) : {};
  if (!('provider_id' in dirtyPatch)) {
    // an unchanged model never blocks saving other settings
    delete clientErrors.provider;
    delete clientErrors.model;
  }
  const errorKeys = Object.keys(clientErrors);
  const errors = form ? visibleErrors(form, clientErrors, attempted, fieldProblem) : {};

  const save = async (allowDuplicate = false) => {
    if (!form || !base || saving) return;
    setAttempted(true);
    if (errorKeys.length) {
      haptic('error');
      return;
    }
    const patch = settingsPatch(form, base);
    if (!Object.keys(patch).length) return;
    if (allowDuplicate) patch.allow_duplicate_name = true;
    setSaving(true);
    setProblem(null);
    setFieldProblem(null);
    haptic('impact');
    try {
      const res = await capi.update(agentId, patch);
      haptic('success');
      toast.success('Settings saved');
      setQueryData<AgentComposerSettings>(settingsKey(agentId), () => res);
      setQueryData<AgentDetail>(`agent:${agentId}`, (a) => (a ? { ...a, ...res.agent } : a));
      setBase(res);
      setForm(formFromSettings(res));
      setAttempted(false);
    } catch (e) {
      haptic('error');
      const p = describeProblem(e, { name: patch.name ?? form.name, capabilityLabel: (id) => options?.capabilities.find((c) => c.id === id)?.label ?? id });
      if (p.kind === 'duplicate') setDup(patch.name ?? form.name);
      else if (p.kind === 'field') setFieldProblem({ field: p.field, message: p.message, at: fieldSlice(form, p.field) });
      else setProblem(p);
    } finally {
      setSaving(false);
    }
  };

  const doRevoke = async () => {
    if (!revoke) return;
    const r = await run('revoke', () => ctx.api.vault.revoke(revoke.id), { success: `Access to ${revoke.entry_name} revoked` });
    if (r !== undefined) {
      setRevoke(null);
      sq.reload();
    }
  };

  const title = base?.name ?? 'Agent';
  const saveBtn = (
    <Btn size="sm" variant="primary" className="mr-1" loading={saving} disabled={!dirty || saving} onClick={() => void save(false)}>
      Save
    </Btn>
  );
  return (
    <Screen title="Settings" subtitle={title} back={false} leading={inTelegram ? undefined : <IconBtn label="Back" icon={<IcBack />} onClick={back} />} actions={form && options ? saveBtn : undefined}>
      {!s || !form || !base ? (
        sq.error ? <ErrorState error={sq.error} onRetry={sq.reload} title="Could not load the agent settings" /> : <SkeletonList rows={4} />
      ) : !options ? (
        opts.error ? <ErrorState error={opts.error} onRetry={opts.reload} title="Could not load the agent options" /> : <SkeletonList rows={4} />
      ) : (
        <form
          noValidate
          aria-label="Agent settings"
          onSubmit={(e) => {
            e.preventDefault();
            void save(false);
          }}
        >
          <StatusBlock id={agentId} name={s.name} state={s.status} avatar={s.avatar} env={s.environment?.env === 'host' ? 'host' : 'vm'} onChanged={sq.reload} />
          {attempted && errorKeys.length > 0 && (
            <div role="alert" className="mb-4">
              <Notice tone="danger" title={errorKeys.length === 1 ? 'Check 1 field' : `Check ${errorKeys.length} fields`} />
            </div>
          )}
          {problem && (
            <div role="alert" className="mb-4" data-testid="settings-problem">
              <Notice tone={problem.kind === 'network' ? 'warning' : 'danger'} title={problem.kind === 'general' ? problem.title : 'Not saved'}>
                {'message' in problem ? problem.message : null}
              </Notice>
            </div>
          )}
          <fieldset disabled={saving} className="min-w-0">
            <IdentitySection form={form} update={update} options={options} errors={errors} selfName={base.name} agentId={agentId} />
            <AiSection form={form} update={update} options={options} errors={errors} models={models} mode="edit" />
            <CapabilitiesSection form={form} update={update} options={options} errors={errors} />
            <SecuritySection form={form} update={update} options={options} errors={errors}>
              <VaultGrants settings={s} onRevoke={setRevoke} />
            </SecuritySection>
            <AdvancedSection
              form={form}
              update={update}
              options={options}
              errors={errors}
              mode="edit"
              open={advanced}
              onToggle={() => setAdvanced((v) => !v)}
              readOnlyExtra={
                <KV
                  items={[
                    ['Resource mode', s.resource_mode === 'SLEEP' ? 'Asleep' : s.resource_mode.charAt(0) + s.resource_mode.slice(1).toLowerCase()],
                    ['Desktop resolution', `${s.desktop_resolution.replace('x', ' × ')} (fixed at creation)`],
                  ]}
                />
              }
            />
          </fieldset>
          <EnvironmentBlock env={s.environment?.env === 'host' ? 'host' : 'vm'} agentId={agentId} />
          <VoiceBlock agentId={agentId} />
          <DeleteBlock agentId={agentId} />
          <div className="mb-6 grid grid-cols-2 gap-2">
            <Btn onClick={reset} disabled={!dirty || saving}>
              Discard changes
            </Btn>
            <Btn variant="primary" type="submit" loading={saving} disabled={!dirty || saving}>
              Save changes
            </Btn>
          </div>
        </form>
      )}
      {confirm}
      <ConfirmSheet open={dup !== null} title={`An agent named “${dup ?? ''}” already exists`} confirmLabel="Rename anyway" onCancel={() => setDup(null)} onConfirm={() => {
        setDup(null);
        void save(true);
      }}>
        Use this name anyway? Both agents keep their own chats, memory and desktop.
      </ConfirmSheet>
      <ConfirmSheet open={revoke !== null} title={`Revoke access to ${revoke?.entry_name ?? 'this credential'}?`} confirmLabel="Revoke" tone="danger" busy={isPending('revoke')} onCancel={() => setRevoke(null)} onConfirm={() => void doRevoke()}>
        {title} can no longer use this credential. Granting it again is possible only on your Mac.
      </ConfirmSheet>
    </Screen>
  );
}

function VaultGrants({ settings: s, onRevoke }: { settings: AgentComposerSettings; onRevoke: (g: AgentComposerSettings['vault']['grants'][number]) => void }) {
  const grants = s.vault?.grants ?? [];
  return (
    <Section title={`Saved credentials${grants.length ? ` · ${grants.length}` : ''}`} footer="Grants are created on your Mac. Here you can only revoke them.">
      <Card className="mb-2">
        <KV items={[['Vault mode', MODE_LABEL[s.vault?.mode ?? ''] ?? s.vault?.mode ?? '—']]} />
      </Card>
      {grants.length ? (
        <ul className="space-y-2">
          {grants.map((g) => (
            <li key={g.id} className="rounded-card bg-panel p-4" data-testid="settings-grant">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="min-w-0 flex-1 truncate text-body font-semibold text-text">{g.entry_name}</span>
                <Pill tone={g.enabled ? 'success' : 'neutral'}>{g.enabled ? 'active' : 'revoked'}</Pill>
              </div>
              <p className="mt-1 font-mono text-footnote break-all text-muted">{g.origins.join(', ') || '—'}</p>
              <p className="text-footnote text-subtle">{POLICY_LABEL[g.policy] ?? g.policy.replace(/_/g, ' ')}</p>
              {g.enabled && (
                <Btn size="sm" className="mt-2 w-full" variant="danger" onClick={() => onRevoke(g)}>
                  Revoke
                </Btn>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="rounded-card bg-panel px-4 py-3.5 text-subhead text-muted">No saved credentials granted.</p>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------- read-only (no `agents` permission)
function ReadOnlySettings({ agentId }: { agentId: string }) {
  const { api } = useMini();
  const q = useQuery<AgentDetail>(`agent:${agentId}`, (s) => api.agents.get(agentId, s), {
    refreshOn: (ev) => ev.agent_id === agentId && ev.type.startsWith('agent.'),
  });
  const a = q.data;
  const cfg = (a?.config ?? {}) as { instructions?: unknown; memory_auto_save?: unknown; sign_in_assistance?: unknown; idle_sleep_minutes?: unknown };
  const items: [ReactNode, ReactNode][] = a
    ? [
        ['Model', a.model_id ? `${a.provider_id} · ${a.model_id}` : 'not configured'],
        ['Permission level', levelLabel(a.permission_level)],
        ['Memory', cfg.memory_auto_save === false ? 'Off' : 'On'],
        ['Password Vault access', cfg.sign_in_assistance === false ? 'No access' : 'Ask me when a sign-in is needed'],
        ['Idle sleep', typeof cfg.idle_sleep_minutes === 'number' ? `${cfg.idle_sleep_minutes} min` : 'Never'],
        ['Resources', `${a.resource_mode.toLowerCase()} · ${a.desktop_resolution}`],
      ]
    : [];
  return (
    <Screen title="Settings" subtitle={a?.name}>
      {!a ? (
        q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : <SkeletonList rows={3} />
      ) : (
        <>
          <StatusBlock id={a.id} name={a.name} state={a.state} avatar={agentAvatar(a)} env={envOf(a)} onChanged={q.reload} />
          <Notice tone="info" className="mb-6">
            <span data-testid="owner-only-note">{OWNER_ONLY}</span>
          </Notice>
          {a.description && (
            <Section title="Description">
              <Card>
                <p className="text-subhead whitespace-pre-wrap text-muted [overflow-wrap:anywhere]">{a.description}</p>
              </Card>
            </Section>
          )}
          <Section title="Configuration">
            <Card>
              <KV items={items} />
            </Card>
          </Section>
          <Section title="System instructions">
            <Card>
              <p className="text-subhead whitespace-pre-wrap text-muted [overflow-wrap:anywhere]">{typeof cfg.instructions === 'string' && cfg.instructions.trim() ? cfg.instructions : 'None — NEBULA defaults only.'}</p>
            </Card>
          </Section>
          <Section>
            <List>
              <Row href={mhref(`/agents/${a.id}/skills`)} leading={<Glyph tone="warning"><IconSkills /></Glyph>} title="Skills" />
              <Row href={mhref(`/agents/${a.id}/vault`)} leading={<Glyph tone="accent"><IconKey /></Glyph>} title="Password Vault access" />
            </List>
          </Section>
          <EnvironmentBlock env={envOf(a)} agentId={a.id} />
          <VoiceBlock agentId={a.id} />
          <DeleteBlock agentId={a.id} />
        </>
      )}
    </Screen>
  );
}
