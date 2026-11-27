import { useEffect, useId, useState } from 'react';
import { api } from '../api';
import type { ModelInfo, Provider } from '../types';
import { isConnected, providerLabel } from '../lib/providers';
import { useToast } from './Toast';
import { Button, Field, Input, Select } from './ui';

export const RESOLUTIONS = ['1024x768', '1280x720', '1280x800', '1440x900', '1920x1080'];

export const PERMISSION_LEVELS: { id: 'READ_ONLY' | 'STANDARD' | 'ADVANCED'; label: string; text: string }[] = [
  {
    id: 'READ_ONLY',
    label: 'Read only',
    text: 'Can look at web pages and read files in its own workspace. Cannot click, type, write files or run commands.',
  },
  {
    id: 'STANDARD',
    label: 'Standard',
    text: 'Uses its browser and desktop (click, type, scroll) and reads/writes files in its own workspace. No terminal.',
  },
  {
    id: 'ADVANCED',
    label: 'Advanced',
    text: 'Everything in Standard plus a restricted shell under its own Linux account (never root). Sensitive actions still ask for approval when enabled.',
  },
];

export const RESOURCE_MODES: { id: 'ACTIVE' | 'IDLE' | 'SLEEP'; text: string }[] = [
  { id: 'ACTIVE', text: 'Desktop running and ready for tasks.' },
  { id: 'IDLE', text: 'Desktop may keep running, but no new work is expected.' },
  { id: 'SLEEP', text: 'Desktop and browser are stopped after creation; files and state are kept. Wake it before use.' },
];

export function PermissionLevelField({
  value,
  onChange,
  catalog,
}: {
  value: string;
  onChange: (v: 'READ_ONLY' | 'STANDARD' | 'ADVANCED') => void;
  catalog?: Record<string, string[]> | null;
}) {
  const name = useId();
  return (
    <fieldset>
      <legend className="mb-2 text-[13px] font-medium text-text">Permission level</legend>
      <div className="grid gap-2 md:grid-cols-3">
        {PERMISSION_LEVELS.map((l) => (
          <label
            key={l.id}
            className={`flex cursor-pointer flex-col gap-1.5 rounded-xl border p-3.5 transition-colors focus-within:ring-2 focus-within:ring-accent/40 ${
              value === l.id ? 'border-accent/60 bg-accent/[0.08]' : 'border-border bg-input hover:border-border-hover'
            }`}
          >
            <span className="flex items-center gap-2">
              <input
                type="radio"
                name={name}
                value={l.id}
                checked={value === l.id}
                onChange={() => onChange(l.id)}
                className="accent-accent"
              />
              <span className="text-sm font-medium text-text">{l.label}</span>
              <span className="font-mono text-[10px] text-subtle">{l.id}</span>
            </span>
            <span className="text-xs text-muted">{l.text}</span>
            {catalog?.[l.id] && <span className="font-mono text-[10px] text-subtle">{catalog[l.id].join(', ')}</span>}
          </label>
        ))}
      </div>
      <p className="mt-2 text-xs text-subtle">HOST_CONTROL (access to the Mac itself) requires the separate Host Agent and is disabled in this version.</p>
    </fieldset>
  );
}

export function ResourceModeField({ value, onChange }: { value: string; onChange: (v: 'ACTIVE' | 'IDLE' | 'SLEEP') => void }) {
  const id = useId();
  const mode = RESOURCE_MODES.find((m) => m.id === value);
  return (
    <Field htmlFor={id} label="Resource mode" hint={mode?.text}>
      <Select id={id} value={value} onChange={(e) => onChange(e.target.value as 'ACTIVE' | 'IDLE' | 'SLEEP')}>
        {RESOURCE_MODES.map((m) => (
          <option key={m.id} value={m.id}>
            {m.id}
          </option>
        ))}
      </Select>
    </Field>
  );
}

/** Provider (connected only) + model (from /providers/{id}/models) + optional fallback provider. */
export function ProviderModelFields({
  providers,
  providerId,
  modelId,
  fallbackId,
  fallbackModelId = '',
  onChange,
}: {
  providers: Provider[];
  providerId: string;
  modelId: string;
  fallbackId: string;
  fallbackModelId?: string;
  onChange: (v: { providerId?: string; modelId?: string; fallbackId?: string; fallbackModelId?: string }) => void;
}) {
  const pid = useId();
  const mid = useId();
  const fid = useId();
  const fmid = useId();
  const connected = providers.filter((p) => isConnected(p.state));
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const toast = useToast();

  useEffect(() => {
    if (!providerId) {
      setModels(null);
      setModelsError(null);
      return;
    }
    let cancelled = false;
    setLoadingModels(true);
    setModelsError(null);
    api.providers
      .models(providerId)
      .then((m) => {
        if (!cancelled) setModels(m);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setModels(null);
          setModelsError(e instanceof Error ? e.message : String(e));
          toast.error(e, 'Could not load models');
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingModels(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerId, attempt]);

  // keep a stored model that the provider no longer lists visible instead of silently dropping it
  const modelOptions = models ?? [];
  const unknownStored = modelId && !modelOptions.some((m) => m.id === modelId);

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Field
        htmlFor={pid}
        label="AI provider"
        hint={connected.length === 0 ? 'No provider is connected yet — connect one on the AI Providers page.' : 'Only connected providers are listed.'}
      >
        <Select id={pid} value={providerId} onChange={(e) => onChange({ providerId: e.target.value, modelId: '' })}>
          <option value="">None (choose later)</option>
          {connected.map((p) => (
            <option key={p.id} value={p.id}>
              {providerLabel(p)} — {p.state}
            </option>
          ))}
          {providerId && !connected.some((p) => p.id === providerId) && (
            <option value={providerId}>{providerId} (not connected)</option>
          )}
        </Select>
      </Field>
      <Field
        htmlFor={mid}
        label="Model"
        error={modelsError ? `Could not load models: ${modelsError}` : null}
        hint={!providerId ? 'Choose a provider first.' : loadingModels ? 'Loading models…' : models && models.length === 0 ? 'This provider lists no models.' : undefined}
      >
        <div className="flex gap-2">
          <Select
            id={mid}
            value={modelId}
            disabled={!providerId || loadingModels}
            onChange={(e) => onChange({ modelId: e.target.value })}
          >
            <option value="">{providerId ? 'Select a model' : '—'}</option>
            {modelOptions.map((m) => (
              <option key={m.id} value={m.id}>
                {m.display_name}
                {m.supports_images ? ' · vision' : ''}
                {m.supports_tools ? '' : ' · no tools'}
              </option>
            ))}
            {unknownStored && <option value={modelId}>{modelId} (current)</option>}
          </Select>
          {modelsError && (
            <Button size="md" onClick={() => setAttempt((x) => x + 1)}>
              Retry
            </Button>
          )}
        </div>
      </Field>
      <Field htmlFor={fid} label="Fallback provider (optional)" hint="Stored as this agent’s approved fallback preference; never used without it.">
        <Select id={fid} value={fallbackId} onChange={(e) => onChange({ fallbackId: e.target.value, fallbackModelId: '' })}>
          <option value="">No fallback</option>
          {connected
            .filter((p) => p.id !== providerId)
            .map((p) => (
              <option key={p.id} value={p.id}>
                {providerLabel(p)}
              </option>
            ))}
          {fallbackId && !connected.some((p) => p.id === fallbackId) && <option value={fallbackId}>{fallbackId} (not connected)</option>}
        </Select>
      </Field>
      <Field
        htmlFor={fmid}
        label="Fallback model"
        hint={fallbackId ? 'Model id at the fallback provider (required for the fallback to be used).' : 'Choose a fallback provider first.'}
      >
        <Input
          id={fmid}
          value={fallbackModelId}
          disabled={!fallbackId}
          placeholder={fallbackId ? 'e.g. a model listed on the AI Providers page' : '—'}
          onChange={(e) => onChange({ fallbackModelId: e.target.value })}
        />
      </Field>
    </div>
  );
}
