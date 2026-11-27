// Provider names and states without the ProviderCard UI (so lists and the Command Center do not load the card).
import type { Provider } from '../types';

/** UI labels (spec §6.1). The backend display_name is used for anything not listed here. */
const LABELS: Record<string, string> = {
  'openai-siwc': 'OpenAI — Continue with ChatGPT',
  'openai-api': 'OpenAI API Key',
  'anthropic-api': 'Claude API Key',
  'gemini-api': 'Google Gemini API Key',
  'openai-compatible': 'Other OpenAI-compatible endpoint',
  'ollama-local': 'Ollama (local)',
  'claude-code-cli': 'Use installed Claude Code (coding mode)',
  'codex-cli': 'OpenAI Codex CLI (coding mode)',
  'google-antigravity': 'Google Antigravity',
};

export function providerLabel(p: Pick<Provider, 'id' | 'display_name'>): string {
  return LABELS[p.id] ?? p.display_name;
}

export function isConnected(state: string): boolean {
  return state.startsWith('Connected');
}
