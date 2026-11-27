import { useEffect, useRef } from 'react';
import { api } from '../api';
import { CLI_PROVIDERS, ProviderCard } from '../components/ProviderCard';
import { ProviderChooser, providerCardId } from '../components/ProviderChooser';
import { useToast } from '../components/Toast';
import { ErrorBanner, Notice, PageHeader, Spinner } from '../components/ui';
import { useApi } from '../hooks/useApi';
import { useLiveRefresh } from '../hooks/useEvents';
import { navigate } from '../hooks/useHashRoute';

const ORDER = ['openai-siwc', 'openai-api', 'anthropic-api', 'gemini-api', 'ollama-local', 'openai-compatible', 'claude-code-cli', 'codex-cli', 'google-antigravity'];

export function ProvidersPage({ query }: { query: URLSearchParams }) {
  const toast = useToast();
  const providers = useApi(() => api.providers.list(), []);
  useLiveRefresh(providers.reload, (e) => e.type.startsWith('provider.'));
  const siwc = query.get('siwc');
  const shown = useRef(false);
  const reload = providers.reload;

  useEffect(() => {
    if (siwc === 'connected' && !shown.current) {
      shown.current = true;
      toast.success('Signed in with ChatGPT', 'OpenAI — Continue with ChatGPT is connected.');
      reload();
      navigate('/providers', { replace: true });
    } else if (siwc === 'signed_in_unreachable' && !shown.current) {
      shown.current = true;
      toast.error(
        new Error('Your ChatGPT sign-in succeeded and is stored, but NEBULA cannot reach api.openai.com from this Mac. See the reason on the provider card.'),
        'Signed in — API unreachable',
      );
      reload();
      navigate('/providers', { replace: true });
    }
  }, [siwc, toast, reload]);

  const list = [...(providers.data ?? [])].sort((a, b) => {
    const ia = ORDER.indexOf(a.id);
    const ib = ORDER.indexOf(b.id);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  const main = list.filter((p) => !CLI_PROVIDERS.has(p.id));
  // Claude Code / Codex CLI / Antigravity are detection-only (unsupported): never offered as a way to connect.

  return (
    <>
      <PageHeader
        title="AI Providers"
        description="Choose how your agents get their AI: a free local model, an API key billed per token, or Sign in with ChatGPT. Each card states which one applies."
      />
      <div className="mb-5">
        <Notice tone="info">
          NEBULA never asks for a third-party username or password. The only subscription it can use is ChatGPT, through OpenAI’s official sign-in flow; API keys
          are stored in the macOS Keychain.
        </Notice>
      </div>
      {providers.error ? <div className="mb-4"><ErrorBanner error={providers.error} onRetry={providers.reload} /></div> : null}
      {!providers.data && providers.loading ? (
        <Spinner label="Loading providers…" />
      ) : (
        <>
          <ProviderChooser providers={main} />
          <div className="grid gap-4 xl:grid-cols-2">
            {main.map((p) => (
              <div key={p.id} id={providerCardId(p.id)} tabIndex={-1} className="scroll-mt-20 rounded-xl outline-none">
                <ProviderCard provider={p} onChanged={providers.reload} />
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}
