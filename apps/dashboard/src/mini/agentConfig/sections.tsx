// Sections shared by the agent creator (sheet) and the agent settings screen: Identity, AI configuration,
// Capabilities, Security and Advanced. State lives in the parent (AgentForm), so collapsing a section never loses input.
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { AvatarGlyph } from '../../components/avatarGlyphs';
import { errorMessage, isApiError } from '../../lib/http';
import { haptic } from '../telegram';
import { Avatar, Btn, Card, cx, initials, List, Pill, Section, Spinner } from '../uiKit';
import { Notice, Segmented } from '../uiExtra';
import { CheckRow, describedBy, Disclosure, FieldShell, RadioList, SelectInput, TextArea, TextInput, ToggleRow } from './fields';
import { duplicateOf, levelAllows, levelLabel, limitsOf, setCapability, setLevel, type AgentForm, type FormErrors } from './form';
import type { AgentAvatar, AgentLevel, AgentOptions, ModelChoice } from './types';

export interface SectionProps {
  form: AgentForm;
  update: (fn: (f: AgentForm) => AgentForm) => void;
  options: AgentOptions;
  errors: FormErrors;
  disabled?: boolean;
}

// ---------------------------------------------------------------- models per provider (lazy, cached in the form)
export interface ModelsEntry {
  status: 'loading' | 'ready' | 'error';
  models: ModelChoice[] | null;
  error: unknown;
}

/** Models are fetched only once a provider is chosen, and kept per provider while the form is open. */
export function useModels(load: (providerId: string, signal: AbortSignal) => Promise<ModelChoice[]>) {
  const [map, setMap] = useState<Record<string, ModelsEntry>>({});
  const ref = useRef(map);
  ref.current = map;
  const loadRef = useRef(load);
  loadRef.current = load;
  const ctls = useRef(new Map<string, AbortController>());
  useEffect(() => {
    const all = ctls.current;
    return () => {
      for (const c of all.values()) c.abort();
      all.clear();
    };
  }, []);
  const fetchFor = useCallback((providerId: string, force = false) => {
    if (!providerId) return;
    const cur = ref.current[providerId];
    if (cur && !force && cur.status !== 'error') return;
    ctls.current.get(providerId)?.abort();
    const ctl = new AbortController();
    ctls.current.set(providerId, ctl);
    setMap((m) => ({ ...m, [providerId]: { status: 'loading', models: m[providerId]?.models ?? null, error: null } }));
    loadRef.current(providerId, ctl.signal).then(
      (models) => {
        if (ctl.signal.aborted) return;
        setMap((m) => ({ ...m, [providerId]: { status: 'ready', models, error: null } }));
      },
      (error: unknown) => {
        if (ctl.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) return;
        setMap((m) => ({ ...m, [providerId]: { status: 'error', models: null, error } }));
      },
    );
  }, []);
  return { get: (providerId: string): ModelsEntry | null => map[providerId] ?? null, load: fetchFor };
}

export type ModelsApi = ReturnType<typeof useModels>;

// ---------------------------------------------------------------- A · identity
export const EMOJI_PRESETS = ['🤖', '🧠', '🔍', '📊', '💼', '🌐', '🛡️', '📚', '⚡', '⭐', '✉️', '🎯'];

const ICON_LABEL = (id: string) => id.charAt(0).toUpperCase() + id.slice(1);

type AvatarMode = 'initials' | 'emoji' | 'icon';

export function AvatarPicker({
  name,
  id,
  avatar,
  onChange,
  icons,
  error,
  disabled,
}: {
  name: string;
  id?: string;
  avatar: AgentAvatar | null;
  onChange: (a: AgentAvatar | null) => void;
  icons: string[];
  error?: string;
  disabled?: boolean;
}) {
  const [mode, setMode] = useState<AvatarMode>(avatar?.kind ?? 'initials');
  // per-mode drafts: switching tabs never loses what was typed or picked
  const [emoji, setEmoji] = useState(avatar?.kind === 'emoji' ? avatar.value : '');
  const [own, setOwn] = useState(avatar?.kind === 'initials' ? avatar.value : '');
  const [icon, setIcon] = useState(avatar?.kind === 'icon' ? avatar.value : '');
  const fid = useId();
  const auto = initials(name.trim() || '?');
  const pick = (m: AvatarMode) => {
    setMode(m);
    haptic('selection');
    if (m === 'initials') onChange(own.trim() ? { kind: 'initials', value: own.trim() } : null);
    else if (m === 'emoji') onChange(emoji.trim() ? { kind: 'emoji', value: emoji.trim() } : avatar);
    else onChange(icon ? { kind: 'icon', value: icon } : avatar);
  };
  return (
    <div className="flex flex-col gap-3" data-testid="avatar-picker">
      <div className="flex items-center gap-4">
        <Avatar name={name.trim() || 'New agent'} id={id ?? 'new-agent'} size="lg" avatar={avatar} />
        <div className="min-w-0 flex-1">
          <p className="text-footnote font-medium text-muted">Avatar</p>
          <Segmented<AvatarMode>
            label="Avatar style"
            value={mode}
            onChange={(m) => !disabled && pick(m)}
            options={[
              { id: 'initials', label: 'Initials' },
              { id: 'emoji', label: 'Emoji' },
              { id: 'icon', label: 'Icon' },
            ]}
          />
        </div>
      </div>
      {mode === 'initials' && (
        <FieldShell id={`${fid}-ini`} label="Custom initials" hint={`Empty: from the name (${auto}).`} error={error}>
          <TextInput
            id={`${fid}-ini`}
            value={own}
            maxLength={2}
            disabled={disabled}
            autoComplete="off"
            autoCapitalize="characters"
            placeholder={auto}
            invalid={Boolean(error)}
            aria-describedby={describedBy(`${fid}-ini`, error, null, 'hint')}
            onChange={(e) => {
              const v = e.target.value;
              setOwn(v);
              onChange(v.trim() ? { kind: 'initials', value: v.trim() } : null);
            }}
          />
        </FieldShell>
      )}
      {mode === 'emoji' && (
        <>
          <div role="group" aria-label="Emoji" className="grid grid-cols-6 gap-2">
            {EMOJI_PRESETS.map((e) => {
              const on = avatar?.kind === 'emoji' && avatar.value === e;
              return (
                <button
                  key={e}
                  type="button"
                  aria-label={`Emoji ${e}`}
                  aria-pressed={on}
                  disabled={disabled}
                  onClick={() => {
                    setEmoji(e);
                    haptic('selection');
                    onChange({ kind: 'emoji', value: e });
                  }}
                  className={cx('nb-press grid aspect-square min-h-11 place-items-center rounded-xl text-[22px] focus-ring', on ? 'bg-accent/20 shadow-[0_0_0_2px_var(--color-accent)]' : 'bg-text/8')}
                >
                  {e}
                </button>
              );
            })}
          </div>
          <FieldShell id={`${fid}-emo`} label="Or type an emoji" error={error}>
            <TextInput
              id={`${fid}-emo`}
              value={emoji}
              disabled={disabled}
              autoComplete="off"
              inputMode="text"
              maxLength={16}
              placeholder="😀"
              invalid={Boolean(error)}
              aria-describedby={describedBy(`${fid}-emo`, error)}
              onChange={(e) => {
                const v = e.target.value;
                setEmoji(v);
                onChange(v.trim() ? { kind: 'emoji', value: v.trim() } : null);
              }}
            />
          </FieldShell>
        </>
      )}
      {mode === 'icon' && (
        <>
          <div role="group" aria-label="Icons" className="grid grid-cols-8 gap-1.5">
            {icons.map((i) => {
              const on = avatar?.kind === 'icon' && avatar.value === i;
              return (
                <button
                  key={i}
                  type="button"
                  aria-label={ICON_LABEL(i)}
                  aria-pressed={on}
                  disabled={disabled}
                  onClick={() => {
                    setIcon(i);
                    haptic('selection');
                    onChange({ kind: 'icon', value: i });
                  }}
                  className={cx('nb-press grid aspect-square min-h-10 place-items-center rounded-xl text-text focus-ring', on ? 'bg-accent/20 text-accent-soft shadow-[0_0_0_2px_var(--color-accent)]' : 'bg-text/8')}
                >
                  <AvatarGlyph id={i} className="size-[22px]" />
                </button>
              );
            })}
          </div>
          {error && <p className="px-1 text-footnote text-danger">{error}</p>}
        </>
      )}
    </div>
  );
}

export function IdentitySection({ form, update, options, errors, disabled, selfName, agentId }: SectionProps & { selfName?: string; agentId?: string }) {
  const fid = useId();
  const lim = limitsOf(options);
  const others = selfName ? options.existing_names.filter((n) => n.trim().toLowerCase() !== selfName.trim().toLowerCase()) : options.existing_names;
  const dup = duplicateOf(form.name, others);
  const nameId = `${fid}-name`;
  const descId = `${fid}-desc`;
  const warning = dup ? `An agent named “${dup}” already exists. You can still use this name.` : null;
  return (
    <Section title="Identity">
      <Card className="space-y-4">
        <AvatarPicker
          name={form.name}
          id={agentId}
          avatar={form.avatar}
          icons={options.avatar.icons}
          error={errors.avatar}
          disabled={disabled}
          onChange={(a) => update((f) => ({ ...f, avatar: a }))}
        />
        <FieldShell id={nameId} label="Name" required error={errors.name} warning={warning} aside={`${[...form.name].length}/${lim.nameMax}`}>
          <TextInput
            id={nameId}
            data-field="name"
            value={form.name}
            disabled={disabled}
            maxLength={lim.nameMax}
            autoComplete="off"
            autoCapitalize="words"
            enterKeyHint="next"
            required
            aria-required
            placeholder="e.g. Researcher"
            invalid={Boolean(errors.name)}
            aria-describedby={describedBy(nameId, errors.name, warning)}
            onChange={(e) => update((f) => ({ ...f, name: e.target.value }))}
          />
        </FieldShell>
        <FieldShell id={descId} label="Description or role" error={errors.description} hint="Optional. The first line is shown as its role." aside={form.description ? `${[...form.description].length}/${lim.descriptionMax}` : undefined}>
          <TextArea
            id={descId}
            rows={2}
            value={form.description}
            disabled={disabled}
            maxLength={lim.descriptionMax}
            placeholder="e.g. Researches products and compares prices"
            invalid={Boolean(errors.description)}
            aria-describedby={describedBy(descId, errors.description, null, 'hint')}
            onChange={(e) => update((f) => ({ ...f, description: e.target.value }))}
          />
        </FieldShell>
      </Card>
    </Section>
  );
}

// ---------------------------------------------------------------- B · AI configuration
function modelsErrorText(e: unknown): string {
  if (isApiError(e) && e.status === 0) return 'Cannot reach NEBULA. Check your connection.';
  if (isApiError(e) && (e.code === 'provider_disconnected' || e.code === 'models_unavailable' || e.code === 'provider_unsupported')) return errorMessage(e);
  return `Could not load the models — ${errorMessage(e)}`;
}

const contextText = (m: ModelChoice) => {
  const parts: string[] = [];
  if (m.context_tokens) parts.push(m.context_tokens >= 1000 ? `${Math.round(m.context_tokens / 1000)}k context` : `${m.context_tokens} tokens context`);
  if (m.supports_images) parts.push('understands images');
  return parts.join(' · ');
};

export function AiSection({
  form,
  update,
  options,
  errors,
  disabled,
  models,
  mode,
}: SectionProps & { models: ModelsApi; mode: 'create' | 'edit' }) {
  const fid = useId();
  const lim = limitsOf(options);
  const modelId = `${fid}-model`;
  const instrId = `${fid}-instr`;
  const envHint = `${fid}-env`;
  const entry = form.providerId ? models.get(form.providerId) : null;
  const list = entry?.models ?? null;
  const selected = list?.find((m) => m.id === form.modelId) ?? null;
  const noTools = (list ?? []).filter((m) => !m.supports_tools).length;
  const connected = options.providers.filter((p) => p.connected).length;
  const instrLen = [...form.instructions].length;
  const modelHint = selected ? contextText(selected) || undefined : noTools ? 'Greyed-out models cannot use tools, so they cannot work as agents.' : undefined;
  const providerHint = `${fid}-prov`;
  return (
    <>
      <Section title="AI provider" footer={connected === 0 ? undefined : 'Providers are connected on your Mac (Settings → AI providers).'}>
        {options.providers.length === 0 || connected === 0 ? (
          <Notice tone="warning" title="No AI provider is connected" className="mb-2">
            Connect one on your Mac (Settings → AI providers), then come back here.
          </Notice>
        ) : null}
        {options.providers.length > 0 && (
          <RadioList
            label="AI provider"
            value={form.providerId}
            disabled={disabled}
            invalid={Boolean(errors.provider)}
            describedBy={errors.provider ? providerHint : undefined}
            testId="provider-list"
            onChange={(pid) => {
              haptic('selection');
              update((f) => ({ ...f, providerId: pid, modelId: pid === f.providerId ? f.modelId : '' }));
              models.load(pid);
            }}
            options={options.providers.map((p) => ({
              id: p.id,
              label: p.name,
              description: p.connected ? p.state : undefined,
              disabled: !p.connected,
              reason: p.reason ?? 'Not connected',
              trailing: <Pill tone={p.connected ? 'success' : 'neutral'}>{p.connected ? 'Connected' : 'Off'}</Pill>,
            }))}
          />
        )}
        {errors.provider && (
          <p id={providerHint} className="mt-1.5 px-4 text-footnote text-danger">
            {errors.provider}
          </p>
        )}
      </Section>

      <Section title="Model and instructions">
        <Card className="space-y-4">
          <FieldShell id={modelId} label="Model" required error={errors.model} hint={modelHint}>
            {!form.providerId ? (
              <SelectInput id={modelId} disabled value="" invalid={Boolean(errors.model)} aria-describedby={describedBy(modelId, errors.model)}>
                <option value="">Choose a provider first</option>
              </SelectInput>
            ) : entry?.status === 'loading' && !list ? (
              <div id={modelId} className="flex min-h-11 items-center rounded-xl bg-text/8 px-3" tabIndex={-1}>
                <Spinner className="size-4" label="Loading models…" />
              </div>
            ) : entry?.status === 'error' ? (
              <div id={modelId} role="alert" tabIndex={-1} className="flex min-h-11 flex-wrap items-center gap-2 rounded-xl bg-danger/10 px-3 py-2">
                <span className="min-w-0 flex-1 text-footnote text-danger">{modelsErrorText(entry.error)}</span>
                <Btn size="sm" variant="tinted" onClick={() => models.load(form.providerId, true)}>
                  Retry
                </Btn>
              </div>
            ) : list ? (
              <SelectInput
                id={modelId}
                value={form.modelId}
                disabled={disabled}
                invalid={Boolean(errors.model)}
                aria-describedby={describedBy(modelId, errors.model, null, modelHint)}
                onChange={(e) => update((f) => ({ ...f, modelId: e.target.value }))}
              >
                <option value="">{list.length ? 'Choose a model' : 'This provider offers no models'}</option>
                {form.modelId && !list.some((m) => m.id === form.modelId) && <option value={form.modelId}>{form.modelId} (not offered any more)</option>}
                {list.map((m) => (
                  <option key={m.id} value={m.id} disabled={!m.supports_tools}>
                    {m.name}
                    {m.supports_tools ? '' : ' — This model cannot use tools'}
                  </option>
                ))}
              </SelectInput>
            ) : (
              // settings: the current model; the list is loaded only when the owner wants to change it
              <div className="flex min-h-11 items-center gap-2 rounded-xl bg-text/8 pr-1 pl-3">
                <span id={modelId} className="min-w-0 flex-1 truncate text-body text-text" tabIndex={-1}>
                  {form.modelId || 'No model'}
                </span>
                <Btn size="sm" variant="ghost" disabled={disabled} onClick={() => models.load(form.providerId)}>
                  Change
                </Btn>
              </div>
            )}
          </FieldShell>

          <FieldShell
            id={instrId}
            label="System instructions"
            error={errors.instructions}
            hint="Added to the agent's instructions, below NEBULA's safety rules."
            aside={`${instrLen}/${lim.instructionsMax}`}
          >
            <TextArea
              id={instrId}
              rows={5}
              value={form.instructions}
              disabled={disabled}
              placeholder="Describe how this agent should behave, what it specializes in, and what rules it should follow."
              invalid={Boolean(errors.instructions)}
              aria-describedby={describedBy(instrId, errors.instructions, null, 'hint')}
              onChange={(e) => update((f) => ({ ...f, instructions: e.target.value }))}
            />
            <div className="flex justify-end">
              <Btn size="sm" variant="tinted" disabled={disabled || form.instructions.trim() === options.default_instructions.trim()} onClick={() => update((f) => ({ ...f, instructions: options.default_instructions }))}>
                Use default
              </Btn>
            </div>
          </FieldShell>
        </Card>
      </Section>

      {mode === 'create' && (
        <Section title="Execution environment" footer={errors.environment ? undefined : 'Every agent created here runs in its own isolated Linux user in the Ubuntu VM.'}>
          <RadioList
            label="Execution environment"
            value="vm"
            describedBy={errors.environment ? envHint : undefined}
            onChange={() => undefined}
            options={options.environments.map((e) => ({
              id: e.id,
              label: e.label,
              description: e.description,
              disabled: !e.available,
              reason: e.reason,
            }))}
          />
          {errors.environment && (
            <p id={envHint} className="mt-1.5 px-4 text-footnote text-danger">
              {errors.environment}
            </p>
          )}
        </Section>
      )}
    </>
  );
}

// ---------------------------------------------------------------- C · capabilities
export function CapabilitiesSection({ form, update, options, errors, disabled }: SectionProps) {
  const [notice, setNotice] = useState<string | null>(null);
  return (
    <Section title="Capabilities" footer="What this agent can use. You can change it later.">
      <List>
        {options.capabilities.map((c) => {
          const high = c.requires_level === 'ADVANCED';
          return (
            <ToggleRow
              key={c.id}
              label={c.label}
              description={c.description}
              checked={Boolean(form.capabilities[c.id])}
              disabled={disabled}
              badge={high ? <Pill tone="warning">Needs {levelLabel(c.requires_level)}</Pill> : undefined}
              note={high && form.capabilities[c.id] ? `Permission level: ${levelLabel(form.level)}` : undefined}
              onChange={(on) => {
                haptic('selection');
                const raise = on && !levelAllows(form.level, c.requires_level);
                update((f) => setCapability(f, c.id, on, options.capabilities).form);
                if (raise) setNotice(`Permission level set to ${levelLabel(c.requires_level)} — ${c.label} needs it. You can change it under Advanced.`);
              }}
            />
          );
        })}
        <ToggleRow
          label="Memory"
          description={options.memory.description}
          checked={Boolean(form.capabilities.memory)}
          disabled={disabled}
          onChange={(on) => update((f) => ({ ...f, capabilities: { ...f.capabilities, memory: on } }))}
        />
      </List>
      {notice && (
        <Notice tone="info" className="mt-2">
          <span role="status">{notice}</span>
        </Notice>
      )}
      {errors.capabilities && (
        <p role="alert" className="mt-1.5 px-4 text-footnote text-danger">
          {errors.capabilities}
        </p>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------- D · security
export function SecuritySection({ form, update, options, errors, disabled, children }: SectionProps & { children?: ReactNode }) {
  return (
    <>
      <Section title="Password Vault access" footer={options.vault.granted_note}>
        <RadioList
          label="Password Vault access"
          value={form.vaultAccess}
          disabled={disabled}
          onChange={(v) => update((f) => ({ ...f, vaultAccess: v }))}
          options={options.vault.options.map((o) => ({ id: o.id, label: o.label, description: o.description }))}
        />
        {errors.vault && <p className="mt-1.5 px-4 text-footnote text-danger">{errors.vault}</p>}
      </Section>
      {children}
      <Section title="Approvals" footer={options.approvals.note}>
        <Card>
          <p className="text-subhead text-text">
            {options.approvals.sensitive_actions_need_approval ? 'Sensitive actions need your approval.' : 'Sensitive actions run without approval (set on your Mac).'}
          </p>
          {options.approvals.always.length > 0 && (
            <>
              <p className="mt-2 text-footnote text-muted">Always asks you first:</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-footnote text-muted">
                {options.approvals.always.map((a) => (
                  <li key={a}>{a}</li>
                ))}
              </ul>
            </>
          )}
        </Card>
      </Section>
    </>
  );
}

// ---------------------------------------------------------------- E · advanced
export function AdvancedSection({
  form,
  update,
  options,
  errors,
  disabled,
  mode,
  open,
  onToggle,
  readOnlyExtra,
}: SectionProps & { mode: 'create' | 'edit'; open: boolean; onToggle: () => void; readOnlyExtra?: ReactNode }) {
  const fid = useId();
  const [dropped, setDropped] = useState<string | null>(null);
  const idleId = `${fid}-idle`;
  const resId = `${fid}-res`;
  const idle = options.advanced.idle_sleep_minutes;
  return (
    <Disclosure title="Advanced" open={open} onToggle={onToggle} id={`${fid}-adv`}>
      <Section title="Permission level">
        <RadioList<AgentLevel>
          label="Permission level"
          value={form.level}
          disabled={disabled}
          onChange={(lv) => {
            haptic('selection');
            const r = setLevel(form, lv, options.capabilities, options.extra_skills);
            update((f) => setLevel(f, lv, options.capabilities, options.extra_skills).form);
            setDropped(r.dropped.length ? `Turned off (needs a higher level): ${r.dropped.join(', ')}.` : null);
          }}
          options={options.levels.map((l) => ({ id: l.id, label: levelLabel(l.id), description: l.description }))}
        />
        {dropped && (
          <p role="status" className="mt-1.5 px-4 text-footnote text-warn">
            {dropped}
          </p>
        )}
        {errors.level && <p className="mt-1.5 px-4 text-footnote text-danger">{errors.level}</p>}
      </Section>

      {options.extra_skills.length > 0 && (
        <Section title="Extra skills" footer="Skills that need a higher permission level are disabled until you raise it.">
          <List>
            {options.extra_skills.map((s) => {
              const allowed = levelAllows(form.level, s.requires_level);
              const on = form.extraSkills.includes(s.id);
              return (
                <CheckRow
                  key={s.id}
                  label={s.name}
                  description={s.description}
                  checked={on}
                  disabled={disabled || (!allowed && !on)}
                  reason={`Needs the ${levelLabel(s.requires_level)} permission level`}
                  onChange={(v) => update((f) => ({ ...f, extraSkills: v ? [...f.extraSkills.filter((x) => x !== s.id), s.id] : f.extraSkills.filter((x) => x !== s.id) }))}
                />
              );
            })}
          </List>
          {errors.extra_skills && <p className="mt-1.5 px-4 text-footnote text-danger">{errors.extra_skills}</p>}
        </Section>
      )}

      {mode === 'create' && (
        <Section title="Start mode">
          <RadioList<'ACTIVE' | 'SLEEP'>
            label="Start mode"
            value={form.resourceMode}
            disabled={disabled}
            onChange={(m) => update((f) => ({ ...f, resourceMode: m }))}
            options={options.advanced.resource_modes.map((m) => ({
              id: m,
              label: m === 'SLEEP' ? 'Asleep' : 'Active',
              description: m === 'SLEEP' ? 'Starts asleep and wakes when you send a task (frees memory until then).' : 'Ready right away.',
            }))}
          />
        </Section>
      )}

      <Section>
        <Card className="space-y-4">
          <FieldShell id={idleId} label="Idle sleep (minutes)" error={errors.idle_sleep} hint={`Sleeps after this many idle minutes (${idle.min}–${idle.max}). Empty: never.`}>
            <TextInput
              id={idleId}
              value={form.idleSleep}
              disabled={disabled}
              inputMode="numeric"
              pattern="[0-9]*"
              autoComplete="off"
              placeholder="Never"
              invalid={Boolean(errors.idle_sleep)}
              aria-describedby={describedBy(idleId, errors.idle_sleep, null, 'hint')}
              onChange={(e) => update((f) => ({ ...f, idleSleep: e.target.value.replace(/[^\d]/g, '').slice(0, 5) }))}
            />
          </FieldShell>
          {mode === 'create' && (
            <FieldShell id={resId} label="Desktop resolution">
              <SelectInput id={resId} value={form.resolution} disabled={disabled} onChange={(e) => update((f) => ({ ...f, resolution: e.target.value }))}>
                {options.advanced.resolutions.map((r) => (
                  <option key={r} value={r}>
                    {r.replace('x', ' × ')}
                  </option>
                ))}
              </SelectInput>
            </FieldShell>
          )}
          {readOnlyExtra}
        </Card>
      </Section>
      <p className="-mt-3 mb-2 px-4 text-footnote text-subtle">{options.advanced.not_here}</p>
    </Disclosure>
  );
}
