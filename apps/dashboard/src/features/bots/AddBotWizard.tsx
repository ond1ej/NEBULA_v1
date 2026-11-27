// "Add agent bot" wizard: BotFather guide -> agent + token (validated & bound by the host) -> metadata result -> pairing code.
// The token lives only in this component's input state until the POST; it is cleared right after the request and on close.
import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { errorMessage } from '../../api';
import { IconCheck, IconCheckCircle, IconExternal, IconKey, IconXCircle } from '../../components/icons';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { Button, Checkbox, EmptyState, Field, Input, Kbd, Notice, Select } from '../../components/ui';
import type { Agent } from '../../types';
import { botsApi, TOKEN_RE, type AddedBot, type BotMetadataResult, type BotPairing } from './api';
import { PairingCode } from './parts';

const STEPS = ['Create in @BotFather', 'Bind to an agent', 'Pair your Telegram'] as const;

function StepList({ step }: { step: number }) {
  return (
    <ol className="mb-5 grid grid-cols-3 gap-2" aria-label="Wizard progress">
      {STEPS.map((label, i) => {
        const n = i + 1;
        const done = n < step;
        const on = n === step;
        return (
          <li key={label} aria-current={on ? 'step' : undefined} className="min-w-0">
            <div className={`h-1 rounded-full ${done || on ? 'bg-accent' : 'bg-panel-3'}`} />
            <p className={`mt-1.5 flex items-center gap-1 truncate text-2xs font-medium ${on ? 'text-text' : done ? 'text-muted' : 'text-subtle'}`}>
              {done ? <IconCheck className="size-3 shrink-0 text-success" /> : <span className="tabular-nums">{n}.</span>}
              <span className="truncate">{label}</span>
            </p>
          </li>
        );
      })}
    </ol>
  );
}

function GuideStep({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span aria-hidden className="grid size-6 shrink-0 place-items-center rounded-full border border-border-strong bg-panel-2 text-xs font-semibold text-muted">
        {n}
      </span>
      <div className="min-w-0 pb-1">
        <p className="text-sm font-medium text-text">{title}</p>
        <div className="mt-0.5 text-sm leading-relaxed text-muted">{children}</div>
      </div>
    </li>
  );
}

const META_LABEL: Record<string, string> = {
  commands: 'Command menu (/help, /status, /pause …)',
  description: 'Description',
  short_description: 'Short description (profile)',
  menu_button: 'Menu button → Mini App',
  avatar: 'Profile photo',
};

export function MetadataResults({ meta }: { meta: BotMetadataResult }) {
  const keys = Object.keys(meta).sort((a, b) => (a === 'avatar' ? 1 : b === 'avatar' ? -1 : a.localeCompare(b)));
  if (keys.length === 0) return <p className="text-sm text-muted">Metadata was not configured (you unchecked it). You can re-apply it from the bot card.</p>;
  return (
    <ul className="divide-y divide-border/60 rounded-xl border border-border bg-panel-2/40" aria-label="Bot metadata results">
      {keys.map((k) => {
        const v = meta[k];
        const okish = v === 'ok' || v === 'Mini App';
        const manual = k === 'avatar';
        const failed = !okish && !manual && /^(failed|skipped)/i.test(v);
        return (
          <li key={k} className="flex items-start gap-2.5 px-3 py-2.5 text-sm">
            {okish ? (
              <IconCheckCircle className="mt-0.5 size-4 shrink-0 text-success" />
            ) : manual ? (
              <IconKey className="mt-0.5 size-4 shrink-0 text-warn" />
            ) : (
              <IconXCircle className={`mt-0.5 size-4 shrink-0 ${failed ? 'text-danger' : 'text-muted'}`} />
            )}
            <div className="min-w-0">
              <p className="text-text">{META_LABEL[k] ?? k}</p>
              <p className={`text-xs break-words ${failed ? 'text-danger' : manual ? 'text-warn' : 'text-muted'}`}>{okish ? 'Configured' : manual ? `Manual step: ${v}` : v}</p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function AddBotWizard({
  open,
  onClose,
  agents,
  boundAgentIds,
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  agents: Agent[] | null;
  boundAgentIds: Set<string>;
  onAdded: (bot: AddedBot) => void;
}) {
  const toast = useToast();
  const ids = { agent: useId(), token: useId() };
  const [step, setStep] = useState(1);
  const [agentId, setAgentId] = useState('');
  const [token, setToken] = useState('');
  const [configure, setConfigure] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<AddedBot | null>(null);
  const [pairing, setPairing] = useState<BotPairing | null>(null);
  const [pairBusy, setPairBusy] = useState(false);

  const free = (agents ?? []).filter((a) => !boundAgentIds.has(a.id) && a.state !== 'DELETING');
  const tokenTrim = token.trim();
  const tokenLooksOk = TOKEN_RE.test(tokenTrim);

  const reset = () => {
    setStep(1);
    setAgentId('');
    setToken('');
    setConfigure(true);
    setError(null);
    setAdded(null);
    setPairing(null);
  };

  const close = () => {
    if (busy) return;
    reset();
    onClose();
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !agentId || !tokenLooksOk) return;
    setBusy(true);
    setError(null);
    const secret = tokenTrim;
    // Clear the field before awaiting: the token is never shown again in this UI, success or not.
    setToken('');
    try {
      const bot = await botsApi.add(agentId, secret, configure);
      setAdded(bot);
      setStep(3);
      onAdded(bot);
      toast.success(`@${bot.username ?? 'bot'} is now bound to ${bot.agent_name ?? 'the agent'}`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const createPairing = async () => {
    if (!added) return;
    setPairBusy(true);
    try {
      setPairing(await botsApi.pairing(added.id));
    } catch (e) {
      toast.error(e, 'Could not create a pairing code');
    } finally {
      setPairBusy(false);
    }
  };

  const footer =
    step === 1 ? (
      <>
        <Button onClick={close}>Cancel</Button>
        <Button variant="primary" onClick={() => setStep(2)} data-autofocus>
          I have the token
        </Button>
      </>
    ) : step === 2 ? (
      <>
        <Button onClick={() => setStep(1)} disabled={busy}>
          Back
        </Button>
        <Button
          variant="primary"
          type="submit"
          form="add-bot-form"
          loading={busy}
          disabledReason={!agentId ? 'Choose an agent' : !tokenTrim ? 'Paste the token from @BotFather' : !tokenLooksOk ? 'The token format looks wrong' : null}
        >
          Validate &amp; bind
        </Button>
      </>
    ) : (
      <Button variant="primary" onClick={close}>
        Done
      </Button>
    );

  return (
    <Modal open={open} onClose={close} dismissible={!busy} size="lg" title="Add an agent bot" description="Give one agent its own Telegram identity. Messages to that bot reach only that agent." footer={footer}>
      <StepList step={step} />

      {step === 1 && (
        <div className="space-y-4">
          <ol className="space-y-3.5">
            <GuideStep n={1} title="Open @BotFather in Telegram">
              <a className="inline-flex items-center gap-1 rounded text-accent-soft underline-offset-2 hover:underline focus-ring" href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer">
                t.me/BotFather
                <IconExternal className="size-3.5" />
              </a>{' '}
              is Telegram&apos;s official bot for creating bots.
            </GuideStep>
            <GuideStep n={2} title="Send /newbot">
              Choose a display name (e.g. <em>Researcher</em>) and a unique username ending in <Kbd>bot</Kbd> (e.g. <em>my_researcher_bot</em>).
            </GuideStep>
            <GuideStep n={3} title="Copy the token">
              BotFather replies with an HTTP API token like <code className="font-mono text-xs text-text">123456789:AA…</code>. Treat it like a password: anyone with it controls the bot.
            </GuideStep>
            <GuideStep n={4} title="Optional: profile photo">
              The Bot API cannot set avatars. In BotFather send <Kbd>/setuserpic</Kbd>, pick the bot and send an image.
            </GuideStep>
          </ol>
          <Notice tone="info">
            NEBULA validates the token with Telegram (<code className="font-mono text-xs">getMe</code>), refuses the main bot&apos;s token or a bot already bound to another agent, and stores it in
            the macOS Keychain. It is never displayed again.
          </Notice>
        </div>
      )}

      {step === 2 &&
        (agents && free.length === 0 ? (
          <EmptyState compact title="Every agent already has a bot">
            Remove a binding first, or create a new agent.
          </EmptyState>
        ) : (
          <form id="add-bot-form" className="space-y-4" onSubmit={submit} autoComplete="off">
            <Field label="Agent" htmlFor={ids.agent} required hint="Only agents without a bot are listed. One bot per agent.">
              <Select id={ids.agent} value={agentId} onChange={(e) => setAgentId(e.target.value)} disabled={busy || !agents} data-autofocus>
                <option value="">{agents ? 'Choose an agent…' : 'Loading agents…'}</option>
                {free.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                    {a.state && a.state !== 'READY' && a.state !== 'ACTIVE' ? ` (${a.state})` : ''}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="Bot token"
              htmlFor={ids.token}
              required
              error={tokenTrim && !tokenLooksOk ? 'Expected the format 123456789:AA… (digits, a colon, then 30–64 letters, digits, - or _).' : undefined}
              hint="Sent once over this local connection, then stored in the Keychain. It is never shown again."
            >
              <Input
                id={ids.token}
                type="password"
                name="nebula-agent-bot-token"
                autoComplete="off"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                data-1p-ignore
                data-lpignore="true"
                value={token}
                maxLength={128}
                onChange={(e) => setToken(e.target.value)}
                disabled={busy}
                placeholder="123456789:AA…"
                aria-invalid={Boolean(tokenTrim && !tokenLooksOk)}
                className="font-mono"
              />
            </Field>
            <Checkbox
              checked={configure}
              onChange={setConfigure}
              disabled={busy}
              label="Configure bot metadata"
              description="Sets the command menu, description and short description from the agent (and the Mini App menu button when remote access is set up)."
            />
            {error && (
              <div role="alert" className="rounded-xl border border-danger/30 bg-danger/[0.07] px-4 py-3 text-sm">
                <p className="font-semibold text-danger">The bot was not added</p>
                <p className="mt-0.5 break-words text-text">{error}</p>
                <p className="mt-1 text-xs text-muted">For security the token field was cleared — paste it again to retry.</p>
              </div>
            )}
          </form>
        ))}

      {step === 3 && added && (
        <div className="space-y-4">
          <Notice tone="success" title={`@${added.username ?? 'bot'} is bound to ${added.agent_name ?? 'the agent'}`}>
            The token was accepted by Telegram and stored in the Keychain. The bot {added.polling ? 'is polling now' : 'starts polling in a moment'}.
          </Notice>
          <div>
            <p className="mb-2 text-sm font-medium text-text">Metadata</p>
            <MetadataResults meta={added.metadata ?? {}} />
            <p className="mt-2 text-xs text-muted">
              The avatar must be set in @BotFather (<Kbd>/setuserpic</Kbd>) — Telegram does not allow bots to change their own profile photo.
            </p>
          </div>
          <div>
            <p className="mb-2 text-sm font-medium text-text">Pair your Telegram account with this bot</p>
            {pairing ? (
              <PairingCode pairing={pairing} botUsername={added.username} onNew={createPairing} busy={pairBusy} />
            ) : (
              <Button variant="primary" onClick={createPairing} loading={pairBusy} icon={<IconKey />}>
                Create pairing code
              </Button>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
