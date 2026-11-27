import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setCsrfToken } from '../api';
import { installFetch, ok } from '../test/fetchMock';
import { PROVIDER_STATES, type Provider } from '../types';
import { ProviderCard } from './ProviderCard';
import { ToastProvider } from './Toast';

const AUTH_MODE: Record<string, string> = {
  'openai-siwc': 'subscription',
  'openai-api': 'api_key',
  'anthropic-api': 'api_key',
  'gemini-api': 'api_key',
  'openai-compatible': 'api_key',
  'ollama-local': 'local',
  'claude-code-cli': 'cli',
  'codex-cli': 'cli',
  'google-antigravity': 'cli',
};

function provider(id: string, state: string, extra: Partial<Provider> = {}): Provider {
  return {
    id,
    adapter_type: id,
    display_name: `Backend name of ${id}`,
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
    ...extra,
  };
}

function renderCard(p: Provider, onChanged = vi.fn()) {
  return render(
    <ToastProvider>
      <ProviderCard provider={p} onChanged={onChanged} />
    </ToastProvider>,
  );
}

function card(id: string) {
  return screen.getByTestId(`provider-${id}`).closest('section') as HTMLElement;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setCsrfToken(null);
});

describe('ProviderCard', () => {
  it.each(PROVIDER_STATES.map((s) => [s]))('renders the exact state label "%s"', (state) => {
    renderCard(provider('anthropic-api', state));
    const c = card('anthropic-api');
    expect(within(c).getByText(state, { selector: 'span' })).toBeInTheDocument();
  });

  it('labels the Anthropic key provider "Claude API Key" with a password-type key field and no username/password form', () => {
    renderCard(provider('anthropic-api', 'Not Connected'));
    const c = card('anthropic-api');
    expect(within(c).getAllByText('Claude API Key').length).toBeGreaterThan(0);
    const key = within(c).getByLabelText('Claude API Key');
    expect(key).toHaveAttribute('type', 'password');
    expect(within(c).queryByLabelText(/username/i)).not.toBeInTheDocument();
    expect(within(c).queryByLabelText(/^password$/i)).not.toBeInTheDocument();
    expect(c.querySelectorAll('input[type="password"]')).toHaveLength(1);
  });

  it.each(['openai-api', 'gemini-api'])('%s uses a single password-type API key input', (id) => {
    renderCard(provider(id, 'Not Connected'));
    const c = card(id);
    expect(within(c).getByLabelText('API key')).toHaveAttribute('type', 'password');
    expect(within(c).queryByLabelText(/username|e-?mail/i)).not.toBeInTheDocument();
  });

  it('submits only {api_key} to /providers/{id}/connect and shows the resulting state', async () => {
    setCsrfToken('c1');
    const user = userEvent.setup();
    const onChanged = vi.fn();
    const { calls } = installFetch({
      'POST /api/v1/providers/anthropic-api/connect': () =>
        ok({ provider_id: 'anthropic-api', state: 'Connected (API Billing)', detail: '3 models', billing: 'API billing (per token)', capabilities: [], account: {} }),
    });
    renderCard(provider('anthropic-api', 'Not Connected'), onChanged);
    const c = card('anthropic-api');
    await user.type(within(c).getByLabelText('Claude API Key'), '  sk-ant-test  ');
    await user.click(within(c).getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(calls[0].body).toEqual({ api_key: 'sk-ant-test' });
    expect(calls[0].headers['x-csrf-token']).toBe('c1');
    expect(within(c).getByLabelText('Claude API Key')).toHaveValue('');
    expect(await within(c).findByText('3 models')).toBeInTheDocument();
  });

  it('openai-siwc offers "Continue with ChatGPT" and no credential inputs', () => {
    renderCard(provider('openai-siwc', 'Not Connected'));
    const c = card('openai-siwc');
    expect(within(c).getByRole('button', { name: 'Continue with ChatGPT' })).toBeInTheDocument();
    expect(c.querySelectorAll('input[type="password"]')).toHaveLength(0);
    expect(within(c).queryByLabelText(/username|e-?mail/i)).not.toBeInTheDocument();
    expect(within(c).getByText(/ChatGPT plan usage/)).toBeInTheDocument();
  });

  it('openai-siwc in Re-auth Required asks to sign in again', () => {
    renderCard(provider('openai-siwc', 'Re-auth Required', { last_error: 'token refresh rejected' }));
    const c = card('openai-siwc');
    expect(within(c).getByRole('button', { name: 'Continue with ChatGPT (sign in again)' })).toBeInTheDocument();
    expect(within(c).getByText(/token refresh rejected/)).toBeInTheDocument();
  });

  it('openai-compatible needs base URL, key and a declared billing mode', async () => {
    const user = userEvent.setup();
    renderCard(provider('openai-compatible', 'Not Connected'));
    const c = card('openai-compatible');
    const save = within(c).getByRole('button', { name: /Save & test/ });
    expect(save).toBeDisabled();
    expect(within(c).getByLabelText(/Base URL/)).toBeInTheDocument();
    expect(within(c).getByLabelText('API key')).toHaveAttribute('type', 'password');
    await user.type(within(c).getByLabelText(/Base URL/), 'https://llm.example.com/v1');
    expect(within(c).getByRole('button', { name: /Save & test/ })).toBeDisabled();
    await user.type(within(c).getByLabelText(/Billing mode/), 'self-hosted, free');
    expect(within(c).getByRole('button', { name: 'Save & test' })).toBeEnabled();
  });

  it('ollama-local shows Test connection, model listing and a RAM warning', () => {
    renderCard(provider('ollama-local', 'Connected (Local)', { last_error: 'Ollama 0.9 with 2 installed model(s)' }));
    const c = card('ollama-local');
    expect(within(c).getByRole('button', { name: 'Test connection' })).toBeInTheDocument();
    expect(within(c).getByRole('button', { name: 'List installed models' })).toBeInTheDocument();
    expect(within(c).getByText('RAM warning')).toBeInTheDocument();
    expect(within(c).getByText('Connected (Local)', { selector: 'span' })).toBeInTheDocument();
  });

  it.each([
    ['claude-code-cli', 'Use installed Claude Code (coding mode)'],
    ['codex-cli', 'OpenAI Codex CLI (coding mode)'],
    ['google-antigravity', 'Google Antigravity'],
  ])('%s shows the unsupported reason and has no connect action', (id, label) => {
    renderCard(provider(id, 'Unsupported on this version', { last_error: `Reason text for ${id}. \`bin\` not found.` }));
    const c = card(id);
    expect(within(c).getByText(label)).toBeInTheDocument();
    expect(within(c).getByText(`Reason text for ${id}. \`bin\` not found.`)).toBeInTheDocument();
    expect(within(c).getByRole('button', { name: 'Run detection' })).toBeInTheDocument();
    expect(within(c).queryByRole('button', { name: /connect/i })).not.toBeInTheDocument();
    expect(c.querySelectorAll('input')).toHaveLength(0);
  });

  it('CLI detection shows the detection result from the test response', async () => {
    const user = userEvent.setup();
    installFetch({
      'POST /api/v1/providers/claude-code-cli/test': () =>
        ok({
          provider_id: 'claude-code-cli',
          state: 'Unsupported on this version',
          detail: 'Detection-only in V1. Detected: 2.1.0.',
          billing: 'per the vendor’s own CLI terms',
          capabilities: [],
          account: { installed: true, path: '/usr/local/bin/claude', version: '2.1.0' },
        }),
    });
    renderCard(provider('claude-code-cli', 'Unsupported on this version'));
    const c = card('claude-code-cli');
    await user.click(within(c).getByRole('button', { name: 'Run detection' }));
    expect(await within(c).findByText('/usr/local/bin/claude')).toBeInTheDocument();
    expect(within(c).getByText('Detection-only in V1. Detected: 2.1.0.')).toBeInTheDocument();
  });

  it('Quota Reached explains the stop and keeps Test/Disconnect available', () => {
    renderCard(provider('openai-api', 'Quota Reached', { has_credentials: true, last_error: 'NEBULA daily token cap 50000 reached', daily_token_cap: 50000, usage_today: { input_tokens: 40000, output_tokens: 10000, requests: 12 } }));
    const c = card('openai-api');
    expect(within(c).getByText('Quota reached')).toBeInTheDocument();
    expect(within(c).getByText(/NEBULA daily token cap 50000 reached/)).toBeInTheDocument();
    expect(within(c).getByRole('button', { name: 'Test' })).toBeInTheDocument();
    expect(within(c).getByRole('button', { name: 'Disconnect' })).toBeInTheDocument();
    expect(within(c).getByText(/12 requests/)).toBeInTheDocument();
  });

  it('Connected (API Billing) shows billing mode, usage and a confirmed Disconnect', async () => {
    setCsrfToken('c2');
    const user = userEvent.setup();
    const { calls } = installFetch({
      'POST /api/v1/providers/gemini-api/disconnect': () => ok({ provider_id: 'gemini-api', state: 'Not Connected' }),
    });
    renderCard(provider('gemini-api', 'Connected (API Billing)', { has_credentials: true, usage_today: { input_tokens: 1200, output_tokens: 300, requests: 4 } }));
    const c = card('gemini-api');
    expect(within(c).getByText(/API billing \(per token/)).toBeInTheDocument();
    expect(within(c).getByText(/4 requests/)).toBeInTheDocument();
    await user.click(within(c).getByRole('button', { name: 'Disconnect' }));
    const dialog = await screen.findByRole('dialog');
    expect(calls).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(calls.map((x) => `${x.method} ${x.path}`)).toEqual(['POST /api/v1/providers/gemini-api/disconnect']));
  });

  it('Not Connected API-key provider offers no Disconnect', () => {
    renderCard(provider('openai-api', 'Not Connected'));
    expect(within(card('openai-api')).queryByRole('button', { name: 'Disconnect' })).not.toBeInTheDocument();
  });

  it('daily token cap posts {daily_token_cap}', async () => {
    setCsrfToken('c3');
    const user = userEvent.setup();
    const { calls } = installFetch({
      'POST /api/v1/providers/openai-api/limits': () => ok({ provider_id: 'openai-api', daily_token_cap: 200000 }),
    });
    renderCard(provider('openai-api', 'Connected (API Billing)', { has_credentials: true }));
    const c = card('openai-api');
    await user.type(within(c).getByLabelText('Daily token cap'), '200000');
    await user.click(within(c).getByRole('button', { name: 'Save cap' }));
    await waitFor(() => expect(calls[0]?.body).toEqual({ daily_token_cap: 200000 }));
  });
});
