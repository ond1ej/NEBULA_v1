// Agent Voice tab: how this agent answers (text / voice / both / automatic), with which provider, voice, language
// and speed (GET|PUT /agents/{id}/voice), plus a live preview.
import { useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import { IconVoice } from '../../components/icons';
import { Button, Card, ErrorBanner, Field, LoadingRows, Notice, SegmentedControl, Select, TextLink } from '../../components/ui';
import { useAction, useApi } from '../../hooks/useApi';
import { href } from '../../hooks/useHashRoute';
import { REPLY_MODES, SAMPLE_TEXT, voiceApi, type AgentVoice, type ReplyMode, type TtsInfo, type TtsProvider, type VoiceLanguage } from '../../features/voice/api';
import { PreviewButton, PreviewPlayer, useVoicePreview } from '../../features/voice/VoicePreview';
import type { Agent } from '../../types';

const LANGS: { value: VoiceLanguage; label: string }[] = [
  { value: 'auto', label: 'Automatic' },
  { value: 'cs', label: 'Czech' },
  { value: 'en', label: 'English' },
];

function same(a: AgentVoice, b: AgentVoice): boolean {
  return a.reply_mode === b.reply_mode && a.provider === b.provider && (a.voice ?? null) === (b.voice ?? null) && a.language === b.language && Math.abs(a.rate - b.rate) < 1e-6;
}

function VoiceForm({ agent, initial, tts, onSaved }: { agent: Agent; initial: AgentVoice; tts: TtsInfo | null; onSaved: (v: AgentVoice) => void }) {
  const ids = { voice: useId(), rate: useId(), mode: useId() };
  const { run, isPending } = useAction();
  const [v, setV] = useState<AgentVoice>(initial);
  useEffect(() => setV(initial), [initial]);
  const { play, busy, result } = useVoicePreview();
  const set = <K extends keyof AgentVoice>(k: K, val: AgentVoice[K]) => setV((p) => ({ ...p, [k]: val }));

  const cloudReady = Boolean(tts && tts.providers.openai.available && tts.settings.cloud_consent);
  const voices = useMemo(() => {
    const all = tts?.voices ?? [];
    return v.language === 'auto' ? all.filter((x) => x.language === 'cs' || x.language === 'en') : all.filter((x) => x.language === v.language);
  }, [tts, v.language]);
  const voiceKnown = !v.voice || voices.some((x) => x.id === v.voice);
  const previewLang: 'cs' | 'en' = v.language === 'auto' ? ((tts?.voices.find((x) => x.id === v.voice)?.language as 'cs' | 'en' | undefined) ?? 'cs') : v.language;
  const dirty = !same(v, initial);
  const mode = REPLY_MODES.find((m) => m.value === v.reply_mode);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!dirty) return;
    const r = await run('save', () => voiceApi.setAgentVoice(agent.id, v), { success: `Voice settings for ${agent.name} saved`, errorTitle: 'Could not save the voice settings' });
    if (r) onSaved(r);
  };

  return (
    <form onSubmit={save} className="space-y-5">
      <Card title="Replies" subtitle={`How ${agent.name} answers in Telegram.`} icon={<IconVoice />}>
        <div className="space-y-2">
          <SegmentedControl<ReplyMode> label="Reply mode" value={v.reply_mode} onChange={(m) => set('reply_mode', m)} options={REPLY_MODES.map((m) => ({ value: m.value, label: m.label }))} />
          <p id={ids.mode} className="text-xs text-muted">
            {mode?.hint}
          </p>
        </div>
      </Card>

      <Card title="Voice" subtitle="Provider, voice, language and speed for spoken replies.">
        <div className="space-y-5">
          <div className="flex flex-wrap gap-x-6 gap-y-4">
            <div>
              <p className="mb-1.5 text-[13px] font-medium text-text">Provider</p>
              <SegmentedControl<TtsProvider>
                label="Voice provider"
                value={v.provider}
                onChange={(p) => set('provider', p)}
                options={[
                  { value: 'macos', label: 'macOS (local)' },
                  { value: 'openai', label: 'OpenAI (cloud)', disabled: !cloudReady && v.provider !== 'openai', title: cloudReady ? undefined : 'Needs an OpenAI API key and consent on the Voice page' },
                ]}
              />
            </div>
            <div>
              <p className="mb-1.5 text-[13px] font-medium text-text">Language</p>
              <SegmentedControl<VoiceLanguage>
                label="Reply language"
                value={v.language}
                onChange={(l) => setV((p) => ({ ...p, language: l, voice: l !== 'auto' && p.voice && !(tts?.voices ?? []).some((x) => x.id === p.voice && x.language === l) ? null : p.voice }))}
                options={LANGS}
              />
            </div>
          </div>
          {v.provider === 'openai' && !cloudReady && (
            <Notice tone="warn">
              OpenAI voice is selected but cloud text-to-speech is not allowed or no API key is connected — replies fall back to an error. Allow it on the <TextLink href={href('/voice')}>Voice page</TextLink> or choose macOS.
            </Notice>
          )}
          <div className="grid gap-5 sm:grid-cols-2">
            <Field
              label="Voice"
              htmlFor={ids.voice}
              hint={v.provider === 'openai' ? `OpenAI uses ${tts?.settings.cloud_voice ?? 'its configured voice'} unless you pick one.` : v.language === 'auto' ? 'Default picks Zuzana for Czech and Samantha for English automatically.' : undefined}
            >
              <Select id={ids.voice} value={v.voice ?? ''} onChange={(e) => set('voice', e.target.value || null)} disabled={v.provider === 'openai'}>
                <option value="">Default for the language</option>
                {!voiceKnown && v.voice && <option value={v.voice}>{v.voice} (not installed)</option>}
                {voices.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.id} ({x.locale})
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Speed" htmlFor={ids.rate} aside={`${v.rate.toFixed(2)}×`} hint="1.00× is the normal speaking rate.">
              <input
                id={ids.rate}
                type="range"
                min={0.5}
                max={2}
                step={0.05}
                value={v.rate}
                onChange={(e) => set('rate', Number(e.target.value))}
                className="h-9 w-full cursor-pointer accent-accent"
              />
            </Field>
          </div>
          <div>
            <PreviewButton
              busy={busy}
              disabledReason={v.provider === 'openai' && !cloudReady ? 'Cloud text-to-speech is not allowed' : null}
              onClick={() => void play({ text: SAMPLE_TEXT[previewLang], language: previewLang, voice: v.provider === 'openai' ? null : v.voice, rate: v.rate, provider: v.provider })}
            />
            <PreviewPlayer result={result} />
          </div>
        </div>
      </Card>

      <div className="flex flex-wrap justify-end gap-2">
        <Button onClick={() => setV(initial)} disabled={!dirty || isPending('save')}>
          Reset
        </Button>
        <Button type="submit" variant="primary" loading={isPending('save')} disabledReason={dirty ? null : 'No changes'}>
          Save voice settings
        </Button>
      </div>
    </form>
  );
}

export function VoiceTab({ agent }: { agent: Agent }) {
  const voice = useApi((s) => voiceApi.agentVoice(agent.id, s), [agent.id]);
  const tts = useApi((s) => voiceApi.tts(s), []);
  if (voice.error && !voice.data) return <ErrorBanner error={voice.error} onRetry={voice.reload} title="Could not load the voice settings" />;
  if (!voice.data) return <LoadingRows rows={5} label="Loading voice settings…" />;
  return (
    <div className="space-y-4">
      {tts.error && !tts.data ? <ErrorBanner error={tts.error} onRetry={tts.reload} title="Voices could not be listed" /> : null}
      <VoiceForm agent={agent} initial={voice.data} tts={tts.data} onSaved={(n) => voice.setData(() => n)} />
    </div>
  );
}
