# AI providers

An agent thinks with one AI provider and model. You connect providers in **Dashboard → AI Providers** and choose one
per agent in **Create Agent** (or later in the agent's settings).

## Support matrix

| Provider id | Name in the dashboard | How you connect | Billing | Status |
|---|---|---|---|---|
| `ollama-local` | Ollama (local) | Install Ollama on the Mac, pull a tool-capable model, press **Test connection** | Local, no token billing; uses Mac RAM | **Stable**: verified on hardware |
| `openai-api` | OpenAI API key | Paste an API key from your OpenAI account | Per token, by OpenAI | **Experimental**: contract-tested with mocked HTTP |
| `anthropic-api` | Claude API Key (Anthropic) | Paste an API key from the Anthropic console | Per token, by Anthropic | **Experimental**: contract-tested with mocked HTTP |
| `gemini-api` | Google Gemini API key | Paste an API key from Google AI Studio | Per Google's API terms | **Experimental**: contract-tested with mocked HTTP |
| `openai-compatible` | Other OpenAI-compatible endpoint | Base URL (HTTPS, or HTTP on `127.0.0.1`), optional key, and the billing mode you declare | As declared by you | **Experimental**: contract-tested with mocked HTTP |
| `openai-siwc` | OpenAI, Continue with ChatGPT | **Continue with ChatGPT** on the Mac; OpenAI's sign-in page opens and redirects back to `http://127.0.0.1:<port>/auth/callback` | Your ChatGPT plan's usage limits | **Experimental**: follows OpenAI's documented flow for local open-source clients; availability depends on OpenAI |
| `claude-code-cli` | not shown | Cannot be connected | n/a | **Not supported** in 1.0 |
| `codex-cli` | not shown | Cannot be connected | n/a | **Not supported** in 1.0 |
| `google-antigravity` | not shown | Cannot be connected | n/a | **Not supported** in 1.0 |

The last three ids exist only so that the API (`GET /api/v1/providers`) can report an installed Claude Code, Codex or
Antigravity CLI as unsupported, with the reason. The Providers page does not show them and offers no way to connect
them.

"Contract-tested with mocked HTTP" means the adapter's requests and response handling are covered by automated tests,
but this release was not run against the provider's live API. Please report problems you hit with a real key.

### What NEBULA never does

- It never asks for your ChatGPT, Claude or Google account password.
- It never reads browser cookies or session tokens, and never calls a subscription's private web endpoints.
- It never offers a "log in with your Claude subscription" or "Gemini subscription" option. Claude and Gemini are
  supported **only with API keys**.
- It never uses one person's plan for another person. Sign in with ChatGPT is for your own local install.

## Ollama (local models)

1. Install Ollama from [ollama.com](https://ollama.com) and start it. NEBULA expects it at `http://127.0.0.1:11434`
   (`providers.ollama_base_url`; only loopback addresses are accepted).
2. Pull a model that supports tool calls, for example:

   ```bash
   ollama pull qwen2.5:7b
   ```

3. Dashboard → AI Providers → Ollama → **Test connection**. The card lists the models it found.

Memory matters. A 7B model needs about 5 GB next to the VM. On a 16 GB Mac use `vm.ram_mb: 4096` (or install with
`--vm-ram-mb 4096`); NEBULA runs Ollama with an 8k context and refuses to load a model that does not fit into
reclaimable memory, so the task waits in `WAITING_PROVIDER` instead of pushing the Mac into heavy swap (see
[decisions.md](decisions.md) D24). Local inference runs one request at a time. Small local models are noticeably less
reliable at multi-step tool use than large cloud models; tasks can take minutes and sometimes fail with the agent's
own explanation.

## API keys (OpenAI, Anthropic, Gemini, OpenAI-compatible)

Paste the key into the provider card and press **Test connection**. The key is written to the macOS Keychain; the
database keeps only a reference, and the API never returns the key. To remove it, use **Disconnect** on the card.

For an OpenAI-compatible endpoint you also give the base URL. It must use HTTPS, except for loopback addresses
(`http://127.0.0.1:<port>`), so a local inference server works as well. You declare how it is billed, and NEBULA shows
that declaration; it cannot verify it.

Because your API key is sent to that endpoint, an HTTPS endpoint must be public: a host name that resolves to a
private, CGNAT (Tailscale), loopback or link-local address is refused, and so are NEBULA's own ports on loopback. The
name is resolved and checked again before use, at most once a minute: a passed check is cached for 60 seconds, and
the address is not pinned for the requests themselves. A DNS answer that changes after a passed check (DNS
rebinding) can therefore send every request of up to the next minute, with your API key, to the new address.
Run local servers on `http://127.0.0.1:<port>` instead.

## Sign in with ChatGPT

**Continue with ChatGPT** connects your ChatGPT plan through OpenAI's documented sign-in for open-source, locally
hosted clients:

- OIDC authorization code with PKCE (S256) against `auth.openai.com`, with dynamic client registration on the first
  sign-in and a per-install host identifier.
- The redirect goes to `http://127.0.0.1:<dashboard port>/auth/callback`, so the sign-in must be started **on the Mac
  itself**. The stored connection can then be used from every device.
- The ID token is verified against OpenAI's published keys (issuer, audience, nonce, expiry). Refresh tokens rotate and
  are refreshed one at a time; a refresh that fails for good marks the provider `Re-auth Required`.
- Inference uses the Responses API with `store: false`. If the grant does not include the scope that allows direct
  plan use, NEBULA refuses inference and suggests an API key instead.
- Plan limits are OpenAI's. When a usage limit is reached the provider shows `Quota Reached`, tasks wait in
  `WAITING_PROVIDER`, and NEBULA links to your usage page instead of guessing a reset time.

Whether this option is available to you is up to OpenAI. If OpenAI changes or ends the programme, use an API key.

## Provider states

Each provider card shows one state: `Not Connected`, `Connect`, `Connected (Local)`, `Connected (API Billing)`,
`Connected (Subscription)`, `Quota Reached`, `Re-auth Required`, `Error` (with a diagnosis) or
`Unsupported on this version`.

If a cloud endpoint is blocked on your Mac (an `/etc/hosts` entry or a DNS sinkhole), NEBULA reports the exact cause on
the card and in preflight, and never works around the block. Ollama is unaffected.

## Choosing models and fallbacks

- Models are listed live from the provider and cached for an hour (refresh from the card).
- An agent never switches to another provider on its own. A per-agent fallback provider is the only way a different
  (possibly paid) provider is used automatically, and it is off unless you set it.

## Spending limits

- **Per task:** `agents.max_steps_per_task` (default 30) caps both tool calls and model requests, counted before each
  request is sent.
- **Per provider:** a daily token cap (minimum 1000), set on the provider card or through
  `POST /api/v1/providers/{id}/limits` with `{"daily_token_cap": N}`. When the cap is reached the provider shows
  `Quota Reached` and tasks wait in `WAITING_PROVIDER` until you resume them.
- **Teams and companies:** optional budgets of model requests per run.
- Rate-limit and temporary errors are retried three times with backoff (5 s, 20 s, 60 s); then the task waits.

Prices are not hard-coded in NEBULA. Check your provider's pricing page.
