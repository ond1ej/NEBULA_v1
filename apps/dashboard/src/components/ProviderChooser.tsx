// "Which kind of AI do you want?": the three honest ways to power an agent, side by side, before the technical cards.
// Each option says what it costs and what it needs, links to the card that connects it and shows whether it already is.
// Claude and Gemini SUBSCRIPTIONS are not supported by NEBULA (only their API keys) and are never offered here.
import type { ReactNode } from 'react';
import { isConnected } from '../lib/providers';
import type { Provider } from '../types';
import { Badge, Notice } from './ui';

/** DOM id of the card of one provider on the Providers page (the chooser scrolls to it). */
export const providerCardId = (id: string): string => `provider-card-${id}`;

function focusCard(id: string): void {
  const el = document.getElementById(providerCardId(id));
  if (!el) return;
  el.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  el.focus?.({ preventScroll: true });
}

function Option({ title, tag, tone, lead, facts, connected, children }: { title: string; tag: string; tone: 'success' | 'info' | 'warn'; lead: string; facts: string[]; connected: boolean; children: ReactNode }) {
  return (
    <li className="flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-panel p-4 shadow-card" data-testid={`choice-${title.split(' ')[0].toLowerCase()}`}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-text">{title}</h3>
        <Badge tone={tone}>{tag}</Badge>
        {connected && (
          <Badge tone="success" dot>
            Connected
          </Badge>
        )}
      </div>
      <p className="text-sm text-muted">{lead}</p>
      <ul className="list-disc space-y-1 pl-4 text-xs leading-5 text-muted">
        {facts.map((f) => (
          <li key={f}>{f}</li>
        ))}
      </ul>
      <div className="mt-auto flex flex-wrap gap-2 pt-1">{children}</div>
    </li>
  );
}

function Pick({ id, children }: { id: string; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={() => focusCard(id)}
      className="inline-flex h-8 items-center rounded-lg border border-border-strong bg-panel-2 px-3 text-[13px] font-medium text-text transition-colors hover:border-border-hover hover:bg-white/[0.04] focus-ring"
    >
      {children}
    </button>
  );
}

export function ProviderChooser({ providers }: { providers: Provider[] }) {
  const on = (...ids: string[]) => providers.some((p) => ids.includes(p.id) && isConnected(p.state));
  return (
    <section aria-label="Choose how to power your agents" className="mb-6 space-y-4">
      <ul className="grid gap-4 lg:grid-cols-3">
        <Option
          title="Local model (Ollama)"
          tag="Free"
          tone="success"
          connected={on('ollama-local')}
          lead="Runs on this Mac. Nothing leaves your machine and there is no bill."
          facts={['Uses this Mac’s RAM: a 7B model needs about 5 GB and competes with the Ubuntu VM.', 'Smaller models are less capable at multi-step browsing.', 'Needs Ollama installed and a model pulled.']}
        >
          <Pick id="ollama-local">Set up Ollama</Pick>
        </Option>
        <Option
          title="API key"
          tag="Billed per token"
          tone="warn"
          connected={on('openai-api', 'anthropic-api', 'gemini-api', 'openai-compatible')}
          lead="Paste a key from OpenAI, Anthropic (Claude), Google Gemini or any OpenAI-compatible endpoint."
          facts={['The provider charges your account for every token, so long agent runs cost money. Set a daily token cap on the card.', 'The key is stored in the macOS Keychain, never in the database.']}
        >
          <Pick id="openai-api">OpenAI</Pick>
          <Pick id="anthropic-api">Claude (Anthropic)</Pick>
          <Pick id="gemini-api">Gemini</Pick>
          <Pick id="openai-compatible">OpenAI-compatible</Pick>
        </Option>
        <Option
          title="Sign in with ChatGPT"
          tag="Uses your ChatGPT plan"
          tone="info"
          connected={on('openai-siwc')}
          lead="OpenAI’s official sign-in for open-source local clients. Requests count against your ChatGPT plan’s usage limits instead of per-token billing."
          facts={['You sign in on OpenAI’s own page; NEBULA never sees your password.', 'Experimental: it depends on OpenAI’s programme for local clients and can change.', 'Start it on the Mac mini itself (OpenAI only allows a 127.0.0.1 callback).']}
        >
          <Pick id="openai-siwc">Continue with ChatGPT</Pick>
        </Option>
      </ul>
      <Notice tone="warn" title="Claude and Gemini subscriptions are not supported">
        A Claude.ai subscription (including Claude Code login) and a Google Gemini / AI Pro subscription cannot be used by NEBULA, and NEBULA will never ask for their passwords. To use Claude or Gemini, use an API key
        above.
      </Notice>
    </section>
  );
}
