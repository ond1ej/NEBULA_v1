// Typed client for Voice 2.0 (routes_v3.py "voice 2.0" + the V2 /voice/stt settings): speech-to-text status and
// models, text-to-speech providers/voices/preview and per-agent voice settings.
import { request, requestBlob } from '../../api';

const enc = encodeURIComponent;

export interface SttModel {
  name: string;
  size_mb: number;
  installed: boolean;
  downloading: boolean;
  downloaded_mb: number | null;
  source: string;
}

export interface SttJobs {
  running: number;
  done: number;
  failed: number;
}

export interface SttStatus {
  backend: 'whisper_cpp' | 'openai' | null;
  local: { binary: string | null; model: string | null; ffmpeg: boolean };
  cloud: { provider_connected: boolean; consent: boolean; model: string };
  language: string;
  models: SttModel[];
  jobs: SttJobs;
  local_binary_hint: string;
  setup_hint: string | null;
}

export interface SttPatch {
  cloud_consent?: boolean;
  cloud_model?: string;
  language?: string;
}

export interface TtsVoice {
  id: string;
  locale: string;
  language: string;
  sample: string;
  provider: string;
}

export interface TtsProviders {
  macos: { available: boolean; voices: number; czech: string[]; english: string[]; ogg_opus: boolean; local: boolean };
  openai: { available: boolean; consent: boolean; local: boolean };
}

export type TtsProvider = 'macos' | 'openai';

export interface TtsSettings {
  provider: TtsProvider;
  cloud_consent: boolean;
  cloud_model: string;
  cloud_voice: string;
}

export interface TtsInfo {
  providers: TtsProviders;
  default_provider: TtsProvider | string;
  settings: TtsSettings;
  voices: TtsVoice[];
}

export interface VoiceOverview {
  stt: SttStatus;
  tts: { providers: TtsProviders; default_provider: string };
}

export type ReplyMode = 'text' | 'voice' | 'text_voice' | 'auto';
export type VoiceLanguage = 'auto' | 'cs' | 'en';

export interface AgentVoice {
  reply_mode: ReplyMode;
  provider: TtsProvider;
  voice: string | null;
  language: VoiceLanguage;
  rate: number;
}

export interface PreviewBody {
  text: string;
  language: string;
  voice?: string | null;
  rate?: number;
  provider?: TtsProvider | null;
  format?: 'ogg' | 'm4a';
}

export interface PreviewAudio {
  blob: Blob;
  mime: string;
  voice: string | null;
  provider: string | null;
  duration: number | null;
}

export const REPLY_MODES: { value: ReplyMode; label: string; hint: string }[] = [
  { value: 'text', label: 'Text only', hint: 'Always answer with text messages.' },
  { value: 'voice', label: 'Voice only', hint: 'Always answer with a voice note (long results are summarised).' },
  { value: 'text_voice', label: 'Text + Voice', hint: 'Send the text and a voice note of it.' },
  { value: 'auto', label: 'Automatic', hint: 'Answer voice with voice: a voice message gets a voice reply, text gets text.' },
];

export const SAMPLE_TEXT: Record<'cs' | 'en', string> = {
  cs: 'Ahoj, tady NEBULA. Úkol je hotový a výsledek najdeš v pracovní složce.',
  en: 'Hi, this is NEBULA. The task is done and the result is in your workspace.',
};

/** Ogg/Opus plays in Chrome and Firefox; Safari needs the M4A fallback. */
export function previewFormat(): 'ogg' | 'm4a' {
  try {
    const a = document.createElement('audio');
    return a.canPlayType?.('audio/ogg; codecs=opus') ? 'ogg' : 'm4a';
  } catch {
    return 'm4a';
  }
}

export const voiceApi = {
  status: (signal?: AbortSignal) => request<VoiceOverview>('/voice/status', { signal }),
  stt: (signal?: AbortSignal) => request<SttStatus>('/voice/stt', { signal }),
  patchStt: (body: SttPatch) => request<SttStatus>('/voice/stt', { method: 'PATCH', body }),
  tts: (signal?: AbortSignal) => request<TtsInfo>('/voice/tts', { signal }),
  patchTts: (body: Partial<Pick<TtsSettings, 'provider' | 'cloud_consent' | 'cloud_model' | 'cloud_voice'>>) =>
    request<TtsSettings>('/voice/tts', { method: 'PATCH', body }),
  models: (signal?: AbortSignal) => request<SttModel[]>('/voice/models', { signal }),
  /** Starts the owner-confirmed download (202). Call only after the user confirmed size and source. */
  downloadModel: (name: string) => request<{ name: string; downloading: boolean }>(`/voice/models/${enc(name)}/download`, { method: 'POST', query: { confirm: true } }),
  preview: async (body: PreviewBody, signal?: AbortSignal): Promise<PreviewAudio> => {
    const r = await requestBlob('/voice/tts/preview', { method: 'POST', body: { rate: 1, format: previewFormat(), ...body }, signal });
    const dur = Number(r.headers.get('x-duration'));
    return {
      blob: r.blob,
      mime: r.headers.get('content-type') ?? r.blob.type,
      voice: r.headers.get('x-voice') || null,
      provider: r.headers.get('x-provider') || null,
      duration: Number.isFinite(dur) && dur > 0 ? dur : null,
    };
  },
  agentVoice: (agentId: string, signal?: AbortSignal) => request<AgentVoice>(`/agents/${enc(agentId)}/voice`, { signal }),
  setAgentVoice: (agentId: string, body: Partial<AgentVoice>) => request<AgentVoice>(`/agents/${enc(agentId)}/voice`, { method: 'PUT', body }),
};

export function sttBackendLabel(b: SttStatus['backend']): string {
  return b === 'whisper_cpp' ? 'Local whisper.cpp (audio stays on this Mac)' : b === 'openai' ? 'OpenAI cloud (you consented)' : 'Not set up — voice notes are refused';
}
