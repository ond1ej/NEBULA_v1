// Agent composer endpoints (V3.2.2). Kept out of ../api.ts so the initial Mini App bundle does not carry them: only
// the creator / settings chunks import this module. Every route is on the gateway allow-list with the `agents`
// permission (main bot's paired owner); local Dashboard sessions are always allowed.
import type { MiniClient } from '../client';
import type { AgentComposerPatch, AgentComposerSettings, AgentOptions, CreateAgentBody, ModelChoice } from './types';

const enc = encodeURIComponent;

/** Agent creation provisions a Linux user + desktop in the VM (5–60 s): give up waiting after this long. */
export const CREATE_TIMEOUT_MS = 150_000;

export const OPTIONS_KEY = 'agent-options';
export const settingsKey = (agentId: string) => `agent-settings:${agentId}`;

export function composerApi(c: MiniClient) {
  return {
    options: (signal?: AbortSignal) => c.request<AgentOptions>('/miniapp/agent-options', { signal }),
    models: (providerId: string, signal?: AbortSignal) =>
      c.request<ModelChoice[]>('/miniapp/agent-options/models', { query: { provider_id: providerId }, signal }),
    /** The Idempotency-Key makes a retry (double tap, lost connection) return the same agent, never a second one. */
    create: (body: CreateAgentBody, idempotencyKey: string, signal?: AbortSignal) =>
      c.request<AgentComposerSettings>('/miniapp/agents', { method: 'POST', body, idempotencyKey, signal }),
    settings: (agentId: string, signal?: AbortSignal) => c.request<AgentComposerSettings>(`/miniapp/agents/${enc(agentId)}/settings`, { signal }),
    update: (agentId: string, patch: AgentComposerPatch) =>
      c.request<AgentComposerSettings>(`/miniapp/agents/${enc(agentId)}/settings`, { method: 'PATCH', body: patch }),
  };
}

export type ComposerApi = ReturnType<typeof composerApi>;
