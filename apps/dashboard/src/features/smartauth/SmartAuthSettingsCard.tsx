// Password Vault → Settings → Smart sign-in (local only): sign-in assistance on / off, answers from outside this Mac,
// what NEBULA does when a site asks for a passkey or security key, the remote sign-in PIN (set / change with the
// current PIN / remove) and the time-outs and limits. PINs live only in this card's state and are cleared right after
// each request.
import { useEffect, useId, useState, type FormEvent } from 'react';
import { ConfirmDialog } from '../../components/Modal';
import { IconKey } from '../../components/icons';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, ErrorBanner, Field, Input, KeyValue, LoadingRows, Notice, Switch } from '../../components/ui';
import { relativeTime, formatTime } from '../../lib/format';
import { SecretInput } from '../vault/forms';
import { smartAuthApi } from './api';
import { pinProblem, pinStrength } from './core/lib';
import type { PasskeyFallback, SmartAuthPinStatus, SmartAuthSettings, SmartAuthSettingsPatch } from './core/types';

type LimitKey = keyof Omit<
  SmartAuthSettings,
  'enabled' | 'remote_submission' | 'allow_local_network' | 'passkey_fallback' | 'pin' | 'local' | 'observe_interval_s' | 'max_steps' | 'loop_threshold'
>;

/** V3.4: a passkey / security key request (NEBULA's isolated browser has neither). */
export const PASSKEY_FALLBACK: { id: PasskeyFallback; label: string; hint: string }[] = [
  { id: 'password', label: 'Use the site’s password option automatically (recommended)', hint: 'NEBULA picks “use your password” or another way the site offers and asks you for it.' },
  { id: 'ask', label: 'Ask me first', hint: 'NEBULA shows you the other ways the site offers and waits for your choice.' },
];

export const LIMITS: { key: LimitKey; label: string; min: number; max: number; unit?: 's'; hint: string }[] = [
  { key: 'request_ttl_s', label: 'Request time-out', min: 120, max: 1800, unit: 's', hint: 'How long a sign-in request waits for your answer.' },
  { key: 'otp_ttl_s', label: 'Verification code time-out', min: 30, max: 600, unit: 's', hint: 'How long NEBULA may take to use a code after you submit it.' },
  { key: 'token_ttl_s', label: 'Form submission window', min: 30, max: 600, unit: 's', hint: 'How long one prepared submission stays valid.' },
  { key: 'session_max_s', label: 'Maximum sign-in duration', min: 300, max: 3600, unit: 's', hint: 'A sign-in that takes longer is stopped.' },
  { key: 'max_credential_attempts', label: 'Password attempts', min: 1, max: 5, hint: 'Rejected sign-in details before NEBULA gives up.' },
  { key: 'max_otp_attempts', label: 'Code attempts', min: 1, max: 5, hint: 'Rejected verification codes before NEBULA gives up.' },
  { key: 'max_retries', label: 'Automatic retries', min: 0, max: 3, hint: 'Retries when the sign-in page breaks.' },
  { key: 'max_per_agent', label: 'Sign-ins per agent', min: 1, max: 3, hint: 'Parallel sign-ins one agent may run.' },
  { key: 'max_global', label: 'Sign-ins in total', min: 1, max: 10, hint: 'Parallel sign-ins across all agents.' },
];

const human = (s: number) => (s >= 120 && s % 60 === 0 ? `${s / 60} min` : `${s} s`);

function limitProblem(l: (typeof LIMITS)[number], raw: string): string | null {
  if (!/^\d+$/.test(raw.trim())) return 'Enter a whole number';
  const n = Number(raw);
  if (n < l.min || n > l.max) return `Between ${l.min} and ${l.max}`;
  return null;
}

export function SmartAuthSettingsCard() {
  const toast = useToast();
  const [data, setData] = useState<SmartAuthSettings | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = () => {
    setLoadError(null);
    smartAuthApi.settings().then(setData, setLoadError);
  };
  useEffect(load, []);

  const apply = async (patch: SmartAuthSettingsPatch, success: string, key: string) => {
    setBusy(key);
    try {
      const r = await smartAuthApi.updateSettings(patch);
      setData((d) => ({ ...(d as SmartAuthSettings), ...r, local: r.local ?? d?.local ?? true }));
      toast.success(success);
      return true;
    } catch (e) {
      toast.error(e, 'Setting not changed');
      return false;
    } finally {
      setBusy(null);
    }
  };

  if (!data) {
    return (
      <Card title="Smart sign-in" icon={<IconKey />}>
        {loadError ? <ErrorBanner error={loadError} onRetry={load} title="Could not load the Smart sign-in settings" /> : <LoadingRows rows={3} label="Loading Smart sign-in settings…" />}
      </Card>
    );
  }

  const local = data.local;
  return (
    <Card
      title="Smart sign-in"
      icon={<IconKey />}
      subtitle="When an agent’s task reaches a website login, NEBULA opens it in an isolated browser and asks you for the details. The agent and the AI never see what you type."
      actions={
        <Badge tone={data.enabled ? 'success' : 'neutral'} dot>
          {data.enabled ? 'On' : 'Off'}
        </Badge>
      }
    >
      <div className="space-y-5" data-testid="smart-signin-settings">
        {!local && (
          <Notice tone="warn" title="Only on this Mac">
            Smart sign-in settings and the remote sign-in PIN can only be changed in the Dashboard opened on the NEBULA Mac.
          </Notice>
        )}
        <div className="grid gap-4 md:grid-cols-2">
          <Switch
            checked={data.enabled}
            disabled={!local}
            loading={busy === 'enabled'}
            onChange={(v) => void apply({ enabled: v }, v ? 'Sign-in assistance turned on' : 'Sign-in assistance turned off', 'enabled')}
            label="Sign-in assistance"
            description="Agents may ask you to sign in to a website during a task. Off: agents are told that sign-in assistance is unavailable."
          />
          <Switch
            checked={data.remote_submission}
            disabled={!local}
            loading={busy === 'remote'}
            onChange={(v) => void apply({ remote_submission: v }, v ? 'Remote answers allowed' : 'Remote answers turned off', 'remote')}
            label="Allow answers from outside this Mac"
            description="Lets you answer sign-in requests from the Telegram Mini App. Passwords then need the remote sign-in PIN; one-time codes do not."
          />
          <Switch
            checked={Boolean(data.allow_local_network)}
            disabled={!local}
            loading={busy === 'localnet'}
            onChange={(v) => void apply({ allow_local_network: v }, v ? 'Local-network sign-ins allowed' : 'Local-network sign-ins blocked', 'localnet')}
            label="Allow sign-in on IP addresses and local-network names"
            description="Off by default: an agent inside the VM could serve a fake sign-in page on such an address. Turn on only for your own router, NAS or intranet; such requests always need your review."
          />
        </div>
        <PasskeyFallbackField
          value={data.passkey_fallback === 'ask' ? 'ask' : 'password'}
          disabled={!local || busy === 'passkey'}
          onChange={(v) => void apply({ passkey_fallback: v }, v === 'ask' ? 'NEBULA asks you first' : 'NEBULA uses the site’s password option', 'passkey')}
        />
        <PinSection pin={data.pin} local={local} onPin={(pin) => setData((d) => (d ? { ...d, pin } : d))} />
        {local ? (
          <LimitsForm data={data} busy={busy === 'limits'} onSave={(patch) => apply(patch, 'Smart sign-in limits saved', 'limits')} />
        ) : (
          <KeyValue items={LIMITS.map((l) => [l.label, l.unit ? human(data[l.key]) : String(data[l.key])])} />
        )}
      </div>
    </Card>
  );
}

function PasskeyFallbackField({ value, disabled, onChange }: { value: PasskeyFallback; disabled: boolean; onChange: (v: PasskeyFallback) => void }) {
  const id = useId();
  return (
    <fieldset data-testid="passkey-fallback" aria-describedby={`${id}-d`}>
      <legend className="text-[13px] font-medium text-text">When a site asks for a passkey or security key</legend>
      <p id={`${id}-d`} className="mt-0.5 mb-2 text-xs leading-5 text-muted">
        NEBULA’s isolated sign-in browser has no passkey or security key, so it cannot finish that step itself.
      </p>
      <div className="grid gap-2 md:grid-cols-2">
        {PASSKEY_FALLBACK.map((o) => {
          const on = value === o.id;
          return (
            <label
              key={o.id}
              className={`flex items-start gap-3 rounded-xl border p-3 transition-colors ${disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'} ${on ? 'border-accent/60 bg-accent/[0.06]' : 'border-border hover:border-border-strong'}`}
            >
              <input
                type="radio"
                name={`${id}-passkey`}
                value={o.id}
                checked={on}
                disabled={disabled}
                onChange={() => onChange(o.id)}
                aria-describedby={`${id}-${o.id}`}
                className="mt-1 size-4 shrink-0 accent-accent"
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-text">{o.label}</span>
                <span id={`${id}-${o.id}`} className="mt-0.5 block text-xs leading-5 text-muted">
                  {o.hint}
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

function PinStrength({ pin }: { pin: string }) {
  const problem = pinProblem(pin);
  const s = pinStrength(pin);
  return (
    <p className={`text-xs ${problem ? 'text-warn' : 'text-muted'}`} role="status" data-testid="pin-strength">
      {problem ?? `Strength: ${s.label}`}
    </p>
  );
}

function PinSection({ pin, local, onPin }: { pin: SmartAuthPinStatus; local: boolean; onPin: (p: SmartAuthPinStatus) => void }) {
  const toast = useToast();
  const ids = { cur: useId(), n1: useId(), n2: useId() };
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [removing, setRemoving] = useState(false);
  const change = pin.configured;
  const invalid = !local
    ? 'Only on this Mac'
    : change && !current
      ? 'Enter the current PIN'
      : pinProblem(next) ?? (next !== repeat ? 'The PINs do not match' : null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (invalid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await smartAuthApi.setPin(next, change ? current : undefined);
      onPin(r);
      toast.success(change ? 'Remote sign-in PIN changed' : 'Remote sign-in PIN set', 'Use it to enter passwords from the Mini App.');
    } catch (err) {
      setError(err);
    } finally {
      setCurrent('');
      setNext('');
      setRepeat('');
      setBusy(false);
    }
  };

  const locked = pin.locked_until && pin.locked_until * 1000 > Date.now();
  return (
    <section className="space-y-3 rounded-xl border border-border bg-panel-2/60 px-3.5 py-3" aria-labelledby={`${ids.cur}-h`} data-testid="pin-section">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={`${ids.cur}-h`} className="text-sm font-semibold text-text">
          Remote sign-in PIN
        </h3>
        {pin.configured ? (
          <Badge tone={locked ? 'danger' : 'success'} dot>
            {locked ? `Locked until ${formatTime(pin.locked_until)}` : `Set ${pin.set_at ? relativeTime(pin.set_at) : ''}`.trim()}
          </Badge>
        ) : (
          <Badge tone="neutral">Not set</Badge>
        )}
      </div>
      <p className="text-xs leading-5 text-muted">
        Needed to enter passwords, use saved accounts without a grant, save to the vault or enter recovery codes from outside this Mac. 6–64 characters; avoid
        repetitive or sequential PINs. It is stored only as a hash on this Mac.
      </p>
      {local && (
        <form onSubmit={submit} className="grid max-w-xl gap-3" aria-label={change ? 'Change the remote sign-in PIN' : 'Set the remote sign-in PIN'}>
          {change && (
            <Field htmlFor={ids.cur} label="Current PIN">
              <SecretInput id={ids.cur} toggleLabel="current PIN" value={current} onChange={(e) => setCurrent(e.target.value)} maxLength={64} />
            </Field>
          )}
          <Field htmlFor={ids.n1} label={change ? 'New PIN' : 'PIN'}>
            <SecretInput id={ids.n1} toggleLabel={change ? 'new PIN' : 'PIN'} value={next} onChange={(e) => setNext(e.target.value)} maxLength={64} />
          </Field>
          {next && <PinStrength pin={next} />}
          <Field htmlFor={ids.n2} label={change ? 'Repeat the new PIN' : 'Repeat the PIN'} error={repeat && repeat !== next ? 'The PINs do not match' : null}>
            <SecretInput id={ids.n2} toggleLabel="repeated PIN" value={repeat} onChange={(e) => setRepeat(e.target.value)} maxLength={64} />
          </Field>
          {error ? <ErrorBanner error={error} title={change ? 'PIN not changed' : 'PIN not set'} /> : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="primary" loading={busy} disabledReason={busy ? null : invalid}>
              {change ? 'Change PIN' : 'Set PIN'}
            </Button>
            {change && (
              <Button variant="danger" onClick={() => setRemoving(true)} disabled={busy}>
                Remove PIN
              </Button>
            )}
          </div>
        </form>
      )}
      <ConfirmDialog
        open={removing}
        title="Remove the remote sign-in PIN?"
        confirmLabel="Remove PIN"
        onCancel={() => setRemoving(false)}
        onConfirm={async () => {
          try {
            onPin(await smartAuthApi.clearPin());
            toast.success('Remote sign-in PIN removed', 'Passwords can no longer be entered from outside this Mac until you set a new PIN.');
            setRemoving(false);
          } catch (e) {
            toast.error(e, 'PIN not removed');
          }
        }}
      >
        <p>Without a PIN, passwords and saved accounts without a grant can only be used from the Dashboard on this Mac. One-time codes still work remotely.</p>
      </ConfirmDialog>
    </section>
  );
}

function LimitsForm({ data, busy, onSave }: { data: SmartAuthSettings; busy: boolean; onSave: (patch: SmartAuthSettingsPatch) => Promise<boolean> }) {
  const idBase = useId();
  const initial = () => Object.fromEntries(LIMITS.map((l) => [l.key, String(data[l.key])])) as Record<LimitKey, string>;
  const [form, setForm] = useState<Record<LimitKey, string>>(initial);
  // a save elsewhere (or the response) updates the baseline
  const sig = LIMITS.map((l) => data[l.key]).join(',');
  useEffect(() => setForm(initial()), [sig]); // eslint-disable-line react-hooks/exhaustive-deps
  const problems = Object.fromEntries(LIMITS.map((l) => [l.key, limitProblem(l, form[l.key])])) as Record<LimitKey, string | null>;
  const changed = LIMITS.filter((l) => !problems[l.key] && Number(form[l.key]) !== data[l.key]);
  const invalid = LIMITS.some((l) => problems[l.key]) ? 'Fix the highlighted values' : changed.length === 0 ? 'Nothing changed' : null;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (invalid) return;
    void onSave(Object.fromEntries(changed.map((l) => [l.key, Number(form[l.key])])) as SmartAuthSettingsPatch);
  };
  return (
    <form onSubmit={submit} aria-label="Smart sign-in limits" className="space-y-3">
      <h3 className="text-sm font-semibold text-text">Time-outs and limits</h3>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {LIMITS.map((l) => {
          const id = `${idBase}-${l.key}`;
          return (
            <Field key={l.key} htmlFor={id} label={l.unit ? `${l.label} (seconds)` : l.label} hint={`${l.hint} ${l.min}–${l.max}${l.unit ? ' s' : ''}.`} error={problems[l.key]}>
              <Input
                id={id}
                type="number"
                inputMode="numeric"
                min={l.min}
                max={l.max}
                step={1}
                value={form[l.key]}
                aria-invalid={problems[l.key] ? true : undefined}
                onChange={(e) => setForm((f) => ({ ...f, [l.key]: e.target.value }))}
              />
            </Field>
          );
        })}
      </div>
      <Button type="submit" loading={busy} disabledReason={busy ? null : invalid}>
        Save limits
      </Button>
    </form>
  );
}
