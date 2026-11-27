import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setCsrfToken } from '../../api';
import { ToastProvider } from '../../components/Toast';
import { VoiceTab } from '../../pages/agent/VoiceTab';
import { installFetch, ok } from '../../test/fetchMock';
import type { Agent } from '../../types';
import { VoiceSettingsPage } from './VoiceSettingsPage';

const origCreate = URL.createObjectURL;
const origRevoke = URL.revokeObjectURL;

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => 'blob:nebula-preview');
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setCsrfToken(null);
  URL.createObjectURL = origCreate;
  URL.revokeObjectURL = origRevoke;
});

const models = (over: Record<string, Record<string, unknown>> = {}) =>
  ['tiny', 'base', 'small'].map((name, i) => ({
    name,
    size_mb: [74, 141, 464][i],
    installed: false,
    downloading: false,
    downloaded_mb: null,
    source: `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${name}.bin`,
    ...(over[name] ?? {}),
  }));

const stt = {
  backend: null,
  local: { binary: null, model: null, ffmpeg: true },
  cloud: { provider_connected: false, consent: false, model: 'whisper-1' },
  language: 'auto',
  models: models(),
  jobs: { running: 0, done: 4, failed: 1 },
  local_binary_hint: 'brew install whisper-cpp (installs whisper-cli; NEBULA never installs it for you)',
  setup_hint: 'Local: install whisper.cpp (brew install whisper-cpp) and put a ggml model into /data/models.',
};

const tts = {
  providers: {
    macos: { available: true, voices: 3, czech: ['Zuzana'], english: ['Samantha', 'Daniel'], ogg_opus: true, local: true },
    openai: { available: false, consent: false, local: false },
  },
  default_provider: 'macos',
  settings: { provider: 'macos', cloud_consent: false, cloud_model: 'gpt-4o-mini-tts', cloud_voice: 'alloy' },
  voices: [
    { id: 'Zuzana', locale: 'cs_CZ', language: 'cs', sample: 'Dobrý den', provider: 'macos' },
    { id: 'Samantha', locale: 'en_US', language: 'en', sample: 'Hello', provider: 'macos' },
    { id: 'Daniel', locale: 'en_GB', language: 'en', sample: 'Hello', provider: 'macos' },
  ],
};

const audio = () =>
  new Response(new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/mp4' }), {
    status: 200,
    headers: { 'Content-Type': 'audio/mp4', 'X-Voice': 'Zuzana', 'X-Provider': 'macos (local)', 'X-Duration': '2.4' },
  });

describe('Voice settings page', () => {
  it('previews a voice through /voice/tts/preview and plays the returned audio', async () => {
    setCsrfToken('c');
    const user = userEvent.setup();
    const { calls } = installFetch({
      'GET /api/v1/voice/stt': () => ok(stt),
      'GET /api/v1/voice/tts': () => ok(tts),
      'GET /api/v1/voice/models': () => ok(models()),
      'POST /api/v1/voice/tts/preview': () => audio(),
    });
    render(
      <ToastProvider>
        <VoiceSettingsPage />
      </ToastProvider>,
    );
    expect(await screen.findByText('Not set up — voice notes are refused')).toBeInTheDocument();
    expect(screen.getByText('brew install whisper-cpp')).toBeInTheDocument();
    expect(screen.getByText('Zuzana')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Preview voice' }));
    await waitFor(() => expect(calls.find((c) => c.path === '/api/v1/voice/tts/preview')).toBeTruthy());
    const call = calls.find((c) => c.path === '/api/v1/voice/tts/preview')!;
    expect(call.body).toMatchObject({ language: 'cs', voice: null, rate: 1, provider: 'macos', format: 'm4a' });
    expect((call.body as { text: string }).text).toMatch(/NEBULA/);
    const player = await screen.findByTestId('voice-preview');
    expect(player.querySelector('audio')).toHaveAttribute('src', 'blob:nebula-preview');
    expect(within(player).getByText(/macos \(local\)/)).toBeInTheDocument();
    expect(within(player).getByText(/2\.4 s/)).toBeInTheDocument();
  });

  it('downloads a whisper model only after confirming size and source', async () => {
    setCsrfToken('c');
    const user = userEvent.setup();
    let started = false;
    const { calls } = installFetch({
      'GET /api/v1/voice/stt': () => ok(stt),
      'GET /api/v1/voice/tts': () => ok(tts),
      'GET /api/v1/voice/models': () => ok(models(started ? { base: { downloading: true, downloaded_mb: 20 } } : {})),
      'POST /api/v1/voice/models/base/download': () => {
        started = true;
        return ok({ name: 'base', downloading: true }, 202);
      },
    });
    render(
      <ToastProvider>
        <VoiceSettingsPage />
      </ToastProvider>,
    );
    const list = await screen.findByRole('list', { name: 'Speech-to-text models' });
    const base = within(list).getByText('ggml-base.bin').closest('li') as HTMLElement;
    await user.click(within(base).getByRole('button', { name: 'Download' }));
    const dlg = await screen.findByRole('dialog', { name: 'Download ggml-base.bin (~141 MB)?' });
    expect(within(dlg).getByText('huggingface.co')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    await user.click(within(dlg).getByRole('button', { name: 'Download 141 MB' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')?.url).toBe('/api/v1/voice/models/base/download?confirm=true'));
    expect(await screen.findByText('20 of 141 MB')).toBeInTheDocument();
  });
});

describe('Agent voice tab', () => {
  const agent = { id: 'ag1', name: 'Developer', state: 'READY', provider_id: 'x', model_id: 'y' } as unknown as Agent;

  it('saves reply mode, voice and speed and previews with the agent settings', async () => {
    setCsrfToken('c');
    const user = userEvent.setup();
    const { calls } = installFetch({
      'GET /api/v1/agents/ag1/voice': () => ok({ reply_mode: 'auto', provider: 'macos', voice: null, language: 'auto', rate: 1 }),
      'GET /api/v1/voice/tts': () => ok(tts),
      'PUT /api/v1/agents/ag1/voice': (c) => ok({ reply_mode: 'auto', provider: 'macos', voice: null, language: 'auto', rate: 1, ...(c.body as object) }),
      'POST /api/v1/voice/tts/preview': () => audio(),
    });
    render(
      <ToastProvider>
        <VoiceTab agent={agent} />
      </ToastProvider>,
    );
    await user.click(await screen.findByRole('radio', { name: 'Text + Voice' }));
    await user.click(screen.getByRole('radio', { name: 'English' }));
    const voice = screen.getByLabelText('Voice');
    expect(within(voice).queryByRole('option', { name: /Zuzana/ })).toBeNull();
    await user.selectOptions(voice, 'Daniel');
    await user.click(screen.getByRole('button', { name: 'Preview voice' }));
    await waitFor(() => expect(calls.find((c) => c.path === '/api/v1/voice/tts/preview')?.body).toMatchObject({ language: 'en', voice: 'Daniel', provider: 'macos' }));
    await user.click(screen.getByRole('button', { name: 'Save voice settings' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ reply_mode: 'text_voice', provider: 'macos', voice: 'Daniel', language: 'en', rate: 1 }),
    );
  });
});
