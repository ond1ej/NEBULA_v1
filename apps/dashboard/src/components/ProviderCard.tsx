import { useEffect, useId, useState, type FormEvent } from 'react';
import { api } from '../api';
import { useAction } from '../hooks/useApi';
import { formatNumber, formatTime } from '../lib/format';
import { isConnected, providerLabel } from '../lib/providers';
import type { ModelInfo, Provider, ProviderTestResult } from '../types';
import { ConfirmDialog } from './Modal';
import { StatusPill } from './StatusPill';
import { Button, Card, Field, Input, KeyValue, Mono, Notice } from './ui';

export const API_KEY_PROVIDERS = new Set(['openai-api', 'anthropic-api', 'gemini-api']);
export const CLI_PROVIDERS = new Set(['claude-code-cli', 'codex-cli', 'google-antigravity']);

export { isConnected, providerLabel };

function billingMode(p: Provider, test: ProviderTestResult | null): string {
  if (test?.billing) return test.billing;
  switch (p.auth_mode) {
    case 'api_key':
      if (p.id === 'openai-compatible') {
        const note = typeof p.config.billing_note === 'string' ? p.config.billing_note : '';
        return note ? `Declared by you: ${note}` : 'Not declared yet';
      }
      return 'API billing (per token, charged by the provider)';
    case 'subscription':
      return 'ChatGPT plan usage (consumes your plan limits)';
    case 'local':
      return 'Local (no token billing; uses this Mac’s RAM/CPU)';
    case 'cli':
      return 'Per the vendor’s own CLI terms';
    default:
      return p.auth_mode;
  }
}

function ApiKeyForm({ provider, onDone }: { provider: Provider; onDone: (r: ProviderTestResult) => void }) {
  const id = useId();
  const [key, setKey] = useState('');
  const { run, isPending } = useAction();
  const label = provider.id === 'anthropic-api' ? 'Claude API Key' : 'API key';
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await run('connect', () => api.providers.connect(provider.id, { api_key: key.trim() }), {
      success: (res) => `${providerLabel(provider)}: ${res.state}`,
      errorTitle: 'Connect failed',
    });
    if (r) {
      setKey('');
      onDone(r);
    }
  };
  return (
    <form onSubmit={submit} className="space-y-3" aria-label={`Connect ${providerLabel(provider)}`}>
      <Field
        htmlFor={id}
        label={label}
        hint="Stored in the macOS Keychain on this Mac; only a reference is kept in the database. NEBULA never asks for your account password."
      >
        <Input
          id={id}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={provider.has_credentials ? 'Replace the stored key…' : 'Paste your API key'}
        />
      </Field>
      <Button type="submit" variant="primary" loading={isPending('connect')} disabledReason={key.trim() ? null : 'Enter an API key first'}>
        {provider.has_credentials ? 'Save key & test' : 'Connect'}
      </Button>
    </form>
  );
}

function CompatibleForm({ provider, onDone }: { provider: Provider; onDone: (r: ProviderTestResult) => void }) {
  const base = useId();
  const keyId = useId();
  const noteId = useId();
  const [baseUrl, setBaseUrl] = useState(typeof provider.config.base_url === 'string' ? provider.config.base_url : '');
  const [key, setKey] = useState('');
  const [note, setNote] = useState(typeof provider.config.billing_note === 'string' ? provider.config.billing_note : '');
  const { run, isPending } = useAction();
  const missing = !baseUrl.trim() ? 'Enter the endpoint base URL' : !note.trim() ? 'Declare the billing mode of this endpoint' : null;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await run(
      'connect',
      () => api.providers.connect(provider.id, { base_url: baseUrl.trim(), api_key: key.trim(), billing_note: note.trim() }),
      { success: (res) => `Endpoint saved: ${res.state}`, errorTitle: 'Connect failed' },
    );
    if (r) {
      setKey('');
      onDone(r);
    }
  };
  return (
    <form onSubmit={submit} className="space-y-3" aria-label="Connect OpenAI-compatible endpoint">
      <Field htmlFor={base} label="Base URL" required hint="Only https:// endpoints or a localhost address are accepted (certificates are verified).">
        <Input id={base} type="url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.example.com/v1" />
      </Field>
      <Field htmlFor={keyId} label="API key" hint="Optional for local endpoints. Stored in the macOS Keychain.">
        <Input id={keyId} type="password" autoComplete="off" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)} />
      </Field>
      <Field htmlFor={noteId} label="Billing mode" required hint="Required: who bills this endpoint and how (e.g. “self-hosted, free” or “Together AI, per token”).">
        <Input id={noteId} value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <Button type="submit" variant="primary" loading={isPending('connect')} disabledReason={missing}>
        Save & test
      </Button>
    </form>
  );
}

function OllamaPanel({ provider, onDone }: { provider: Provider; onDone: (r: ProviderTestResult) => void }) {
  const id = useId();
  const configured = typeof provider.config.base_url === 'string' ? provider.config.base_url : '';
  const [baseUrl, setBaseUrl] = useState(configured);
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const { run, isPending } = useAction();

  const testConn = async () => {
    const changed = baseUrl.trim() && baseUrl.trim() !== configured;
    const r = await run(
      'test',
      () => (changed ? api.providers.connect(provider.id, { base_url: baseUrl.trim() }) : api.providers.test(provider.id)),
      { success: (res) => `Ollama: ${res.state}`, errorTitle: 'Ollama test failed' },
    );
    if (r) onDone(r);
  };
  const listModels = async () => {
    setModelsError(null);
    const r = await run('models', () => api.providers.models(provider.id), { errorTitle: 'Could not list Ollama models' });
    if (r) setModels(r);
    else setModelsError('Model list unavailable (see notification).');
  };

  return (
    <div className="space-y-3">
      <Field htmlFor={id} label="Ollama URL" hint="Leave empty to use the configured default (http://127.0.0.1:11434).">
        <Input id={id} type="url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://127.0.0.1:11434" />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" onClick={testConn} loading={isPending('test')}>
          Test connection
        </Button>
        <Button onClick={listModels} loading={isPending('models')}>
          List installed models
        </Button>
      </div>
      {models && (
        <div>
          <p className="mb-1 text-xs font-semibold tracking-wide text-subtle uppercase">Installed models ({models.length})</p>
          {models.length === 0 ? (
            <p className="text-sm text-muted">No models installed. Run <Mono>ollama pull &lt;model&gt;</Mono> on this Mac.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {models.map((m) => (
                <li key={m.id} className="flex flex-wrap items-center gap-2">
                  <span className="text-text">{m.display_name}</span>
                  {m.supports_tools && <StatusPill state={null} tone="info" label="tools" />}
                  {m.supports_images && <StatusPill state={null} tone="info" label="vision" />}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {modelsError && <p className="text-sm text-danger">{modelsError}</p>}
      <Notice tone="warn" title="RAM warning">
        Local models run on this Mac and compete with the Ubuntu VM for memory. A 7B model needs about 5 GB of RAM; on a 16 GB Mac
        prefer small models and watch memory pressure on the System page. NEBULA never switches an agent to a cloud provider without your consent.
      </Notice>
    </div>
  );
}

function SiwcPanel({ provider }: { provider: Provider }) {
  const { run, isPending } = useAction();
  const [link, setLink] = useState<string | null>(null);
  const start = async () => {
    // Open the window synchronously (inside the click) so popup blockers allow it, then navigate it.
    const w = window.open('', '_blank');
    const r = await run('siwc', () => api.providers.connectSiwc(), { errorTitle: 'Could not start Sign in with ChatGPT' });
    if (!r) {
      w?.close();
      return;
    }
    setLink(r.authorize_url);
    if (w) {
      w.opener = null;
      w.location.href = r.authorize_url;
    }
  };
  const remote = !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(window.location.hostname);
  return (
    <div className="space-y-3">
      <Button
        variant="primary"
        onClick={start}
        loading={isPending('siwc')}
        disabledReason={remote ? 'Start Sign in with ChatGPT on the Mac mini itself (OpenAI only allows a 127.0.0.1 callback).' : null}
      >
        {provider.state === 'Re-auth Required' ? 'Continue with ChatGPT (sign in again)' : 'Continue with ChatGPT'}
      </Button>
      {remote && (
        <p className="text-xs text-warn">
          You are using NEBULA over the local network. Sign in with ChatGPT on the Mac mini at http://127.0.0.1:{window.location.port || '3101'}/ —
          the connection is then available from every device.
        </p>
      )}
      <p className="text-xs text-muted">
        Opens OpenAI’s official sign-in page in a new window. After you approve, it returns to this dashboard. Requests made with this
        connection consume your ChatGPT plan’s usage limits.
      </p>
      {link && (
        <p className="text-xs text-muted">
          No window opened?{' '}
          <a className="text-accent-soft underline" href={link} target="_blank" rel="noopener noreferrer">
            Open the ChatGPT sign-in page
          </a>
          . The link expires in 10 minutes.
        </p>
      )}
    </div>
  );
}

function CliPanel({ provider, test, onDone }: { provider: Provider; test: ProviderTestResult | null; onDone: (r: ProviderTestResult) => void }) {
  const { run, isPending } = useAction();
  const detect = async () => {
    const r = await run('detect', () => api.providers.test(provider.id), { errorTitle: 'Detection failed' });
    if (r) onDone(r);
  };
  const acc = (test?.account ?? {}) as { installed?: boolean; path?: string | null; version?: string | null };
  const reason = test?.detail ?? provider.last_error;
  return (
    <div className="space-y-3">
      <Button onClick={detect} loading={isPending('detect')}>
        Run detection
      </Button>
      {test && (
        <KeyValue
          items={[
            ['Installed', acc.installed ? 'Yes' : 'No'],
            ['Path', acc.path ? <Mono>{acc.path}</Mono> : '—'],
            ['Version', acc.version ?? '—'],
          ]}
        />
      )}
      {reason ? (
        <Notice tone="info" title="Unsupported on this version">
          {reason}
        </Notice>
      ) : (
        <p className="text-sm text-muted">Run detection to see whether the official CLI is installed and why this mode is not available yet.</p>
      )}
      {provider.id === 'claude-code-cli' && (
        <p className="text-xs text-muted">
          This mode would run the unmodified, official Claude Code CLI that you sign in to yourself. NEBULA never offers a Claude.ai subscription login
          and never asks for a Claude password. Usage limits and terms of the CLI apply.
        </p>
      )}
    </div>
  );
}

function CapForm({ provider, onSaved }: { provider: Provider; onSaved: () => void }) {
  const id = useId();
  const [cap, setCap] = useState(provider.daily_token_cap ? String(provider.daily_token_cap) : '');
  useEffect(() => setCap(provider.daily_token_cap ? String(provider.daily_token_cap) : ''), [provider.daily_token_cap]);
  const { run, isPending } = useAction();
  const n = Number(cap);
  const invalid = cap.trim() !== '' && (!Number.isInteger(n) || n < 1000) ? 'Enter a whole number of at least 1000 tokens' : null;
  const save = async (value: number | null) => {
    const r = await run('cap', () => api.providers.setLimit(provider.id, value), {
      success: value ? `Daily cap set to ${formatNumber(value)} tokens` : 'Daily cap removed',
      errorTitle: 'Could not save the daily cap',
    });
    if (r) onSaved();
  };
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void save(cap.trim() ? n : null);
      }}
    >
      <div className="w-48">
        <Field htmlFor={id} label="Daily token cap" error={invalid}>
          <Input id={id} type="number" min={1000} step={1000} inputMode="numeric" value={cap} onChange={(e) => setCap(e.target.value)} placeholder="No cap" />
        </Field>
      </div>
      <Button type="submit" size="sm" loading={isPending('cap')} disabledReason={invalid}>
        Save cap
      </Button>
      {provider.daily_token_cap != null && (
        <Button size="sm" variant="ghost" onClick={() => void save(null)} disabled={isPending('cap')}>
          Remove cap
        </Button>
      )}
    </form>
  );
}

export function ProviderCard({ provider, onChanged }: { provider: Provider; onChanged: () => void }) {
  const [test, setTest] = useState<ProviderTestResult | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const { run, isPending } = useAction();
  const connected = isConnected(provider.state);
  const cli = CLI_PROVIDERS.has(provider.id);
  const label = providerLabel(provider);
  const u = provider.usage_today ?? { input_tokens: 0, output_tokens: 0, requests: 0 };

  const done = (r: ProviderTestResult) => {
    setTest(r);
    onChanged();
  };

  const runTest = async () => {
    const r = await run('test', () => api.providers.test(provider.id), { success: (res) => `${label}: ${res.state}`, errorTitle: 'Test failed' });
    if (r) done(r);
  };

  const canDisconnect = !cli && (connected || provider.has_credentials || provider.state === 'Quota Reached' || provider.state === 'Re-auth Required');

  return (
    <Card
      title={
        <span className="flex flex-wrap items-center gap-2">
          {label}
          <StatusPill state={provider.state} />
        </span>
      }
      subtitle={<Mono>{provider.id}</Mono>}
      actions={
        !cli && provider.id !== 'ollama-local' ? (
          <>
            <Button
              size="sm"
              onClick={runTest}
              loading={isPending('test')}
              disabledReason={provider.id === 'openai-compatible' && !provider.config.base_url ? 'Save the endpoint first' : null}
            >
              Test
            </Button>
            {canDisconnect && (
              <Button size="sm" variant="danger" onClick={() => setConfirmDisconnect(true)}>
                Disconnect
              </Button>
            )}
          </>
        ) : provider.id === 'ollama-local' && canDisconnect ? (
          <Button size="sm" variant="danger" onClick={() => setConfirmDisconnect(true)}>
            Disconnect
          </Button>
        ) : undefined
      }
    >
      <div className="space-y-4" data-testid={`provider-${provider.id}`}>
        <KeyValue
          items={[
            ['Billing mode', billingMode(provider, test)],
            [
              'Usage today',
              cli
                ? '—'
                : `${formatNumber(u.input_tokens)} in · ${formatNumber(u.output_tokens)} out · ${formatNumber(u.requests)} requests${
                    provider.daily_token_cap ? ` (cap ${formatNumber(provider.daily_token_cap)})` : ''
                  }`,
            ],
            ['Last check', provider.last_checked_at ? formatTime(provider.last_checked_at) : 'Never'],
            ...(provider.capabilities?.length ? ([['Capabilities', provider.capabilities.join(', ')]] as [string, string][]) : []),
          ]}
        />

        {provider.state === 'Quota Reached' && (
          <Notice tone="warn" title="Quota reached">
            {provider.last_error ?? 'The provider or your NEBULA daily cap stopped further requests.'} Tasks wait in WAITING_PROVIDER instead of retrying endlessly.
          </Notice>
        )}
        {provider.state === 'Re-auth Required' && (
          <Notice tone="danger" title="Re-authentication required">
            {provider.last_error ?? 'The stored credential was rejected.'} Reconnect below.
          </Notice>
        )}
        {provider.state === 'Error' && provider.last_error && (
          <Notice tone="danger" title="Error">
            {provider.last_error}
          </Notice>
        )}
        {!cli && !test && provider.last_error && !['Quota Reached', 'Re-auth Required', 'Error'].includes(provider.state) && (
          <p className="text-xs text-muted">Last check: {provider.last_error}</p>
        )}

        {test && !cli && (
          <div className="rounded-md border border-border bg-bg/60 p-3 text-sm" aria-live="polite">
            <p className="mb-1 flex flex-wrap items-center gap-2 text-text">
              Test result <StatusPill state={test.state} />
            </p>
            {test.detail && <p className="text-muted">{test.detail}</p>}
            {test.plan && typeof test.plan.note === 'string' && <p className="mt-1 text-xs text-subtle">{test.plan.note}</p>}
            {test.account && Object.keys(test.account).length > 0 && (
              <p className="mt-1 text-xs text-subtle">
                Account: {Object.entries(test.account).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(' · ')}
              </p>
            )}
          </div>
        )}

        {provider.id === 'openai-siwc' && <SiwcPanel provider={provider} />}
        {API_KEY_PROVIDERS.has(provider.id) && <ApiKeyForm provider={provider} onDone={done} />}
        {provider.id === 'openai-compatible' && <CompatibleForm provider={provider} onDone={done} />}
        {provider.id === 'ollama-local' && <OllamaPanel provider={provider} onDone={done} />}
        {cli && <CliPanel provider={provider} test={test} onDone={done} />}

        {!cli && <CapForm provider={provider} onSaved={onChanged} />}
      </div>

      <ConfirmDialog
        open={confirmDisconnect}
        title={`Disconnect ${label}?`}
        confirmLabel="Disconnect"
        onCancel={() => setConfirmDisconnect(false)}
        onConfirm={async () => {
          const r = await run('disconnect', () => api.providers.disconnect(provider.id), {
            success: `${label} disconnected`,
            errorTitle: 'Disconnect failed',
          });
          if (r) {
            setConfirmDisconnect(false);
            setTest(null);
            onChanged();
          }
        }}
      >
        <p>
          The stored credential is removed from the Keychain{provider.id === 'openai-siwc' ? ' and the OpenAI session is revoked' : ''}. Agents using
          this provider cannot start new model calls until you connect it again.
        </p>
      </ConfirmDialog>
    </Card>
  );
}
