import { useId, useRef, useState, type FormEvent } from 'react';
import { ApiError, api, newIdempotencyKey } from '../api';
import { PermissionLevelField, ProviderModelFields, RESOLUTIONS, ResourceModeField } from '../components/AgentFields';
import { useToast } from '../components/Toast';
import { IconAgents, IconMonitor, IconProviders } from '../components/icons';
import { Button, Card, ErrorBanner, Field, Input, LoadingRows, Notice, PageHeader, Select, Textarea } from '../components/ui';
import { useApi, useNow } from '../hooks/useApi';
import { href, navigate } from '../hooks/useHashRoute';
import { formatDuration } from '../lib/format';
import type { CreateAgentBody, PermissionLevel, ResourceMode } from '../types';

const NAME_RE = /^[\p{L}\p{N}_ .\-()]{1,64}$/u;
const TASK_TYPES = ['general', 'browser', 'research', 'coding', 'office'];

/** `?first=1` (from the first-run checklist) pre-fills a friendly name; every other default is already the safe one. */
export function CreateAgentPage({ query }: { query?: URLSearchParams } = {}) {
  const toast = useToast();
  const ids = { name: useId(), desc: useId(), res: useId(), type: useId(), list: useId() };
  const providers = useApi(() => api.providers.list(), []);
  const settings = useApi(() => api.settings.get(), []);

  const [name, setName] = useState(() => (query?.get('first') === '1' ? 'Assistant' : ''));
  const [description, setDescription] = useState('');
  const [providerId, setProviderId] = useState('');
  const [modelId, setModelId] = useState('');
  const [fallbackId, setFallbackId] = useState('');
  const [fallbackModelId, setFallbackModelId] = useState('');
  const [resolution, setResolution] = useState('1280x800');
  const [level, setLevel] = useState<PermissionLevel>('STANDARD');
  const [mode, setMode] = useState<ResourceMode>('ACTIVE');
  const [taskType, setTaskType] = useState('general');
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const idemKey = useRef<string>(newIdempotencyKey());
  const now = useNow(1000);

  const nameError = !name.trim() ? 'Required' : !NAME_RE.test(name.trim()) ? '1–64 letters, digits, spaces, . - _ ( )' : null;
  const modelError = providerId && !modelId ? 'Choose a model for the selected provider' : null;
  const creating = startedAt !== null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (nameError || modelError || creating) return;
    const body: CreateAgentBody = {
      name: name.trim(),
      description: description.trim(),
      provider_id: providerId || null,
      model_id: modelId || null,
      desktop_resolution: resolution,
      permission_level: level,
      resource_mode: mode,
      task_type: taskType.trim() || 'general',
      fallback_provider_id: fallbackId || null,
      fallback_model_id: fallbackModelId || null,
    };
    setError(null);
    setStartedAt(Date.now());
    try {
      const agent = await api.agents.create(body, idemKey.current);
      toast.success(`Agent ${agent.name} is ready`, `Linux user ${agent.linux_user ?? ''} on display ${agent.display_id ?? ''}`);
      navigate(`/agents/${agent.id}`);
    } catch (err) {
      setError(err);
      toast.error(err, 'Agent creation failed');
      // a failed attempt must not be replayed from the idempotency cache on the next submit
      idemKey.current = newIdempotencyKey();
    } finally {
      setStartedAt(null);
    }
  };

  const failedAgentId = error instanceof ApiError && typeof error.details.agent_id === 'string' ? error.details.agent_id : null;

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Agents', href: href('/agents') }, { label: 'New agent' }]}
        title="Create Agent"
        description="A new agent gets its own Linux account, XFCE desktop and visible browser inside the shared Ubuntu VM."
      />
      <form onSubmit={submit} noValidate className="space-y-5">
        <Card title="Identity" icon={<IconAgents />}>
          <div className="grid gap-4 md:grid-cols-2">
            <Field htmlFor={ids.name} label="Name" required error={touched ? nameError : null}>
              <Input id={ids.name} value={name} onChange={(e) => setName(e.target.value)} maxLength={64} placeholder="e.g. Researcher" disabled={creating} />
            </Field>
            <Field htmlFor={ids.type} label="Task type" hint="A label to organise agents (default: general).">
              <Input id={ids.type} list={ids.list} value={taskType} maxLength={64} onChange={(e) => setTaskType(e.target.value)} disabled={creating} />
              <datalist id={ids.list}>
                {TASK_TYPES.map((t) => (
                  <option key={t} value={t} />
                ))}
              </datalist>
            </Field>
            <div className="md:col-span-2">
              <Field htmlFor={ids.desc} label="Description">
                <Textarea id={ids.desc} rows={2} maxLength={1000} value={description} onChange={(e) => setDescription(e.target.value)} disabled={creating} />
              </Field>
            </div>
          </div>
        </Card>

        <Card title="AI model" icon={<IconProviders />}>
          {providers.error && !providers.data ? (
            <ErrorBanner error={providers.error} onRetry={providers.reload} title="Could not load providers" />
          ) : !providers.data ? (
            <LoadingRows rows={2} label="Loading providers…" />
          ) : (
            <>
              <ProviderModelFields
                providers={providers.data}
                providerId={providerId}
                modelId={modelId}
                fallbackId={fallbackId}
                fallbackModelId={fallbackModelId}
                onChange={(v) => {
                  if (v.providerId !== undefined) setProviderId(v.providerId);
                  if (v.modelId !== undefined) setModelId(v.modelId);
                  if (v.fallbackId !== undefined) setFallbackId(v.fallbackId);
                  if (v.fallbackModelId !== undefined) setFallbackModelId(v.fallbackModelId);
                }}
              />
              {touched && modelError && <p className="mt-2 text-xs text-danger" role="alert">{modelError}</p>}
              {!providerId && (
                <p className="mt-3 text-xs text-muted">
                  Without a provider and model the agent can be created, but it cannot run tasks until you set them in its Settings.{' '}
                  <a className="text-accent-soft underline" href={href('/providers')}>Connect a provider</a>
                </p>
              )}
            </>
          )}
        </Card>

        <Card title="Desktop & permissions" icon={<IconMonitor />}>
          <div className="space-y-5">
            <div className="grid gap-4 md:grid-cols-2">
              <Field htmlFor={ids.res} label="Desktop resolution">
                <Select id={ids.res} value={resolution} onChange={(e) => setResolution(e.target.value)} disabled={creating}>
                  {RESOLUTIONS.map((r) => (
                    <option key={r} value={r}>
                      {r.replace('x', ' × ')}
                      {r === '1280x800' ? ' (default)' : ''}
                    </option>
                  ))}
                </Select>
              </Field>
              <ResourceModeField value={mode} onChange={setMode} />
            </div>
            <PermissionLevelField value={level} onChange={setLevel} catalog={settings.data?.permission_levels} />
            <Notice tone="info" title="Telegram topic mapping is automatic">
              When Telegram is paired, NEBULA creates a topic named after this agent in each approved chat (or falls back to <code>/use</code> where topics are
              not available). You can review mappings on the Telegram page.
            </Notice>
          </div>
        </Card>

        {error ? (
          <div className="space-y-2">
            <ErrorBanner error={error} title="The agent was not created" />
            {failedAgentId && (
              <p className="text-sm text-muted">
                A record was left in ERROR state:{' '}
                <a className="text-accent-soft underline" href={href(`/agents/${failedAgentId}`)}>open it</a> to inspect or delete it.
              </p>
            )}
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-4">
          <Button type="submit" variant="primary" size="lg" loading={creating}>
            {creating ? 'Creating…' : 'Create agent'}
          </Button>
          {creating && startedAt !== null && (
            <p className="text-sm text-muted" role="status" aria-live="polite">
              Provisioning Linux user, desktop and browser… elapsed {formatDuration((now - startedAt) / 1000)}. This usually takes up to a minute; the
              request returns only after the guest confirms a working desktop.
            </p>
          )}
        </div>
      </form>
    </>
  );
}
