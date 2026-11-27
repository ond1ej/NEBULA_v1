// "Instructions & Mini App settings" (V3.2.2): the agent's own system instructions, its avatar and Smart sign-in
// (vault access none / ask), edited through the same validated endpoint the Telegram Mini App uses
// (PATCH /miniapp/agents/{id}/settings — local Dashboard sessions are always allowed). Only changed fields are sent.
import { useEffect, useId, useState } from 'react';
import { api } from '../../api';
import { AVATAR_ICON_IDS } from '../../components/avatarGlyphs';
import { IconSettings } from '../../components/icons';
import { Avatar, Button, Card, ErrorBanner, Field, Input, LoadingRows, Select, Textarea } from '../../components/ui';
import { useAction, useApi } from '../../hooks/useApi';
import type { AgentAvatar, AgentAvatarKind, AgentComposerPatch, AgentComposerSettings, VaultAccess } from '../../types';

const MAX_INSTRUCTIONS = 4000;

type Kind = 'name' | AgentAvatarKind;

function avatarFrom(kind: Kind, value: string): AgentAvatar | null {
  const v = value.trim();
  if (kind === 'name' || !v) return null;
  return { kind, value: kind === 'initials' ? v.toUpperCase() : v };
}

export function miniSettingsPatch(s: AgentComposerSettings, instructions: string, avatar: AgentAvatar | null, vault: VaultAccess): AgentComposerPatch {
  const p: AgentComposerPatch = {};
  if (instructions.trim() !== (s.instructions ?? '').trim()) p.instructions = instructions.trim();
  if ((avatar?.kind ?? null) !== (s.avatar?.kind ?? null) || (avatar?.value ?? null) !== (s.avatar?.value ?? null)) p.avatar = avatar;
  if (vault !== s.vault_access) p.vault_access = vault;
  return p;
}

export function MiniSettingsCard({ agentId, name, onChanged }: { agentId: string; name: string; onChanged: () => void }) {
  const ids = { instr: useId(), kind: useId(), value: useId(), vault: useId() };
  const q = useApi(() => api.agents.composerSettings(agentId), [agentId]);
  const { run, isPending } = useAction();
  const [instructions, setInstructions] = useState('');
  const [kind, setKind] = useState<Kind>('name');
  const [value, setValue] = useState('');
  const [vault, setVault] = useState<VaultAccess>('none');
  const s = q.data;
  const load = (x: AgentComposerSettings) => {
    setInstructions(x.instructions ?? '');
    setKind(x.avatar?.kind ?? 'name');
    setValue(x.avatar?.value ?? '');
    setVault(x.vault_access === 'ask' ? 'ask' : 'none');
  };
  useEffect(() => {
    if (s) load(s);
  }, [s]);

  if (!s) {
    return (
      <Card title="Instructions & Mini App settings" icon={<IconSettings />}>
        {q.error ? <ErrorBanner error={q.error} onRetry={q.reload} /> : <LoadingRows rows={2} label="Loading…" />}
      </Card>
    );
  }
  const avatar = avatarFrom(kind, value);
  const patch = miniSettingsPatch(s, instructions, avatar, vault);
  const dirty = Object.keys(patch).length > 0;
  const tooLong = instructions.trim().length > MAX_INSTRUCTIONS ? `At most ${MAX_INSTRUCTIONS} characters` : null;
  const save = async () => {
    const r = await run('mini-save', () => api.agents.patchComposerSettings(agentId, patch), { success: 'Instructions and Mini App settings saved', errorTitle: 'Could not save' });
    if (r) {
      q.setData(() => r);
      onChanged();
    }
  };
  return (
    <Card title="Instructions & Mini App settings" icon={<IconSettings />} subtitle="Also editable from the Telegram Mini App">
      <div className="space-y-5" data-testid="mini-settings-card">
        <Field
          htmlFor={ids.instr}
          label="System instructions"
          hint="Added to the agent's instructions, below NEBULA's safety rules."
          error={tooLong}
          aside={`${instructions.length}/${MAX_INSTRUCTIONS}`}
        >
          <Textarea
            id={ids.instr}
            rows={5}
            value={instructions}
            placeholder="Describe how this agent should behave, what it specializes in, and what rules it should follow."
            onChange={(e) => setInstructions(e.target.value)}
          />
        </Field>
        <div className="grid gap-4 md:grid-cols-[auto_1fr_1fr] md:items-end">
          <Avatar name={name} id={agentId} size="lg" avatar={avatar} />
          <Field htmlFor={ids.kind} label="Avatar">
            <Select
              id={ids.kind}
              value={kind}
              onChange={(e) => {
                const k = e.target.value as Kind;
                setKind(k);
                setValue(k === 'icon' ? AVATAR_ICON_IDS[0] : '');
              }}
            >
              <option value="name">Initials from the name</option>
              <option value="emoji">Emoji</option>
              <option value="initials">Custom initials</option>
              <option value="icon">Icon</option>
            </Select>
          </Field>
          {kind === 'icon' ? (
            <Field htmlFor={ids.value} label="Icon">
              <Select id={ids.value} value={value} onChange={(e) => setValue(e.target.value)}>
                {AVATAR_ICON_IDS.map((i) => (
                  <option key={i} value={i}>
                    {i.charAt(0).toUpperCase() + i.slice(1)}
                  </option>
                ))}
              </Select>
            </Field>
          ) : kind !== 'name' ? (
            <Field htmlFor={ids.value} label={kind === 'emoji' ? 'Emoji' : 'Initials (1–2 letters or digits)'}>
              <Input id={ids.value} value={value} maxLength={kind === 'initials' ? 2 : 16} autoComplete="off" onChange={(e) => setValue(e.target.value)} />
            </Field>
          ) : (
            <span />
          )}
        </div>
        <Field htmlFor={ids.vault} label="Smart sign-in (Password Vault access)" hint="Saved-credential grants are managed under Security.">
          <Select id={ids.vault} value={vault} onChange={(e) => setVault(e.target.value as VaultAccess)}>
            <option value="none">No access</option>
            <option value="ask">Ask me when a sign-in is needed</option>
          </Select>
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" loading={isPending('mini-save')} disabledReason={!dirty ? 'No changes' : tooLong} onClick={() => void save()}>
            Save
          </Button>
          <Button disabled={!dirty} onClick={() => load(s)}>
            Discard
          </Button>
        </div>
      </div>
    </Card>
  );
}
