import { useEffect, useId, useState, type FormEvent } from 'react';
import { api } from '../api';
import { useToast } from '../components/Toast';
import { IconChevronRight, IconDevices, IconLock, IconLogout, IconSettings, IconShield, IconUser, IconVault } from '../components/icons';
import { Avatar, Button, ButtonLink, Card, Checkbox, ErrorBanner, Field, Input, LoadingRows, Notice, PageHeader, Select, TextLink } from '../components/ui';
import { getRouteBase, href } from '../hooks/useHashRoute';
import { useAction, useApi } from '../hooks/useApi';
import type { SettingsPatch } from '../types';
import { MIN_PASSWORD } from './passwordPolicy';
import { LanAccessCard } from '../components/LanAccess';
import { getLocale, LOCALES, setLocale, t, type Locale } from '../i18n';

function ChangePassword({ onSignedOut }: { onSignedOut: () => void }) {
  const toast = useToast();
  const ids = { cur: useId(), n1: useId(), n2: useId() };
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const { run, isPending } = useAction();
  const invalid = !current
    ? 'Enter your current password'
    : next.length < MIN_PASSWORD
      ? `New password needs at least ${MIN_PASSWORD} characters`
      : next !== confirm
        ? 'New passwords do not match'
        : null;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (invalid) return;
    const r = await run('pw', () => api.auth.changePassword(current, next), { errorTitle: 'Password not changed' });
    if (r) {
      toast.success('Password changed', 'All sessions were signed out. Sign in with the new password.');
      onSignedOut();
    }
  };
  return (
    <Card title="Change password" icon={<IconLock />} subtitle="Changing the password signs out every session, including this one.">
      <form onSubmit={submit} className="grid max-w-xl gap-4">
        <Field htmlFor={ids.cur} label="Current password">
          <Input id={ids.cur} type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </Field>
        <Field htmlFor={ids.n1} label="New password" hint={`At least ${MIN_PASSWORD} characters.`} error={next && next.length < MIN_PASSWORD ? `At least ${MIN_PASSWORD} characters` : null}>
          <Input id={ids.n1} type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
        </Field>
        <Field htmlFor={ids.n2} label="Confirm new password" error={confirm && confirm !== next ? 'Passwords do not match' : null}>
          <Input id={ids.n2} type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </Field>
        <div>
          <Button type="submit" variant="primary" loading={isPending('pw')} disabledReason={invalid}>
            Change password
          </Button>
        </div>
      </form>
    </Card>
  );
}

function AgentDefaults() {
  const settings = useApi(() => api.settings.get(), []);
  const ids = { limit: useId(), ret: useId(), policy: useId(), steps: useId() };
  const { run, isPending } = useAction();
  const cfg = settings.data?.config.agents;
  const [approval, setApproval] = useState(true);
  const [limit, setLimit] = useState('2');
  const [retention, setRetention] = useState('7');
  const [policy, setPolicy] = useState<'queue_when_full' | 'sleep_lru'>('queue_when_full');
  const [steps, setSteps] = useState('30');

  useEffect(() => {
    if (!cfg) return;
    setApproval(cfg.require_approval_for_sensitive_actions);
    setLimit(String(cfg.default_active_limit));
    setRetention(String(cfg.screenshot_retention_days));
    setPolicy(cfg.resource_policy === 'sleep_lru' ? 'sleep_lru' : 'queue_when_full');
    setSteps(String(cfg.max_steps_per_task));
  }, [cfg]);

  const n = { limit: Number(limit), ret: Number(retention), steps: Number(steps) };
  const errors = {
    limit: !Number.isInteger(n.limit) || n.limit < 1 || n.limit > 8 ? '1–8' : null,
    ret: !Number.isInteger(n.ret) || n.ret < 0 || n.ret > 365 ? '0–365 days' : null,
    steps: !Number.isInteger(n.steps) || n.steps < 1 || n.steps > 500 ? '1–500' : null,
  };
  const invalid = errors.limit || errors.ret || errors.steps ? 'Fix the highlighted values' : null;

  const patch: SettingsPatch = {};
  if (cfg) {
    if (approval !== cfg.require_approval_for_sensitive_actions) patch.require_approval_for_sensitive_actions = approval;
    if (n.limit !== cfg.default_active_limit) patch.default_active_limit = n.limit;
    if (n.ret !== cfg.screenshot_retention_days) patch.screenshot_retention_days = n.ret;
    if (policy !== cfg.resource_policy) patch.resource_policy = policy;
    if (n.steps !== cfg.max_steps_per_task) patch.max_steps_per_task = n.steps;
  }
  const dirty = Object.keys(patch).length > 0;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!dirty || invalid) return;
    const r = await run('save', () => api.settings.patch(patch), { success: 'Settings saved to config.yaml' });
    if (r) settings.reload();
  };

  return (
    <>
      <Card title="Approvals & limits" icon={<IconShield />} subtitle="Saved to the host configuration (config.yaml) and applied immediately.">
        {settings.error && !settings.data ? (
          <ErrorBanner error={settings.error} onRetry={settings.reload} />
        ) : !cfg ? (
          <LoadingRows rows={4} label="Loading settings…" />
        ) : (
          <form onSubmit={save} className="space-y-5">
            <Checkbox
              label="Require approval for sensitive actions"
              description="Payments, sending messages, deleting data, installing software, signing in to other accounts… pause the task until you approve or deny."
              checked={approval}
              onChange={setApproval}
            />
            {!approval && (
              <Notice tone="warn">With approvals off, agents perform sensitive actions without asking. Keep this on unless you fully trust the agents’ tasks.</Notice>
            )}
            <div className="grid gap-4 md:grid-cols-2">
              <Field htmlFor={ids.limit} label="Active desktop limit" hint="Agents with a running GUI desktop at the same time (1–8). 2 is the default on a 16 GB Mac." error={errors.limit}>
                <Input id={ids.limit} type="number" min={1} max={8} value={limit} onChange={(e) => setLimit(e.target.value)} />
              </Field>
              <Field htmlFor={ids.policy} label="When the limit is reached">
                <Select id={ids.policy} value={policy} onChange={(e) => setPolicy(e.target.value as 'queue_when_full' | 'sleep_lru')}>
                  <option value="queue_when_full">Queue new tasks until a desktop is free</option>
                  <option value="sleep_lru">Put the least recently used agent to sleep</option>
                </Select>
              </Field>
              <Field htmlFor={ids.steps} label="Max steps per task" hint="Default step budget for new tasks (1–500)." error={errors.steps}>
                <Input id={ids.steps} type="number" min={1} max={500} value={steps} onChange={(e) => setSteps(e.target.value)} />
              </Field>
              <Field htmlFor={ids.ret} label="Screenshot retention (days)" hint="Task screenshots older than this are deleted hourly. 0 keeps them forever." error={errors.ret}>
                <Input id={ids.ret} type="number" min={0} max={365} value={retention} onChange={(e) => setRetention(e.target.value)} />
              </Field>
            </div>
            <Button type="submit" variant="primary" loading={isPending('save')} disabledReason={!dirty ? 'No changes' : invalid}>
              Save settings
            </Button>
          </form>
        )}
      </Card>
      {settings.data && (
        <Card title="Current configuration" icon={<IconSettings />} subtitle="Read-only view of the host configuration (no secrets are stored here).">
          <details className="group">
            <summary className="inline-flex items-center gap-1.5 rounded text-sm text-muted hover:text-text focus-ring">
              <IconChevronRight className="size-4 transition-transform group-open:rotate-90" />
              Show configuration
            </summary>
            <div className="mt-4 grid gap-4 lg:grid-cols-2">
              {Object.entries(settings.data.config).map(([section, values]) => (
                <div key={section} className="min-w-0">
                  <h3 className="mb-1.5 text-2xs font-semibold tracking-wider text-subtle uppercase">{section}</h3>
                  <pre className="max-h-72 overflow-auto rounded-lg border border-border bg-input p-3 font-mono text-2xs text-muted">{JSON.stringify(values, null, 2)}</pre>
                </div>
              ))}
              <div className="min-w-0">
                <h3 className="mb-1.5 text-2xs font-semibold tracking-wider text-subtle uppercase">Permission levels</h3>
                <pre className="max-h-72 overflow-auto rounded-lg border border-border bg-input p-3 font-mono text-2xs text-muted">{JSON.stringify(settings.data.permission_levels, null, 2)}</pre>
              </div>
            </div>
          </details>
        </Card>
      )}
    </>
  );
}

/** Interface language (English by default; Czech is an optional translation). Applies after a reload. */
function LanguageCard() {
  const id = useId();
  const [locale, setChoice] = useState<Locale>(getLocale());
  return (
    <Card title={t('lang.title')} subtitle={t('lang.subtitle')}>
      <div className="max-w-xs">
        <Field label={t('lang.label')} htmlFor={id} hint={t('lang.note')}>
          <Select
            id={id}
            value={locale}
            onChange={(e) => {
              const next = e.target.value as Locale;
              setChoice(next);
              setLocale(next);
              window.location.reload();
            }}
          >
            {LOCALES.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>
    </Card>
  );
}

/** Licence of NEBULA and the notices of the third-party code in the Dashboard bundle (noVNC is MPL-2.0). */
export function AboutCard() {
  // the Mini App's gateway serves only the app bundle, not /licenses
  const inMiniApp = getRouteBase() !== '';
  return (
    <Card title="About NEBULA" subtitle="Open source, MIT licensed.">
      <p className="text-sm text-muted">
        NEBULA is released under the MIT License. The Live Desktop view uses noVNC (MPL-2.0, unmodified); its license and the notices of the other bundled libraries are in{' '}
        {inMiniApp ? (
          'Third-party licenses (open the Dashboard on your Mac to read them)'
        ) : (
          <TextLink href="/licenses/THIRD_PARTY_NOTICES.txt" target="_blank" rel="noopener noreferrer">
            Third-party licenses
          </TextLink>
        )}
        .
      </p>
    </Card>
  );
}

export function SettingsPage({ username, onLogout, onSignedOut, loggingOut }: { username: string | null; onLogout: () => void; onSignedOut: () => void; loggingOut: boolean }) {
  return (
    <>
      <PageHeader title="Settings & Security" description="LAN access, local administrator, Password Vault, approval defaults, resource limits and data retention." />
      <div className="space-y-5">
        <Card
          title="Session"
          icon={<IconUser />}
          actions={
            <Button size="sm" icon={<IconLogout />} onClick={onLogout} loading={loggingOut}>
              Log out
            </Button>
          }
        >
          <div className="flex items-center gap-3">
            <Avatar name={username ?? '?'} />
            <p className="text-sm text-muted">
              Signed in as <strong className="text-text">{username ?? '—'}</strong>. The session cookie is HttpOnly and bound to this browser; every change is protected by a CSRF token.
            </p>
          </div>
        </Card>
        <LanAccessCard />
        <Card
          title="Password Vault"
          icon={<IconVault />}
          subtitle="Encrypted credentials agents can sign in with — they never see a password."
          actions={
            <ButtonLink size="sm" href={href('/vault')}>
              Open Password Vault
            </ButtonLink>
          }
        >
          <p className="text-sm text-muted">
            Set up or unlock the vault, manage credentials and agent grants, change the auto-lock and vault passphrase, or export an encrypted backup. Which credentials an agent may
            use is set in the agent’s <strong className="text-text">Security</strong> tab.
          </p>
        </Card>
        <Card
          title={t('settings.devices.title')}
          icon={<IconDevices />}
          subtitle={t('settings.devices.subtitle')}
          actions={
            <ButtonLink size="sm" href={href('/devices')}>
              {t('settings.devices.action')}
            </ButtonLink>
          }
        >
          <p className="text-sm text-muted">{t('settings.devices.body')}</p>
        </Card>
        <ChangePassword onSignedOut={onSignedOut} />
        <AgentDefaults />
        <LanguageCard />
        <AboutCard />
      </div>
    </>
  );
}
