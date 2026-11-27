// Create Agent (V3.2.2): a full-screen, keyboard-aware sheet over the Agents list (#/agents/new). Its own lazy chunk:
// nothing of it — not even the options request — loads before the owner opens it. Models load only after a provider
// is chosen. The Idempotency-Key is generated once when the form opens and reused for retries of the same submission,
// so a double tap or a lost connection can never create a second agent.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { newIdempotencyKey } from '../../lib/http';
import type { Agent } from '../../types';
import { composerApi, CREATE_TIMEOUT_MS, OPTIONS_KEY } from '../agentConfig/api';
import {
  createBody,
  describeProblem,
  FIELD_LABEL,
  fieldSlice,
  initialCreateForm,
  isRejection,
  limitsOf,
  validate,
  visibleErrors,
  type AgentForm,
  type FieldKey,
  type FieldProblem,
  type Problem,
} from '../agentConfig/form';
import { AdvancedSection, AiSection, CapabilitiesSection, IdentitySection, SecuritySection, useModels } from '../agentConfig/sections';
import type { AgentComposerSettings, AgentOptions } from '../agentConfig/types';
import { useBackOverlay } from '../backStack';
import { CONVERSATIONS_KEY } from '../chat/keys';
import { ConversationScreen } from '../chunks';
import { useMini } from '../context';
import { invalidateQuery, setQueryData, useQuery } from '../hooks';
import { IcChats, IcRetry } from '../icons';
import { navigate } from '../router';
import { haptic, setClosingConfirmation } from '../telegram';
import { agentStatus, Avatar, Btn, ErrorState, Sheet, Spinner } from '../uiKit';
import { ConfirmSheet, Notice } from '../uiExtra';

export function readyText(s: AgentComposerSettings): string {
  if (!s.ready) return `${s.name} was created but is not ready yet (${agentStatus(s.status).label.toLowerCase()}). Check it in the Agents list in a moment.`;
  return s.status === 'SLEEP' ? `${s.name} is ready and asleep — it wakes when you send a task.` : `${s.name} is ready.`;
}

export function AgentCreatorSheet({ onClose, onCreated }: { onClose: () => void; onCreated?: (s: AgentComposerSettings) => void }) {
  const { client } = useMini();
  const capi = useMemo(() => composerApi(client), [client]);
  const opts = useQuery<AgentOptions>(OPTIONS_KEY, (s) => capi.options(s));
  const options = opts.data;
  const models = useModels((pid, s) => capi.models(pid, s));

  const [form, setForm] = useState<AgentForm | null>(() => (options ? initialCreateForm(options) : null));
  const initial = useRef<string | null>(form ? JSON.stringify(form) : null);
  useEffect(() => {
    if (options && !form) {
      const f = initialCreateForm(options);
      initial.current = JSON.stringify(f);
      setForm(f);
    }
  }, [options, form]);

  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [fieldProblem, setFieldProblem] = useState<FieldProblem | null>(null);
  const [done, setDone] = useState<AgentComposerSettings | null>(null);
  const [dup, setDup] = useState<string | null>(null);
  const [discard, setDiscard] = useState(false);
  const [advanced, setAdvanced] = useState(false);

  // One key per submission: reused for retries (network / unknown outcome), new after a definitive rejection.
  const key = useRef(newIdempotencyKey());
  const rotate = useRef(false);
  const lastAllowDup = useRef(false);
  const busyRef = useRef(false);
  const summary = useRef<HTMLDivElement>(null);
  const openChatBtn = useRef<HTMLButtonElement>(null);

  const dirty = Boolean(form && initial.current !== null && JSON.stringify(form) !== initial.current);
  const update = useCallback((fn: (f: AgentForm) => AgentForm) => setForm((f) => (f ? fn(f) : f)), []);

  const lim = limitsOf(options);
  const currentModels = form?.providerId ? (models.get(form.providerId)?.models ?? null) : null;
  const clientErrors = form && options ? validate(form, lim, currentModels, options.capabilities) : {};
  const errors = form ? visibleErrors(form, clientErrors, attempted, fieldProblem) : {};
  const errorKeys = Object.keys(clientErrors) as FieldKey[];

  // ---- closing: confirm before discarding a dirty form (Cancel, Telegram BackButton, Escape, backdrop)
  const state = useRef<{ busy: boolean; dirty: boolean; done: boolean; confirming: boolean; onClose: () => void }>({ busy, dirty, done: false, confirming: false, onClose });
  state.current = { busy, dirty, done: Boolean(done), confirming: discard || dup !== null, onClose };
  const guardedClose = useCallback(() => {
    const s = state.current;
    if (s.busy || busyRef.current || s.confirming) return;
    if (!s.done && s.dirty) {
      haptic('warning');
      setDiscard(true);
      return;
    }
    s.onClose();
  }, []);
  useBackOverlay(true, guardedClose);
  useBackOverlay(discard, () => setDiscard(false));
  useBackOverlay(dup !== null, () => setDup(null));
  useEffect(() => setClosingConfirmation(dirty && !done), [dirty, done]);
  useEffect(() => () => setClosingConfirmation(false), []);
  useEffect(() => {
    if (!done) return;
    openChatBtn.current?.focus();
    // the next screens are ready before a tap (a loading screen would briefly keep this sheet on top)
    void ConversationScreen.preload();
    void import('./AgentSettingsScreen').catch(() => undefined);
  }, [done]);

  const capabilityLabel = (id: string) => options?.capabilities.find((c) => c.id === id)?.label ?? options?.extra_skills.find((s) => s.id === id)?.name ?? id;

  const submit = async (allowDuplicate = false) => {
    if (!form || !options || busyRef.current) return;
    setAttempted(true);
    if (errorKeys.length) {
      haptic('error');
      setProblem(null);
      setTimeout(() => {
        summary.current?.scrollIntoView?.({ block: 'nearest' });
        summary.current?.focus({ preventScroll: true });
      }, 0);
      return;
    }
    const body = createBody(form);
    if (allowDuplicate) body.allow_duplicate_name = true;
    lastAllowDup.current = allowDuplicate;
    if (rotate.current) {
      key.current = newIdempotencyKey();
      rotate.current = false;
    }
    busyRef.current = true;
    setBusy(true);
    setProblem(null);
    setFieldProblem(null);
    haptic('impact');
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(new DOMException('The request took too long', 'TimeoutError')), CREATE_TIMEOUT_MS);
    try {
      const res = await capi.create(body, key.current, ctl.signal);
      haptic('success');
      setQueryData<Agent[]>('agents', (xs) => (xs ? [...xs.filter((a) => a.id !== res.agent.id), res.agent] : xs));
      invalidateQuery('agents');
      invalidateQuery(CONVERSATIONS_KEY);
      setDone(res);
      onCreated?.(res);
    } catch (e) {
      haptic('error');
      if (isRejection(e)) rotate.current = true;
      const p = describeProblem(e, { name: body.name, creating: true, capabilityLabel });
      if (p.kind === 'duplicate') setDup(body.name);
      else if (p.kind === 'field') {
        setFieldProblem({ field: p.field, message: p.message, at: fieldSlice(form, p.field) });
        if (p.field === 'model' && form.providerId) models.load(form.providerId, true);
        if (p.field === 'provider') opts.reload(); // its connection state changed on the Mac
      } else setProblem(p);
    } finally {
      clearTimeout(timer);
      busyRef.current = false;
      setBusy(false);
    }
  };

  const footer = done ? undefined : options && form ? (
    <div className="w-full">
      {busy && (
        <p role="status" className="mb-2 flex items-center gap-2 px-1 text-footnote text-muted">
          <Spinner className="size-4" />
          <span>Creating the agent's desktop in the VM… This can take up to a minute.</span>
        </p>
      )}
      <div className="flex gap-2">
        <Btn className="flex-1" onClick={guardedClose} disabled={busy}>
          Cancel
        </Btn>
        <Btn className="flex-1" variant="primary" loading={busy} onClick={() => void submit(false)}>
          {busy ? 'Creating…' : 'Create Agent'}
        </Btn>
      </div>
    </div>
  ) : (
    <Btn className="flex-1" onClick={guardedClose}>
      Cancel
    </Btn>
  );

  return (
    <>
      <Sheet
        open
        full
        keyboardAware
        testId="agent-creator"
        title={done ? 'Agent created' : 'Create Agent'}
        description={done ? undefined : 'Configure your new AI assistant.'}
        dismissible={!busy}
        onClose={guardedClose}
        footer={footer}
      >
        {done ? (
          <div className="flex flex-col items-center px-2 pt-8 pb-4 text-center" data-testid="agent-created">
            <Avatar name={done.name} id={done.agent.id} size="lg" avatar={done.avatar} />
            <p className="mt-3 text-title font-semibold text-text">{done.name}</p>
            <p role="status" className="mt-1 max-w-sm text-subhead text-muted">
              {readyText(done)}
            </p>
            <div className="mt-6 grid w-full max-w-sm gap-2">
              <Btn ref={openChatBtn} data-autofocus variant="primary" icon={<IcChats />} onClick={() => navigate(`/agents/${done.agent.id}`, { replace: true })}>
                Open Chat
              </Btn>
              <Btn variant="tinted" onClick={() => navigate(`/agents/${done.agent.id}/settings`, { replace: true })}>
                Agent Settings
              </Btn>
              <Btn variant="ghost" onClick={onClose}>
                Back to Agents
              </Btn>
            </div>
          </div>
        ) : !options || !form ? (
          opts.error ? (
            <div className="pt-4">
              <ErrorState error={opts.error} onRetry={opts.reload} title="Could not load the agent options" />
            </div>
          ) : (
            <div className="grid place-items-center py-16">
              <Spinner label="Loading agent options…" />
            </div>
          )
        ) : (
          <form
            noValidate
            aria-label="New agent"
            className="pt-2"
            onSubmit={(e) => {
              e.preventDefault();
              void submit(false);
            }}
          >
            {attempted && errorKeys.length > 0 && (
              <div ref={summary} tabIndex={-1} role="alert" className="mb-4 outline-none" data-testid="form-summary">
                <Notice tone="danger" title={errorKeys.length === 1 ? 'Check 1 field' : `Check ${errorKeys.length} fields`}>
                  {errorKeys.map((k) => FIELD_LABEL[k]).join(', ')}
                </Notice>
              </div>
            )}
            {problem && <ProblemNotice problem={problem} busy={busy} onRetry={() => void submit(lastAllowDup.current)} />}
            <fieldset disabled={busy} className="min-w-0">
              <IdentitySection form={form} update={update} options={options} errors={errors} />
              <AiSection form={form} update={update} options={options} errors={errors} models={models} mode="create" />
              <CapabilitiesSection form={form} update={update} options={options} errors={errors} />
              <SecuritySection form={form} update={update} options={options} errors={errors} />
              <AdvancedSection form={form} update={update} options={options} errors={errors} mode="create" open={advanced} onToggle={() => setAdvanced((v) => !v)} />
            </fieldset>
          </form>
        )}
      </Sheet>
      <ConfirmSheet open={discard} title="Discard this agent?" confirmLabel="Discard" tone="danger" onCancel={() => setDiscard(false)} onConfirm={() => {
        setDiscard(false);
        onClose();
      }}>
        The settings you entered for the new agent are lost.
      </ConfirmSheet>
      <ConfirmSheet open={dup !== null} title={`An agent named “${dup ?? ''}” already exists`} confirmLabel="Create anyway" onCancel={() => setDup(null)} onConfirm={() => {
        setDup(null);
        void submit(true);
      }}>
        Create anyway? Both agents keep their own chats, memory and desktop.
      </ConfirmSheet>
    </>
  );
}

function ProblemNotice({ problem: p, busy, onRetry }: { problem: Problem; busy: boolean; onRetry: () => void }) {
  if (p.kind === 'network')
    return (
      <div role="alert" className="mb-4" data-testid="create-problem">
        <Notice tone="warning" title="Connection lost">
          <p>{p.message}</p>
          <Btn size="sm" variant="tinted" icon={<IcRetry />} className="mt-2" disabled={busy} onClick={onRetry}>
            Try again
          </Btn>
        </Notice>
      </div>
    );
  if (p.kind === 'provisioning')
    return (
      <div role="alert" className="mb-4" data-testid="create-problem">
        <Notice tone="danger" title="The agent's desktop could not be prepared">
          NEBULA could not prepare the agent's desktop in the VM: {p.message}. The agent was not started; you can remove it on your Mac.
        </Notice>
      </div>
    );
  if (p.kind === 'general')
    return (
      <div role="alert" className="mb-4" data-testid="create-problem">
        <Notice tone="danger" title={p.title}>
          {p.message}
        </Notice>
      </div>
    );
  return null;
}
