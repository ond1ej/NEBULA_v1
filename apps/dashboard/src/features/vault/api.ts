// Typed client of the Password Vault API (routes_v32.py "vault"). Secrets only ever travel in JSON request / response
// bodies (POST/PATCH), never in a URL or query string. Metadata responses are reduced to an explicit allow-list of
// fields, so even a malformed response that carried a secret could not reach component state or the screen.
import { request } from '../../lib/http';
import type {
  AgentVaultMode,
  AgentVaultView,
  EntryBody,
  EntryPatch,
  GrantBody,
  GrantPatch,
  RevealField,
  VaultAuditRow,
  VaultCoreStatus,
  VaultEntry,
  VaultEntryDetail,
  VaultExportFile,
  VaultGrant,
  VaultStatus,
} from './types';

const enc = encodeURIComponent;

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** Metadata allow-list of a credential (list rows). */
export function toEntry(raw: unknown): VaultEntry {
  const r = (raw ?? {}) as Record<string, unknown>;
  const t = r.credential_type;
  return {
    id: String(r.id ?? ''),
    display_name: str(r.display_name) ?? '',
    app_name: str(r.app_name),
    origin: str(r.origin),
    credential_type: t === 'application' || t === 'api_token' ? t : 'website',
    tags: strs(r.tags),
    created_at: num(r.created_at) ?? 0,
    updated_at: num(r.updated_at) ?? 0,
    grant_count: num(r.grant_count) ?? 0,
  };
}

/** Owner detail: metadata + username + flags. Password and notes are never kept even if a response carried them. */
export function toEntryDetail(raw: unknown): VaultEntryDetail {
  const r = (raw ?? {}) as Record<string, unknown>;
  const { grant_count, ...meta } = toEntry(r);
  return {
    ...meta,
    grant_count: num(r.grant_count) === null ? undefined : grant_count,
    username: str(r.username) ?? '',
    has_password: r.has_password === true,
    has_notes: r.has_notes === true,
    login_url: str(r.login_url) ?? '',
  };
}

export const vaultApi = {
  // ---------------------------------------------------------------- metadata (available everywhere)
  status: (signal?: AbortSignal) => request<VaultStatus>('/vault/status', { signal }),
  entries: async (q?: string, signal?: AbortSignal) =>
    (await request<unknown[]>('/vault/entries', { query: { q: q?.trim() || undefined }, signal })).map(toEntry),
  grants: (signal?: AbortSignal) => request<VaultGrant[]>('/vault/grants', { signal }),
  audit: (limit = 200, agentId?: string, signal?: AbortSignal) =>
    request<VaultAuditRow[]>('/vault/audit', { query: { limit, agent_id: agentId }, signal }),
  agent: (agentId: string, signal?: AbortSignal) => request<AgentVaultView>(`/agents/${enc(agentId)}/vault`, { signal }),
  lock: () => request<{ locked: true; expired_approvals: number }>('/vault/lock', { method: 'POST' }),
  revokeGrant: (grantId: string) => request<VaultGrant>(`/vault/grants/${enc(grantId)}/revoke`, { method: 'POST' }),

  // ---------------------------------------------------------------- management (only from this Mac)
  create: (passphrase: string) => request<VaultCoreStatus>('/vault', { method: 'POST', body: { passphrase } }),
  unlock: (passphrase: string) => request<VaultCoreStatus>('/vault/unlock', { method: 'POST', body: { passphrase } }),
  reauth: (passphrase: string) => request<{ reauth_until: number }>('/vault/reauth', { method: 'POST', body: { passphrase } }),
  rotate: (current_passphrase: string, new_passphrase: string) =>
    request<VaultCoreStatus>('/vault/passphrase', { method: 'POST', body: { current_passphrase, new_passphrase } }),
  /** Every field optional; only the given ones change. `broker_enabled: false` also cancels pending sign-in requests. */
  settings: (body: { auto_lock_minutes?: number; allow_lan_https?: boolean; broker_enabled?: boolean }) =>
    request<VaultCoreStatus>('/vault/settings', { method: 'PUT', body }),

  entry: async (id: string, signal?: AbortSignal) => toEntryDetail(await request<unknown>(`/vault/entries/${enc(id)}`, { signal })),
  createEntry: async (body: EntryBody) => toEntry(await request<unknown>('/vault/entries', { method: 'POST', body })),
  updateEntry: async (id: string, body: EntryPatch) => toEntry(await request<unknown>(`/vault/entries/${enc(id)}`, { method: 'PATCH', body })),
  /** Always sends confirm=true: call only after the owner confirmed. Also deletes the credential's grants. */
  deleteEntry: (id: string) =>
    request<{ deleted: boolean; grants_revoked: number }>(`/vault/entries/${enc(id)}`, { method: 'DELETE', query: { confirm: true } }),
  /** The only call that returns a stored secret. Keep the value in component state only. */
  reveal: async (id: string, field: RevealField) => {
    const r = await request<{ value?: unknown }>(`/vault/entries/${enc(id)}/reveal`, { method: 'POST', body: { field } });
    return typeof r.value === 'string' ? r.value : '';
  },
  exportVault: (export_passphrase: string) => request<VaultExportFile>('/vault/export', { method: 'POST', body: { export_passphrase } }),
  importVault: (export_passphrase: string, file: VaultExportFile, confirm: boolean) =>
    request<{ imported: number }>('/vault/import', { method: 'POST', body: { export_passphrase, export: file, confirm } }),

  setAgentMode: (agentId: string, mode: AgentVaultMode, managed_tags: string[] = []) =>
    request<AgentVaultView>(`/agents/${enc(agentId)}/vault`, { method: 'PUT', body: { mode, managed_tags } }),
  createGrant: (agentId: string, body: GrantBody) => request<VaultGrant>(`/agents/${enc(agentId)}/vault/grants`, { method: 'POST', body }),
  updateGrant: (grantId: string, body: GrantPatch) => request<VaultGrant>(`/vault/grants/${enc(grantId)}`, { method: 'PATCH', body }),
  deleteGrant: (grantId: string) => request<{ deleted: boolean }>(`/vault/grants/${enc(grantId)}`, { method: 'DELETE' }),
};
