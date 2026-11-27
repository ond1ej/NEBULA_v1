import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setCsrfToken } from '../api';
import { ToastProvider } from '../components/Toast';
import { installFetch, ok } from '../test/fetchMock';
import { TelegramPage } from './TelegramPage';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setCsrfToken(null);
});

const voice = (consent: boolean) => ({
  backend: consent ? 'openai' : null,
  local: { binary: null, model: null, ffmpeg: true },
  cloud: { provider_connected: true, consent, model: 'whisper-1' },
  setup_hint: consent ? null : 'Local: install whisper.cpp',
});

describe('Telegram voice transcription', () => {
  it('asks for explicit consent before sending audio to OpenAI', async () => {
    setCsrfToken('c');
    const user = userEvent.setup();
    const { calls } = installFetch({
      'GET /api/v1/telegram': () => ok({ enabled: true, configured: true, polling: true, bot_username: 'bot', bot_id: 1, topics_mode: 'private_topics', has_topics_enabled: true, update_offset: 0, last_poll_at: null, last_error: null, users: [], topics: [], note: '' }),
      'GET /api/v1/agents': () => ok([]),
      'GET /api/v1/voice/stt': () => ok(voice(false)),
      'PATCH /api/v1/voice/stt': () => ok(voice(true)),
    });
    render(
      <ToastProvider>
        <TelegramPage />
      </ToastProvider>,
    );
    expect(await screen.findByText('Local: install whisper.cpp')).toBeInTheDocument();
    expect(screen.getByText('Not set up — voice notes are refused')).toBeInTheDocument();
    await user.click(screen.getByRole('switch', { name: 'Allow cloud transcription' }));
    const dialog = await screen.findByRole('dialog', { name: 'Send voice audio to OpenAI?' });
    expect(within(dialog).getByText(/audio recording/)).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
    await user.click(within(dialog).getByRole('button', { name: 'Allow cloud transcription' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ cloud_consent: true }));
    expect(await screen.findByText('OpenAI cloud (you consented)')).toBeInTheDocument();
  });
});
