import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setCsrfToken } from '../api';
import { installFetch, ok } from '../test/fetchMock';
import type { Provider } from '../types';
import { ProviderChooser, providerCardId } from './ProviderChooser';
import { ToastProvider } from './Toast';
import { ProvidersPage } from '../pages/ProvidersPage';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setCsrfToken(null);
});

const AUTH_MODE: Record<string, string> = { 'openai-siwc': 'subscription', 'ollama-local': 'local', 'claude-code-cli': 'cli', 'codex-cli': 'cli', 'google-antigravity': 'cli' };
const provider = (id: string, state = 'Not connected'): Provider => ({
  id,
  adapter_type: id,
  display_name: `Backend ${id}`,
  state,
  auth_mode: AUTH_MODE[id] ?? 'api_key',
  capabilities: [],
  config: {},
  last_checked_at: null,
  last_error: null,
  created_at: 1,
  updated_at: 1,
  has_credentials: false,
  usage_today: { input_tokens: 0, output_tokens: 0, requests: 0 },
  daily_token_cap: null,
});

describe('ProviderChooser', () => {
  it('labels the three options honestly and says Claude / Gemini subscriptions are not supported', () => {
    render(<ProviderChooser providers={[provider('ollama-local')]} />);
    const local = screen.getByTestId('choice-local');
    expect(within(local).getByText('Free')).toBeInTheDocument();
    expect(within(local).getByText(/Uses this Mac’s RAM/)).toBeInTheDocument();
    const key = screen.getByTestId('choice-api');
    expect(within(key).getByText('Billed per token')).toBeInTheDocument();
    for (const name of ['OpenAI', 'Claude (Anthropic)', 'Gemini', 'OpenAI-compatible']) expect(within(key).getByRole('button', { name })).toBeInTheDocument();
    const chatgpt = screen.getByTestId('choice-sign');
    expect(within(chatgpt).getByText('Uses your ChatGPT plan')).toBeInTheDocument();
    expect(within(chatgpt).getByText(/official sign-in for open-source local clients/)).toBeInTheDocument();
    expect(screen.getByText('Claude and Gemini subscriptions are not supported')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /subscription/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Claude Code|Antigravity|Codex/ })).toBeNull();
  });

  it('shows which option is already connected', () => {
    render(<ProviderChooser providers={[provider('ollama-local', 'Connected'), provider('anthropic-api', 'Connected (API Billing)'), provider('openai-siwc')]} />);
    expect(within(screen.getByTestId('choice-local')).getByText('Connected')).toBeInTheDocument();
    expect(within(screen.getByTestId('choice-api')).getByText('Connected')).toBeInTheDocument();
    expect(within(screen.getByTestId('choice-sign')).queryByText('Connected')).toBeNull();
  });

  it('scrolls to the matching provider card', async () => {
    const user = userEvent.setup();
    const target = document.createElement('div');
    target.id = providerCardId('anthropic-api');
    target.scrollIntoView = vi.fn();
    document.body.appendChild(target);
    render(<ProviderChooser providers={[]} />);
    await user.click(screen.getByRole('button', { name: 'Claude (Anthropic)' }));
    expect(target.scrollIntoView).toHaveBeenCalled();
    target.remove();
  });
});

describe('ProvidersPage', () => {
  it('offers the chooser and never offers CLI / subscription modes for Claude, Gemini or Codex', async () => {
    installFetch({
      'GET /api/v1/providers': () =>
        ok(['openai-siwc', 'openai-api', 'anthropic-api', 'gemini-api', 'ollama-local', 'openai-compatible', 'claude-code-cli', 'codex-cli', 'google-antigravity'].map((id) => provider(id))),
    });
    render(
      <ToastProvider>
        <ProvidersPage query={new URLSearchParams()} />
      </ToastProvider>,
    );
    expect(await screen.findByLabelText('Choose how to power your agents')).toBeInTheDocument();
    expect(screen.getByTestId('provider-openai-siwc')).toBeInTheDocument();
    expect(screen.getByTestId('provider-anthropic-api')).toBeInTheDocument();
    expect(screen.queryByTestId('provider-claude-code-cli')).toBeNull();
    expect(screen.queryByTestId('provider-codex-cli')).toBeNull();
    expect(screen.queryByTestId('provider-google-antigravity')).toBeNull();
    expect(screen.queryByText(/Coding-mode CLIs/)).toBeNull();
  });
});
