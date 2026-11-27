// Voice (#/voice): speech-to-text (local whisper.cpp / consented cloud), whisper models, text-to-speech providers
// (local macOS voices, optional consented OpenAI) with live preview, and voice job counters.
import { useEffect, useId, useMemo, useState } from 'react';
import { IconAlert, IconCheckCircle, IconDownload, IconMic, IconVoice, IconXCircle } from '../../components/icons';
import { ConfirmDialog } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import {
  Badge,
  Button,
  Card,
  ErrorBanner,
  Field,
  KeyValue,
  LoadingRows,
  Meter,
  Mono,
  Notice,
  PageHeader,
  SegmentedControl,
  Select,
  Stat,
  Switch,
  Textarea,
} from '../../components/ui';
import { useAction, useApi, useVisiblePoll } from '../../hooks/useApi';
import { useNebulaEvents } from '../../hooks/useEvents';
import { CopyButton } from '../bots/parts';
import { SAMPLE_TEXT, sttBackendLabel, voiceApi, type SttModel, type SttStatus, type TtsInfo, type TtsProvider } from './api';
import { PreviewButton, PreviewPlayer, useVoicePreview } from './VoicePreview';

const STT_LANGUAGES: { value: string; label: string }[] = [
  { value: 'auto', label: 'Detect automatically' },
  { value: 'cs', label: 'Czech' },
  { value: 'en', label: 'English' },
  { value: 'sk', label: 'Slovak' },
  { value: 'de', label: 'German' },
  { value: 'pl', label: 'Polish' },
  { value: 'fr', label: 'French' },
  { value: 'es', label: 'Spanish' },
  { value: 'it', label: 'Italian' },
];

function Detected({ ok, yes, no }: { ok: boolean; yes: string; no: string }) {
  return (
    <span className={`inline-flex items-start gap-1.5 ${ok ? 'text-text' : 'text-warn'}`}>
      {ok ? <IconCheckCircle className="mt-0.5 size-4 shrink-0 text-success" /> : <IconAlert className="mt-0.5 size-4 shrink-0 text-warn" />}
      <span className="min-w-0 break-all">{ok ? yes : no}</span>
    </span>
  );
}

function installCommand(hint: string | null | undefined): string | null {
  const m = /(brew install [\w.-]+)/.exec(hint ?? '');
  return m ? m[1] : null;
}

// ---------------------------------------------------------------- speech-to-text
function ModelRow({ m, onDownload, starting }: { m: SttModel; onDownload: (m: SttModel) => void; starting: boolean }) {
  const pct = m.downloading && m.downloaded_mb != null && m.size_mb ? (m.downloaded_mb / m.size_mb) * 100 : null;
  return (
    <li className="flex flex-col gap-2 px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <Mono className="text-text">ggml-{m.name}.bin</Mono>
          <span className="text-xs text-muted">{m.size_mb} MB</span>
          {m.installed ? (
            <Badge tone="success" dot>
              Installed
            </Badge>
          ) : m.downloading ? (
            <Badge tone="info" dot>
              Downloading
            </Badge>
          ) : (
            <Badge>Not installed</Badge>
          )}
        </p>
        <p className="mt-0.5 text-xs text-subtle">{m.name === 'tiny' ? 'Fastest, least accurate' : m.name === 'base' ? 'Good balance for short voice notes' : 'Most accurate, slower on long audio'} · multilingual (Czech + English)</p>
        {m.downloading && (
          <div className="mt-2 max-w-sm">
            <Meter value={pct ?? 0} label={`Download of ggml-${m.name}.bin`} tone="info" size="sm" />
            <p className="mt-1 text-2xs text-subtle tabular-nums">
              {m.downloaded_mb ?? 0} of {m.size_mb} MB
            </p>
          </div>
        )}
      </div>
      {!m.installed && (
        <Button size="sm" icon={<IconDownload />} onClick={() => onDownload(m)} loading={starting || m.downloading} disabledReason={m.downloading ? 'Download in progress' : null}>
          {m.downloading ? 'Downloading…' : 'Download'}
        </Button>
      )}
    </li>
  );
}

function SpeechToTextCard({ stt, onStt, onModelsChanged }: { stt: SttStatus; onStt: (s: SttStatus) => void; onModelsChanged: () => void }) {
  const toast = useToast();
  const { run, isPending } = useAction();
  const langId = useId();
  const models = useApi((s) => voiceApi.models(s), []);
  const [confirmModel, setConfirmModel] = useState<SttModel | null>(null);
  const [confirmCloud, setConfirmCloud] = useState(false);
  const [watch, setWatch] = useState<{ name: string; since: number } | null>(null);
  const list = models.data ?? stt.models;
  const downloading = list.some((m) => m.downloading);
  const reloadModels = models.reload;

  // Poll while a download is running (or was just started and has not shown up yet).
  useVisiblePoll(reloadModels, downloading || watch ? 2000 : null);

  useEffect(() => {
    if (!watch || !models.data) return;
    const m = models.data.find((x) => x.name === watch.name);
    if (m?.installed) {
      toast.success(`ggml-${watch.name}.bin installed`, 'The model was verified and is ready for local transcription.');
      setWatch(null);
      onModelsChanged();
    } else if (m && !m.downloading && Date.now() - watch.since > 20_000) {
      toast.warn(`ggml-${watch.name}.bin was not installed`, 'The download stopped. Check the network and the audit log, then try again.');
      setWatch(null);
    }
  }, [models.data, watch, toast, onModelsChanged]);

  const cmd = installCommand(stt.local_binary_hint);
  const patch = async (key: string, body: Parameters<typeof voiceApi.patchStt>[0], success: string) => {
    const r = await run(key, () => voiceApi.patchStt(body), { success, errorTitle: 'Could not save the voice setting' });
    if (r) onStt(r);
    return r;
  };

  return (
    <Card title="Speech-to-text" subtitle="Transcribes Telegram voice notes and audio/video attachments." icon={<IconMic />}>
      <div className="space-y-5">
        <div className={`rounded-xl border px-4 py-3 ${stt.backend ? 'border-success/25 bg-success/[0.05]' : 'border-warn/30 bg-warn/[0.06]'}`}>
          <p className="text-2xs font-semibold tracking-wider text-subtle uppercase">Active backend</p>
          <p className={`mt-1 text-sm font-medium ${stt.backend ? 'text-text' : 'text-warn'}`}>{sttBackendLabel(stt.backend)}</p>
          {stt.setup_hint && <p className="mt-1.5 text-xs leading-5 text-muted">{stt.setup_hint}</p>}
        </div>

        <KeyValue
          items={[
            ['whisper.cpp', <Detected key="b" ok={Boolean(stt.local.binary)} yes={stt.local.binary ?? ''} no="whisper-cli not found" />],
            ['Model in use', <Detected key="m" ok={Boolean(stt.local.model)} yes={stt.local.model ?? ''} no="No ggml model installed" />],
            ['ffmpeg', <Detected key="f" ok={stt.local.ffmpeg} yes="Detected (decodes voice notes)" no="Not found — brew install ffmpeg" />],
          ]}
        />

        {!stt.local.binary && (
          <Notice tone="info" title="Install whisper.cpp yourself">
            <p>{stt.local_binary_hint}</p>
            {cmd && (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <code className="rounded-md border border-border bg-input px-2 py-1 font-mono text-xs text-text">{cmd}</code>
                <CopyButton text={cmd} label="Copy command" />
              </div>
            )}
            <p className="mt-1.5 text-xs">Run it in Terminal as your own user, then reload this page. NEBULA never installs software for you.</p>
          </Notice>
        )}

        <div>
          <h3 className="mb-1 text-sm font-semibold text-text">Local models</h3>
          <p className="mb-2 text-xs text-muted">Official whisper.cpp models from huggingface.co. Downloaded only when you click Download.</p>
          {models.error && !models.data ? <ErrorBanner error={models.error} onRetry={models.reload} /> : null}
          <ul className="divide-y divide-border/60 rounded-xl border border-border" aria-label="Speech-to-text models">
            {list.map((m) => (
              <ModelRow key={m.name} m={m} starting={isPending(`dl-${m.name}`) || watch?.name === m.name} onDownload={setConfirmModel} />
            ))}
          </ul>
        </div>

        <div className="grid gap-5 md:grid-cols-2">
          <Field label="Spoken language" htmlFor={langId} hint="Fixing the language improves accuracy for short Czech notes.">
            <Select id={langId} value={stt.language} disabled={isPending('lang')} onChange={(e) => void patch('lang', { language: e.target.value }, 'Transcription language saved')}>
              {STT_LANGUAGES.map((l) => (
                <option key={l.value} value={l.value}>
                  {l.label}
                </option>
              ))}
              {!STT_LANGUAGES.some((l) => l.value === stt.language) && <option value={stt.language}>{stt.language}</option>}
            </Select>
          </Field>
          <div className="space-y-2">
            <Switch
              checked={stt.cloud.consent}
              loading={isPending('consent')}
              label="Allow cloud transcription"
              description={
                stt.cloud.provider_connected
                  ? `Fallback when no local model is installed: audio is sent to OpenAI (${stt.cloud.model}).`
                  : 'Needs a connected OpenAI API key (Providers). Audio would be sent to OpenAI.'
              }
              onChange={(v) => (v ? setConfirmCloud(true) : void patch('consent', { cloud_consent: false }, 'Cloud transcription disabled'))}
            />
            {stt.cloud.consent && <p className="text-xs text-warn">Voice notes may be uploaded to OpenAI when no local model is available.</p>}
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={confirmModel !== null}
        destructive={false}
        title={confirmModel ? `Download ggml-${confirmModel.name}.bin (~${confirmModel.size_mb} MB)?` : ''}
        confirmLabel={confirmModel ? `Download ${confirmModel.size_mb} MB` : 'Download'}
        onCancel={() => setConfirmModel(null)}
        onConfirm={async () => {
          if (!confirmModel) return;
          const m = confirmModel;
          const r = await run(`dl-${m.name}`, () => voiceApi.downloadModel(m.name), { success: `Downloading ggml-${m.name}.bin…`, errorTitle: 'Could not start the download' });
          if (r) {
            setConfirmModel(null);
            setWatch({ name: m.name, since: Date.now() });
            models.reload();
          }
        }}
      >
        {confirmModel && (
          <>
            <p>
              NEBULA downloads about <strong>{confirmModel.size_mb} MB</strong> from <strong>huggingface.co</strong> (the official whisper.cpp model repository):
            </p>
            <p className="font-mono text-xs break-all text-text">{confirmModel.source}</p>
            <p>The size and the ggml file header are verified and the SHA-256 is recorded. The file is stored in the NEBULA data folder; nothing else is installed.</p>
          </>
        )}
      </ConfirmDialog>
      <ConfirmDialog
        open={confirmCloud}
        title="Send voice audio to OpenAI?"
        confirmLabel="Allow cloud transcription"
        onCancel={() => setConfirmCloud(false)}
        onConfirm={async () => {
          const r = await patch('consent', { cloud_consent: true }, 'Cloud transcription allowed');
          if (r) setConfirmCloud(false);
        }}
      >
        <p>
          <strong>Privacy:</strong> when no local whisper.cpp model is available, the audio recording of every voice note (and the audio track of video attachments) is uploaded to
          OpenAI (api.openai.com) for transcription. Recordings can contain your voice, names and private details.
        </p>
        <p>Local transcription keeps audio on this Mac. You can withdraw consent at any time.</p>
      </ConfirmDialog>
    </Card>
  );
}

// ---------------------------------------------------------------- text-to-speech
function VoiceChips({ ids, empty }: { ids: string[]; empty: string }) {
  if (ids.length === 0) return <p className="text-xs text-warn">{empty}</p>;
  return (
    <ul className="flex flex-wrap gap-1.5">
      {ids.map((v) => (
        <li key={v}>
          <Badge>{v}</Badge>
        </li>
      ))}
    </ul>
  );
}

function TextToSpeechCard({ tts, onTts }: { tts: TtsInfo; onTts: (fn: (t: TtsInfo) => TtsInfo) => void }) {
  const { run, isPending } = useAction();
  const [confirmCloud, setConfirmCloud] = useState(false);
  const mac = tts.providers.macos;
  const oa = tts.providers.openai;
  const cloudReady = oa.available && tts.settings.cloud_consent;

  const save = async (key: string, body: Parameters<typeof voiceApi.patchTts>[0], success: string) => {
    const r = await run(key, () => voiceApi.patchTts(body), { success, errorTitle: 'Could not save the voice setting' });
    if (r) onTts((t) => ({ ...t, settings: r, default_provider: r.provider, providers: { ...t.providers, openai: { ...t.providers.openai, consent: r.cloud_consent } } }));
    return r;
  };

  return (
    <Card title="Text-to-speech" subtitle="Voice replies for Telegram and voice previews." icon={<IconVoice />}>
      <div className="space-y-5">
        <div>
          <p className="mb-1.5 text-[13px] font-medium text-text">Default provider</p>
          <SegmentedControl<TtsProvider>
            label="Default text-to-speech provider"
            value={(tts.settings.provider as TtsProvider) ?? 'macos'}
            disabled={isPending('provider')}
            onChange={(v) => void save('provider', { provider: v }, v === 'openai' ? 'OpenAI voice is now the default' : 'Local macOS voices are now the default')}
            options={[
              { value: 'macos', label: 'macOS (local)' },
              { value: 'openai', label: 'OpenAI (cloud)', disabled: !cloudReady, title: cloudReady ? undefined : 'Needs an OpenAI API key and your consent below' },
            ]}
          />
          <p className="mt-1.5 text-xs text-muted">Agents can override the provider in their Voice tab.</p>
        </div>

        <div className="rounded-xl border border-border p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-semibold text-text">macOS voices</p>
            <div className="flex flex-wrap gap-1.5">
              <Badge tone={mac.available ? 'success' : 'danger'} dot>
                {mac.available ? `${mac.voices} voices` : 'say not available'}
              </Badge>
              <Badge tone={mac.ogg_opus ? 'success' : 'warn'} title={mac.ogg_opus ? 'ffmpeg encodes Ogg/Opus voice notes' : 'Without ffmpeg replies are sent as M4A audio'}>
                {mac.ogg_opus ? 'Ogg/Opus' : 'M4A fallback'}
              </Badge>
            </div>
          </div>
          <p className="mt-1 text-xs text-muted">Free, offline, nothing leaves this Mac. Add voices in System Settings → Accessibility → Spoken Content.</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div>
              <p className="mb-1.5 text-xs font-medium text-muted">Czech</p>
              <VoiceChips ids={mac.czech} empty="No Czech voice installed (Zuzana is recommended)." />
            </div>
            <div>
              <p className="mb-1.5 text-xs font-medium text-muted">English</p>
              <VoiceChips ids={mac.english} empty="No English voice installed." />
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-border p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-semibold text-text">OpenAI text-to-speech (optional)</p>
            <Badge tone={oa.available ? 'success' : 'neutral'}>{oa.available ? 'API key connected' : 'No API key'}</Badge>
          </div>
          <p className="mt-1 text-xs text-muted">
            Model {tts.settings.cloud_model}, voice {tts.settings.cloud_voice}. Used only when you choose it and consent below.
          </p>
          <div className="mt-3">
            <Switch
              checked={tts.settings.cloud_consent}
              loading={isPending('tts-consent')}
              label="Allow sending reply text to OpenAI"
              description="Required before any agent can use the OpenAI voice."
              onChange={(v) => (v ? setConfirmCloud(true) : void save('tts-consent', { cloud_consent: false, ...(tts.settings.provider === 'openai' ? { provider: 'macos' as const } : {}) }, 'Cloud text-to-speech disabled'))}
            />
          </div>
        </div>
      </div>
      <ConfirmDialog
        open={confirmCloud}
        title="Send reply text to OpenAI for speech?"
        confirmLabel="Allow cloud text-to-speech"
        onCancel={() => setConfirmCloud(false)}
        onConfirm={async () => {
          const r = await save('tts-consent', { cloud_consent: true }, 'Cloud text-to-speech allowed');
          if (r) setConfirmCloud(false);
        }}
      >
        <p>
          <strong>Privacy:</strong> when an agent (or a preview) uses the OpenAI voice, the full reply text is sent to OpenAI (api.openai.com) to be synthesised. Replies can contain
          results of your tasks, file contents and personal data.
        </p>
        <p>Local macOS voices never send anything. You can withdraw consent at any time.</p>
      </ConfirmDialog>
    </Card>
  );
}

// ---------------------------------------------------------------- preview
function PreviewCard({ tts }: { tts: TtsInfo }) {
  const ids = { text: useId(), voice: useId(), rate: useId() };
  const [language, setLanguage] = useState<'cs' | 'en'>('cs');
  const [text, setText] = useState(SAMPLE_TEXT.cs);
  const [voice, setVoice] = useState('');
  const [rate, setRate] = useState(1);
  const [provider, setProvider] = useState<TtsProvider>((tts.settings.provider as TtsProvider) ?? 'macos');
  const { play, busy, result } = useVoicePreview();
  const voices = useMemo(() => tts.voices.filter((v) => v.language === language), [tts.voices, language]);
  const cloudReady = tts.providers.openai.available && tts.settings.cloud_consent;
  const effectiveProvider: TtsProvider = provider === 'openai' && !cloudReady ? 'macos' : provider;

  return (
    <Card title="Preview" subtitle="Hear exactly what a voice reply will sound like." icon={<IconVoice />}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <SegmentedControl<'cs' | 'en'>
            label="Preview language"
            value={language}
            onChange={(l) => {
              if (text === SAMPLE_TEXT[language]) setText(SAMPLE_TEXT[l]);
              setLanguage(l);
              setVoice('');
            }}
            options={[
              { value: 'cs', label: 'Czech' },
              { value: 'en', label: 'English' },
            ]}
          />
          <SegmentedControl<TtsProvider>
            label="Preview provider"
            value={effectiveProvider}
            onChange={setProvider}
            options={[
              { value: 'macos', label: 'macOS' },
              { value: 'openai', label: 'OpenAI', disabled: !cloudReady, title: cloudReady ? undefined : 'Needs an OpenAI API key and consent' },
            ]}
          />
        </div>
        <Field label="Text" htmlFor={ids.text} aside={`${text.length}/1500`}>
          <Textarea id={ids.text} rows={3} maxLength={1500} value={text} onChange={(e) => setText(e.target.value)} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Voice" htmlFor={ids.voice} hint={effectiveProvider === 'openai' ? `OpenAI uses ${tts.settings.cloud_voice}.` : undefined}>
            <Select id={ids.voice} value={voice} onChange={(e) => setVoice(e.target.value)} disabled={effectiveProvider === 'openai'}>
              <option value="">Default for {language === 'cs' ? 'Czech' : 'English'}</option>
              {voices.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.id} ({v.locale})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Speed" htmlFor={ids.rate} aside={`${rate.toFixed(2)}×`}>
            <input id={ids.rate} type="range" min={0.5} max={2} step={0.05} value={rate} onChange={(e) => setRate(Number(e.target.value))} className="h-9 w-full cursor-pointer accent-accent" />
          </Field>
        </div>
        <PreviewButton
          busy={busy}
          disabledReason={!text.trim() ? 'Write some text first' : null}
          onClick={() => void play({ text: text.trim(), language, voice: voice || null, rate, provider: effectiveProvider })}
        />
        <PreviewPlayer result={result} />
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- page
export function VoiceSettingsPage(_props: Record<string, never>) {
  const stt = useApi((s) => voiceApi.stt(s), []);
  const tts = useApi((s) => voiceApi.tts(s), []);
  // Voice jobs change on every transcription; refresh counters when attachments are processed.
  useNebulaEvents((e) => {
    if (e.type === 'attachment.processed') stt.reload();
  });

  const s = stt.data;
  const t = tts.data;
  return (
    <>
      <PageHeader
        title="Voice"
        icon={<IconVoice className="size-6 text-accent-soft" />}
        description="Speak to your agents in Czech or English and let them answer with voice. Local by default: audio and text stay on this Mac unless you explicitly allow a cloud provider."
      />
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Speech-to-text"
          icon={s?.backend ? <IconCheckCircle /> : <IconXCircle />}
          tone={s ? (s.backend ? 'success' : 'warn') : undefined}
          value={<span className="text-lg">{s ? (s.backend === 'whisper_cpp' ? 'Local' : s.backend === 'openai' ? 'Cloud' : 'Off') : '—'}</span>}
          hint={s ? (s.backend === 'whisper_cpp' ? 'whisper.cpp' : s.backend === 'openai' ? 'OpenAI (consented)' : 'Not set up') : 'Loading…'}
        />
        <Stat
          label="Text-to-speech"
          icon={<IconVoice />}
          value={<span className="text-lg">{t ? (t.settings.provider === 'openai' ? 'OpenAI' : 'macOS') : '—'}</span>}
          hint={t ? `${t.providers.macos.czech.length} Czech · ${t.providers.macos.english.length} English voices` : 'Loading…'}
        />
        <Stat label="Voice jobs running" value={s?.jobs.running ?? '—'} hint="Transcriptions in progress" tone={s?.jobs.running ? 'info' : undefined} />
        <Stat label="Voice jobs" value={s ? `${s.jobs.done} / ${s.jobs.failed}` : '—'} hint="Done / failed since start" tone={s?.jobs.failed ? 'warn' : undefined} />
      </div>
      <div className="grid gap-5 xl:grid-cols-2">
        <div className="min-w-0 space-y-5">
          {stt.error && !s ? (
            <ErrorBanner error={stt.error} onRetry={stt.reload} title="Could not load speech-to-text status" />
          ) : !s ? (
            <Card title="Speech-to-text">
              <LoadingRows rows={5} />
            </Card>
          ) : (
            <SpeechToTextCard stt={s} onStt={(n) => stt.setData(() => n)} onModelsChanged={stt.reload} />
          )}
        </div>
        <div className="min-w-0 space-y-5">
          {tts.error && !t ? (
            <ErrorBanner error={tts.error} onRetry={tts.reload} title="Could not load text-to-speech status" />
          ) : !t ? (
            <Card title="Text-to-speech">
              <LoadingRows rows={5} />
            </Card>
          ) : (
            <>
              <TextToSpeechCard tts={t} onTts={(fn) => tts.setData((p) => (p ? fn(p) : p))} />
              <PreviewCard tts={t} />
            </>
          )}
        </div>
      </div>
    </>
  );
}
