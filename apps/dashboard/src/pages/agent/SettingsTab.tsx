import { useId, useState, type FormEvent } from 'react';
import { api } from '../../api';
import { PermissionLevelField, ProviderModelFields, ResourceModeField } from '../../components/AgentFields';
import { ConfirmDialog } from '../../components/Modal';
import { StatusPill } from '../../components/StatusPill';
import { IconAgents, IconMonitor, IconProviders, IconShield, IconTrash } from '../../components/icons';
import { Button, Card, ErrorBanner, Field, Input, KeyValue, LoadingRows, Mono, Textarea } from '../../components/ui';
import { useAction, useApi } from '../../hooks/useApi';
import { navigate } from '../../hooks/useHashRoute';
import { formatBytes, formatTime } from '../../lib/format';
import type { AgentDetail, AgentPatch } from '../../types';
import { DeleteAgentDialog } from '../AgentsPage';
import { MiniSettingsCard } from './MiniSettingsCard';

export function SettingsTab({ agent, onChanged }: { agent: AgentDetail; onChanged: () => void }) {
  const ids = { name: useId(), desc: useId(), type: useId() };
  const providers = useApi(() => api.providers.list(), []);
  const { run, isPending } = useAction();
  const [name, setName] = useState(agent.name);
  const [description, setDescription] = useState(agent.description);
  const [taskType, setTaskType] = useState(agent.task_type);
  const [providerId, setProviderId] = useState(agent.provider_id ?? '');
  const [modelId, setModelId] = useState(agent.model_id ?? '');
  const [fallbackId, setFallbackId] = useState(agent.fallback_provider_id ?? '');
  const [fallbackModelId, setFallbackModelId] = useState(agent.fallback_model_id ?? '');
  const [level, setLevel] = useState(agent.permission_level);
  const [mode, setMode] = useState(agent.resource_mode);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [exported, setExported] = useState<{ path: string; size_bytes: number } | null>(null);

  const patch: AgentPatch = {};
  if (name.trim() !== agent.name) patch.name = name.trim();
  if (description !== agent.description) patch.description = description;
  if (taskType.trim() !== agent.task_type) patch.task_type = taskType.trim() || 'general';
  if ((providerId || null) !== agent.provider_id) patch.provider_id = providerId || null;
  if ((modelId || null) !== agent.model_id) patch.model_id = modelId || null;
  if ((fallbackId || null) !== agent.fallback_provider_id) patch.fallback_provider_id = fallbackId || null;
  if ((fallbackModelId || null) !== (agent.fallback_model_id ?? null)) patch.fallback_model_id = fallbackModelId || null;
  if (level !== agent.permission_level) patch.permission_level = level;
  if (mode !== agent.resource_mode) patch.resource_mode = mode;
  const dirty = Object.keys(patch).length > 0;
  const invalid = !name.trim() ? 'Name is required' : providerId && !modelId ? 'Choose a model for the selected provider' : null;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!dirty || invalid) return;
    const r = await run('save', () => api.agents.patch(agent.id, patch), { success: 'Agent settings saved' });
    if (r) onChanged();
  };

  const reset = () => {
    setName(agent.name);
    setDescription(agent.description);
    setTaskType(agent.task_type);
    setProviderId(agent.provider_id ?? '');
    setModelId(agent.model_id ?? '');
    setFallbackId(agent.fallback_provider_id ?? '');
    setFallbackModelId(agent.fallback_model_id ?? '');
    setLevel(agent.permission_level);
    setMode(agent.resource_mode);
  };

  return (
    <div className="space-y-5">
      <form onSubmit={save} className="space-y-5">
        <Card title="General" icon={<IconAgents />}>
          <div className="grid gap-4 md:grid-cols-2">
            <Field htmlFor={ids.name} label="Name" required>
              <Input id={ids.name} value={name} maxLength={64} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field htmlFor={ids.type} label="Task type">
              <Input id={ids.type} value={taskType} maxLength={64} onChange={(e) => setTaskType(e.target.value)} />
            </Field>
            <div className="md:col-span-2">
              <Field htmlFor={ids.desc} label="Description">
                <Textarea id={ids.desc} rows={2} maxLength={1000} value={description} onChange={(e) => setDescription(e.target.value)} />
              </Field>
            </div>
          </div>
        </Card>
        <Card title="AI model" icon={<IconProviders />}>
          {providers.error && !providers.data ? (
            <ErrorBanner error={providers.error} onRetry={providers.reload} />
          ) : !providers.data ? (
            <LoadingRows rows={2} label="Loading providers…" />
          ) : (
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
          )}
        </Card>
        <Card title="Permissions & resources" icon={<IconShield />}>
          <div className="space-y-5">
            <PermissionLevelField value={level} onChange={setLevel} catalog={agent.permission_catalog} />
            <div className="max-w-sm">
              <ResourceModeField value={mode} onChange={setMode} />
            </div>
            <p className="text-xs text-subtle">The desktop resolution ({agent.desktop_resolution}) is fixed at creation.</p>
          </div>
        </Card>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="primary" loading={isPending('save')} disabledReason={!dirty ? 'No changes' : invalid}>
            Save changes
          </Button>
          <Button onClick={reset} disabled={!dirty}>
            Discard changes
          </Button>
        </div>
      </form>

      <MiniSettingsCard agentId={agent.id} name={agent.name} onChanged={onChanged} />

      <Card title="Desktop & workspace" icon={<IconMonitor />}>
        <div className="space-y-4">
          <KeyValue
            items={[
              ['Linux user', <Mono>{agent.linux_user ?? '—'}</Mono>],
              ['Display', <Mono>{agent.display_id ?? '—'}</Mono>],
              ['Resolution', agent.desktop_resolution],
              ['Permissions', agent.permissions.length ? agent.permissions.join(', ') : '—'],
              ['Telegram', agent.telegram_mapping ? `${agent.telegram_mapping}${agent.telegram_topic_id ? ` (thread ${agent.telegram_topic_id})` : ''}` : 'Not mapped'],
              ['Control held by user', agent.control_held_by_user ? <StatusPill state={null} tone="warn" label="Yes" /> : 'No'],
              ['Created', formatTime(agent.created_at)],
            ]}
          />
          {agent.desktop_health != null && (
            <details>
              <summary className="inline-flex rounded text-xs text-muted hover:text-text focus-ring">Desktop health (last report)</summary>
              <pre className="mt-1.5 max-h-48 overflow-auto rounded-lg border border-border bg-input p-2.5 font-mono text-2xs text-muted">{JSON.stringify(agent.desktop_health, null, 2)}</pre>
            </details>
          )}
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => setConfirmRestart(true)} disabledReason={agent.state === 'SLEEP' ? 'Wake the agent first' : null}>
              Restart desktop
            </Button>
            <Button
              loading={isPending('export')}
              onClick={async () => {
                const r = await run('export', () => api.agents.exportWorkspace(agent.id), {
                  success: (res) => `Workspace exported (${formatBytes(res.size_bytes)})`,
                  errorTitle: 'Export failed',
                });
                if (r) setExported(r);
              }}
            >
              Export workspace
            </Button>
            <Button variant="danger" icon={<IconTrash />} onClick={() => setDeleting(true)}>
              Delete agent
            </Button>
          </div>
          {isPending('export') && <p className="text-sm text-muted" role="status">Packing the workspace inside the VM and copying it to this Mac…</p>}
          {exported && (
            <p className="text-sm text-muted">
              Saved to <Mono>{exported.path}</Mono> ({formatBytes(exported.size_bytes)}).
            </p>
          )}
        </div>
      </Card>

      {agent.tools?.length > 0 && (
        <Card title="Tools available by level">
          <ul className="grid gap-1 text-sm sm:grid-cols-2 lg:grid-cols-3">
            {agent.tools.map((t) => (
              <li key={t.name} className="flex items-center justify-between gap-2 rounded-lg border border-border px-2.5 py-1.5">
                <Mono className="text-text">{t.name}</Mono>
                <span className="text-[10px] text-subtle">{t.min_level}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <ConfirmDialog
        open={confirmRestart}
        title="Restart the agent desktop?"
        confirmLabel="Restart desktop"
        busyText="Restarting…"
        onCancel={() => setConfirmRestart(false)}
        onConfirm={async () => {
          const r = await run('restart', () => api.agents.restartDesktop(agent.id), { success: 'Desktop session restarted' });
          if (r) {
            setConfirmRestart(false);
            onChanged();
          }
        }}
      >
        <p>Only this agent’s XFCE session and browser are restarted; open windows and unsaved GUI state are lost. Other agents are not affected.</p>
      </ConfirmDialog>
      <DeleteAgentDialog
        agent={deleting ? agent : null}
        onClose={() => setDeleting(false)}
        onDeleted={() => {
          setDeleting(false);
          navigate('/agents');
        }}
      />
    </div>
  );
}
