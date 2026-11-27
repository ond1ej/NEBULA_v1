// Password Vault + Smart sign-in owner endpoints for the Mini App (routes_v32.py vault, routes_v321.py settings / PIN,
// routes_v33.py trust). Requests go through lib/http with the Mini App's Bearer transport, so a 403 `stepup_required` /
// `reauth_required` opens the ONE owner confirmation (StepUpProvider, V4.0) and is retried once; unlocking, revealing
// and exporting confirm first (useOwnerConfirm / useReauth). Secrets travel only in JSON request bodies — never in a URL — and every metadata
// response is whitelisted (clean*). The only secret-bearing responses are `reveal` (its value goes straight back to the
// caller) and `export` (already encrypted with the export passphrase).
import { request } from '../../lib/http';
import type { VaultExportFile } from '../../features/vault/types';
import {
  cleanAgentVault,
  cleanAudits,
  cleanEntries,
  cleanEntry,
  cleanEntryDetail,
  cleanGrant,
  cleanGrants,
  cleanSignInSettings,
  cleanStatus,
  cleanTrust,
} from './data';

const enc = encodeURIComponent;
const POST = 'POST' as const;

export interface EntryInput {
  display_name: string;
  credential_type: 'website' | 'application' | 'api_token';
  origin?: string;
  app_name?: string;
  username?: string;
  password?: string;
  notes?: string;
  tags?: string[];
}

export const vaultApiM = {
  status: async (signal?: AbortSignal) => cleanStatus(await request<unknown>('/vault/status', { signal })),
  create: async (passphrase: string) => cleanStatus(await request<unknown>('/vault', { method: POST, body: { passphrase } })),
  unlock: async (passphrase: string) => cleanStatus(await request<unknown>('/vault/unlock', { method: POST, body: { passphrase } })),
  lock: () => request<unknown>('/vault/lock', { method: POST }),
  reauth: (passphrase: string) => request<{ reauth_until: number }>('/vault/reauth', { method: POST, body: { passphrase } }),
  rotate: async (current_passphrase: string, new_passphrase: string) =>
    cleanStatus(await request<unknown>('/vault/passphrase', { method: POST, body: { current_passphrase, new_passphrase } })),
  settings: async (body: { auto_lock_minutes?: number; broker_enabled?: boolean }) => cleanStatus(await request<unknown>('/vault/settings', { method: 'PUT', body })),

  entries: async (q?: string, signal?: AbortSignal) => cleanEntries(await request<unknown>('/vault/entries', { query: { q: q?.trim() || undefined }, signal })),
  entry: async (id: string, signal?: AbortSignal) => cleanEntryDetail(await request<unknown>(`/vault/entries/${enc(id)}`, { signal })),
  createEntry: async (body: EntryInput) => cleanEntry(await request<unknown>('/vault/entries', { method: POST, body })),
  updateEntry: async (id: string, body: Partial<EntryInput>) => cleanEntry(await request<unknown>(`/vault/entries/${enc(id)}`, { method: 'PATCH', body })),
  deleteEntry: (id: string) => request<unknown>(`/vault/entries/${enc(id)}`, { method: 'DELETE', query: { confirm: true } }),
  /** The only call that returns a stored secret: keep it in component state only. */
  reveal: async (id: string, field: 'password' | 'username' | 'notes' = 'password') => {
    const r = await request<{ value?: unknown }>(`/vault/entries/${enc(id)}/reveal`, { method: POST, body: { field } });
    return typeof r?.value === 'string' ? r.value : '';
  },
  exportVault: (export_passphrase: string) => request<VaultExportFile>('/vault/export', { method: POST, body: { export_passphrase } }),
  importVault: (export_passphrase: string, file: unknown) =>
    request<{ imported?: number }>('/vault/import', { method: POST, body: { export_passphrase, export: file, confirm: true } }),

  grants: async (signal?: AbortSignal) => cleanGrants(await request<unknown>('/vault/grants', { signal })),
  audit: async (limit = 200, agentId?: string, signal?: AbortSignal) => cleanAudits(await request<unknown>('/vault/audit', { query: { limit, agent_id: agentId }, signal })),
  agent: async (agentId: string, signal?: AbortSignal) => cleanAgentVault(await request<unknown>(`/agents/${enc(agentId)}/vault`, { signal })),
  setMode: async (agentId: string, mode: string, managed_tags: string[] = []) =>
    cleanAgentVault(await request<unknown>(`/agents/${enc(agentId)}/vault`, { method: 'PUT', body: { mode, managed_tags } })),
  createGrant: async (agentId: string, entry_id: string, approval_policy: string) =>
    cleanGrant(await request<unknown>(`/agents/${enc(agentId)}/vault/grants`, { method: POST, body: { entry_id, approval_policy } })),
  updateGrant: async (grantId: string, approval_policy: string) => cleanGrant(await request<unknown>(`/vault/grants/${enc(grantId)}`, { method: 'PATCH', body: { approval_policy } })),
  revokeGrant: (grantId: string) => request<unknown>(`/vault/grants/${enc(grantId)}/revoke`, { method: POST }),
  deleteGrant: (grantId: string) => request<unknown>(`/vault/grants/${enc(grantId)}`, { method: 'DELETE' }),

  // Smart sign-in (owner)
  signInSettings: async (signal?: AbortSignal) => cleanSignInSettings(await request<unknown>('/smart-auth/settings', { signal })),
  updateSignInSettings: async (patch: { enabled?: boolean; remote_submission?: boolean; allow_local_network?: boolean; passkey_fallback?: 'password' | 'ask' }) =>
    cleanSignInSettings(await request<unknown>('/smart-auth/settings', { method: 'PUT', body: patch })),
  setPin: (pin: string, currentPin?: string) => request<unknown>('/smart-auth/pin', { method: 'PUT', body: currentPin ? { pin, current_pin: currentPin } : { pin } }),
  clearPin: () => request<unknown>('/smart-auth/pin', { method: 'DELETE' }),
  trust: async (signal?: AbortSignal) => cleanTrust(await request<unknown>('/smart-auth/trust', { signal })),
  addRelationship: async (service: string, idp: string, first_party: boolean) =>
    cleanTrust(await request<unknown>('/smart-auth/trust/relationships', { method: POST, body: { service, idp, first_party } })),
  removeRelationship: async (service: string, idp: string) => cleanTrust(await request<unknown>('/smart-auth/trust/relationships', { method: 'DELETE', query: { service, idp } })),
  verifySite: async (origin: string) => cleanTrust(await request<unknown>('/smart-auth/trust/sites', { method: POST, body: { origin } })),
  unverifySite: async (origin: string) => cleanTrust(await request<unknown>('/smart-auth/trust/sites', { method: 'DELETE', query: { origin } })),
};
